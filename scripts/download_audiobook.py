"""One-shot download when an audiobook job is ready. No polling loop."""
from __future__ import annotations

import sys
from pathlib import Path

import httpx

from audiobook_client import download_output, output_url

APP_BASE = "https://echomancer-v2.vercel.app"


def main() -> int:
    if len(sys.argv) < 3:
        print('Usage: python scripts/download_audiobook.py <job_id> <output.mp3>')
        return 1

    job_id = sys.argv[1]
    dest = Path(sys.argv[2])
    output_key = f"audiobooks/{job_id}/audiobook.mp3"
    url = output_url(output_key)

    with httpx.Client(follow_redirects=True) as client:
        resp = client.head(url, timeout=30.0)
        if resp.status_code != 200:
            print(f"Not ready yet ({resp.status_code}): {url}")
            return 1
        download_output(client, output_key, dest)

    print(f"SUCCESS: {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())