# Fish Audio voice cloning

Clone a private narrator from a short audio sample, then use it for preview /
listen / take-home like any other voice.

## Env

```bash
OPENROUTER_API_KEY=...   # optional path for stock Fish Narrator via OpenRouter
FISH_API_KEY=...         # required for cloning, Live Listen, and direct Fish synth
```

Get a Fish key at [fish.audio](https://fish.audio/) (developer dashboard).

## Flow

1. On `/dashboard/voice`, upload 10s–3 min of clear speech in a **dry room**
   (phone close to your mouth) and a name. Cleaning tools will not rescue
   echo — re-record instead.
2. The picker runs a client-side quality check (Web Audio). A `fail`
   verdict blocks Clone; `warn` still allows proceed.
3. Browser requests a storage URL (`POST /api/tts/clones/upload` JSON),
   **PUTs the sample to R2** (or the local object route in dev), then
   `POST /api/tts/clones` with `{ uploadId, title? }`.
4. Server reads the object from storage, re-checks 16-bit WAV with the
   same gate (`SAMPLE_QUALITY` 422 on fail — no Fish call), then calls
   Fish `POST /model` (fast train, private visibility).
5. Row lands in `cloned_voices`; catalog id is `clone:<uuid>`.
6. Preview / jobs use provider `fish` → direct `POST /v1/tts` with
   `reference_id` = Fish voice id and model `s2.1-pro-free`.

Clones are **not** routed through OpenRouter — private reference ids belong to
your Fish account. The sample never travels through a Vercel function body
(same pattern as book PDFs). Existing R2 env (`R2_*`) is reused; no new
secrets. A clip larger than ~5 MB works as long as it stays under the
32 MB product ceiling.

## API

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/api/tts/clones` | List session clones |
| `POST` | `/api/tts/clones/upload` | JSON presign: `{ fileName, contentType, byteSize }` → PUT URL under `clones/<id>/` |
| `PUT` | `/api/tts/clones/upload/[id]/object` | Local-only byte sink (404 when R2 is configured) |
| `POST` | `/api/tts/clones` | JSON `{ uploadId, title?, transcript? }` — create from the stored object. Multipart is rejected (`USE_PRESIGN`). Fail quality → 422 `{ code: SAMPLE_QUALITY, verdict, headline, primary_message, fails, metrics }`. |
| `DELETE` | `/api/tts/clones/[id]` | Soft-delete |
| `GET`/`POST` | `/api/tts/live` | Fish **HTTP** chunked TTS proxy (`catalogVoiceId`, optional `text`) |

`GET /api/tts/voices` merges clones at the top when `FISH_API_KEY` is set
(`fishCloneConfigured: true`).

## Live streaming (previews)

Fish streams MP3 over plain HTTP (`POST https://api.fish.audio/v1/tts`,
chunked). When `FISH_API_KEY` is set, the voice picker plays Fish / clone
previews via `GET /api/tts/live?catalogVoiceId=…` so the browser can start
audio as soon as the first chunks arrive — no wait for a full unary preview.

We intentionally **do not** proxy Fish’s WebSocket `/v1/tts/live` on Vercel:
that protocol is for token-by-token LLM text. Previews and book listen already
have the full string, so HTTP streaming is the right mode (lower ops complexity,
works with serverless `maxDuration`).

## Limits

- Sample: wav / mp3 / m4a / opus / ogg / webm, `audio/*`, 8 KB–32 MB
  (`src/lib/clone-sample-formats.ts`). Bytes go to R2, so Vercel’s ~4.5 MB
  function body does not apply.
- WAV samples are quality-gated then high-pass / noise-gated /
  peak-normalized in-process (`clone-sample-quality-metrics.ts`,
  `clone-sample-audio.ts`). **No ffmpeg** on this function.
  Compressed formats are checked in the browser (Web Audio); the server
  cannot decode them cheaply, so it skips the PCM re-check and still
  runs Fish `enhance_audio_quality`.
- Max 20 clones per session
- 5 clone creates per hour per identity
