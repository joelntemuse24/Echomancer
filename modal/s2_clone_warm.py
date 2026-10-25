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

# An app object is required to host `local_entrypoint`; nothing is deployed
# from this file. The worker lives in s2_clone_service.py.
app = modal.App("echomancer-s2-clone-warm")

APP_NAME = "echomancer-s2-clone"
CLASS_NAME = "S2CloneWorker"
SAMPLE_TEXT = (
    "The river had not moved for three days. Elena stood at the window and "
    "watched the light change on the water."
)


def main(reference_audio: str) -> None:
    """One call builds the snapshot (on a fresh deploy) and proves the path works.

    `synthesize_section` shares all model, codec and mastering code with the
    HTTP endpoint, so a success here means the deploy is good.
    """
    worker = modal.Cls.from_name(APP_NAME, CLASS_NAME)
    audio = ref_text = ""
    if reference_audio:
        path = pathlib.Path(reference_audio)
        audio = base64.b64encode(path.read_bytes()).decode()
        transcript = path.with_suffix(path.suffix + ".txt")
        if transcript.exists():
            ref_text = transcript.read_text(encoding="utf-8").strip()

    started = time.time()
    result = worker().synthesize_section.remote(SAMPLE_TEXT, audio, ref_text, "0.9,0.9")
    elapsed = time.time() - started
    print(f"container answered in {elapsed:.0f}s")
    print({k: v for k, v in result.items() if k != "audio_b64"})
    print(
        "\nIf that took ~15 min this call built the snapshot. Later calls "
        "restore it (~20 s cold, seconds warm)."
    )


@app.local_entrypoint()
def warm(reference_audio: str = "") -> None:
    """Build the GPU snapshot after a deploy; optionally use a real clip."""
    print(f"warming {APP_NAME}.{CLASS_NAME} …")
    main(reference_audio)
    if not reference_audio:
        print(
            "\nPass --reference-audio path/to/clip.mp3 (with an optional .txt "
            "transcript beside it) to exercise a real clone."
        )
