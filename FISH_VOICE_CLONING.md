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

`GET /api/tts/voices` merges clones at the top when `FISH_API_KEY` is set
(`fishCloneConfigured: true`).

## Limits

- Sample: wav / mp3 / m4a / opus / ogg / webm, 8 KB–10 MB
- Max 20 clones per session
- 5 clone creates per hour per identity
