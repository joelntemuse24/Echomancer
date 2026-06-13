"""Shared audiobook job helpers — submit without blocking; no Modal log streaming."""
from __future__ import annotations

import json
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

import httpx

APP_BASE = "https://echomancer-v2.vercel.app"
HYBRID_BASE = "https://ntemusejoel--echomancer-hybrid-tts-fastapi-app.modal.run"


def clip_voice_for_upload(
    voice_path: Path, start: float = 10.0, duration: float = 30.0, prefix: str = "voice_"
) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix=prefix)) / "ref.wav"
    cmd = [
        "ffmpeg", "-y", "-i", str(voice_path),
        "-ss", str(start), "-t", str(duration), "-ac", "1", "-ar", "24000", str(tmp),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    print(f"Clipped voice for upload: {tmp} ({tmp.stat().st_size} bytes)")
    return tmp


def upload_file(
    client: httpx.Client,
    endpoint: str,
    local_path: Path,
    content_type: str = "application/octet-stream",
) -> str:
    with local_path.open("rb") as f:
        files = {"file": (local_path.name, f, content_type)}
        resp = client.post(f"{APP_BASE}{endpoint}", files=files, timeout=120.0)
    print(f"POST {endpoint} -> {resp.status_code}")
    if resp.status_code != 200:
        raise RuntimeError(resp.text[:2000])
    data = resp.json()
    path = data["storagePath"]
    print(f"  storagePath: {path}")
    return path


def trigger_audiobook(client: httpx.Client, payload: dict) -> dict:
    url = f"{HYBRID_BASE}/generate_audiobook"
    resp = client.post(url, json=payload, timeout=120.0)
    print(f"POST {url} -> {resp.status_code}")
    if resp.status_code != 200:
        raise RuntimeError(resp.text[:2000])
    data = resp.json()
    print(json.dumps(data, indent=2))
    return data


def output_url(output_key: str) -> str:
    return f"{APP_BASE}/api/storage/{output_key}"


def wait_for_output(
    client: httpx.Client,
    output_key: str,
    timeout_s: int = 7200,
    interval_s: int = 120,
) -> bool:
    """Poll R2 via Vercel only when explicitly requested (--wait)."""
    url = output_url(output_key)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        resp = client.head(url, timeout=30.0)
        if resp.status_code == 200:
            print(f"Output ready: {url}")
            return True
        print(f"  waiting ({resp.status_code}), next check in {interval_s}s ...", flush=True)
        time.sleep(interval_s)
    return False


def download_output(client: httpx.Client, output_key: str, dest: Path) -> None:
    url = output_url(output_key)
    with client.stream("GET", url, timeout=300.0) as resp:
        resp.raise_for_status()
        dest.write_bytes(resp.read())
    print(f"Downloaded: {dest} ({dest.stat().st_size} bytes)")


def submit_audiobook_job(
    *,
    pdf_path: Path,
    voice_path: Path,
    book_title: str,
    out_mp3: Path,
    timbre_mode: str = "qwen_clone",
    job_prefix: str = "hybrid-job",
    wait: bool = False,
) -> int:
    if not pdf_path.exists() or not voice_path.exists():
        print("Missing test assets")
        return 1

    job_id = f"{job_prefix}-{uuid.uuid4().hex[:12]}"
    output_key = f"audiobooks/{job_id}/audiobook.mp3"

    print(f"Job ID: {job_id}")
    print(f"PDF: {pdf_path}")
    print(f"Voice: {voice_path}")
    print(f"timbre_mode: {timbre_mode}")

    voice_upload_path = clip_voice_for_upload(voice_path, prefix=f"{job_prefix}_voice_")

    with httpx.Client(follow_redirects=True) as client:
        pdf_key = upload_file(client, "/api/pdf/upload", pdf_path, "application/pdf")
        voice_key = upload_file(client, "/api/audio/upload", voice_upload_path, "audio/wav")

        payload = {
            "job_id": job_id,
            "pdf_r2_key": pdf_key,
            "voice_r2_key": voice_key,
            "start_time": 0,
            "end_time": 30,
            "webhook_url": "https://httpbin.org/post",
            "book_title": book_title,
            "voice_name": voice_path.stem,
            "r2_bucket_name": "echomancer-audio",
            "pipeline_mode": "hybrid",
            "timbre_mode": timbre_mode,
            "qwen_language": "English",
        }

        result = trigger_audiobook(client, payload)
        print(f"Spawned Modal call_id={result.get('call_id')}")
        print(f"Output key: {output_key}")
        print(f"Download URL (when ready): {output_url(output_key)}")
        print(f"Local target: {out_mp3}")
        print()
        print("Job submitted. Script exits now to avoid burning Modal credits on log polling.")
        print("When the job finishes, download with:")
        print(f'  python scripts/download_audiobook.py {job_id} "{out_mp3}"')

        if not wait:
            return 0

        print(f"\n--wait enabled: checking every 120s (max {7200 // 60} min) ...")
        if not wait_for_output(client, output_key):
            print("Timed out waiting for audiobook MP3")
            return 1
        download_output(client, output_key, out_mp3)
        print(f"SUCCESS: audiobook at {out_mp3}")
    return 0