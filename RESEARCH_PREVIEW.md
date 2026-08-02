# MiniMax Free API (simple env toggle)

When these two env vars are set, seeded MiniMax voices show up in the voice
picker like every other narrator (preview, Try a chapter, Get the whole book):

```bash
MINIMAX_FREE_API_BASE_URL=http://127.0.0.1:8000
MINIMAX_FREE_API_TOKEN=<realUserID>+<_token>
```

Leave them unset → those cards disappear. No allowlist, no extra flags.

## Setup

1. Run the Free API proxy (Docker), e.g.:

   ```bash
   docker run -it -d --init --name minimax-free-api -p 8000:8000 \
     akashrajpuroh1t/minimax-free-api-fix:latest
   ```

2. From [agent.minimaxi.com](https://agent.minimaxi.com/), copy `realUserID` and
   `_token`, join with `+` (see that project’s README).

3. Put the two env vars in `.env.local` or Vercel.

4. Reload `/dashboard/voice` — MiniMax cards appear (badge: Research preview).

## Notes

- Synthesis hits `POST {BASE}/v1/audio/speech` (OpenAI-compatible).
- Token stays server-side.
- Unset the env vars when you are done testing / before treating this as a
  permanent production dependency — reverse proxies are brittle.
