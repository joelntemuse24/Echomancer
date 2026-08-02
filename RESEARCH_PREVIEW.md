# Research preview — MiniMax Free API (internal only)

Probe MiniMax speech **stability and access** through an OpenAI-compatible
reverse proxy ([MiniMax-Free-API](https://github.com/xiaoY233/MiniMax-Free-API))
without putting that path on the public product surface.

This is **not** a production feature. Production customers stay on OpenRouter
stock TTS. When you ship for real, leave these env vars unset.

## Rules of the road

- Off unless every required env var is set.
- Visible only to `RESEARCH_PREVIEW_ALLOWLIST` (session `userId` and/or IP).
- Token stays **server-side** — never sent to the browser.
- Full audiobooks are **blocked** unless you explicitly set
  `RESEARCH_PREVIEW_ALLOW_TAKEHOME=true` (reverse APIs + long books = ban risk).
- Prefer preview + “Try a chapter” for probing.

## Setup

1. Run the Free API locally (or on a private host you control):

   ```bash
   docker run -it -d --init --name minimax-free-api -p 8000:8000 \
     -e TZ=Asia/Shanghai akashrajpuroh1t/minimax-free-api-fix:latest
   ```

2. From [agent.minimaxi.com](https://agent.minimaxi.com/), grab
   `realUserID` + `_token` and concatenate with `+`
   (see that project’s README).

3. In Vercel (Preview / Development) or `.env.local`:

   ```bash
   RESEARCH_PREVIEW_ENABLED=true
   RESEARCH_PREVIEW_ALLOWLIST=anon_<your-session-user-id>
   MINIMAX_FREE_API_BASE_URL=http://127.0.0.1:8000
   MINIMAX_FREE_API_TOKEN=450234567894+eyJhbGciOiJIUzI1NiI...
   # optional — only if you truly need full-book probes
   # RESEARCH_PREVIEW_ALLOW_TAKEHOME=true
   ```

4. Find your session user id: DevTools → Application → Cookies → `ec_session`
   (token shape `v1.<userId>.<issuedAt>.<hmac>` — use the `<userId>` part).

5. Reload `/dashboard/voice`. Allowlisted sessions see cards tagged
   **Research preview** and can preview / stream them.

## Code map

| Piece | Path |
|-------|------|
| Gate + catalog cards | `src/lib/tts/research-preview.ts` |
| Provider adapter | `src/lib/tts/providers/minimax-free.ts` |
| Adapter routing | `src/lib/tts/providers/index.ts` → `resolveStockAdapter` |
| Voices / jobs / preview gates | `src/app/api/tts/voices`, `…/preview`, `…/jobs` |

Catalog ids look like `research:minimax-free:English_CaptivatingStoryteller`.

## What we are probing

- Does `/v1/audio/speech` on the proxy stay up?
- Empty/silent audio rate vs OpenRouter MiniMax HD
- Latency / TTFA for stream windows
- Auth failure modes (401 on new tokens, multi-token rotation)

Results inform whether official MiniMax / OpenRouter HD remains the only path
when the product leaves research.
