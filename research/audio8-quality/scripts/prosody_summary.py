"""Average prosody metrics per variant -> markdown table.  python prosody_summary.py metrics.json gen.json"""
import json, sys
import numpy as np
m = json.load(open(sys.argv[1])); g = json.load(open(sys.argv[2]))
cols = ["breaths_per_min", "wer", "spk_sim", "f0_std_st", "f0_range_st", "wpm", "pauses_per_min", "pause_med_s", "pause_p90_s",
        "reset_join_abs_st", "reset_internal_abs_st"]
order = ["whole", "flat150", "natural", "natctx"]
print("| variant | n | " + " | ".join(cols) + " | audio s / GPU s |"); print("|" + "---|" * (len(cols) + 3))
for v in order:
    rows = [r for k, r in m.items() if k.startswith(v + "__")]
    if not rows: continue
    cells = []
    for c in cols:
        x = [r[c] for r in rows if r.get(c) is not None]
        cells.append(f"{np.mean(x):.3g}" if x else "-")
    t = [g["takes"][k]["audio_per_gpu_s"] for k in m if k.startswith(v + "__") and k in g["takes"]]
    print(f"| {v} | {len(rows)} | " + " | ".join(cells) + f" | {np.mean(t):.2f} |")
