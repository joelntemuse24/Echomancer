"""
Thin wrapper around MeanVC offline reference-guided voice conversion.
Used by hybrid_tts_server.MeanVCConverter inside the Modal image.
"""
from __future__ import annotations

import json
import os
from typing import Tuple

import librosa
import numpy as np
import torch
import torch.nn as nn
import torchaudio
import torchaudio.compliance.kaldi as kaldi
from librosa.filters import mel as librosa_mel_fn

MEANVC_ROOT = os.environ.get("MEANVC_ROOT", "/opt/MeanVC")
C_KV_CACHE_MAX_LEN = 100


def _amp_to_db(x, min_level_db):
    min_level = np.exp(min_level_db / 20 * np.log(10))
    min_level = torch.ones_like(x) * min_level
    return 20 * torch.log10(torch.maximum(min_level, x))


def _normalize(S, max_abs_value, min_db):
    return torch.clamp(
        (2 * max_abs_value) * ((S - min_db) / (-min_db)) - max_abs_value,
        -max_abs_value,
        max_abs_value,
    )


class MelSpectrogramFeatures(nn.Module):
    def __init__(
        self,
        sample_rate=16000,
        n_fft=1024,
        win_size=640,
        hop_length=160,
        n_mels=80,
        fmin=0,
        fmax=8000,
        center=True,
    ):
        super().__init__()
        self.sample_rate = sample_rate
        self.n_fft = n_fft
        self.hop_length = hop_length
        self.n_mels = n_mels
        self.win_size = win_size
        self.fmin = fmin
        self.fmax = fmax
        self.center = center
        self.mel_basis = {}
        self.hann_window = {}

    def forward(self, y):
        y = y.float()
        dtype_device = str(y.dtype) + "_" + str(y.device)
        fmax_dtype_device = str(self.fmax) + "_" + dtype_device
        wnsize_dtype_device = str(self.win_size) + "_" + dtype_device
        if fmax_dtype_device not in self.mel_basis:
            mel = librosa_mel_fn(
                sr=self.sample_rate,
                n_fft=self.n_fft,
                n_mels=self.n_mels,
                fmin=self.fmin,
                fmax=self.fmax,
            )
            self.mel_basis[fmax_dtype_device] = torch.from_numpy(mel).to(dtype=y.dtype, device=y.device)
        if wnsize_dtype_device not in self.hann_window:
            self.hann_window[wnsize_dtype_device] = torch.hann_window(self.win_size).to(
                dtype=y.dtype, device=y.device
            )

        spec = torch.stft(
            y,
            self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_size,
            window=self.hann_window[wnsize_dtype_device],
            center=self.center,
            pad_mode="reflect",
            normalized=False,
            onesided=True,
            return_complex=True,
        )
        spec = torch.abs(spec).float()
        spec = torch.matmul(self.mel_basis[fmax_dtype_device], spec)
        spec = _amp_to_db(spec, -115) - 20
        spec = _normalize(spec, 1, -115)
        return spec


def _as_float32(wav: np.ndarray) -> np.ndarray:
    return np.asarray(wav, dtype=np.float32)


def _as_f32_tensor(t: torch.Tensor) -> torch.Tensor:
    if t.is_complex():
        return t.real.float()
    return t.float()


def _patch_sv_model_get_feat_f32(sv_model) -> None:
    """WavLM hidden states are float64; cast before InstanceNorm / conv layers."""
    import types

    import torch.nn.functional as F

    def _get_feat_f32(self, x):
        if self.update_extract:
            feats = self.feature_extract([sample for sample in x])
        else:
            with torch.no_grad():
                if self.feat_type in ("fbank", "mfcc"):
                    feats = self.feature_extract(x) + 1e-6
                else:
                    feats = self.feature_extract([sample for sample in x])

        if self.feat_type == "fbank":
            feats = feats.log()

        if self.feat_type not in ("fbank", "mfcc"):
            feats = feats[self.feature_selection]
            if isinstance(feats, (list, tuple)):
                feats = torch.stack(feats, dim=0)
            else:
                feats = feats.unsqueeze(0)
            norm_weights = (
                F.softmax(self.feature_weight, dim=-1)
                .unsqueeze(-1)
                .unsqueeze(-1)
                .unsqueeze(-1)
                .float()
            )
            feats = (norm_weights * feats.float()).sum(dim=0)
            feats = torch.transpose(feats, 1, 2).float() + 1e-6

        feats = _as_f32_tensor(feats)
        return self.instance_norm(feats)

    sv_model.get_feat = types.MethodType(_get_feat_f32, sv_model)


def extract_fbanks(wav: np.ndarray, sample_rate=16000, mel_bins=80, frame_length=25, frame_shift=12.5):
    wav = _as_float32(wav) * (1 << 15)
    wav_t = torch.from_numpy(wav).float().unsqueeze(0)
    fbanks = kaldi.fbank(
        wav_t,
        frame_length=frame_length,
        frame_shift=frame_shift,
        snip_edges=True,
        num_mel_bins=mel_bins,
        energy_floor=0.0,
        dither=0.0,
        sample_frequency=sample_rate,
    )
    return fbanks.unsqueeze(0).float()


class MeanVCRuntime:
    """Loads MeanVC once and converts source audio to a target speaker."""

    def __init__(self, device: str = "cuda"):
        import sys

        for path in (
            MEANVC_ROOT,
            os.path.join(MEANVC_ROOT, "src", "infer"),
        ):
            if path not in sys.path:
                sys.path.insert(0, path)

        from src.infer.dit_kvcache import DiT
        from src.model.utils import load_checkpoint
        from src.runtime.speaker_verification.verification import init_model as init_sv_model

        self.device = device
        config_path = os.path.join(MEANVC_ROOT, "src/config/config_200ms.json")
        ckpt_path = os.path.join(MEANVC_ROOT, "src/ckpt/model_200ms.safetensors")
        vocoder_path = os.path.join(MEANVC_ROOT, "src/ckpt/vocos.pt")
        asr_path = os.path.join(MEANVC_ROOT, "src/ckpt/fastu2++.pt")
        sv_path = os.path.join(
            MEANVC_ROOT, "src/runtime/speaker_verification/ckpt/wavlm_large_finetune.pth"
        )

        with open(config_path) as f:
            model_config = json.load(f)

        dit_model = DiT(**model_config["model"])
        dit_model = dit_model.to(device)
        dit_model = load_checkpoint(dit_model, ckpt_path, device=device, use_ema=False)
        dit_model = dit_model.float()
        dit_model.eval()

        self.model = dit_model
        # Reference MeanVC infer runs vocos on CPU; CUDA JIT decode can hit complex-dtype errors.
        self.vocos = torch.jit.load(vocoder_path).to("cpu")
        self.asr_model = torch.jit.load(asr_path).to(device)
        self.sv_model = init_sv_model("wavlm_large", sv_path).to(device).float()
        self.sv_model.eval()
        _patch_sv_model_get_feat_f32(self.sv_model)
        self.mel_extractor = MelSpectrogramFeatures(
            sample_rate=16000,
            n_fft=1024,
            win_size=640,
            hop_length=160,
            n_mels=80,
            fmin=0,
            fmax=8000,
            center=True,
        ).to(device)
        self.chunk_size = 20
        self.steps = 2

    def _extract_features(self, source_wav: np.ndarray, ref_wav: np.ndarray):
        device = self.device
        source_wav = _as_float32(source_wav)
        ref_wav = _as_float32(ref_wav)
        source_fbanks = extract_fbanks(source_wav, frame_shift=10).float().to(device)

        with torch.no_grad():
            offset = 0
            decoding_chunk_size = 5
            num_decoding_left_chunks = 2
            subsampling = 4
            context = 7
            stride = subsampling * decoding_chunk_size
            required_cache_size = decoding_chunk_size * num_decoding_left_chunks
            decoding_window = (decoding_chunk_size - 1) * subsampling + context
            att_cache = torch.zeros((0, 0, 0, 0), device=device)
            cnn_cache = torch.zeros((0, 0, 0, 0), device=device)
            bn_chunks = []

            for i in range(0, source_fbanks.shape[1], stride):
                fbank_chunk = source_fbanks[:, i : i + decoding_window, :].float()
                if fbank_chunk.shape[1] < required_cache_size:
                    pad_size = required_cache_size - fbank_chunk.shape[1]
                    fbank_chunk = torch.nn.functional.pad(
                        fbank_chunk, (0, 0, 0, pad_size), mode="constant", value=0.0
                    )
                encoder_output, att_cache, cnn_cache = self.asr_model.forward_encoder_chunk(
                    fbank_chunk, offset, required_cache_size, att_cache, cnn_cache
                )
                encoder_output = _as_f32_tensor(encoder_output)
                if att_cache.numel():
                    att_cache = _as_f32_tensor(att_cache)
                if cnn_cache.numel():
                    cnn_cache = _as_f32_tensor(cnn_cache)
                offset += encoder_output.size(1)
                bn_chunks.append(encoder_output)

            bn = torch.cat(bn_chunks, dim=1)
            bn = bn.transpose(1, 2)
            bn = torch.nn.functional.interpolate(
                bn, size=int(bn.shape[2] * 4), mode="linear", align_corners=True
            )
            bn = bn.transpose(1, 2)

            ref_tensor = torch.from_numpy(ref_wav).unsqueeze(0).to(device=device, dtype=torch.float32)
            spk_emb = _as_f32_tensor(self.sv_model(ref_tensor.float()))
            prompt_mel = _as_f32_tensor(self.mel_extractor(ref_tensor).transpose(1, 2))

        return _as_f32_tensor(bn), spk_emb, prompt_mel

    @torch.inference_mode()
    def _infer(self, bn, spk_emb, prompt_mel) -> torch.Tensor:
        device = self.device
        steps = self.steps
        chunk_size = self.chunk_size

        if steps == 1:
            timesteps = torch.tensor([1.0, 0.0], device=device, dtype=torch.float32)
        elif steps == 2:
            timesteps = torch.tensor([1.0, 0.8, 0.0], device=device, dtype=torch.float32)
        else:
            timesteps = torch.linspace(1.0, 0.0, steps + 1, device=device, dtype=torch.float32)

        seq_len = bn.shape[1]
        cache = None
        x_pred = []
        B = 1
        offset = 0
        kv_cache = None

        for start in range(0, seq_len, chunk_size):
            end = min(start + chunk_size, seq_len)
            bn_chunk = bn[:, start:end].float()
            x = torch.randn(B, bn_chunk.shape[1], 80, device=device, dtype=torch.float32)

            for i in range(steps):
                t = timesteps[i]
                r = timesteps[i + 1]
                t_tensor = torch.full((B,), t, device=x.device, dtype=torch.float32)
                r_tensor = torch.full((B,), r, device=x.device, dtype=torch.float32)
                if cache is not None:
                    cache = _as_f32_tensor(cache)
                u, tmp_kv_cache = self.model(
                    x,
                    t_tensor,
                    r_tensor,
                    cache=cache,
                    cond=bn_chunk,
                    spks=spk_emb,
                    prompts=prompt_mel,
                    offset=offset,
                    is_inference=True,
                    kv_cache=kv_cache,
                )
                u = _as_f32_tensor(u)
                x = (x - (t - r) * u).float()

            kv_cache = tmp_kv_cache
            offset += x.shape[1]
            cache = x.float()
            x_pred.append(x)

            if offset > 40 and kv_cache is not None and kv_cache[0][0].shape[2] > C_KV_CACHE_MAX_LEN:
                for i in range(len(kv_cache)):
                    new_k = kv_cache[i][0][:, :, -C_KV_CACHE_MAX_LEN:, :]
                    new_v = kv_cache[i][1][:, :, -C_KV_CACHE_MAX_LEN:, :]
                    kv_cache[i] = (new_k, new_v)

        x_pred = _as_f32_tensor(torch.cat(x_pred, dim=1))
        mel = _as_f32_tensor(x_pred.transpose(1, 2))
        mel = ((mel + 1) / 2).float().contiguous()
        return self._vocos_decode(mel)

    def _vocos_decode(self, mel: torch.Tensor) -> torch.Tensor:
        mel = _as_f32_tensor(mel).float().contiguous().cpu()
        wav = _as_f32_tensor(self.vocos.decode(mel))
        return wav.to(self.device)

    def convert_arrays(
        self,
        source_wav: np.ndarray,
        source_sr: int,
        ref_wav: np.ndarray,
        ref_sr: int,
    ) -> Tuple[np.ndarray, int]:
        """Convert mono source audio to target speaker timbre at 16 kHz."""
        source_wav = _as_float32(source_wav)
        ref_wav = _as_float32(ref_wav)
        source_16k = _as_float32(librosa.resample(source_wav, orig_sr=source_sr, target_sr=16000))
        ref_16k = _as_float32(librosa.resample(ref_wav, orig_sr=ref_sr, target_sr=16000))
        try:
            bn, spk_emb, prompt_mel = self._extract_features(source_16k, ref_16k)
        except Exception as exc:
            raise RuntimeError(f"extract_features: {exc}") from exc
        try:
            wav = self._infer(bn, spk_emb, prompt_mel)
        except Exception as exc:
            raise RuntimeError(f"infer: {exc}") from exc
        audio = _as_float32(wav.squeeze().cpu().numpy())
        return audio, 16000