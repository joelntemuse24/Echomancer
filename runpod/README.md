# RunPod Fish Speech S2 Pro Worker

A RunPod serverless worker that exposes Fish Speech S2 Pro as a TTS API endpoint.

This is an exact copy of [mguinhos/runpod-worker-fish-speech](https://github.com/mguinhos/runpod-worker-fish-speech) for Echomancer integration.

---

## How it works

On startup, the worker launches the Fish Speech API server in the background, waits for it to be ready, then starts the RunPod handler. Incoming jobs are forwarded to the internal Fish Speech server and the generated audio is returned as base64.

---

## Project Structure

```
runpod/
├── src/
│   ├── handler.py    # RunPod serverless handler
│   └── run.sh        # Startup script
├── checkpoints/      # Downloaded at build time (gitignored)
├── Dockerfile
└── .gitignore
```

---

## API Usage

### Request

```json
{
  "input": {
    "text": "Hello, world!",
    "format": "wav",
    "reference_audio": [],
    "reference_text": [],
    "temperature": 0.8,
    "top_p": 0.8,
    "repetition_penalty": 1.1,
    "max_new_tokens": 1024,
    "chunk_length": 300,
    "seed": null,
    "use_memory_cache": "off"
  }
}
```

### Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| text | string | required | Text to synthesize |
| format | string | wav | Output format: wav, mp3, flac |
| reference_audio | list[base64] | [] | Reference audio clips for voice cloning |
| reference_text | list[string] | [] | Transcripts matching each reference audio |
| reference_id | string | null | ID of a pre-loaded reference model |
| temperature | float | 0.8 | Sampling temperature |
| top_p | float | 0.8 | Top-p sampling |
| repetition_penalty | float | 1.1 | Repetition penalty |
| max_new_tokens | int | 1024 | Max tokens to generate |
| seed | int | null | Fixed seed for deterministic output |
| use_memory_cache | string | off | Memory cache setting |

### Response

```json
{
  "audio_base64": "<base64 encoded audio>",
  "format": "wav"
}
```

### Example (curl)

```bash
curl -X POST https://api.runpod.ai/v2/ENDPOINT_ID/run \
     -H "authorization: Bearer RUNPOD_API_KEY" \
     -H "content-type: application/json" \
     -d '{
       "input": {
         "text": "Hello, world!"
       }
     }'
```

---

## Deployment Instructions

### Step 1: Build the Docker Image

```bash
cd runpod
docker build -t fish-worker .
```

### Step 2: Test Locally (requires NVIDIA GPU)

```bash
docker run --gpus all fish-worker
```

### Step 3: Push to Registry

**Option A: Docker Hub**
```bash
# Login to Docker Hub
docker login

# Tag and push
docker tag fish-worker:latest YOUR_USERNAME/fish-worker:latest
docker push YOUR_USERNAME/fish-worker:latest
```

**Option B: GitHub Container Registry (GHCR)**
```bash
# Login to GHCR (using GitHub token)
echo YOUR_GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

# Tag and push
docker tag fish-worker:latest ghcr.io/YOUR_USERNAME/fish-worker:latest
docker push ghcr.io/YOUR_USERNAME/fish-worker:latest
```

### Step 4: Create RunPod Serverless Endpoint

1. Go to [RunPod Console](https://www.runpod.io/console/serverless)
2. Click **"New Endpoint"**
3. Configure the endpoint:
   - **Name**: `fish-speech-tts`
   - **Container Image**: Your pushed image (e.g., `ghcr.io/YOUR_USERNAME/fish-worker:latest`)
   - **GPU**: Select the fastest available:
     - **Priority 1**: H100 (fastest)
     - **Priority 2**: A100 80GB
     - **Priority 3**: L40S
     - **Priority 4**: RTX 4090
     - **Priority 5**: A6000 (48GB)
   - **Workers**: Start with 0 (scale to demand) or 1 (always ready)
   - **Flash Boot**: Enable for faster cold starts
   - **GPU Count per Worker**: 1
4. Click **"Deploy"**

### Step 5: Test the Endpoint

**Simple test (no voice cloning):**
```bash
curl -X POST https://api.runpod.ai/v2/YOUR_ENDPOINT_ID/run \
     -H "authorization: Bearer YOUR_RUNPOD_API_KEY" \
     -H "content-type: application/json" \
     -d '{
       "input": {
         "text": "Hello, world!"
       }
     }'
```

**Test with voice cloning:**
```bash
curl -X POST https://api.runpod.ai/v2/YOUR_ENDPOINT_ID/run \
     -H "authorization: Bearer YOUR_RUNPOD_API_KEY" \
     -H "content-type: application/json" \
     -d '{
       "input": {
         "text": "This is a test of voice cloning with Fish Speech.",
         "reference_audio": ["BASE64_AUDIO_HERE"],
         "reference_text": ["Original transcript of the reference audio."],
         "format": "wav",
         "temperature": 0.7
       }
     }'
```

---

## Environment Variables

The Dockerfile handles model download at build time using the Hugging Face CLI. No environment variables are strictly required for basic operation.

Optional environment variables (if needed later):
- `HF_TOKEN`: Hugging Face token for accessing gated models
- `RUNPOD_API_KEY`: RunPod API key (handled by RunPod platform)

---

## GPU Recommendations

| GPU | VRAM | Speed | Best For |
|-----|------|-------|----------|
| H100 | 80GB | Fastest | Production, high throughput |
| A100 80GB | 80GB | Very Fast | Production, long contexts |
| L40S | 48GB | Fast | Balanced performance/cost |
| RTX 4090 | 24GB | Fast | Cost-effective |
| A6000 | 48GB | Medium | Larger models, voice cloning |

**Recommended**: H100 or A100 80GB for best performance.

---

## Troubleshooting

### Build fails with model download error
- Ensure you have a stable internet connection
- If model is gated, set `HF_TOKEN` as a build secret

### Container starts but handler fails
- Check logs in RunPod console
- Verify the Fish Speech server started correctly

### Out of memory errors
- Use a GPU with more VRAM
- Reduce `chunk_length` in requests

---

## Integration with Echomancer

After deployment, update your `.env.local`:

```bash
RUNPOD_FISH_SPEECH_ENDPOINT_ID=your_endpoint_id_here
RUNPOD_API_KEY=your_runpod_api_key_here
```

Then update the TTS client in `src/lib/` to call the RunPod endpoint instead of Modal.

---

## License

MIT (same as original repository)
