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
   `POST /api/tts/clones` with `{ uploadId, title?, accent? }`.
   `accent` is `american` (default), `british`, `australian`, or `irish`.
   It is a catalog label (`Shauna · British`), not a Fish training setting.
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
| `POST` | `/api/tts/clones` | JSON `{ uploadId, title?, transcript?, accent? }` — create from the stored object. `accent` defaults to `american`. Multipart is rejected (`USE_PRESIGN`). Fail quality → 422 `{ code: SAMPLE_QUALITY, verdict, headline, primary_message, fails, metrics }`. |
| `PATCH` | `/api/tts/clones/[id]` | JSON `{ accent }` — relabel a clone the caller owns (`american` / `british` / `australian` / `irish`). Id may be the row id or `clone:<id>`. Does not retrain Fish. Another session's clone is 404. |
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
- The browser decodes every sample (wav, mp3, m4a, webm) before upload,
  trims silence, and sets about −20 LUFS with gain only. The server
  remeasures that WAV (`measureCloneSamplePcm`). A 95% energy point below
  4 kHz, or speech less than 25 dB above the noise bed, is a warning and
  does not block. Server cleanup is an 80 Hz high-pass only. **No ffmpeg**
  on this path. Fish `enhance_audio_quality` is always on.
- Max 20 clones per session
- 5 clone creates per hour per identity

## Set accent on an existing clone

Rows created before the accent column (and any clone that omitted `accent`)
are **American**. Changing the label does not re-clone the sample.

The owner can call, with the same session cookie as the library:

```http
PATCH /api/tts/clones/clone:<id>
Content-Type: application/json

{ "accent": "british" }
```

Or in Turso, for the existing Shauna clone:

```sql
UPDATE cloned_voices
SET accent = 'british'
WHERE title = 'Shauna' AND deleted_at IS NULL;
```

Use the row `id` in the `WHERE` clause when more than one clone shares the title.
The voice picker then shows **Shauna · British**. On `/dashboard/voice` (Clone
path) the same four accents can be changed on the selected clone.

## YouTube clip

On the Clone screen a person can paste a YouTube link or type a search
without leaving Echomancer.

1. `GET /api/tts/youtube/search?q=` requires a signed-in account. Anonymous
   sessions are 401, so they cannot spend the Data API quota. With
   `YOUTUBE_API_KEY`, text search calls `search.list` (`part=snippet`) for
   the title, channel, and thumbnail, then `videos.list`
   (`part=contentDetails` only) for the duration. Hits are cached for 10
   minutes in Turso. A pasted link skips `search.list`. Signed out, or
   without the key, a pasted link still opens the player.
2. The page embeds the official IFrame player at 720p and shows a live
   countdown. A two-handle range is 10–60 seconds (default 20, starting past
   a short intro on longer videos). "Use this clip" plays from the trimmed
   start and stops at the end.
3. Desktop Chrome, Edge, Opera, and Brave record tab audio. The share
   request turns echo cancellation, noise suppression, and auto gain off,
   then `MediaRecorder` writes `audio/webm;codecs=opus` at 256 kbps. The
   browser trims and levels that take, then uploads WAV through the normal
   clone presign and `POST /api/tts/clones` `{ uploadId, youtube }`.
4. iOS, Android, Safari, and Firefox cannot capture tab audio. The same
   screen offers a microphone recording or a file upload instead. The
   "Use this clip" button is hidden there.
5. `completeStoredClone` high-passes at 80 Hz, always asks Fish to enhance,
   and for a YouTube clip adds a nova-3 transcript when it returns within
   3 seconds. Then `POST /model` (`visibility=private`). The row stores `source_kind`,
   `source_url`, `source_start_sec`, `source_end_sec`, and
   `source_consented_at`. Those clones are not shareable.

The worker does not download YouTube audio.


