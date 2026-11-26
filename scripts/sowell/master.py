"""Section mastering inside the Kokoro container.

The worker used to send every Kokoro take to a second app (`echomancer-cpu`)
for the podcast chain: one more cold start, idle tail and upload per book.
Now the request can carry ``master`` and the container answers with the
mastered MP3 next to the raw WAV.

The filter graphs are not re-implemented here. The worker builds them with
the same functions `src/lib/tts/section-master.ts` uses
(`src/lib/tts/kokoro-master.ts` → ``kokoroMasterRecipe``) and sends the
strings; this module only runs ffmpeg the way ``masterSectionBuffer`` does:

* ≥ ``shortSeconds``: loudnorm measure pass, then the same chain with the
  measured values and ``linear=true`` (the measure graph with its
  ``print_format=json`` loudnorm swapped for the linear one). A probe that
  does not parse uses the one-pass ``fallbackAf``.
* < ``shortSeconds``: the pre-loudnorm chain to float PCM, BS.1770
  integrated loudness (a port of ``integratedLufs`` in
  `clone-sample-prepare.ts`), one clamped gain and a true-peak limiter.

Output: mono MP3 at the recipe's rate and bitrate, no bit reservoir and no
Xing frame, so the book join can packet-copy it.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np

REQUIRED = (
    "measureAf",
    "loudnorm",
    "fallbackAf",
    "preAf",
    "targetI",
    "targetTp",
    "gainClampDb",
    "shortSeconds",
    "sampleRate",
    "bitrate",
)


class MasterError(RuntimeError):
    pass


def check_recipe(recipe: object) -> dict:
    if not isinstance(recipe, dict):
        raise MasterError("master recipe is not an object")
    missing = [k for k in REQUIRED if k not in recipe]
    if missing:
        raise MasterError("master recipe is missing " + ", ".join(missing))
    for key in ("measureAf", "loudnorm", "fallbackAf", "preAf", "bitrate"):
        value = recipe[key]
        if not isinstance(value, str) or not value or len(value) > 4000 or "\n" in value:
            raise MasterError(f"master recipe {key} is not a filter string")
    for key in ("targetI", "targetTp", "gainClampDb", "shortSeconds", "sampleRate"):
        if not isinstance(recipe[key], (int, float)) or not math.isfinite(recipe[key]):
            raise MasterError(f"master recipe {key} is not a number")
    if f"{recipe['loudnorm']}:print_format=json" not in recipe["measureAf"]:
        raise MasterError("master recipe measureAf does not print its loudnorm")
    return recipe


def js_number(value: float) -> str:
    """`${n}` in JavaScript for the values loudnorm prints (no exponents)."""
    if float(value).is_integer():
        return str(int(value))
    return repr(float(value))


def parse_loudnorm_probe(stderr: str) -> dict | None:
    """Same as ``parseLoudnormProbe``: the last {...} in stderr."""
    start, end = stderr.rfind("{"), stderr.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        raw = json.loads(stderr[start : end + 1])
        probe = {k: float(raw[k]) for k in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")}
    except (ValueError, KeyError, TypeError):
        return None
    if not all(math.isfinite(v) for v in probe.values()):
        return None
    return probe


def linear_af(recipe: dict, probe: dict) -> str:
    loudnorm = recipe["loudnorm"]
    linear = ":".join(
        [
            loudnorm,
            f"measured_I={js_number(probe['input_i'])}",
            f"measured_TP={js_number(probe['input_tp'])}",
            f"measured_LRA={js_number(probe['input_lra'])}",
            f"measured_thresh={js_number(probe['input_thresh'])}",
            f"offset={js_number(probe['target_offset'])}",
            "linear=true",
        ]
    )
    return recipe["measureAf"].replace(f"{loudnorm}:print_format=json", linear, 1)


def _biquad(x: np.ndarray, b0: float, b1: float, b2: float, a1: float, a2: float) -> np.ndarray:
    try:
        from scipy.signal import lfilter  # type: ignore

        return lfilter([b0, b1, b2], [1.0, a1, a2], x).astype(np.float32)
    except ImportError:
        out = np.empty_like(x, dtype=np.float32)
        x1 = x2 = y1 = y2 = 0.0
        for i, x0 in enumerate(x.tolist()):
            y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            out[i] = y0
            x2, x1, y2, y1 = x1, x0, y1, y0
        return out


def _k_weight(samples: np.ndarray, rate: int) -> np.ndarray:
    shelf_f, shelf_g, shelf_q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    k = math.tan(math.pi * shelf_f / rate)
    vh = 10 ** (shelf_g / 20)
    vb = vh**0.4996667741545416
    a0 = 1 + k / shelf_q + k * k
    shelved = _biquad(
        samples,
        (vh + vb * k / shelf_q + k * k) / a0,
        2 * (k * k - vh) / a0,
        (vh - vb * k / shelf_q + k * k) / a0,
        2 * (k * k - 1) / a0,
        (1 - k / shelf_q + k * k) / a0,
    )
    hp_f, hp_q = 38.13547087602444, 0.5003270373238773
    k = math.tan(math.pi * hp_f / rate)
    a0 = 1 + k / hp_q + k * k
    return _biquad(shelved, 1 / a0, -2 / a0, 1 / a0, 2 * (k * k - 1) / a0, (1 - k / hp_q + k * k) / a0)


def integrated_lufs(samples: np.ndarray, rate: int) -> float | None:
    """Port of ``integratedLufs``: 400 ms blocks, 100 ms hop, −70 / −10 gates."""
    if samples.size < rate * 0.4 or rate < 1000:
        return None
    weighted = _k_weight(samples.astype(np.float32), rate).astype(np.float64)
    block, hop = round(0.4 * rate), round(0.1 * rate)
    sq = np.concatenate([[0.0], np.cumsum(weighted * weighted)])
    starts = np.arange(0, weighted.size - block + 1, hop)
    if starts.size == 0:
        return None
    blocks = (sq[starts + block] - sq[starts]) / block
    above = blocks[blocks > 10 ** ((-70 + 0.691) / 10)]
    if above.size == 0:
        return None
    gated = above[above > above.mean() * 0.1]
    mean = (gated if gated.size else above).mean()
    if not mean > 0:
        return None
    return -0.691 + 10 * math.log10(mean)


def short_apply_af(gain_db: float, true_peak_db: float) -> str:
    """``shortSectionApplyAf``."""
    limit = 10 ** (true_peak_db / 20)
    return f"volume={gain_db:.3f}dB,alimiter=limit={limit:.5f}:level=false"


def _ffmpeg(args: list[str], timeout: float) -> subprocess.CompletedProcess:
    run = subprocess.run(
        [os.environ.get("FFMPEG_BIN", "ffmpeg"), "-hide_banner", "-y", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return run


def _checked(args: list[str], timeout: float) -> None:
    run = _ffmpeg(args, timeout)
    if run.returncode != 0:
        raise MasterError(f"ffmpeg exit {run.returncode}: {run.stderr[-400:]}")


def master_wav(wav: bytes, seconds: float, recipe: dict, timeout: float = 120.0) -> tuple[bytes, dict]:
    """Mastered MP3 bytes and a small report. Raises MasterError."""
    recipe = check_recipe(recipe)
    rate = str(int(recipe["sampleRate"]))
    with tempfile.TemporaryDirectory(prefix="kokoro-master-") as tmp:
        src, out = Path(tmp) / "in.wav", Path(tmp) / "out.mp3"
        src.write_bytes(wav)
        mp3 = ["-ar", rate, "-c:a", "libmp3lame", "-b:a", recipe["bitrate"], "-reservoir", "0", "-write_xing", "0", str(out)]
        if 0 < seconds < float(recipe["shortSeconds"]):
            pre = Path(tmp) / "pre.f32"
            _checked(["-i", str(src), "-ac", "1", "-af", recipe["preAf"], "-ar", rate, "-f", "f32le", str(pre)], timeout)
            measured = integrated_lufs(np.fromfile(pre, dtype="<f4"), int(recipe["sampleRate"]))
            if measured is None:
                plan, args = "short-onepass", ["-i", str(src), "-ac", "1", "-af", recipe["fallbackAf"], *mp3]
            else:
                clamp = float(recipe["gainClampDb"])
                gain = max(-clamp, min(clamp, float(recipe["targetI"]) - measured))
                plan = "short-gain"
                args = [
                    "-f", "f32le", "-ar", rate, "-ac", "1", "-i", str(pre),
                    "-af", short_apply_af(gain, float(recipe["targetTp"])), *mp3,
                ]
        else:
            probe_run = _ffmpeg(["-i", str(src), "-ac", "1", "-af", recipe["measureAf"], "-f", "null", "-"], timeout)
            probe = parse_loudnorm_probe(probe_run.stderr or "") if probe_run.returncode == 0 else None
            plan = "two-pass" if probe else "one-pass"
            af = linear_af(recipe, probe) if probe else recipe["fallbackAf"]
            args = ["-i", str(src), "-ac", "1", "-af", af, *mp3]
        _checked(args, timeout)
        data = out.read_bytes()
    if len(data) < 1000:
        raise MasterError("mastered audio is empty")
    return data, {"plan": plan}
