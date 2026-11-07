"""Rebuild gen.json from modal_prosody stdout logs (+ optional takes/*.json) when a run was interrupted.
    python prosody_gen_from_log.py OUT.json LOG [LOG...]"""
import ast, json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from audio8q import prosody as P
CH = dict(whole=P.chunk_whole, flat150=P.chunk_flat150, natural=P.chunk_natural, natctx=P.chunk_natural)
g = dict(sr=44100, takes={}, timing={})
for log in sys.argv[2:]:
    for line in open(log):
        m = re.match(r"^(\w+)__(\w+)__s(\d+) (\{.*\})$", line.strip())
        if m:
            d = ast.literal_eval(m.group(4)); d["chunks"] = CH[m.group(1)](P.PASSAGES[m.group(2)])
            g["takes"][f"{m.group(1)}__{m.group(2)}__s{m.group(3)}"] = d
        m = re.match(r"^(whole_batched|natural_batched_2passages) (\{.*\})$", line.strip())
        if m:
            g["timing"][m.group(1)] = ast.literal_eval(m.group(2))
json.dump(g, open(sys.argv[1], "w"), indent=1)
print(len(g["takes"]), "takes", list(g["timing"]))
