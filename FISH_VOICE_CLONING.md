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

1. On `/dashboard/voice`, upload ~10–60s of clear speech and a name.
2. Browser requests a storage URL (`POST /api/tts/clones/upload` JSON),
   **PUTs the sample to R2** (or the local object route in dev), then
   `POST /api/tts/clones` with `{ uploadId, title? }`.
3. Server reads the object from storage, calls Fish `POST /model`
   (fast train, private visibility).
4. Row lands in `cloned_voices`; catalog id is `clone:<uuid>`.
5. Preview / jobs use provider `fish` → direct `POST /v1/tts` with
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
| `POST` | `/api/tts/clones` | JSON `{ uploadId, title?, transcript? }` — create from the stored object. Multipart is rejected (`USE_PRESIGN`). |
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
- WAV samples are high-pass / noise-gated / peak-normalized in-process
  (`src/lib/tts/clone-sample-audio.ts`). **No ffmpeg** on this function.
  Compressed formats pass through; Fish `enhance_audio_quality` still runs.
- Max 20 clones per session
- 5 clone creates per hour per identity
