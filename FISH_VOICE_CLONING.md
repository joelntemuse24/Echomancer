# Fish Audio voice cloning

Clone a private narrator from a short audio sample, then use it for preview /
listen / take-home like any other voice.

## Env

```bash
OPENROUTER_API_KEY=...   # stock Fish Narrator + Gemini path
FISH_API_KEY=...         # required for cloning + synthesizing clones
```

Get a Fish key at [fish.audio](https://fish.audio/) (developer dashboard).

## Flow

1. On `/dashboard/voice`, upload ~10–60s of clear speech and a name.
2. Server calls Fish `POST /model` (fast train, private visibility).
3. Row lands in `cloned_voices`; catalog id is `clone:<uuid>`.
4. Preview / jobs use provider `fish` → direct `POST /v1/tts` with
   `reference_id` = Fish voice id and model `s2.1-pro-free`.

Clones are **not** routed through OpenRouter — private reference ids belong to
your Fish account.

## API

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/api/tts/clones` | List session clones |
| `POST` | `/api/tts/clones` | multipart: `title`, `audio`, optional `transcript` |
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

- Sample: wav / mp3 / m4a / opus / ogg / webm, 8 KB–10 MB
- Max 20 clones per session
- 5 clone creates per hour per identity
