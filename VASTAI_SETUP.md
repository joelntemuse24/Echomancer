# Vast.ai Setup for EchoMancer

## Step 1: Rent a GPU (~$0.05-0.40/hour)

1. Go to https://vast.ai/console/create/
2. Click "SEARCH" at the top
3. Set filters:
   - **Disk Space**: Min 30 GB
   - **Upload Speed**: Min 100 Mbps
   - **Download Speed**: Min 100 Mbps
   - **GPU RAM**: Min 8 GB
4. Sort by **$/hr** (cheapest first)
5. Look for RTX 3060, 3090, 4070, or 4090
6. Click **RENT** on a cheap one (~$0.05-0.15/hr for RTX 3060)

## Step 2: Connect to Instance

1. Wait for instance to show "running" status (30-60 seconds)
2. Click **OPEN SSH** button in Vast.ai dashboard
3. Copy the SSH command, or use their web terminal

## Step 3: Setup F5-TTS (copy-paste this entire block)

```bash
# Install F5-TTS and dependencies
pip install f5-tts fastapi uvicorn httpx

# Copy the server script
cat > /workspace/f5-tts-server.py << 'SERVEREOF'
#!/usr/bin/env python3
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
import tempfile
import httpx
import uuid
import subprocess
import os
from pathlib import Path

app = FastAPI(title="F5-TTS API Server")
MODEL = "F5TTS_v1_Base"
TEMP_DIR = Path(tempfile.gettempdir()) / "f5-tts-api"
TEMP_DIR.mkdir(exist_ok=True)

class GenerateRequest(BaseModel):
    text: str
    voice_sample_url: str
    ref_text: str = ""

@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL}

@app.post("/generate")
async def generate_audio(request: GenerateRequest):
    job_id = str(uuid.uuid4())
    job_dir = TEMP_DIR / job_id
    job_dir.mkdir(exist_ok=True)
    try:
        # Download voice sample
        voice_path = job_dir / "reference.wav"
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(request.voice_sample_url)
            response.raise_for_status()
            voice_path.write_bytes(response.content)

        # Run F5-TTS
        cmd = ["f5-tts_infer-cli", "--model", MODEL, "--ref_audio", str(voice_path),
               "--gen_text", request.text, "--output_dir", str(job_dir)]
        if request.ref_text:
            cmd.extend(["--ref_text", request.ref_text])

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"F5-TTS error: {result.stderr}")

        # Find generated audio file
        wav_files = [f for f in job_dir.glob("*.wav") if f.name != "reference.wav"]
        if not wav_files:
            raise HTTPException(status_code=500, detail="No output generated")
        output_file = max(wav_files, key=lambda f: f.stat().st_mtime)

        return FileResponse(output_file, media_type="audio/wav", filename=f"{job_id}.wav")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=400, detail=f"Download failed: {str(e)}")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Generation timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
SERVEREOF

# Make it executable
chmod +x /workspace/f5-tts-server.py

# Start the server (this will run forever - keep this terminal open)
python /workspace/f5-tts-server.py
```

## Step 4: Get Your Public URL

1. In Vast.ai dashboard, find your instance
2. Look for the **Port Mappings** section
3. Find where port **8080** is mapped to
4. It will show something like: `8080:12345` → This means port 12345 is public
5. Your URL will be: `http://<instance-ip>:12345`
   - Example: `http://123.45.67.89:12345`

## Step 5: Test the Server

Open a new terminal on your local machine and test:

```bash
curl http://<your-vastai-url>/health
```

You should see: `{"status":"ok","model":"F5TTS_v1_Base"}`

## Step 6: Update EchoMancer Backend

Edit `backend/.env`:

```
TTS_PROVIDER=vastai
VASTAI_URL=http://<your-instance-ip>:<mapped-port>
```

Example:
```
TTS_PROVIDER=vastai
VASTAI_URL=http://123.45.67.89:12345
```

## Step 7: Restart Your Services

1. Stop the web server (if running)
2. Stop the worker (if running)
3. Start them again:

```bash
# Terminal 1 - Web Server
cd backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000 --host 0.0.0.0

# Terminal 2 - Worker
cd backend
..\.venv\Scripts\python.exe -m arq app.workers.audiobook.WorkerSettings
```

## Done!

Now when you create an audiobook job, it will use your Vast.ai F5-TTS server to generate the audio.

## Cost

- **Rental**: ~$0.05-0.15/hour (RTX 3060)
- **10-hour audiobook**: Takes ~2-3 hours to generate = **$0.10-0.45 total**

Remember to **DESTROY THE INSTANCE** when done to stop charges!

## Troubleshooting

### "Connection refused" error
- Make sure the server is running on Vast.ai (keep that terminal open)
- Check the port mapping is correct
- Try accessing `http://<url>/health` in your browser

### "CUDA out of memory"
- Restart the Vast.ai instance
- Or rent a GPU with more VRAM

### Server keeps stopping
- The server runs forever - don't close the terminal/SSH session
- Or run it in background: `nohup python /workspace/f5-tts-server.py &`
