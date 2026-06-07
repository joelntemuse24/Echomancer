"""Full hybrid audiobook E2E via production APIs + Modal orchestrator."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

import httpx

PDF_PATH = Path(r"C:\Users\ntemu\Downloads\echo test 1.pdf")
VOICE_PATH = Path(r"C:\Users\ntemu\Downloads\Ntw-enhanced-v2.wav")
OUT_MP3 = Path(r"C:\Users\ntemu\Downloads\hybrid_refined_full.mp3")

APP_BASE = "https://echomancer-v2.vercel.app"
HYBRID_BASE = "https://ntemusejoel--echomancer-hybrid-tts-fastapi-app.modal.run"


def clip_voice_for_upload(voice_path: Path, start: float = 10.0, duration: float = 30.0) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="hybrid_e2e_voice_")) / "ref_15s.wav"
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


def trigger_audiobook(client: httpx.Client, payload: dict) -> str:
    url = f"{HYBRID_BASE}/generate_audiobook"
    resp = client.post(url, json=payload, timeout=120.0)
    print(f"POST {url} -> {resp.status_code}")
    if resp.status_code != 200:
        raise RuntimeError(resp.text[:2000])
    data = resp.json()
    print(json.dumps(data, indent=2))
    return data["call_id"]


def poll_output(client: httpx.Client, output_key: str, timeout_s: int = 7200) -> bool:
    url = f"{APP_BASE}/api/storage/{output_key}"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        resp = client.head(url, timeout=30.0)
        if resp.status_code == 200:
            print(f"Output ready: {url}")
            return True
        print(f"  waiting ({resp.status_code}) ...", flush=True)
        time.sleep(30)
    return False


def download_output(client: httpx.Client, output_key: str, dest: Path) -> None:
    url = f"{APP_BASE}/api/storage/{output_key}"
    with client.stream("GET", url, timeout=300.0) as resp:
        resp.raise_for_status()
        dest.write_bytes(resp.read())
    print(f"Downloaded: {dest} ({dest.stat().st_size} bytes)")


def main() -> int:
    if not PDF_PATH.exists() or not VOICE_PATH.exists():
        print("Missing test assets")
        return 1

    job_id = f"hybrid-e2e-{uuid.uuid4().hex[:12]}"
    output_key = f"audiobooks/{job_id}/audiobook.mp3"

    print(f"Job ID: {job_id}")
    print(f"PDF: {PDF_PATH}")
    print(f"Voice: {VOICE_PATH}")

    voice_upload_path = clip_voice_for_upload(VOICE_PATH)

    with httpx.Client(follow_redirects=True) as client:
        pdf_key = upload_file(client, "/api/pdf/upload", PDF_PATH, "application/pdf")
        voice_key = upload_file(
            client, "/api/audio/upload", voice_upload_path, "audio/wav"
        )

        payload = {
            "job_id": job_id,
            "pdf_r2_key": pdf_key,
            "voice_r2_key": voice_key,
            "start_time": 0,
            "end_time": 30,
            "webhook_url": "https://httpbin.org/post",
            "book_title": "Echo Test Full E2E",
            "voice_name": "Ntw-enhanced-v2",
            "r2_bucket_name": "echomancer-audio",
            "pipeline_mode": "hybrid",
            "qwen_speaker": "Ryan",
            "qwen_language": "English",
        }

        call_id = trigger_audiobook(client, payload)
        print(f"Spawned Modal call_id={call_id}")
        print(f"Polling for {output_key} (up to 2h) ...")

        if not poll_output(client, output_key):
            print("Timed out waiting for audiobook MP3")
            return 1

        download_output(client, output_key, OUT_MP3)

    print(f"SUCCESS: full hybrid audiobook at {OUT_MP3}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())