"""`_decode_step` must actually compile, for both engines.

Every other test in this directory bypasses `torch.compile`. `_runnable_engine`
sets `engine.step = engine._decode_step` so the loop is testable on a CPU, which
means none of them ever ran Dynamo, AOTAutograd or Inductor. Two production bugs
lived in exactly that gap:

* the v9 path called `globals().get("logits_to_probs")`, and
  `torch.compile(fullgraph=True)` refuses to trace the `globals` builtin — so the
  **default** engine failed to compile at boot, before a single section;
* a `float` attribute read inside the step (`codebook_inv_scale`, every
  `RMSNorm.eps`) was wrapped by Dynamo as a 0-D CPU `float64` placeholder, which
  Inductor then reported as `skipping cudagraphs due to cpu device (arg10_1)`.

Both are silent failures in the worst way: the call still returns audio, about
twice as slowly, and only a log grep notices. So these tests compile the real
method with the real arguments and assert it traces, runs, and agrees with eager.

They use `backend="eager"` for the tracing assertions: Dynamo, AOTAutograd and
the `fullgraph=True` contract are what the bugs were in, and `eager` runs in about
a second where `inductor` needs a C++ toolchain and a minute. `backend="inductor"`
is exercised by the CUDA-graph tests, which skip without a GPU.
"""

from __future__ import annotations

import importlib
import math
import os
import sys
import types

import pytest

torch = pytest.importorskip("torch")

MODAL_DIR = __import__("pathlib").Path(__file__).parent


def _fish_source() -> str | None:
    from test_s2_numerics import _fish_source as find

    return find()


@pytest.fixture(scope="module", autouse=True)
def _stubs():
    from test_s2_service_import import Recorder, _install_stubs

    _install_stubs(Recorder())
    source = _fish_source()
    if source is None:
        pytest.skip("the pinned fish-speech source is not available")
    if source not in sys.path:
        sys.path.insert(0, source)
    if str(MODAL_DIR) not in sys.path:
        sys.path.insert(0, str(MODAL_DIR))


#: Switches a test may set before calling `_load`. Cleared by default so one
#: test's environment cannot leak into the next, but preserved when the caller
#: set them deliberately (the bucketing guard test does).
_KEEP_ON_LOAD: set[str] = set()


def _load(engine: str):
    """Import `s2_batch` fresh for one engine, with the container's bindings."""
    os.environ["S2C_ENGINE"] = engine
    for key in ("S2B_FAST_DECODE", "S2B_BUCKET", "S2B_WORK_STEAL"):
        if key not in _KEEP_ON_LOAD:
            os.environ.pop(key, None)
    sys.modules.pop("s2_batch", None)
    module = importlib.import_module("s2_batch")
    # `with gpu_image.imports():` only executes in the GPU image. Bind the same
    # upstream functions so the compile path sees exactly what the container sees.
    from test_s2_numerics import _upstream_inference_functions

    names = _upstream_inference_functions()
    assert names, "the pinned upstream sampler is required for a faithful compile"
    module.logits_to_probs = names["logits_to_probs"]
    module.multinomial_sample_one_no_sync = names["multinomial_sample_one_no_sync"]
    return module


def _tiny_model(module, *, num_codebooks=2, vocab=32, dim=32):
    from fish_speech.models.text2semantic.llama import (
        DualARModelArgs,
        DualARTransformer,
    )

    args = DualARModelArgs(
        vocab_size=256,
        n_layer=1,
        n_head=4,
        dim=dim,
        intermediate_size=64,
        n_local_heads=2,
        head_dim=8,
        num_codebooks=num_codebooks,
        codebook_size=vocab,
        semantic_begin_id=100,
        semantic_end_id=100 + vocab - 1,
        n_fast_layer=1,
        fast_dim=32,
        fast_n_head=4,
        fast_n_local_heads=2,
        fast_head_dim=8,
        fast_intermediate_size=64,
        scale_codebook_embeddings=True,
        norm_fastlayer_input=True,
        rope_base=10_000,
    )
    torch.manual_seed(0)
    model = DualARTransformer(args).eval()
    with torch.device("cpu"):
        model.setup_caches(
            max_batch_size=module.BATCH, max_seq_len=512, dtype=torch.float32
        )
    return model


def _engine(module, model):
    """The attributes `_decode_step` reads, exactly as `__init__` sets them."""
    cfg = model.config
    engine = object.__new__(module._BatchEngine)
    engine.model = model
    engine.cfg = cfg
    engine.device = torch.device("cpu")
    engine.dtype = torch.float32
    engine.im_end_id = cfg.vocab_size - 1
    engine.top_k = 5
    engine.fast_pos = torch.arange(cfg.num_codebooks, dtype=torch.long)
    engine.high_temperature = torch.tensor(1.0)
    engine.high_top_p = torch.tensor(0.9)
    engine.codebook_offsets = (
        torch.arange(cfg.num_codebooks, dtype=torch.long) * cfg.codebook_size
    )[None, :, None]
    engine.scale_codebook_embeddings = True
    engine.codebook_inv_scale = 1.0 / math.sqrt(cfg.num_codebooks + 1)
    allowed = list(range(cfg.semantic_begin_id, cfg.semantic_end_id + 1))
    allowed.append(engine.im_end_id)
    engine.allowed_ids = torch.tensor(allowed, dtype=torch.long)
    engine.out_weight = model.embeddings.weight[engine.allowed_ids].contiguous()
    return engine


def _args(module, width: int, num_codebooks: int = 2, kv_len: int = 512):
    n = num_codebooks
    x = torch.zeros((width, n + 1, 1), dtype=torch.long)
    pos = torch.zeros(width, dtype=torch.long)
    prev = torch.zeros((width, n + 1, module.RAS_WIN_SIZE), dtype=torch.long)
    return x, pos, kv_len, prev, torch.tensor([0.7]), torch.tensor([0.7])


# ── the two engines ────────────────────────────────────────────────────────


@pytest.mark.parametrize("engine_name", ["v9", "v10"])
def test_the_decode_step_compiles_with_fullgraph(engine_name):
    """`fullgraph=True` must trace the **real** `_decode_step`.

    This is the assertion that would have caught the `globals()` crash before a
    deployment: the default engine could not be compiled at all, and every
    offline test passed because none of them compiled anything.
    """
    module = _load(engine_name)
    model = _tiny_model(module)
    engine = _engine(module, model)
    width = module.choose_batch_width([[{"text": "a"}, {"text": "b"}]])
    args = _args(module, width, model.config.num_codebooks)

    # Deterministic sampler: the step *draws* tokens, so two runs from one RNG
    # only agree by luck. Argmax keeps the assertion about the compiler — every
    # op, the KV-cache writes, the embedding, the fast transformer — while
    # removing the sampling noise from it.
    engine._sample = lambda logits, temperature, top_p: logits.argmax(
        dim=-1, keepdim=True
    ).long()

    # Eager first: if this fails, the failure is in the code, not the compiler.
    with torch.no_grad():
        expected = engine._decode_step(*args)

    step = torch.compile(
        engine._decode_step, backend="eager", fullgraph=True, dynamic=True
    )
    with torch.no_grad():
        got = step(*args)
    assert got.shape == expected.shape
    assert torch.equal(got, expected), (
        "the compiled step produced different tokens from the eager one"
    )


@pytest.mark.parametrize("engine_name", ["v9", "v10"])
def test_the_decode_step_survives_a_second_shape(engine_name):
    """`dynamic=True` means one graph serves several widths.

    A single-shape smoke would pass while the second width recompiled, which on
    the real container records a graph mid-request.
    """
    module = _load(engine_name)
    model = _tiny_model(module)
    engine = _engine(module, model)
    step = torch.compile(
        engine._decode_step, backend="eager", fullgraph=True, dynamic=True
    )
    n = model.config.num_codebooks
    for width in (module.choose_batch_width([[{"text": "a"}]]), module.BATCH):
        with torch.no_grad():
            out = step(*_args(module, width, n))
        assert out.shape == (width, n + 1), out.shape


# ── the float-attribute placeholders that skip CUDA graphs ────────────────


def test_the_engine_turns_on_specialize_float_before_compiling():
    """A `float` attribute read in the step must not become a 0-D CPU tensor.

    Dynamo's `specialize_float=False` (the default in the pinned torch) wraps such
    a value as `pass_arg_as_tensor=True`, i.e. a **CPU `float64` placeholder**.
    Inductor reports exactly that as `skipping cudagraphs due to cpu device
    (arg10_1)`, which is a silent 2x slowdown on every call.

    Asserted on the constructor's source rather than on the global: the flag is
    set in `_BatchEngine.__init__`, which needs a GPU here, so a test that only
    imports the module would check nothing. The ordering ("set it *before*
    `torch.compile`") is what has to hold.
    """
    module = _load("v10")
    import inspect

    source = inspect.getsource(module._BatchEngine.__init__)
    assert "specialize_float" in source, (
        "_decode_step reads self.codebook_inv_scale and RMSNorm.eps; without "
        "specialize_float they become CPU placeholders and inductor refuses to "
        "CUDA-graph the step"
    )
    assert source.index("specialize_float") < source.index("torch.compile("), (
        "the flag is read when the graph is traced, so it must be set first"
    )


def test_the_float_attributes_are_python_floats_not_tensors():
    """`specialize_float` only helps if the values really are Python floats."""
    module = _load("v10")
    model = _tiny_model(module)
    engine = _engine(module, model)
    assert isinstance(engine.codebook_inv_scale, float)
    # `RMSNorm.eps` is where the rest of them live.
    eps_values = [
        m.eps for m in model.modules() if hasattr(m, "eps")
    ]
    assert eps_values, "expected RMSNorm layers to carry an eps"
    assert all(isinstance(e, float) for e in eps_values)


def test_the_step_has_no_untraceable_constructs():
    """`globals()`, a runtime `import`, and `.item()` are all graph breaks.

    `fullgraph=True` raises on the first two rather than breaking, so this is a
    cheap static backstop for the class of bug that broke the default engine.
    """
    module = _load("v9")
    from test_s2_numerics import _code_only

    # Code, not prose: the docstrings explain the calls this must not contain.
    source = _code_only(module._BatchEngine._decode_step)
    assert "globals(" not in source
    assert "import " not in source
    assert ".item()" not in source


def test_the_sampler_is_a_module_global_not_a_runtime_lookup():
    """The v9 sampler must be bound at module scope, where the tracer sees it."""
    module = _load("v9")
    from test_s2_numerics import _code_only

    source = _code_only(module._BatchEngine._logits_to_probs)
    assert "globals(" not in source, "globals() is not traceable under fullgraph"
    # And a module-level binding exists (the container's imports block provides it).
    assert callable(getattr(module, "logits_to_probs", None))


# ── bucketing and the upstream fast step cannot both be on ────────────────


def test_bucketing_is_off_when_the_fast_step_is_off():
    """Upstream's fast step writes a `BATCH`-row KVCache.

    A narrower active batch cannot broadcast into it, so `S2B_FAST_DECODE=0`
    (a documented isolation switch) must also turn bucketing off. Otherwise the
    v10 loop prefills at `width=b` and the next fast step fails on a shape
    mismatch — after the container has already started serving.
    """
    os.environ["S2B_FAST_DECODE"] = "0"
    _KEEP_ON_LOAD.add("S2B_FAST_DECODE")
    try:
        module = _load("v10")
        assert module.FAST_DECODE is False
        assert module.BUCKET_BATCH is False, (
            "bucketing with the upstream fast step is a shape mismatch"
        )
    finally:
        _KEEP_ON_LOAD.discard("S2B_FAST_DECODE")
        os.environ.pop("S2B_FAST_DECODE", None)
        os.environ.pop("S2C_ENGINE", None)


def test_the_fast_step_path_is_used_when_bucketing_is_on():
    """The converse, so the guard above cannot be satisfied by always disabling."""
    module = _load("v10")
    assert module.FAST_DECODE is True
    assert module.BUCKET_BATCH is True


# ── the warm-up must record, not just warm up ─────────────────────────────


def test_the_warm_up_takes_three_steps_per_shape():
    """Inductor warms up, then records, then replays: one step records nothing.

    `CUDAGraphTreeManager` uses call 1 on a new shape key to warm up (eager, no
    graph) and call 2 to record. A one-step-per-shape warm-up therefore left 22
    of 24 shapes unrecorded, and `selftest()` silently became the recording call.
    """
    module = _load("v10")
    assert module.WARM_STEPS_PER_SHAPE >= 3
    import ast
    import inspect
    import textwrap

    source = textwrap.dedent(inspect.getsource(module._BatchEngine._warm_kv_buckets))
    assert "WARM_STEPS_PER_SHAPE" in source, "the step count must be the knob"
    # The step's output feeds the next iteration, as it does in `render`, so the
    # storage liveness the graph-tree manager sees matches the real loop. Checked
    # on the AST because the slice wraps across lines in the source.
    tree = ast.parse(source)
    assigns_to_x = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        and any(isinstance(t, ast.Name) and t.id == "x" for t in node.targets)
    ]
    assert any(
        any(isinstance(n, ast.Subscript) for n in ast.walk(node.value))
        for node in assigns_to_x
    ), "the warm-up must feed its own output back into x"


def test_selftest_reports_and_rejects_cudagraph_skips():
    """A skip means the step runs uncompiled, and every call still succeeds."""
    module = _load("v10")
    import inspect

    source = inspect.getsource(module._BatchEngine.selftest)
    assert "cudagraph_skips" in source
    assert "raise RuntimeError" in source, (
        "a skipped graph must fail the boot, not be a note in a log"
    )
