# British male narrator: George and the shortlist

Joel, 2026-11-07: *"wire in George Kokoro as our British male voice and get rid
of Ryen? Also if you're able to find a voice that's British, around Kokoro, that
is even better than Brian, that's good. I want it to be a deep but kind of grand
British voice … almost like David Attenborough"*.

George is implemented and is the default. This note records the evidence behind
that choice and the alternatives, and separates what was **measured** from what
was **not**.

---

## "Brian" could not be resolved

There is no `Brian` anywhere in this repository — no catalog entry, provider
voice id, alias, or doc mention (checked across `.ts`, `.tsx`, `.json`, `.md`,
`.py`, `.example`). The only British male voices it has ever shipped are
`en-GB-RyanNeural` (Edge) and the Google voices `en-GB-Neural2-B` / `-O` that
were retired under the Randolph label.

So "better than Brian" is read as a comparison to a voice this product does not
ship, and **no substitution was made on the strength of it**. If Brian is an
external reference (an ElevenLabs or Azure voice, say), it has not been
identified here and George remains the default pending an explicit pick.

Also note the screenshot's grading ("Male British English Grade C") is the
**site's opinion**, not a measurement. Nothing below treats it as quality
evidence.

---

## What George is, exactly

| | |
|--|--|
| Catalog id | `george` |
| Display name | George |
| Provider voice | `bm_george` |
| Model | `hexgrad/kokoro-82m` |
| Route | OpenRouter `POST /api/v1/audio/speech` |
| Locale | `en-GB`, accent British, male |
| Per-request ceiling | 800 characters |
| Output | 24 kHz mono |
| License | Apache-2.0 ([HF model card](https://huggingface.co/hexgrad/Kokoro-82M)) |
| Pricing | $0.62 per 1M prompt tokens on OpenRouter (list price at time of check) |

The OpenRouter adapter passes `voiceId` straight through as `voice`, so the wire
request is literally:

```json
{ "model": "hexgrad/kokoro-82m", "voice": "bm_george", "input": "…" }
```

A regression test asserts that request and that no Microsoft Edge host is
contacted, so the card cannot be relabelled without the wire changing.

## Shortlist of British male Kokoro voices

All four exist as weight files in the Apache-2.0 Kokoro repo
(`voices/bm_*.pt`), and all four are available under the same model on
OpenRouter. Samples were generated locally on CPU from the open weights with a
**matched sentence**, so the comparison is like-for-like text:

```
The argument was that the landscape itself had done the work, and that no
European could have written it down honestly.
```

| Voice | Source | Median F0 (measured) | Silence share | Note |
|--|--|--|--|--|
| `bm_george` | [voices/bm_george.pt](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/voices/bm_george.pt) | ~141 Hz | 0.34 | **Chosen.** Mid-low, even pacing |
| `bm_fable` | [voices/bm_fable.pt](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/voices/bm_fable.pt) | ~121 Hz | 0.42 | Lower; more pauses, more "storyteller" |
| `bm_lewis` | [voices/bm_lewis.pt](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/voices/bm_lewis.pt) | ~94 Hz | 0.43 | **Deepest.** Slowest, most gravelled |
| `bm_daniel` | [voices/bm_daniel.pt](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/voices/bm_daniel.pt) | ~123 Hz | 0.31 | Not in the screenshot; included for completeness |

Model card and full voice list:
<https://huggingface.co/hexgrad/Kokoro-82M> · `VOICES.md` ·
[samples index](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/SAMPLES.md)
(note: that repo publishes samples for `af_heart` only — there are **no**
official `bm_*` sample files, which is why these were generated locally).

### What the numbers do and do not say

They are objective signal measurements from a single sentence each on one CPU
synthesis run. They say `bm_lewis` has the lowest median pitch and the most
silence; they say nothing about whether it sounds grand, warm, condescending, or
tired. A lower F0 is not "better", and "deep but kind of grand" is not a
measurable axis. **I have not listened to these and judged them** — I generated
them and measured them, and that is all I am claiming.

Artifacts from this run (48 kHz→24 kHz mono, 128 kbps MP3, matched text):

```
/opt/cursor/artifacts/kokoro-british-male/bm_george.mp3
/opt/cursor/artifacts/kokoro-british-male/bm_fable.mp3
/opt/cursor/artifacts/kokoro-british-male/bm_lewis.mp3
/opt/cursor/artifacts/kokoro-british-male/bm_daniel.mp3
```

They are not committed to the repo: they are evaluation artifacts, and the only
voice sample the product ships is `public/voice-previews/george.mp3` (the real
`bm_george` take of `PREVIEW_TEXT`).

## If `bm_george` is not grand enough

The three realistic next steps, cheapest first. None were implemented, because
changing the default without hearing a comparison would be guessing.

1. **Switch to another Kokoro voice.** One-line catalog change
   (`providerVoiceId`), same model, same route, same cost, same 800-char
   ceiling, no new dependency. `bm_lewis` is the measurable "deeper" option;
   `bm_fable` sits between it and George. This is the lowest-risk experiment and
   needs no infrastructure change at all.
2. **Keep Kokoro, restructure the delivery.** Kokoro has no prosody controls
   beyond speed, so "grander" would come from the text layer: more deliberate
   sentence boundaries and longer inter-sentence gaps, which this app already
   owns (`narration-script.ts`, the pause ladder). Free, but it is pacing, not
   timbre, and it would apply to every voice unless made per-voice.
3. **A different model.** A genuinely deeper British documentary read is more
   likely from a larger model than from Kokoro 82M — but every option I found is
   either a paid hosted service (a new account and spend, which this task
   excludes) or a self-hosted GPU model that would need its own worker and
   snapshot work. Not evaluated here.

## Runtime differences worth knowing

- **Cost.** Kokoro is ~$0.62/M tokens vs **$0** for the Edge voices (Andrew, Ava,
  Libby). George is the first listed British male voice that is not free.
- **Dependency.** George needs `OPENROUTER_API_KEY`. Edge stock needs no key. A
  deployment without that key will fail George's synthesis while the other three
  keep working, which is a visible, honest failure rather than a silent fallback.
- **Latency.** Kokoro is a non-streaming API call (`supportsNativeStream:
  false`) with an 800-character window, so a book packs into more, smaller
  requests than Edge's 4,000-character window. The preview is a committed file,
  so browsing is unaffected.
- **Whole books.** Kokoro was previously excluded from full audiobooks. That
  exclusion is lifted for this one voice: 800 characters clears the 600-character
  floor, and each chunk is an independent request, so nothing needs a larger
  window. The whole 54-voice family stays blocked by the allowlist.
- **License.** Apache-2.0 for the weights. Commercial use of the model is
  permitted; that is a property of the license, not legal advice, and the
  hosting terms of OpenRouter are separate.
