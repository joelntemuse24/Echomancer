"""Measures whether GPU Memory Snapshots remove the torch.compile cold start.

Two apps differ only in `enable_memory_snapshot`. Both load a 36-layer
transformer and call `torch.compile` on it inside `@modal.enter(snap=True)`, so
the comparison isolates the snapshot mechanism.

Why not compile during the image build: Modal image builders have no GPU, so a
CUDA compile step fails with "No NVIDIA driver on your system". That was the
first thing this probe was written to test, and it does not work.

    modal run modal/s2_compile_probe.py::compare --repeats 2

Creates apps named `echomancer-s2-snapshot-*` and touches no production state.
"""

from __future__ import annotations

import modal

GPU = "A10"
D_MODEL = 1024
N_LAYERS = 36
SEQ = 2048

_base = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.5.1", "numpy<2")
    .run_commands("echo image ok")
)


def _model_factory():
    """A 36-layer fp16 stack on CUDA, sized like S2-Pro's slow backbone."""
    import torch

    class Stack(torch.nn.Module):
        def __init__(self, d: int = D_MODEL, n: int = N_LAYERS) -> None:
            super().__init__()
            self.layers = torch.nn.ModuleList(
                [
                    torch.nn.TransformerEncoderLayer(
                        d, 8, 4 * d, batch_first=True,
                        dtype=torch.float16, device="cuda",
                    )
                    for _ in range(n)
                ]
            )

        def forward(self, x):
            for layer in self.layers:
                x = layer(x)
            return x

    return Stack()


def _build_worker(cls_name: str, label: str, snapshot: bool):
    """One app class, optionally snapshot-enabled.

    Modal keys classes by Python name, so each gets a distinct name via `type()`
    rather than renaming after decoration (which is too late).
    """

    def load(self):
        import time

        import torch

        self.t0 = time.time()
        self.model = torch.compile(_model_factory(), mode="reduce-overhead")
        # A forward pass pulls autotuning into the snapshot, matching the
        # documented pattern for guaranteeing a warm restore.
        x = torch.randn(1, SEQ, D_MODEL, device="cuda", dtype=torch.float16)
        with torch.no_grad():
            self.model(x)
        torch.cuda.synchronize()
        self.warm_at = time.time()
        print(f"[{label}] init {self.warm_at - self.t0:.1f}s")

    def publish(self):
        import time

        self.ready_at = time.time()
        print(f"[{label}] post-snapshot {self.ready_at - self.warm_at:.1f}s")

    def report(self):
        import time

        import torch

        t0 = time.time()
        x = torch.randn(1, SEQ, D_MODEL, device="cuda", dtype=torch.float16)
        with torch.no_grad():
            self.model(x)
        torch.cuda.synchronize()
        return {
            "label": label,
            "snapshot": snapshot,
            "init_s": round(self.warm_at - self.t0, 1),
            "post_s": round(self.ready_at - self.warm_at, 1),
            "boot_s": round(self.ready_at - self.t0, 1),
            "first_infer_s": round(time.time() - t0, 2),
        }

    kwargs: dict = {
        "image": _base,
        "gpu": GPU,
        "timeout": 1800,
    }
    if snapshot:
        kwargs["enable_memory_snapshot"] = True
        kwargs["experimental_options"] = {"enable_gpu_snapshot": True}

    body = {
        "load": modal.enter(snap=True)(load),
        "publish": modal.enter()(publish),
        "report": modal.method()(report),
    }
    return app.cls(**kwargs)(type(cls_name, (object,), body))


app = modal.App("echomancer-s2-snapshot-probe")

WithSnapshot = _build_worker("WithSnapshotWorker", "snapshot", True)
NoSnapshot = _build_worker("NoSnapshotWorker", "plain", False)


@app.local_entrypoint()
def compare(repeats: int = 1) -> None:
    print(f"gpu={GPU} seq={SEQ} layers={N_LAYERS} repeats={repeats}\n")
    for _ in range(repeats):
        for cls in (NoSnapshot, WithSnapshot):
            r = cls().report.remote()
            print(
                f"  {r['label']:9} init {r['init_s']:6.1f}s  "
                f"post {r['post_s']:5.1f}s  boot {r['boot_s']:6.1f}s  "
                f"first infer {r['first_infer_s']:5.2f}s"
            )
        print()
