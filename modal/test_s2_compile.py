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


def _tiny_model(module, *, num_codebooks=2, vocab=32, dim=32, max_seq_len=2048):
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
        max_seq_len=max_seq_len,
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

    `_BatchEngine.__init__` and `recompile_step()` both delegate to
    `_compile_step()`, which calls `_configure_dynamo_for_step()` before
    `torch.compile(...)`.
    """
    module = _load("v10")
    import inspect

    init_src = inspect.getsource(module._BatchEngine.__init__)
    assert "self.step = self._compile_step()" in init_src
    compile_src = inspect.getsource(module._BatchEngine._compile_step)
    assert compile_src.index("_configure_dynamo_for_step()") < compile_src.index(
        "torch.compile("
    ), "Dynamo flags are read when the graph is traced, so configure must run first"
    cfg_src = inspect.getsource(module._BatchEngine._configure_dynamo_for_step)
    assert "specialize_float" in cfg_src
    assert "recompile_limit" in cfg_src
    assert "cache_size_limit" in cfg_src
    assert "accumulated_recompile_limit" in cfg_src


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
    assert "NEW_ENGINE and FAST_DECODE and CUDAGRAPHS and skips" in source
    assert "raise RuntimeError" in source, (
        "a skipped graph must fail the boot, not be a note in a log"
    )


def test_bucketing_stays_off_even_when_explicitly_set_with_fast_decode_off():
    """`S2B_FAST_DECODE=0 S2B_BUCKET=1` must still disable bucketing."""
    os.environ["S2B_FAST_DECODE"] = "0"
    os.environ["S2B_BUCKET"] = "1"
    _KEEP_ON_LOAD.update({"S2B_FAST_DECODE", "S2B_BUCKET"})
    try:
        module = _load("v10")
        assert module.FAST_DECODE is False
        assert module.BUCKET_BATCH is False
    finally:
        _KEEP_ON_LOAD.difference_update({"S2B_FAST_DECODE", "S2B_BUCKET"})
        os.environ.pop("S2B_FAST_DECODE", None)
        os.environ.pop("S2B_BUCKET", None)
        os.environ.pop("S2C_ENGINE", None)


@pytest.mark.parametrize(
    "sdpa,topk",
    [("0", "0"), ("1", "0"), ("0", "1"), ("1", "1")],
)
def test_v10_aot_autograd_graph_has_zero_cpu_placeholders_or_ops(sdpa, topk):
    """Run Dynamo + AOTAutograd + Inductor decompositions on a `meta` model.

    `backend="eager"` runs on CPU where every tensor is already on CPU, so it
    cannot distinguish an accidental 0-D CPU scalar placeholder (`arg10_1`)
    from a weight tensor. Placing the model and inputs on `torch.device("meta")`
    makes every real model tensor `meta` while any unspecialized Python float
    wrapped by Dynamo arrives in AOTAutograd as `device(type="cpu")`.
    """
    from fish_speech.models.text2semantic.llama import (
        DualARModelArgs,
        DualARTransformer,
    )
    from functorch.compile import make_boxed_func
    from torch._dynamo.backends.common import aot_autograd
    from torch._inductor.compile_fx import select_decomp_table

    os.environ["S2B_SDPA_DECODE"] = sdpa
    os.environ["S2B_TOPK_FAST_SAMPLE"] = topk
    _KEEP_ON_LOAD.update({"S2B_SDPA_DECODE", "S2B_TOPK_FAST_SAMPLE"})
    prev_spec = torch._dynamo.config.specialize_float
    try:
        module = _load("v10")
        torch._dynamo.config.specialize_float = True
        args = DualARModelArgs(
            vocab_size=256,
            n_layer=1,
            n_head=4,
            dim=32,
            intermediate_size=64,
            n_local_heads=2,
            head_dim=8,
            num_codebooks=2,
            codebook_size=32,
            semantic_begin_id=100,
            semantic_end_id=131,
            n_fast_layer=1,
            fast_dim=32,
            fast_n_head=4,
            fast_n_local_heads=2,
            fast_head_dim=8,
            fast_intermediate_size=64,
            scale_codebook_embeddings=True,
            norm_fastlayer_input=True,
            attention_qk_norm=True,
            rope_base=10_000,
        )
        with torch.device("meta"):
            model = DualARTransformer(args).eval().to(dtype=torch.bfloat16)
            model.setup_caches(
                max_batch_size=module.BATCH, max_seq_len=512, dtype=torch.bfloat16
            )
            engine = object.__new__(module._BatchEngine)
            engine.model = model
            engine.cfg = model.config
            engine.device = torch.device("meta")
            engine.dtype = torch.bfloat16
            engine.im_end_id = 255
            engine.top_k = 5
            engine.fast_pos = torch.arange(args.num_codebooks, dtype=torch.long)
            engine.high_temperature = torch.tensor(1.0, dtype=torch.bfloat16)
            engine.high_top_p = torch.tensor(0.9, dtype=torch.bfloat16)
            engine.codebook_offsets = (
                torch.arange(args.num_codebooks, dtype=torch.long) * args.codebook_size
            )[None, :, None]
            engine.scale_codebook_embeddings = True
            engine.codebook_inv_scale = 1.0 / math.sqrt(args.num_codebooks + 1)
            allowed = list(range(args.semantic_begin_id, args.semantic_end_id + 1)) + [255]
            engine.allowed_ids = torch.tensor(allowed, dtype=torch.long)
            engine.out_weight = model.embeddings.weight[engine.allowed_ids].contiguous()

            call_sets = []
            for w in (1, 4, module.BATCH):
                x = torch.zeros((w, args.num_codebooks + 1, 1), dtype=torch.long)
                pos = torch.full((w,), 127, dtype=torch.long)
                prev = torch.zeros(
                    (w, args.num_codebooks + 1, module.RAS_WIN_SIZE), dtype=torch.long
                )
                temp = torch.tensor([0.7], dtype=torch.bfloat16)
                topp = torch.tensor([0.7], dtype=torch.bfloat16)
                call_sets.append((w, x, pos, 512, prev, temp, topp))

        seen_cpu_placeholders: list[tuple] = []
        seen_cpu_ops: list[tuple] = []

        def fw_compiler(fw_gm, fw_inps):
            placeholders = [n for n in fw_gm.graph.nodes if n.op == "placeholder"]
            for node, val in zip(placeholders, fw_inps):
                if isinstance(val, torch.Tensor) and val.device.type == "cpu" and node.users:
                    seen_cpu_placeholders.append((node.name, val.shape, val.dtype))
            for node in fw_gm.graph.nodes:
                val = node.meta.get("val")
                if isinstance(val, torch.Tensor) and val.device.type == "cpu":
                    seen_cpu_ops.append((node.name, str(node.target)))
            return make_boxed_func(fw_gm.forward)

        torch._dynamo.reset()
        step = torch.compile(
            engine._decode_step,
            backend=aot_autograd(
                fw_compiler=fw_compiler, decompositions=select_decomp_table()
            ),
            fullgraph=True,
            dynamic=True,
        )
        with torch.inference_mode():
            for w, *c_args in call_sets:
                out = step(*c_args)
                assert out.shape == (w, args.num_codebooks + 1)

        assert seen_cpu_placeholders == [], (
            f"surviving CPU placeholders in AOT forward graph: {seen_cpu_placeholders}"
        )
        assert seen_cpu_ops == [], (
            f"surviving CPU ops in AOT forward graph: {seen_cpu_ops}"
        )
    finally:
        torch._dynamo.config.specialize_float = prev_spec
        _KEEP_ON_LOAD.difference_update({"S2B_SDPA_DECODE", "S2B_TOPK_FAST_SAMPLE"})
        os.environ.pop("S2B_SDPA_DECODE", None)
        os.environ.pop("S2B_TOPK_FAST_SAMPLE", None)
        os.environ.pop("S2C_ENGINE", None)


def test_disabling_specialize_float_exposes_the_arg10_1_cpu_placeholders():
    """Negative proof: with `specialize_float=False`, AOT sees CPU placeholders."""
    from fish_speech.models.text2semantic.llama import (
        DualARModelArgs,
        DualARTransformer,
    )
    from functorch.compile import make_boxed_func
    from torch._dynamo.backends.common import aot_autograd
    from torch._inductor.compile_fx import select_decomp_table

    prev_spec = torch._dynamo.config.specialize_float
    try:
        module = _load("v10")
        torch._dynamo.config.specialize_float = False
        args = DualARModelArgs(
            vocab_size=256,
            n_layer=1,
            n_head=4,
            dim=32,
            intermediate_size=64,
            n_local_heads=2,
            head_dim=8,
            num_codebooks=2,
            codebook_size=32,
            semantic_begin_id=100,
            semantic_end_id=131,
            n_fast_layer=1,
            fast_dim=32,
            fast_n_head=4,
            fast_n_local_heads=2,
            fast_head_dim=8,
            fast_intermediate_size=64,
            scale_codebook_embeddings=True,
            norm_fastlayer_input=True,
            attention_qk_norm=True,
            rope_base=10_000,
        )
        with torch.device("meta"):
            model = DualARTransformer(args).eval().to(dtype=torch.bfloat16)
            model.setup_caches(
                max_batch_size=module.BATCH, max_seq_len=512, dtype=torch.bfloat16
            )
            engine = object.__new__(module._BatchEngine)
            engine.model = model
            engine.cfg = model.config
            engine.device = torch.device("meta")
            engine.dtype = torch.bfloat16
            engine.im_end_id = 255
            engine.top_k = 5
            engine.fast_pos = torch.arange(args.num_codebooks, dtype=torch.long)
            engine.high_temperature = torch.tensor(1.0, dtype=torch.bfloat16)
            engine.high_top_p = torch.tensor(0.9, dtype=torch.bfloat16)
            engine.codebook_offsets = (
                torch.arange(args.num_codebooks, dtype=torch.long) * args.codebook_size
            )[None, :, None]
            engine.scale_codebook_embeddings = True
            engine.codebook_inv_scale = 1.0 / math.sqrt(args.num_codebooks + 1)
            allowed = list(range(args.semantic_begin_id, args.semantic_end_id + 1)) + [255]
            engine.allowed_ids = torch.tensor(allowed, dtype=torch.long)
            engine.out_weight = model.embeddings.weight[engine.allowed_ids].contiguous()

            x = torch.zeros((4, args.num_codebooks + 1, 1), dtype=torch.long)
            pos = torch.full((4,), 127, dtype=torch.long)
            prev = torch.zeros(
                (4, args.num_codebooks + 1, module.RAS_WIN_SIZE), dtype=torch.long
            )
            temp = torch.tensor([0.7], dtype=torch.bfloat16)
            topp = torch.tensor([0.7], dtype=torch.bfloat16)

        cpu_names: list[str] = []

        def fw_compiler(fw_gm, fw_inps):
            placeholders = [n for n in fw_gm.graph.nodes if n.op == "placeholder"]
            for node, val in zip(placeholders, fw_inps):
                if isinstance(val, torch.Tensor) and val.device.type == "cpu" and node.users:
                    cpu_names.append(node.name)
            return make_boxed_func(fw_gm.forward)

        torch._dynamo.reset()
        step = torch.compile(
            engine._decode_step,
            backend=aot_autograd(
                fw_compiler=fw_compiler, decompositions=select_decomp_table()
            ),
            fullgraph=True,
            dynamic=True,
        )
        with torch.inference_mode():
            step(x, pos, 512, prev, temp, topp)

        assert len(cpu_names) > 0, (
            "expected specialize_float=False to surface CPU float64 placeholders"
        )
    finally:
        torch._dynamo.config.specialize_float = prev_spec
        os.environ.pop("S2C_ENGINE", None)


def test_recompile_step_replaces_the_compiled_wrapper():
    """Post-restore recapture must replace `engine.step`, not keep a dead closure."""
    module = _load("v10")
    model = _tiny_model(module)
    engine = _engine(module, model)
    sentinel = lambda *a, **k: None
    engine.step = sentinel
    engine._compile_step = lambda: torch.compile(
        engine._decode_step, backend="eager", fullgraph=True, dynamic=True
    )
    engine.recompile_step()
    assert engine.step is not sentinel
    with torch.inference_mode():
        out = engine.step(*_args(module, 1, model.config.num_codebooks))
    assert out.shape == (1, model.config.num_codebooks + 1)


def test_compile_step_configures_dynamo_limits_for_24_shapes():
    """`recompile_limit` (default 8) must be raised well past 24 shapes."""
    module = _load("v10")
    model = _tiny_model(module, max_seq_len=4096)
    engine = _engine(module, model)
    engine.model.max_seq_len = 4104
    shapes = engine.decode_shapes()
    assert len(shapes) == 24
    per_fn, accumulated = module.dynamo_compile_limits(len(shapes))
    assert per_fn >= len(shapes) * 2 + 16
    assert accumulated >= per_fn * 8

    cfg = torch._dynamo.config
    saved = {
        k: getattr(cfg, k)
        for k in (
            "specialize_float",
            "recompile_limit",
            "cache_size_limit",
            "accumulated_recompile_limit",
            "accumulated_cache_size_limit",
        )
        if hasattr(cfg, k)
    }
    try:
        for k in ("recompile_limit", "cache_size_limit"):
            if hasattr(cfg, k):
                setattr(cfg, k, 8)
        for k in ("accumulated_recompile_limit", "accumulated_cache_size_limit"):
            if hasattr(cfg, k):
                setattr(cfg, k, 64)
        engine._configure_dynamo_for_step()
        assert cfg.specialize_float is True
        assert cfg.recompile_limit >= per_fn
        assert cfg.cache_size_limit >= per_fn
        assert cfg.accumulated_recompile_limit >= accumulated
        assert cfg.accumulated_cache_size_limit >= accumulated
    finally:
        for k, v in saved.items():
            setattr(cfg, k, v)


def test_warming_all_24_shapes_and_rendering_never_trips_recompile_limit():
    """Exact staging failure regression: warm 24 shapes + replay + render.

    Reproduces the production geometry that failed after shape 7 on staging:
    `max_seq_len=4096` (with v10's `+8` KV padding = `4104` so `kv_len=4096`
    never flips `524288 != 128*kv_len`), `head_dim=128`, narrow + wide renders,
    all 24 `(width, kv_len)` shapes x 3 warm steps, 24 post-restore replays,
    and a subsequent pipelined `render()`.

    Asserts:
      1. Every step input tensor (`x, pos, prev, temp, topp`) across every call
         is an inference tensor (`t.is_inference() is True`), so the
         `DispatchKeySet(..., ADInplaceOrView)` guard never fires.
      2. Even with `recompile_limit = 8` (PyTorch's unraised default), warming
         all 24 shapes + replaying + rendering succeeds without hitting the cap.
      3. Distinct compiled graphs (`_decode_step_compiles` and backend count)
         stays `<= 2` (`width==1` and `width>=2`), well under the 24 shape count.
    """
    from fish_speech.models.text2semantic.llama import (
        DualARModelArgs,
        DualARTransformer,
    )

    module = _load("v10")
    args = DualARModelArgs(
        vocab_size=256,
        n_layer=1,
        n_head=32,
        dim=128,
        intermediate_size=256,
        n_local_heads=8,
        head_dim=128,
        max_seq_len=4096,
        num_codebooks=2,
        codebook_size=32,
        semantic_begin_id=100,
        semantic_end_id=131,
        n_fast_layer=1,
        fast_dim=64,
        fast_n_head=4,
        fast_n_local_heads=2,
        fast_head_dim=16,
        fast_intermediate_size=64,
        scale_codebook_embeddings=True,
        norm_fastlayer_input=True,
        attention_qk_norm=True,
        rope_base=10_000,
    )
    torch.manual_seed(0)
    model = DualARTransformer(args).eval().to(dtype=torch.bfloat16)
    with torch.device("cpu"):
        model.setup_caches(
            max_batch_size=module.BATCH, max_seq_len=4096 + 8, dtype=torch.bfloat16
        )

    class _FakeDecoder(torch.nn.Module):
        frame_length = 4
        sample_rate = 1000

        def from_indices(self, z):
            return torch.zeros((z.shape[0], 1, z.shape[1] * 4), dtype=torch.float32)

    engine = _engine(module, model)
    engine.dtype = torch.bfloat16
    engine.high_temperature = torch.tensor(1.0, dtype=torch.bfloat16)
    engine.high_top_p = torch.tensor(0.9, dtype=torch.bfloat16)
    engine.decoder = _FakeDecoder()
    engine.frame_length = 4
    engine.sample_rate = 1000
    engine.codec_stream = object()  # enable `_replay_decode_shapes`
    engine.selftest_stats = {}
    engine._last_audio = {}
    engine.build_prompt = lambda ref, history, text: torch.zeros(
        (args.num_codebooks + 1, 8), dtype=torch.long
    )
    call_counter = {"steps": 0}
    non_inference_inputs: list[tuple[int, str]] = []

    cfg = torch._dynamo.config
    saved_spec = cfg.specialize_float
    saved_recomp = cfg.recompile_limit
    saved_cache = cfg.cache_size_limit
    try:
        torch._dynamo.reset()
        cfg.specialize_float = True
        # Deliberately keep the tight default 8 here to prove the root causes
        # (DispatchKeySet + 524288 != 128*kv_len) are gone, not just masked!
        cfg.recompile_limit = 8
        cfg.cache_size_limit = 8

        backend_compiles: list[int] = []

        def counting_backend(gm, inps):
            backend_compiles.append(len(backend_compiles) + 1)
            return gm.forward

        compiled_step = torch.compile(
            engine._decode_step, backend=counting_backend, fullgraph=True, dynamic=True
        )

        def checked_step(x, pos, kv_len: int, prev, temperature, top_p):
            call_counter["steps"] += 1
            for label, tensor in (
                ("x", x),
                ("pos", pos),
                ("prev", prev),
                ("temperature", temperature),
                ("top_p", top_p),
            ):
                if not tensor.is_inference():
                    non_inference_inputs.append((call_counter["steps"], label))
            return compiled_step(x, pos, kv_len, prev, temperature, top_p)

        engine.step = checked_step

        # 1. Narrow + wide pipelined renders (`start_lane` requires max_frames >= 64).
        old_max_frames = module.MAX_NEW_FRAMES
        old_eos_every = module.EOS_CHECK_EVERY
        module.MAX_NEW_FRAMES = 64
        module.EOS_CHECK_EVERY = 2
        try:
            engine.codec_stream = None
            engine.render([[{"text": "a", "pause": "para"}]], None, "0.7,0.7")
            engine.render(
                [[{"text": "a", "pause": "para"}] for _ in range(4)], None, "0.7,0.7"
            )
            # 2. All 24 shapes x 3 steps (`_warm_kv_buckets`).
            shapes = engine.decode_shapes()
            assert len(shapes) == 24
            warmed = engine._warm_kv_buckets()
            assert warmed == 24
            # 3. Post-restore replay of all 24 shapes (`_replay_decode_shapes`).
            engine.codec_stream = object()
            replayed = engine._replay_decode_shapes()
            assert replayed == 24
            # 4. Another live render after warm-up: must add 0 compiles.
            compiles_after_warm = len(backend_compiles)
            engine.codec_stream = None
            engine.render(
                [[{"text": "a", "pause": "para"}, {"text": "b", "pause": "para"}] for _ in range(3)],
                None,
                "0.7,0.7",
            )
            assert len(backend_compiles) == compiles_after_warm, (
                "a live render after warm-up triggered an unexpected recompile"
            )
        finally:
            module.MAX_NEW_FRAMES = old_max_frames
            module.EOS_CHECK_EVERY = old_eos_every

        assert non_inference_inputs == [], (
            f"step received non-inference tensor(s) (ADInplaceOrView mismatch): "
            f"{non_inference_inputs[:5]}"
        )
        cache_entries = module._decode_step_compiles(engine._decode_step)
        assert cache_entries == len(backend_compiles)
        assert len(backend_compiles) <= len(shapes)
        assert len(backend_compiles) <= 2, (
            f"expected at most 2 compiles (width==1 and width>=2), got {len(backend_compiles)}"
        )
    finally:
        cfg.specialize_float = saved_spec
        cfg.recompile_limit = saved_recomp
        cfg.cache_size_limit = saved_cache
        torch._dynamo.reset()


def test_selftest_rejects_compile_count_above_declared_shapes(monkeypatch):
    """`selftest()` must fail loudly if `_decode_step` compiled more graphs than shapes."""
    module = _load("v10")
    model = _tiny_model(module)
    engine = _engine(module, model)
    engine.device_name = "cpu-stub"
    engine.codec_stream = None
    engine.decoder_tuning = {}
    engine.decode_codes = lambda codes, micro_batch=None: [torch.zeros(16)] * len(codes)
    monkeypatch.setattr(module, "_decode_step_compiles", lambda _fn: 99)
    with pytest.raises(RuntimeError, match="exceeding the .* declared decode shapes"):
        engine.selftest()


def test_fast_decode_off_warms_only_full_batch_width():
    """`S2B_FAST_DECODE=0` disables bucketing, so `decode_shapes()` stays at `BATCH`."""
    os.environ["S2B_FAST_DECODE"] = "0"
    _KEEP_ON_LOAD.add("S2B_FAST_DECODE")
    try:
        module = _load("v10")
        model = _tiny_model(module)
        engine = _engine(module, model)
        widths = {w for w, _ in engine.decode_shapes()}
        assert widths == {module.BATCH}
    finally:
        _KEEP_ON_LOAD.discard("S2B_FAST_DECODE")
        os.environ.pop("S2B_FAST_DECODE", None)
        os.environ.pop("S2C_ENGINE", None)
