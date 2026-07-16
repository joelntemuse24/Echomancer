# Deployment Guide

## Vercel (production)

### Environment variables

```bash
# Turso
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...

# Cloudflare R2
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=echomancer-audio

# MOSS-TTS (production default: SGLang)
MOSS_AB_VARIANT=sglang
MODAL_MOSS_SGLANG_TTS_URL=https://<user>--echomancer-sglang-tts-fastapi-app.modal.run/generate_batch
MODAL_TTS_URL=https://<user>--echomancer-sglang-tts-fastapi-app.modal.run/generate_batch

# Optional rollback URLs (keep set, inactive while variant=sglang)
MODAL_MOSS_TTS_URL=https://<user>--echomancer-moss-tts-fastapi-app.modal.run/generate_batch
MODAL_MOSS_LOCAL_TTS_URL=https://<user>--echomancer-moss-local-tts-fastapi-app.modal.run/generate_batch

WEBHOOK_SECRET=...
NEXT_PUBLIC_APP_URL=https://echomancer-v2.vercel.app
```

### Deploy

```bash
npx vercel --prod
```

Or push to `main` with GitHub integration enabled.

### Verify

- https://echomancer-v2.vercel.app/api/debug/env — check `MOSS_AB_VARIANT` and Modal URLs
- https://echomancer-v2.vercel.app/api/health

## Modal TTS workers

Deploy from repo root:

```powershell
.\deploy-sglang.ps1      # production
.\deploy-moss-tts.ps1    # delay + local variants
```

See `MOSI_API_SETUP.md` for the hosted API variant.

## Rollback

Set `MOSS_AB_VARIANT=delay` and point `MODAL_TTS_URL` / `MODAL_MOSS_TTS_URL` at the delay app URL, then redeploy Vercel.

Do **not** set `MOSS_AB_VARIANT=openmoss` in production — quantized OpenMOSS is not a supported production route. Leave `MOSS_AB_VARIANT=sglang` (or unset; code defaults to SGLang).