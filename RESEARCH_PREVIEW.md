# MiniMax Free API (slim test catalog)

When these two env vars are set, the voice picker shrinks to **two options**:

1. **Storyteller** — MiniMax Free API (default)
2. **Kore** — Gemini TTS (stock fallback)

OpenRouter / multi-vendor catalog is shelved while the Free API is configured.
Unset the env vars to restore the normal OpenRouter catalog.

```bash
MINIMAX_FREE_API_BASE_URL=http://127.0.0.1:8000
MINIMAX_FREE_API_TOKEN=<realUserID>+<_token>
```

## Setup

1. Run the Free API proxy (Docker), e.g.:

   ```bash
   docker run -it -d --init --name minimax-free-api -p 8000:8000 \
     akashrajpuroh1t/minimax-free-api-fix:latest
   ```

2. From [agent.minimaxi.com](https://agent.minimaxi.com/), copy `realUserID` and
   `_token`, join with `+` (see that project’s README).

3. Put the two env vars in `.env.local` or Vercel.

4. Reload `/dashboard/voice` — you should see Storyteller (default) and Kore.

## Notes

- Synthesis hits `POST {BASE}/v1/audio/speech` (OpenAI-compatible).
- Jobs with no voice selected default to Storyteller when Free API is configured.
- Token stays server-side.
- Unset the env vars when you are done testing / before treating this as a
  permanent production dependency — reverse proxies are brittle.
