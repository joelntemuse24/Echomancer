"""Build the clone service's GPU snapshot after a deploy.

Run this right after `modal deploy modal/s2_clone_service.py`:

    modal run modal/s2_clone_warm.py

Why not just call the endpoint: Modal's web proxy drops a request at ~542 s,
and a fresh snapshot takes ~15 min. The container is killed mid-compile, so the
snapshot never finishes and every later call repeats the same 9-minute death.
This talks to the class over the client RPC, which has no proxy limit.

It also exercises both endpoints' code path, so a broken deploy fails here
rather than on a customer's book.

Optional: pass a reference clip to warm the clone encode path too.
"""

import base64
import pathlib
import time

import modal

APP_NAME = "echomancer-s2-clone"
CLASS_NAME = "S2CloneWorker"
SAMPLE_TEXT = (
    "The river had not moved for three days. Elena stood at the window and "
    "watched the light change on the water."
)


def main() -> None:
    worker = modal.Cls.from_name(APP_NAME, CLASS_NAME)
    started = time.time()
    timings = worker().timings.remote()
    print(f"container ready in {time.time() - started:.0f}s: {timings}")
    print(
        "\nNow confirm the HTTP endpoint answers, e.g. one section with "
        "synthesize_batch. A warm container responds in seconds."
    )


@app.local_entrypoint()
def warm(reference_audio: str = "") -> None:
    """Start one container so its snapshot exists; optionally test a real clip."""
    print(f"warming {APP_NAME}.{CLASS_NAME} …")
    main()

    if reference_audio:
        path = pathlib.Path(reference_audio)
        audio = base64.b64encode(path.read_bytes()).decode()
        transcript = path.with_suffix(path.suffix + ".txt")
        text = transcript.read_text(encoding="utf-8").strip() if transcript.exists() else ""
        worker = modal.Cls.from_name(APP_NAME, CLASS_NAME)
        result = worker().synthesize_section.remote(
            SAMPLE_TEXT, audio, text, "0.9,0.9"
        )
        print({k: v for k, v in result.items() if k != "audio_b64"})
