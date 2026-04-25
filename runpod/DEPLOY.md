# Deploy Fish Speech Worker to RunPod

## Option 1: GitHub Actions (Recommended - Automatic)

### Step 1: Push to GitHub

Push the `runpod/` directory to your GitHub repository. The workflow will automatically build and push to GHCR on every push to main.

### Step 2: Enable GitHub Actions

1. Go to your GitHub repo → Actions tab
2. Enable workflows if prompted
3. The workflow at `.github/workflows/build-push.yml` will trigger

### Step 3: Get Image URL

After the workflow completes:
- Image URL: `ghcr.io/YOUR_USERNAME/echomancer-v2/fish-speech-worker:latest`

---

## Option 2: Manual Docker Build

### Prerequisites
- Docker Desktop installed
- GitHub account + Personal Access Token (PAT) with `write:packages` scope

### Step 1: Build

```bash
cd runpod
docker build -t fish-worker .
```

### Step 2: Push to GHCR

```bash
# Login
echo YOUR_GITHUB_TOKEN | docker login ghcr.io -u YOUR_USERNAME --password-stdin

# Tag
docker tag fish-worker:latest ghcr.io/YOUR_USERNAME/fish-speech-worker:latest

# Push
docker push ghcr.io/YOUR_USERNAME/fish-speech-worker:latest
```

---

## Create RunPod Serverless Endpoint

### Step 1: Go to RunPod Console
https://www.runpod.io/console/serverless

### Step 2: New Endpoint Configuration

| Setting | Value |
|---------|-------|
| **Name** | `fish-speech-s2-pro` |
| **Container Image** | `ghcr.io/YOUR_USERNAME/echomancer-v2/fish-speech-worker:latest` |
| **GPU** | **H100** (fastest) or **A100 80GB** |
| **GPU Count** | 1 |
| **Workers** | 1 (always ready) or 0 (scale to demand) |
| **Flash Boot** | Enabled |

### Step 3: Deploy

Click **Deploy** and wait for the endpoint to be ready (2-5 minutes).

---

## Test the Endpoint

### Get your Endpoint ID and API Key
- Endpoint ID: Found in RunPod console (format: `abc123def-xyz`)
- API Key: From RunPod account settings

### Test Command

```bash
curl -X POST https://api.runpod.ai/v2/YOUR_ENDPOINT_ID/run \
     -H "authorization: Bearer YOUR_RUNPOD_API_KEY" \
     -H "content-type: application/json" \
     -d '{
       "input": {
         "text": "Hello, world! This is Fish Speech on RunPod."
       }
     }'
```

### Test with Voice Cloning

```bash
# Encode your reference audio
REFERENCE_AUDIO=$(base64 -w 0 reference.wav)

curl -X POST https://api.runpod.ai/v2/YOUR_ENDPOINT_ID/run \
     -H "authorization: Bearer YOUR_RUNPOD_API_KEY" \
     -H "content-type: application/json" \
     -d "{
       \"input\": {
         \"text\": \"This is a test of voice cloning with Fish Speech.\",
         \"reference_audio\": [\"$REFERENCE_AUDIO\"],
         \"reference_text\": [\"Original transcript of the reference audio.\"],
         \"format\": \"wav\",
         \"temperature\": 0.7
       }
     }"
```

---

## Integration with Echomancer

After successful deployment, add to your `.env.local`:

```bash
RUNPOD_FISH_SPEECH_ENDPOINT_ID=your_endpoint_id_here
RUNPOD_API_KEY=your_runpod_api_key_here
```

---

## Troubleshooting

### Build fails on GitHub Actions
- Check that `runpod/Dockerfile` exists
- Verify GitHub Actions is enabled in repo settings

### Endpoint shows "Failed" status
- Check RunPod logs in console
- Verify image is public or credentials are correct
- Ensure you're using a CUDA-capable GPU (H100, A100, L40S, etc.)

### Audio generation is slow
- H100 is fastest (~2-3s for short text)
- A100 80GB is slightly slower (~3-5s)
- Consider enabling Flash Boot for faster cold starts

---

## Send Me Your Details

Once deployed, please share:
- **Endpoint ID**: (from RunPod console)
- **GPU Selected**: (H100, A100 80GB, etc.)
- **Image URL**: (e.g., `ghcr.io/...`)

I'll update the Echomancer integration code to use your RunPod endpoint.
