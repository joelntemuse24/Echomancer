"""Aggregate bake-off metrics -> metrics.json + table rows.  python summarize.py RESULTS_DIR VOL_DIR A8_PROSODY_DIR"""
import json, sys, glob, os
import numpy as np
R, V, A8 = sys.argv[1:4]
COST_HR = 1.10
out = {}
def agg(m, metrics, extras, takes, conc):
    keys = sorted(metrics)
    f = lambda k: round(float(np.mean([metrics[x][k] for x in keys])), 3)
    row = dict(n=len(keys), breaths_per_min=f("breaths_per_min"), wer_mean=f("wer"),
               wer_by_take={x: metrics[x]["wer"] for x in keys}, spk_sim=f("spk_sim"),
               f0_std_st=f("f0_std_st"), f0_range_st=f("f0_range_st"), wpm=f("wpm"), pause_med_s=f("pause_med_s"))
    if extras:
        row.update(asr_fillers=sum(extras[x]["asr_fillers"] for x in keys),
                   gap_voiced_bursts=sum(extras[x]["gap_voiced_bursts"] for x in keys),
                   chunks=sum(extras[x]["n_chunks"] for x in keys),
                   tails_over_150ms=sum(extras[x]["tails_over_150ms"] for x in keys),
                   tail_max_s=max(extras[x]["tail_max_s"] for x in keys))
    if takes:
        a = sum(t["audio_s"] for t in takes.values()); g = sum(t["gpu_s"] for t in takes.values())
        row.update(audio_s_per_gpu_s=round(a / g, 2), usd_per_audio_hr_bs1=round(COST_HR / (a / g), 2),
                   peak_vram_gb=max(t["peak_vram_gb"] for t in takes.values()), gpu=list(takes.values())[0]["gpu"])
    if conc: row["concurrency_probe"] = conc
    return row
for m in ("ming", "chatterbox", "indextts"):
    met = json.load(open(f"{R}/eval_{m}/metrics.json")); ex = json.load(open(f"{R}/eval_{m}/extras.json"))
    tk = {os.path.basename(p)[:-5]: json.load(open(p)) for p in glob.glob(f"{V}/takes/{m}__*__s*.json")}
    cp = f"{V}/takes/{m}__concurrency.json"
    out[m] = agg(m, met, ex, tk, json.load(open(cp)) if os.path.exists(cp) else None)
a8 = {k: v for k, v in json.load(open(f"{A8}/metrics.json")).items() if k.startswith("natural__")}
ex8 = f"{R}/extras_audio8.json"
out["audio8_air_natural"] = agg("audio8", a8, json.load(open(ex8)) if os.path.exists(ex8) else None, None, None)
out["audio8_air_natural"].update(audio_s_per_gpu_s=3.24, note="batched bs 8-13 (prosody run); bs=1 0.74")
json.dump(out, open(f"{R}/metrics.json", "w"), indent=1)
for m, r in out.items():
    print(m, {k: v for k, v in r.items() if k not in ("wer_by_take", "concurrency_probe")})
