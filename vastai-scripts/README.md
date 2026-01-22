# Vast.ai F5-TTS Setup Guide

Generate audiobooks with voice cloning for ~$0.50-1.00 per 10-hour book using F5-TTS.

F5-TTS is the best open-source zero-shot voice cloning model (late 2025):
- Excellent quality from 10-30 second reference audio clips
- ~10-20x realtime on RTX 4090 (full 27-hour book in 1.5-3 hours)
- Works great with older/noisy audio sources
- Natural prosody for audiobook narration

## Quick Start

### 1. Rent a GPU on Vast.ai

1. Go to https://vast.ai/console/create/
2. Filter for:
   - **GPU**: RTX 3060, RTX 4070, RTX 4090, or RTX 3090
   - **Disk**: 30GB+
   - **Price**: ~$0.05-0.50/hour
3. Select a PyTorch template image
4. Click **RENT**

### 2. Connect to the Instance

Use the Vast.ai web terminal or SSH:
```bash
ssh -p <port> root@<ip-address>
```

### 3. Install F5-TTS

```bash
# Install F5-TTS (this downloads the model automatically on first use)
pip install f5-tts

# Verify installation
f5-tts_infer-cli --help
```

### 4. Quick Test with Gradio UI

For easy testing with a web interface:
```bash
f5-tts_infer-gradio
```
Then open the URL shown in your browser (use the port mapping from Vast.ai dashboard).

### 5. Generate Audio via CLI

```bash
# Upload your reference audio (10-30 seconds of Tom Wolfe)
# Then run:

f5-tts_infer-cli \
  --model F5TTS_v1_Base \
  --ref_audio "/workspace/ref_tom_wolfe.wav" \
  --ref_text "The transcription of what's said in the reference clip." \
  --gen_text "Sherman McCoy was not the man he had been a year ago. He had lost his nerve." \
  --output_dir "/workspace/output"
```

### 6. Run the API Server (for backend integration)

```bash
# Install server dependencies
pip install fastapi uvicorn httpx

# Create the server script
cat > /workspace/f5-tts-server.py << 'EOF'
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
        voice_path = job_dir / "reference.wav"
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(request.voice_sample_url)
            response.raise_for_status()
            voice_path.write_bytes(response.content)
        cmd = ["f5-tts_infer-cli", "--model", MODEL, "--ref_audio", str(voice_path),
               "--gen_text", request.text, "--output_dir", str(job_dir)]
        if request.ref_text:
            cmd.extend(["--ref_text", request.ref_text])
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"F5-TTS error: {result.stderr}")
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
EOF

# Start the server
python /workspace/f5-tts-server.py
```

### 7. Update Your Backend .env

Find your Vast.ai instance's public IP and port mapping, then:
```
TTS_PROVIDER=vastai
VASTAI_URL=http://<public-ip>:<mapped-port>
```

---

## Batch Audiobook Generation Script

For generating full audiobooks, save this as `generate-audiobook.py`:

```python
#!/usr/bin/env python3
"""
Batch audiobook generator using F5-TTS.
Splits text into chunks, generates audio in parallel, merges with FFmpeg.
"""
import argparse
import subprocess
import re
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

def split_text(text: str, max_chars: int = 500) -> list[str]:
    """Split text at sentence boundaries."""
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks = []
    current = ""
    for sentence in sentences:
        if len(current) + len(sentence) + 1 <= max_chars:
            current += sentence + " "
        else:
            if current:
                chunks.append(current.strip())
            current = sentence + " "
    if current:
        chunks.append(current.strip())
    return chunks

def generate_chunk(args):
    """Generate audio for a single chunk."""
    idx, chunk, ref_audio, ref_text, output_dir, model = args
    output_file = output_dir / f"chunk_{idx:05d}.wav"

    cmd = [
        "f5-tts_infer-cli",
        "--model", model,
        "--ref_audio", str(ref_audio),
        "--gen_text", chunk,
        "--output_dir", str(output_dir),
    ]
    if ref_text:
        cmd.extend(["--ref_text", ref_text])

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error on chunk {idx}: {result.stderr}")
        return None

    # Find the generated file and rename it
    wav_files = sorted(output_dir.glob("infer_cli_*.wav"), key=lambda f: f.stat().st_mtime)
    if wav_files:
        latest = wav_files[-1]
        latest.rename(output_file)
        return output_file
    return None

def main():
    parser = argparse.ArgumentParser(description="Generate audiobook with F5-TTS")
    parser.add_argument("--text", required=True, help="Path to text file")
    parser.add_argument("--ref_audio", required=True, help="Path to reference audio")
    parser.add_argument("--ref_text", default="", help="Transcription of reference audio")
    parser.add_argument("--output", required=True, help="Output audio file path")
    parser.add_argument("--model", default="F5TTS_v1_Base", help="F5-TTS model")
    parser.add_argument("--chunk_size", type=int, default=500, help="Max characters per chunk")
    parser.add_argument("--workers", type=int, default=1, help="Parallel workers")
    args = parser.parse_args()

    # Read and split text
    text = Path(args.text).read_text(encoding="utf-8")
    chunks = split_text(text, args.chunk_size)
    print(f"Split into {len(chunks)} chunks")

    # Create output directory
    output_dir = Path("temp_chunks")
    output_dir.mkdir(exist_ok=True)

    # Generate chunks
    tasks = [
        (i, chunk, args.ref_audio, args.ref_text, output_dir, args.model)
        for i, chunk in enumerate(chunks)
    ]

    audio_files = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(generate_chunk, task): task[0] for task in tasks}
        for future in as_completed(futures):
            idx = futures[future]
            result = future.result()
            if result:
                audio_files.append((idx, result))
                print(f"Completed chunk {idx + 1}/{len(chunks)}")

    # Sort by index and merge
    audio_files.sort(key=lambda x: x[0])

    # Create file list for FFmpeg
    list_file = output_dir / "files.txt"
    with open(list_file, "w") as f:
        for _, path in audio_files:
            f.write(f"file '{path.absolute()}'\n")

    # Merge with FFmpeg
    output_path = Path(args.output)
    subprocess.run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", str(list_file), "-c", "copy", str(output_path)
    ], check=True)

    print(f"Audiobook saved to: {output_path}")

    # Cleanup
    for _, path in audio_files:
        path.unlink(missing_ok=True)
    list_file.unlink(missing_ok=True)
    output_dir.rmdir()

if __name__ == "__main__":
    main()
```

Usage:
```bash
python generate-audiobook.py \
  --text bonfire_of_the_vanities.txt \
  --ref_audio ref_tom_wolfe.wav \
  --ref_text "And so there we were, in the middle of Manhattan..." \
  --output bonfire_audiobook.wav \
  --workers 2
```

---

## Cost Estimate

| GPU | Rate | 10hr Book Time | Cost |
|-----|------|----------------|------|
| RTX 3060 | ~$0.05/hr | ~3 hours | ~$0.15 |
| RTX 4070 | ~$0.15/hr | ~1.5 hours | ~$0.23 |
| RTX 4090 | ~$0.40/hr | ~1 hour | ~$0.40 |

Plus ~5 min setup time per session.

**Total for 10-hour audiobook: $0.15 - $0.50**

---

## Reference Audio Tips

For best Tom Wolfe voice cloning results:

1. **Length**: 10-30 seconds of clear speech
2. **Quality**: Clean audio, minimal background noise
3. **Content**: Natural speaking (interviews work great)
4. **Format**: WAV preferred, high-quality MP3 okay

If using old recordings:
- Use Audacity to reduce noise
- Normalize volume levels
- Trim to cleanest section
- Export as 16-bit WAV

---

## Troubleshooting

### "CUDA out of memory"
- Use a smaller chunk size: `--chunk_size 300`
- Restart the instance to clear GPU memory

### Model not downloading
```bash
# Force download the model
python -c "from f5_tts.api import F5TTS; F5TTS()"
```

### Audio sounds robotic
- Use a longer/cleaner reference audio
- Provide accurate ref_text transcription
- Try smaller text chunks

### Generation too slow
- Verify GPU is being used: `nvidia-smi`
- Use a faster GPU (RTX 4090 is ~2x faster than 3060)
