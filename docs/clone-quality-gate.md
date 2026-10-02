# Echomancer clone reference quality gate (Oct 2026)

Fact-based pre-cloning gate for clone reference clips. Every threshold below is set from
**real Fish S2 output quality**, not from reference metrics alone.

## Method

- 21 references: 8 real speakers (LibriVox Golding/Klett, TED Brené/Cori/Levitin/Sinek/Treasure,
  the 1972 AP Kissinger clip) plus degraded copies of clean clips: white/brown noise at 5/10/20 dB
  (`n5/n10/n20`), music bed, reverb (`rev`), phone band 300-3400 Hz (`phone`), MP3 32 kbps, an 8 s
  cut (`short8`) and a two-speaker mix (Treasure + Brené).
- Each reference was cloned on Fish S2 and read the same 84-word paragraph. Each output was scored for:
  DNSMOS P.835 SIG / OVRL, **likeness** (Resemblyzer cosine of the output against the *clean*
  reference of that speaker, `sim_clean`), Whisper WER, squeaks/min, pitch spread.
- Noise floor: 5 speakers × 3 independent Fish takes of the same clone.
  Take-to-take range: **likeness ≤ 0.046, OVRL ≤ 0.25**. Anything inside that range is noise.
- Gate metrics come from the TypeScript implementation running on the Contabo worker
  (`worker_bench.txt`), not from the Python prototypes.

Raw data: `/workspace/qg/` (`refs/refmetrics.json`, `out/outscores.json`, `out2/scores.json`,
`rmout/*/outscores.json`, `ts_scores.json`, `takes/take_scores.json`, `worker_bench.txt`).

## Evidence table: reference metric (worker) vs Fish output

| reference | gate | SIG | HF dB | pitch st | pair | out SIG | out OVRL | likeness | Δ vs clean | WER |
|---|---|---|---|---|---|---|---|---|---|---|
| brene (clean) | pass | 3.68 | -23 | 3.53 | 0.75 | 3.65 | 3.19 | 0.857 | – | 1.2% |
| brene_music | pass | 2.36 | -23 | 3.68 | 0.85 | 3.67 | 3.12 | 0.842 | -0.015 | 0.0% |
| brene_n10 | pass | 3.60 | -23 | 3.57 | 0.86 | 3.68 | 3.39 | 0.844 | -0.013 | 1.2% |
| **brene_phone** | **fail bandlimited** | 3.55 | **-88** | 3.78 | 0.78 | 3.55 | 2.93 | 0.797 | **-0.060** | 1.2% |
| **brene_rev** | **fail echo** | **1.17** | -24 | 3.21 | 0.70 | **2.30** | **1.79** | 0.747 | **-0.110** | 6.0% |
| cori | pass | 3.58 | -17 | 3.02 | 0.84 | 3.58 | 3.32 | 0.902 | – | 1.2% |
| golding | pass | 3.55 | -19 | 3.16 | 0.85 | 3.52 | 3.27 | 0.968 | – | 1.2% |
| kissinger (1972) | pass + *flat note* | 3.53 | -21 | **1.33** | 0.92 | 3.54 | 3.26 | 0.823 | – | 2.4% (out pitch 1.11 st) |
| klett | pass | 3.72 | -13 | 2.96 | 0.86 | 3.71 | 3.46 | 0.891 | – | 0.0% |
| levitin | pass | 3.70 | -24 | 2.75 | 0.87 | 3.66 | 3.32 | 0.932 | – | 0.0% |
| sinek | pass | 3.67 | -36 | 2.96 | 0.85 | 3.46 | 3.06 | 0.866 | – | 0.0% |
| treasure (clean) | pass | 3.53 | -16 | 3.64 | 0.86 | 3.67 | 3.34 | 0.925 | – | 1.2% |
| treasure_mp3 | pass | 3.58 | -15 | 3.70 | 0.86 | 3.61 | 3.16 | 0.945 | +0.020 | 1.2% |
| treasure_music | pass | 2.85 | -19 | 3.58 | 0.87 | 3.64 | 3.28 | 0.928 | +0.003 | 2.4% |
| treasure_n5 | pass | 3.31 | -20 | 3.54 | 0.87 | 3.64 | 3.37 | 0.883 | -0.042 | 1.2% |
| treasure_n10 | pass | 3.51 | -20 | 3.66 | 0.89 | 3.61 | 3.29 | 0.933 | +0.008 | 1.2% |
| treasure_n20 | pass | 3.53 | -16 | 3.69 | 0.86 | 3.55 | 3.19 | 0.935 | +0.010 | 0.0% |
| **treasure_phone** | **fail bandlimited** | 3.26 | **-86** | 3.98 | 0.90 | 3.40 | 2.79 | 0.781 | **-0.144** | 1.2% |
| **treasure_rev** | **fail echo** | **1.52** | -15 | 2.95 | 0.83 | **2.18** | **1.67** | 0.791 | **-0.134** | 3.6% |
| treasure_short8 | pass | 3.57 | -16 | 3.91 | n/a | 3.64 | 3.27 | 0.882 | -0.043 | 0.0% |
| **two_speakers** | **fail two_speakers** | 3.60 | -18 | 4.60 | **0.43** | – | 3.33 | **0.563** to Treasure / 0.884 to Brené (Fish cloned only one voice) | | |

Take-to-take noise on the same clone: likeness range 0.007-0.046, OVRL range 0.10-0.25.

What hurt the clone (beyond noise): echo (OVRL -1.4/-1.7, likeness -0.11/-0.13, WER up),
phone band (likeness -0.06/-0.14, OVRL -0.26/-0.55), two voices (wrong speaker).
What did **not** hurt it (inside or at the edge of noise): noise 5-20 dB, music beds,
MP3 32k, an 8 s clip. Fish's own front end handles those.

## Thresholds per verdict

| verdict | rule (worker metric) | evidence / margin |
|---|---|---|
| **FAIL: echo** | DNSMOS SIG < **2.0** | echo refs 1.17 / 1.52; every other ref ≥ 2.36 (lowest music bed). Output OVRL 1.67-1.79 vs ≥ 2.79 elsewhere. |
| **FAIL: bandlimited** | speech energy 4-8 kHz vs 0.3-4 kHz < **-45 dB** (needs ≥ 4 s speech) | phone refs -86 / -88; lowest normal ref -36 (Sinek). Likeness -0.06 / -0.14. |
| **FAIL: two_speakers** | min Resemblyzer likeness between 4 s windows < **0.55** | two-speaker mix 0.43; lowest single-speaker ref 0.70 (brene_rev), clean refs 0.75-0.92. |
| **soft note: flat** (never blocks) | pitch spread < **2.0 st** (needs ≥ 4 s speech) | Kissinger 1.33 st (output 1.11 st); next lowest 2.75. It is his real voice; pitch stretching was tried and rejected, so it is only logged. |
| **PASS** | none of the above | includes noise, music beds, MP3, 8 s clips. |
| **BORDERLINE (silent auto-remaster)** | **none: no such tier** | see remaster verdict. No reference cloned better after remaster *and* close enough to clean to skip the warning. |

Fail-open: if the worker is unreachable, the models are missing, or the sample cannot be decoded,
the gate returns nothing and cloning proceeds exactly as before.

The old browser-side "Muffled or noisy" warning (energy_hz_95 < 4 kHz, speech/bg gap) is removed:
it fired on 17 of 20 test clips including clean LibriVox and TED (`refs/appgate.json`) and did not
predict a worse clone.

## Remaster verdict (measured on Fish output, not just on the reference)

Fish output with original vs remastered reference (DeepFilterNet 3 `dfn`, VoiceFixer `vf`,
Resemble Enhance denoise+enhance `re_enh_dn`):

| ref | remaster | ref SIG | out SIG | out OVRL | likeness (vs clean) | WER |
|---|---|---|---|---|---|---|
| brene_rev | dfn | 1.17→2.94 | 2.30→3.27 | **1.79→2.80** | 0.747→0.739 (-0.008) | 6.0%→1.2% |
| treasure_rev | dfn | 1.52→3.11 | 2.18→3.48 | **1.67→3.21** | 0.791→0.786 (-0.005) | 3.6%→4.8% |
| brene_rev | vf | 1.17→3.40 | 2.30→3.63 | 1.79→3.34 | 0.747→**0.680** (-0.07) | 6.0%→0.0% |
| treasure_rev | vf | 1.52→3.51 | 2.18→3.66 | 1.67→3.44 | 0.791→**0.666** (-0.13), squeaks 0→8.4/min | |
| brene_rev | re_enh_dn | 1.17→3.69 | 2.30→3.60 | 1.79→3.36 | 0.747→**0.545** (-0.20) | |
| treasure_rev | re_enh_dn | 1.52→3.54 | 2.18→3.68 | 1.67→3.47 | 0.791→**0.636** (-0.16) | |
| brene_music | dfn | 2.36→3.46 | 3.67→3.57 | 3.12→3.33 | 0.842→**0.753** (-0.09) | |
| treasure_n5 | dfn | 3.31→3.50 | 3.64→3.64 | 3.37→3.41 | 0.883→**0.802** (-0.08) | |
| treasure_phone | dfn | 3.26→3.05 | 3.40→3.20 | 2.79→2.93 | 0.781→**0.681** (-0.10), WER 1.2%→4.8% | |
| kissinger | dfn | 3.53→3.48 | 3.54→3.47 | 3.26→3.24 | 0.823→**0.775** (-0.05) (squeaks 8.5→0) | |

(VoiceFixer and Resemble Enhance cut likeness by 0.07-0.22 on every clip; they are out.)

**Verdict: keep remaster for echo only, with DeepFilterNet only, and only after "Continue anyway".**
- On echo it measurably improves the Fish output: OVRL +1.0 / +1.5 (6× the take-to-take noise),
  SIG +1.0 / +1.3, likeness unchanged (-0.005/-0.008, inside noise).
- It does **not** close the likeness gap: remastered-echo clones are still 0.12-0.14 below the
  same speaker's clean clone (similar to phone band, which fails). So echo clips still get the
  warning; the remaster is what the user gets if they continue anyway.
- On everything else (music, noise, phone, Kissinger) DFN cut likeness 0.05-0.10 → never applied.
- Keep rule on the worker: remastered SIG ≥ **2.5** and higher than the original (worker bench:
  1.17→2.97, 1.52→3.16 → both kept). Otherwise the original sample is cloned.
- Hence no silent BORDERLINE tier: every clip either cloned fine untouched (remaster only hurt) or
  stayed worse than clean even after the remaster.

## Latency / cost

Worker (Contabo, 6 vCPU, CPU only, onnxruntime-node 1.30, 2 DNSMOS windows, Resemblyzer ONNX):
- Every clone: **~1.2 s** added (median 1.16 s, range 0.93-1.38 s for 32 s clips; 0.52 s for 8 s;
  decode 0.16-0.38 s + measure 0.36-1.04 s) plus one HTTP hop Vercel→worker.
- Echo + "Continue anyway" only: **+8.3-8.7 s** for the DeepFilterNet pass and re-score.
- No API spend: all models local (DNSMOS 1.2 MB, speaker encoder 5.7 MB, deep-filter binary).
  Fish credit was unchanged across all test clones (1.484530 before/after each batch).
- Memory: models load once at worker boot; ~60 MB for deep-filter while it runs.

## UI

Monochrome, few words. On FAIL the clone stops before Fish is called (409 `SAMPLE_RISKY`, the
upload stays pending) and shows:

> This clip may not clone well. Try a cleaner clip. Echo on the voice.
> [Choose another clip]  [Continue anyway]

Issue lines: "Echo on the voice." / "Sounds like a phone line." / "More than one voice."
Continue anyway re-calls complete with `acceptQualityRisk: true` (no re-upload); echo clips get
the DeepFilterNet pass at that point. Same flow in the YouTube clip picker (`risky_audio`).
