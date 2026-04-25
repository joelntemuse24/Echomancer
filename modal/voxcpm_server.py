"""
VoxCPM2 TTS Server - Persistent torch.compile cache for fast cold starts
"""

import modal
from pydantic import BaseModel
from typing import Optional, List

# Use Modal's PyTorch image with CUDA support
image = (
    modal.Image.from_registry(
        "pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime",
        add_python="3.11"
    )
    .apt_install("git", "ffmpeg", "libsndfile1", "espeak-ng", "build-essential")
    .pip_install(
        "voxcpm",
        "soundfile",
        "numpy",
    )
)

app = modal.App("voxcpm-tts", image=image)

class TTSRequest(BaseModel):
    text: str
    reference_audio_base64: str
    reference_text: Optional[str] = None
    cfg_value: float = 2.0
    inference_timesteps: int = 10

class BatchTTSRequest(BaseModel):
    texts: List[str]
    reference_audio_base64: str
    reference_text: Optional[str] = None
    cfg_value: float = 2.0
    inference_timesteps: int = 10

@app.cls(
    gpu="A100",
    scaledown_window=3600,  # Keep warm 60 min
    timeout=1200,  # 20 min — accommodates cold start + batch generation
    allow_concurrent_inputs=10,  # Single container handles multiple requests
)
class VoxCPMServer:
    @modal.enter()
    def setup(self):
        import os
        import torch
        import torch._dynamo
        import torch._inductor
        from voxcpm import VoxCPM

        # NOTE: torch.compile causes ~27s per diffusion step on first run due to
        # recompilation per timestep (shape-changing graphs). The A100 alone gives
        # ~3x speedup over L4 in eager mode, so we disable compilation entirely.
        # Monkey-patch before importing VoxCPM so the library's own compile calls
        # become no-ops.
        torch.compile = lambda model, *args, **kwargs: model  # type: ignore
        os.environ["TORCHDYNAMO_DISABLE"] = "1"
        torch._dynamo.config.disable = True

        print("Loading VoxCPM2 model (eager mode, no torch.compile)...")
        self.model = VoxCPM.from_pretrained(
            "openbmb/VoxCPM2",
            load_denoiser=False,
        )
        self.sample_rate = 48000

        # The VoxCPM wrapper hides the inner VoxCPM2Model.
        # Find it by inspecting attributes — it's typically .tts_model
        inner = getattr(self.model, 'tts_model', None) or getattr(self.model, 'model', None)
        if inner is None:
            # Last resort: scan all attributes for one with base_lm
            for attr_name in dir(self.model):
                attr = getattr(self.model, attr_name, None)
                if attr is not None and hasattr(attr, 'base_lm'):
                    inner = attr
                    print(f"Found inner model at .{attr_name}")
                    break

        if inner and hasattr(inner, 'base_lm'):
            # Increase KV cache limit from default 8192 — reference audio features
            # consume cache slots, and the default is too small for voice cloning.
            new_max_length = 16384
            inner.config.max_length = new_max_length
            dtype = getattr(torch, inner.config.dtype, torch.bfloat16)
            inner.base_lm.setup_cache(1, new_max_length, inner.device, dtype)
            inner.residual_lm.setup_cache(1, new_max_length, inner.device, dtype)
            print(f"✓ VoxCPM2 loaded (KV cache max_length={new_max_length})")
        else:
            print(f"⚠ Could not find inner model to resize cache. Available attrs: {[a for a in dir(self.model) if not a.startswith('_')]}")
            print("✓ VoxCPM2 loaded (default cache)")

        # Eager-mode warm-up: run one short generation so CUDA kernels, cuDNN
        # plans, and the VoxCPM internal caches are initialized before the first
        # real request hits the container.
        print("Warming up model (eager mode)...")
        import tempfile
        import numpy as np
        import soundfile as sf

        rng = np.random.default_rng(42)
        n_samples = int(self.sample_rate * 3.0)  # 3 seconds
        white = rng.standard_normal(n_samples).astype(np.float32)
        hp_window = int(self.sample_rate / 80)
        lp_window = int(self.sample_rate / 8000)
        hp = white - np.convolve(white, np.ones(hp_window) / hp_window, mode='same')
        lp = np.convolve(hp, np.ones(lp_window) / lp_window, mode='same')
        dummy_samples = 0.15 * (lp / (np.max(np.abs(lp)) + 1e-8))

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            sf.write(tmp.name, dummy_samples, self.sample_rate)
            dummy_path = tmp.name
        try:
            _ = self.model.generate(
                text="Warm up.",
                reference_wav_path=dummy_path,
                cfg_value=2.0,
                inference_timesteps=2,  # Short warm-up, production uses 10
            )
            print("✓ Warmup complete")
        except Exception as e:
            print(f"⚠ Warmup generation failed (non-fatal): {e}")
            print("  First real request may be slightly slower.")
        finally:
            os.unlink(dummy_path)

    def _decode_audio(self, audio_base64: str):
        import base64
        import io
        import soundfile as sf
        
        audio_bytes = base64.b64decode(audio_base64)
        with io.BytesIO(audio_bytes) as buf:
            audio_np, sr = sf.read(buf)
        if len(audio_np.shape) > 1:
            audio_np = audio_np.mean(axis=1)
        return audio_np, sr

    def _reset_kv_cache(self):
        """Reset KV cache between generate calls by reinitializing setup_cache.

        Without this, the model's internal prompt cache accumulates state
        across sections, causing audio quality degradation (choppiness)
        and eventually cache_size_limit errors.
        """
        import torch
        inner = getattr(self.model, 'tts_model', None) or getattr(self.model, 'model', None)
        if inner is None:
            for attr_name in dir(self.model):
                attr = getattr(self.model, attr_name, None)
                if attr is not None and hasattr(attr, 'base_lm'):
                    inner = attr
                    break
        if inner is None:
            return

        max_length = getattr(inner.config, 'max_length', 16384)
        dtype = getattr(torch, getattr(inner.config, 'dtype', 'bfloat16'), torch.bfloat16)
        device = getattr(inner, 'device', 'cuda')

        for lm_name in ['base_lm', 'residual_lm']:
            lm = getattr(inner, lm_name, None)
            if lm is not None and hasattr(lm, 'setup_cache'):
                lm.setup_cache(1, max_length, device, dtype)

    def _generate_core(self, text: str, ref_path: str, reference_text: Optional[str] = None, cfg_value: float = 2.0, inference_timesteps: int = 10):
        """Core generation with a pre-written reference audio file."""
        import base64
        import io
        import soundfile as sf

        # Reset KV cache before each generation to prevent accumulation
        self._reset_kv_cache()

        if reference_text:
            wav = self.model.generate(
                text=text,
                prompt_wav_path=ref_path,
                prompt_text=reference_text,
                reference_wav_path=ref_path,
                cfg_value=cfg_value,
                inference_timesteps=inference_timesteps,
            )
        else:
            wav = self.model.generate(
                text=text,
                reference_wav_path=ref_path,
                cfg_value=cfg_value,
                inference_timesteps=inference_timesteps,
            )

        with io.BytesIO() as buf:
            sf.write(buf, wav, self.sample_rate, format="WAV")
            audio_b64 = base64.b64encode(buf.getvalue()).decode()

        return {
            "audio_base64": audio_b64,
            "sample_rate": self.sample_rate,
            "duration_seconds": len(wav) / self.sample_rate,
        }

    def _generate_single(self, text: str, reference_audio_base64: str, reference_text: Optional[str] = None, cfg_value: float = 2.0, inference_timesteps: int = 10):
        import tempfile
        import os
        import soundfile as sf

        ref_audio, ref_sr = self._decode_audio(reference_audio_base64)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            sf.write(tmp.name, ref_audio, ref_sr)
            ref_path = tmp.name

        try:
            return self._generate_core(
                text=text,
                ref_path=ref_path,
                reference_text=reference_text,
                cfg_value=cfg_value,
                inference_timesteps=inference_timesteps,
            )
        finally:
            os.unlink(ref_path)

    @modal.fastapi_endpoint(method="POST")
    def generate(self, request: TTSRequest):
        try:
            return self._generate_single(
                text=request.text,
                reference_audio_base64=request.reference_audio_base64,
                reference_text=request.reference_text,
                cfg_value=request.cfg_value,
                inference_timesteps=request.inference_timesteps,
            )
        except Exception as e:
            import traceback
            return {"error": str(e), "traceback": traceback.format_exc()}

    @modal.fastapi_endpoint(method="POST")
    def generate_batch(self, request: BatchTTSRequest):
        import tempfile
        import os
        import soundfile as sf

        results = []
        errors = []

        # Decode reference audio ONCE for the entire batch
        ref_audio, ref_sr = self._decode_audio(request.reference_audio_base64)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            sf.write(tmp.name, ref_audio, ref_sr)
            ref_path = tmp.name

        try:
            for i, text in enumerate(request.texts):
                try:
                    result = self._generate_core(
                        text=text,
                        ref_path=ref_path,
                        reference_text=request.reference_text,
                        cfg_value=request.cfg_value,
                        inference_timesteps=request.inference_timesteps,
                    )
                    results.append(result)
                except Exception as e:
                    import traceback
                    results.append({
                        "error": str(e),
                        "traceback": traceback.format_exc(),
                    })
                    errors.append(i)
        finally:
            os.unlink(ref_path)

        response = {"results": results, "total": len(results)}
        if errors:
            response["errors"] = errors
        return response

@app.function(image=image)
@modal.fastapi_endpoint(method="GET")
def health():
    return {"status": "ok", "model": "VoxCPM2", "sample_rate": 48000}
