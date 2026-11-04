"""The actual experiment bodies, with no Modal dependency.

Every `modal_*.py` script in this folder is a thin wrapper: it builds an image,
then calls one function here. That split exists so the whole experiment can be
executed on a laptop CPU against a 2-line passage before a single GPU second is
billed -- which is how these jobs were debugged.

Each `run_*` function takes a loaded `(processor, model)` and a plain dict of
options, writes audio and JSON under `out_dir`, and returns a JSON-serialisable
metrics dict. Nothing here imports `modal`.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import numpy as np


# --------------------------------------------------------------------- helpers


def _torch():
    import torch

    return torch


def load_ref_codes(model, processor, ref_dir, entry, sample_rate: int):
    """Encode one reference clip to codes, exactly as the model card does."""
    import librosa
    import soundfile as sf

    audio, rate = sf.read(str(Path(ref_dir) / entry["wav"]), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if rate != sample_rate:
        audio = librosa.resample(audio, orig_sr=rate, target_sr=sample_rate)
    enc = processor(
        text=["x"],
        reference_audio=[np.asarray(audio, dtype=np.float32)],
        sampling_rate=[sample_rate],
        reference_text=[entry["text"]],
        return_tensors="pt",
    )
    device = next(model.parameters()).device
    codes, lengths = model.encode_audio(
        enc["reference_audio_values"].to(device), enc["reference_audio_lengths"].to(device)
    )
    return codes[0, :, : int(lengths[0])].cpu()


def generate(model, processor, text, ref_codes, ref_text, sampling: dict, hook=None):
    """One generation. Returns (audio float32 numpy, codes [10,T], seconds).

    `hook` is an object with `attach(model)` returning a removable handle, used
    for activation steering and for capturing the LM head's input.
    """
    torch = _torch()
    torch.manual_seed(int(sampling.get("seed", 1234)))
    device = next(model.parameters()).device
    inputs = processor(text=[text], reference_codes=[ref_codes], reference_text=[ref_text], return_tensors="pt")
    inputs = {k: v.to(device) for k, v in inputs.items()}
    handle = hook.attach(model) if hook is not None else None
    started = time.time()
    try:
        with torch.inference_mode():
            out = model.generate(
                **inputs,
                max_new_tokens=int(sampling.get("max_new_tokens", 1024)),
                temperature=float(sampling.get("temperature", 0.8)),
                top_p=float(sampling.get("top_p", 0.8)),
                top_k=int(sampling.get("top_k", 30)),
                do_sample=True,
                return_dict_in_generate=True,
            )
            waveform, lengths = model.decode_audio(out.codes)
        if torch.cuda.is_available():
            torch.cuda.synchronize()
    finally:
        if handle is not None:
            handle.remove()
    audio = waveform[0, : int(lengths[0])].float().cpu().numpy()
    return audio, out.codes[0].cpu().numpy(), round(time.time() - started, 2)


def save_wav(path, audio, sample_rate: int) -> str:
    import soundfile as sf

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.asarray(audio, dtype=np.float32), sample_rate, subtype="PCM_16")
    return str(path)


def write_json(path, payload) -> str:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=1, default=_json_default)
    return str(path)


def _json_default(obj):
    if isinstance(obj, np.generic):
        return obj.item()
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    raise TypeError(f"not serialisable: {type(obj)}")


def take_metrics(audio, sample_rate: int) -> dict:
    """Acoustic metrics for one take, no ASR.

    Besides the rates, the *absolute counts* are returned. A per-minute rate is
    noisy on a 12 s take (a single burst swings it by tens of ticks per minute
    when there is only 2 s of pause), so the acceptance decision uses the count
    per take and the rate is reported for context and for comparison with the
    earlier trial's 13-31 ticks per pause-minute.
    """
    from .probes import (
        detect_breaths,
        detect_ticks,
        hf_burst_frames,
        quiet_hf_crest_db,
        speech_band_balance,
    )

    breaths = detect_breaths(audio)
    ticks = detect_ticks(audio)
    return dict(
        audio_s=round(float(len(audio)) / sample_rate, 2),
        breath_candidates=breaths.total,
        breath_audible=breaths.audible,
        breath_loud=breaths.loud,
        pause_ah=breaths.pause_ah,
        pre_sentence_inhale=breaths.inhales,
        breath_kinds=breaths.as_dict()["kind_counts"],
        ticks=ticks.ticks,
        ticks_per_pause_minute=ticks.ticks_per_pause_minute,
        quiet_hf_crest_db=round(quiet_hf_crest_db(audio), 1),
        **hf_burst_frames(audio),
        **speech_band_balance(audio),
    )


def aggregate(rows: list[dict], key: str = "variant") -> dict:
    """Mean of every numeric metric, grouped by `key`."""
    out: dict[str, dict] = {}
    for row in rows:
        bucket = out.setdefault(str(row[key]), {})
        bucket.setdefault("n", 0)
        bucket["n"] += 1
        for name, value in row.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                bucket[name] = bucket.get(name, 0.0) + float(value)
    for bucket in out.values():
        n = max(1, bucket["n"])
        for name in list(bucket):
            if name != "n":
                bucket[name] = round(bucket[name] / n, 3)
    return out


# ------------------------------------------------------------------- baseline


def run_baseline(
    model,
    processor,
    *,
    refs: dict,
    ref_dir: str,
    texts: dict,
    out_dir: str,
    seeds: list[int] | None = None,
    sampling: dict | None = None,
    limit_texts: int | None = None,
) -> dict:
    """Characterise the unmodified model: per-text metrics, frame labels, and
    the codec causality test that says where the ticks come from.
    """
    from . import codec_tools as CT
    from . import steering

    seeds = seeds or [1234]
    base_sampling = dict(sampling or {})
    sample_rate = int(model.config.codec_sample_rate)
    out = Path(out_dir)
    rows: list[dict] = []
    label_counts: dict[str, dict] = {}
    text_ids = sorted(texts)[: limit_texts or len(texts)]

    for ref_name, entry in refs.items():
        ref_codes = load_ref_codes(model, processor, ref_dir, entry, sample_rate)
        for text_id in text_ids:
            for seed in seeds:
                audio, codes, gen_s = generate(
                    model, processor, texts[text_id], ref_codes, entry["text"], {**base_sampling, "seed": seed}
                )
                name = f"base__{text_id}__s{seed}__{ref_name}"
                wav = save_wav(out / "wav" / f"{name}.wav", audio, sample_rate)
                labels = steering.label_frames(audio)
                label_counts[name] = labels.counts()
                rows.append(
                    dict(
                        variant="base",
                        text_id=text_id,
                        ref=ref_name,
                        seed=seed,
                        wav=wav,
                        frames=int(codes.shape[1]),
                        gen_s=gen_s,
                        **take_metrics(audio, sample_rate),
                    )
                )
                write_json(out / "metrics_partial.json", dict(rows=rows, labels=label_counts))

    # ---- codec causality: is the decoder at fault, or the latent it is given?
    ctx = CT.codec_context(model)
    causality: dict[str, dict] = {}
    first = rows[0]
    import soundfile as sf

    audio0, _ = sf.read(first["wav"], dtype="float32")
    codes0 = None
    for ref_name, entry in refs.items():
        ref_codes = load_ref_codes(model, processor, ref_dir, entry, sample_rate)
        audio, codes, _ = generate(model, processor, texts[text_ids[0]], ref_codes, entry["text"], {"seed": seeds[0]})
        runs = CT.pause_runs(codes, audio)
        pause = codes[:, runs[0]] if runs else codes[:, 5:15]
        causality[ref_name] = CT.causality_report(ctx, pause)
        causality[ref_name]["pause_runs"] = [(int(r.start), int(r.stop)) for r in runs]
        causality[ref_name]["silence_substitution"] = CT.speech_frame_hf_delta(ctx, codes, audio)

    metrics = dict(
        kind="baseline",
        sample_rate=sample_rate,
        seeds=seeds,
        gpu=_gpu_name(),
        sampling=base_sampling,
        rows=rows,
        by_text=aggregate(rows, "text_id"),
        overall=aggregate(rows, "variant"),
        frame_labels=label_counts,
        codec_causality=causality,
    )
    write_json(out / "metrics.json", metrics)
    return metrics


def _gpu_name() -> str:
    torch = _torch()
    if torch.cuda.is_available():
        return torch.cuda.get_device_name(0)
    return "cpu"


# --------------------------------------------------------------------- steering


def run_steer(
    model,
    processor,
    *,
    refs: dict,
    ref_dir: str,
    texts: dict,
    calibration_text: str,
    out_dir: str,
    alphas: list[float] | None = None,
    seeds: list[int] | None = None,
    calibration_seeds: list[int] | None = None,
    sampling: dict | None = None,
    limit_texts: int | None = None,
) -> dict:
    """Learn the breath direction from contrast frames, then sweep steering."""
    from . import steering

    torch = _torch()
    alphas = alphas if alphas is not None else [0.0, 0.5, 1.0, 1.5, 2.5]
    seeds = seeds or [1234]
    calibration_seeds = calibration_seeds or [1234]
    base_sampling = dict(sampling or {})
    sample_rate = int(model.config.codec_sample_rate)
    out = Path(out_dir)

    # ---- calibration: capture the LM head's input, label from the audio
    hidden_rows, label_rows = [], []
    calibration: list[dict] = []
    for ref_name, entry in refs.items():
        ref_codes = load_ref_codes(model, processor, ref_dir, entry, sample_rate)
        for seed in calibration_seeds:
            audio, codes, hidden = steering.capture_lm_head_input(
                model, calibration_text, processor, ref_codes, entry["text"], {**base_sampling, "seed": seed}
            )
            labels = steering.label_frames(audio)
            n = min(len(labels.labels), hidden.shape[0], codes.shape[1])
            hidden_rows.append(hidden[:n])
            label_rows.append(labels.labels[:n])
            calibration.append(
                dict(ref=ref_name, seed=seed, frames=int(n), counts=labels.counts(),
                     wav=save_wav(out / "calibration" / f"calib__{ref_name}__s{seed}.wav", audio, sample_rate))
            )
    hidden = np.concatenate(hidden_rows)
    labels = np.concatenate(label_rows)
    direction, direction_stats = steering.contrast_direction(hidden, labels)
    np.save(out / "breath_direction.npy", direction)
    write_json(out / "breath_direction.json", dict(stats=direction_stats, counts=dict(zip(*np.unique(labels, return_counts=True))), calibration=calibration))

    # ---- sweep
    rows: list[dict] = []
    text_ids = sorted(texts)[: limit_texts or len(texts)]
    peak_mb = 0.0
    for ref_name, entry in refs.items():
        ref_codes = load_ref_codes(model, processor, ref_dir, entry, sample_rate)
        for text_id in text_ids:
            for seed in seeds:
                for alpha in alphas:
                    variant = "base" if alpha == 0.0 else f"clamp{alpha:g}"
                    hook = None
                    if alpha > 0.0:
                        hook = steering.SteeringHook(
                            direction, alpha=alpha, mode="clamp", threshold=direction_stats["threshold"]
                        )
                    audio, codes, gen_s = generate(
                        model, processor, texts[text_id], ref_codes, entry["text"],
                        {**base_sampling, "seed": seed}, hook=hook,
                    )
                    name = f"{variant}__{text_id}__s{seed}__{ref_name}"
                    wav = save_wav(out / "wav" / f"{name}.wav", audio, sample_rate)
                    rows.append(
                        dict(
                            variant=variant, alpha=alpha, text_id=text_id, ref=ref_name, seed=seed,
                            wav=wav, frames=int(codes.shape[1]), gen_s=gen_s,
                            hook_proj=(hook.summary() if hook else None),
                            **take_metrics(audio, sample_rate),
                        )
                    )
                    if torch.cuda.is_available():
                        peak_mb = max(peak_mb, torch.cuda.max_memory_allocated() / 2**20)
                    write_json(out / "metrics_partial.json", dict(rows=rows))

    metrics = dict(
        kind="steer",
        sample_rate=sample_rate,
        alphas=alphas,
        seeds=seeds,
        gpu=_gpu_name(),
        peak_gpu_mb=round(peak_mb, 1),
        direction=direction_stats,
        calibration=calibration,
        rows=rows,
        by_variant=aggregate(rows, "variant"),
        by_alpha_text=aggregate(rows, "alpha"),
    )
    write_json(out / "metrics.json", metrics)
    return metrics


# ----------------------------------------------------------------------- codec


def run_codec(
    model,
    processor,
    *,
    refs: dict,
    ref_dir: str,
    texts: dict,
    out_dir: str,
    seeds: list[int] | None = None,
    sampling: dict | None = None,
    decoder_steps: int = 0,
    decoder_lr: float = 2e-4,
    limit_texts: int | None = None,
) -> dict:
    """Decide the codec question on real audio, then optionally fine-tune the
    decoder against the substitution target.

    Three things are measured on identical codes:
      decode_dtype        fp32 vs bf16 -- rules out a precision cause
      decode_windowed8    one long decode vs 8-frame slices -- rules out drift
      pause_substitution  quiet latents swapped for encoder-silence latents,
                          reporting how far the edit leaks into speech frames

    `speech_frame_hf_delta` is reported per take because the codec's post module
    is a causal window transformer: a pause edit is never perfectly local, and
    the leak decides whether a decode-side patch is shippable at all.
    """
    import soundfile as sf

    from . import codec_tools as CT

    seeds = seeds or [1234]
    base_sampling = dict(sampling or {})
    sample_rate = int(model.config.codec_sample_rate)
    out = Path(out_dir)
    rows: list[dict] = []

    generated: list[tuple[str, np.ndarray, np.ndarray]] = []
    for ref_name, entry in refs.items():
        ref_codes = load_ref_codes(model, processor, ref_dir, entry, sample_rate)
        for text_id in sorted(texts)[: limit_texts or len(texts)]:
            audio, codes, _ = generate(
                model, processor, texts[text_id], ref_codes, entry["text"], {**base_sampling, "seed": seeds[0]}
            )
            tag = f"{text_id}__{ref_name}"
            save_wav(out / "wav" / f"gen__{tag}.wav", audio, sample_rate)
            generated.append((tag, audio, codes))

    ctx = CT.codec_context(model)
    leak: dict[str, dict] = {}
    for tag, audio, codes in generated:
        rows.append(dict(tag=tag, setting="as_generated", **take_metrics(audio, sample_rate)))

        # decode the same codes under each setting, comparing quiet-frame HF
        for setting, audio_var in _decode_variants(model, ctx, codes):
            save_wav(out / "wav" / f"{setting}__{tag}.wav", audio_var, sample_rate)
            rows.append(dict(tag=tag, setting=setting, **take_metrics(audio_var, sample_rate)))

        substituted, sub_stats = CT.replace_pause_frames(ctx, codes, audio)
        save_wav(out / "wav" / f"pause_sub__{tag}.wav", substituted, sample_rate)
        rows.append(dict(tag=tag, setting="pause_substitution", **take_metrics(substituted, sample_rate), **sub_stats))
        leak[tag] = CT.speech_frame_hf_delta(ctx, codes, audio)

    fine_tune = None
    if decoder_steps > 0:
        pairs = CT.repair_pairs(ctx, [(codes, audio) for _, audio, codes in generated])
        fine_tune = train_decoder(
            model, ctx.codec, pairs,
            out_dir=str(out / "decoder"), steps=decoder_steps, lr=decoder_lr, sample_rate=sample_rate,
        )
        # score the fine-tuned decoder on the same takes
        for tag, audio, codes in generated:
            repaired = ctx.decode(codes)
            save_wav(out / "wav" / f"decoder_tuned__{tag}.wav", repaired, sample_rate)
            rows.append(dict(tag=tag, setting="decoder_tuned", **take_metrics(repaired, sample_rate)))

    metrics = dict(
        kind="codec",
        sample_rate=sample_rate,
        gpu=_gpu_name(),
        rows=rows,
        by_setting=aggregate(rows, "setting"),
        substitution_leak=leak,
        decoder_fine_tune=fine_tune,
    )
    write_json(out / "metrics.json", metrics)
    return metrics


def _decode_variants(model, ctx, codes):
    """Same latents, three decode paths. Yields (setting, audio).

    * `decode_fp32` / `decode_bf16`: precision only. If these differ, the tick is
      a rounding artefact and the fix is a dtype change, not a weight change.
    * `decode_windowed8`: the codec's post module is a causal window transformer
      with a 128-frame window, so decoding in 8-frame slices changes what each
      frame can attend to. If the artifact moves with the window boundary the
      cause is context, not the latent.
    """
    from . import codec_tools as CT

    torch = _torch()
    out = []
    for dtype_name in ("float32", "bfloat16"):
        dtype = getattr(torch, dtype_name)
        if dtype == torch.bfloat16 and not torch.cuda.is_available():
            continue  # bf16 decode on CPU is not representative; skip locally
        codec = CT.fresh_codec(model, device=ctx.device, dtype=dtype)
        out.append((f"decode_{dtype_name}", CT.CodecContext(codec=codec).decode(codes)))
    windowed = [ctx.decode(codes[:, start: start + 8]) for start in range(0, codes.shape[1], 8)]
    out.append(("decode_windowed8", np.concatenate(windowed) if windowed else np.zeros(0, dtype=np.float32)))
    return out


def train_decoder(model, codec, pairs, *, out_dir, steps, lr, sample_rate):
    """Short decoder fine-tune against the substitution target.

    Why this shape of loss: an earlier draft trained on "reconstruct the clip,
    plus penalise HF energy in quiet frames". Both terms are weak. The decoder
    already reconstructs the clip, so the first term has no gradient left, and
    the penalty punishes the decoder for content the *latents* asked for - it can
    only learn to mute, which is the same whack-a-mole as a gate.

    `codec_tools.repair_pairs` gives a better-posed target instead: the same
    latents decoded twice, as the model wrote them and with the pause runs
    replaced. The decoder learns a mapping rather than an inhibition. Only the
    decoder and the post module are trained; the encoder and quantizer stay
    frozen, so the latents for real speech keep their meaning.

    `CodecContext.decode_trainable` is used rather than `codec.decode`, because
    the latter is decorated with `@torch.inference_mode()` and therefore has no
    graph to backprop through.
    """
    import torch
    import torch.nn.functional as F

    from .codec_tools import CodecContext

    if not pairs:
        return dict(steps=0, skipped="no pause runs found in any take")

    for p in codec.parameters():
        p.requires_grad_(False)
    trainable = []
    for module in (codec.decoder, codec.quantizer.post_module):
        for p in module.parameters():
            p.requires_grad_(True)
            trainable.append(p)
    optimiser = torch.optim.AdamW(trainable, lr=lr)
    device = next(codec.parameters()).device
    graph = CodecContext(codec=codec)

    history = []
    for step in range(steps):
        pair = pairs[step % len(pairs)]
        codes = pair["codes"].unsqueeze(0).to(device)
        target = pair["as_intended"].to(device)
        optimiser.zero_grad(set_to_none=True)
        predicted = graph.decode_trainable(codes)[0, 0].float()
        n = min(predicted.numel(), target.numel())
        if n == 0:
            continue
        loss = F.l1_loss(predicted[:n], target[:n].float())
        loss.backward()
        torch.nn.utils.clip_grad_norm_(trainable, 1.0)
        optimiser.step()
        if step % 10 == 0 or step == steps - 1:
            history.append(dict(step=step, l1=round(float(loss.detach()), 5)))
            print(json.dumps(history[-1]), flush=True)

    Path(out_dir).mkdir(parents=True, exist_ok=True)
    torch.save(
        {"decoder": codec.decoder.state_dict(), "post_module": codec.quantizer.post_module.state_dict()},
        str(Path(out_dir) / "decoder_lite.pt"),
    )
    return dict(steps=steps, lr=lr, trainable=sum(p.numel() for p in trainable),
                pairs=len(pairs), history=history[-8:])


# ------------------------------------------------------------------------- LoRA


def run_lora(
    model,
    processor,
    *,
    dataset_dir: str,
    texts: dict,
    refs: dict,
    ref_dir: str,
    out_dir: str,
    rank: int = 16,
    alpha: float = 32.0,
    steps: int = 400,
    batch_size: int = 1,
    lr: float = 1e-4,
    max_frames: int = 600,
    eval_seeds: list[int] | None = None,
    sampling: dict | None = None,
    limit_texts: int | None = None,
) -> dict:
    """LoRA-train the slow AR on the breath-free corpus, then evaluate it."""
    import torch

    from . import steering, train_lora as TL

    torch = _torch()
    sample_rate = int(model.config.codec_sample_rate)
    out = Path(out_dir)
    manifest = json.loads((Path(dataset_dir) / "manifest.json").read_text(encoding="utf-8"))
    clips = manifest["clips"]
    if not clips:
        raise RuntimeError("empty dataset: run modal_prep first")

    info = TL.inject_lora(model, rank=rank, alpha=alpha)
    device = next(model.parameters()).device
    from . import codec_tools as CT

    codec = CT.fresh_codec(model, device=device, dtype=torch.float32)
    # any earlier generate() in this process left KV caches on the attention
    # layers, which makes a training forward pass raise
    TL.detach_generation_caches(model)
    ref_entry = next(iter(refs.values()))
    train_ref_codes = load_ref_codes(model, processor, ref_dir, ref_entry, sample_rate)
    params = TL.trainable_parameters(model)
    optimiser = torch.optim.AdamW(params, lr=lr)
    history = []
    rng = np.random.default_rng(0)
    model.train()
    for step in range(steps):
        clip = clips[int(rng.integers(0, len(clips)))]
        audio, _ = _read_wav(str(Path(dataset_dir) / Path(clip["wav"]).name))
        with torch.inference_mode():
            codes, lengths = codec.encode(torch.from_numpy(audio)[None, None].to(device))
        target = codes[0, :, : min(int(lengths[0]), max_frames)].cpu().numpy()
        example = TL.build_example(model, processor, target, clip["text"], train_ref_codes, ref_entry["text"])
        optimiser.zero_grad(set_to_none=True)
        loss = TL.semantic_loss(model, example)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(params, 1.0)
        optimiser.step()
        if step % 25 == 0 or step == steps - 1:
            history.append(dict(step=step, loss=round(float(loss.detach()), 4)))
            print(json.dumps(history[-1]), flush=True)

    out.mkdir(parents=True, exist_ok=True)
    torch.save(TL.lora_state_dict(model), str(out / "lora_state.pt"))
    model.eval()

    # evaluate the adapter in place against the same texts
    eval_seeds = eval_seeds or [1234]
    rows = []
    text_ids = sorted(texts)[: limit_texts or len(texts)]
    for ref_name, entry in refs.items():
        ref_codes = load_ref_codes(model, processor, ref_dir, entry, sample_rate)
        for text_id in text_ids:
            for seed in eval_seeds:
                audio, codes, gen_s = generate(
                    model, processor, texts[text_id], ref_codes, entry["text"], {**(sampling or {}), "seed": seed}
                )
                name = f"lora__{text_id}__s{seed}__{ref_name}"
                wav = save_wav(out / "wav" / f"{name}.wav", audio, sample_rate)
                rows.append(dict(variant="lora", text_id=text_id, ref=ref_name, seed=seed, wav=wav,
                                 frames=int(codes.shape[1]), gen_s=gen_s, **take_metrics(audio, sample_rate)))
                write_json(out / "metrics_partial.json", rows)

    metrics = dict(
        kind="lora", gpu=_gpu_name(), lora=info, steps=steps, lr=lr, rank=rank, alpha=alpha,
        dataset=dict(clips=len(clips), speakers=len(manifest.get("speakers", [])),
                     total_seconds=manifest.get("total_seconds"), breaths_removed=manifest.get("breaths_removed")),
        history=history[-20:], rows=rows, overall=aggregate(rows, "variant"),
    )
    write_json(out / "metrics.json", metrics)
    return metrics


def _read_wav(path: str):
    import soundfile as sf

    audio, rate = sf.read(path, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return np.asarray(audio, dtype=np.float32), rate


# -------------------------------------------------------------------- eval


def run_eval(
    *,
    wav_roots: list[str],
    texts: dict,
    ref_dir: str,
    out_dir: str,
    reference_wav: dict[str, str] | None = None,
    whisper: str = "small.en",
    use_words: bool = True,
    limit: int | None = None,
) -> dict:
    """Score wavs written by any job: acoustic metrics, WER, speaker similarity.

    Filenames follow `{variant}__{text_id}__s{seed}__{ref}.wav`, which is what
    every job in this folder writes, so no index file is needed.
    """
    from . import evalharness as EH

    out = Path(out_dir)
    speaker = EH.SpeakerScorer()
    takes = []
    seen = 0
    for root in wav_roots:
        for path in sorted(Path(root).glob("*.wav")):
            stem = path.stem
            parts = stem.split("__")
            if len(parts) < 3:
                continue
            variant, text_id, seed_part = parts[0], parts[1], parts[2]
            ref_name = parts[3] if len(parts) > 3 else ""
            if text_id not in texts:
                continue
            if limit and seen >= limit:
                break
            take = EH.evaluate_take(
                str(path),
                reference_text=texts[text_id],
                reference_wav=(reference_wav or {}).get(ref_name),
                speaker=speaker if reference_wav else None,
                whisper=whisper,
                name=stem,
                text_id=text_id,
                seed=int(seed_part[1:]) if seed_part[1:].isdigit() else 0,
                variant=variant,
                use_words=use_words,
            )
            takes.append(take)
            seen += 1
            EH.write_json(out / "takes_partial.json", takes)

    by_variant: dict[str, list] = {}
    by_variant_ref: dict[str, list] = {}
    for take in takes:
        by_variant.setdefault(take.variant, []).append(take)
        by_variant_ref.setdefault(f"{take.variant}|{take.extra.get('ref', '')}", []).append(take)

    metrics = dict(
        kind="eval",
        whisper=whisper,
        takes=len(takes),
        by_variant={k: EH.summarise(v) for k, v in by_variant.items()},
        rows=[_take_dict(t) for t in takes],
        comparisons=_comparisons(by_variant),
    )
    EH.write_json(out / "metrics.json", metrics)
    return metrics


def _comparisons(by_variant: dict) -> dict:
    from . import evalharness as EH

    baseline = by_variant.get("base")
    if not baseline:
        return {}
    return {variant: EH.compare(baseline, takes) for variant, takes in by_variant.items() if variant != "base"}


def _take_dict(take) -> dict:
    from dataclasses import asdict as _asdict

    payload = _asdict(take)
    payload.pop("extra", None)
    return payload
