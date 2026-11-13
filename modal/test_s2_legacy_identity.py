"""v9 must compute what unmodified PR 283 computes, not merely look like it.

The deployed build's audio is the reference. This suite imports the **actual**
`modal/s2_batch.py` from the base branch (PR 283, `ebd7ade`) as a module, then
runs the same slots through both engines and compares:

  * the sampling distribution (`_logits_to_probs`) — bitwise,
  * the embedding (`_embed`) — bitwise,
  * one fast-transformer step and the whole `_fast` loop — bitwise,
  * the render schedule — which lane ran which `(section, unit)`.

Why the base module and not a paraphrase of it: the blocker this replaces was a
default that *looked* equivalent and was not. `torch.where(cond, vq, 0)` and
`vq * mask` are equal in exact arithmetic and differ in bfloat16; the deployed
loop pins row `r` to `slots[r]` while a longest-first scheduler permutes lanes,
and one batched RNG stream means a permuted lane consumes different random
numbers. Neither difference is visible without running both.

The base file is read out of git, so this suite skips (loudly) on a shallow or
detached checkout rather than silently passing. `S2B_BASE_REF` overrides the ref.
"""

from __future__ import annotations

import importlib.util
import linecache
import os
import pathlib
import subprocess
import sys
import types

import pytest

torch = pytest.importorskip("torch")

MODAL_DIR = pathlib.Path(__file__).parent
REPO_ROOT = MODAL_DIR.parent
BASE_REF = os.environ.get("S2B_BASE_REF", "origin/cursor/longer-clone-sections-4994")
#: PR 283's engine, as committed. The comparison is against this exact file.
BASE_COMMIT = "ebd7adeaa9ddb7267e5ff46e7cd969c66931d0ac"
BASE_PATH = "modal/s2_batch.py"


def _base_source() -> str | None:
    """`modal/s2_batch.py` from the base commit, or None when git cannot supply it."""
    for ref in (BASE_COMMIT, BASE_REF):
        try:
            out = subprocess.run(
                ["git", "show", f"{ref}:{BASE_PATH}"],
                cwd=REPO_ROOT, capture_output=True, text=True, timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if out.returncode == 0 and "class _BatchEngine" in out.stdout:
            return out.stdout
    return None


@pytest.fixture(scope="module")
def base_engine_module():
    """PR 283's `s2_batch` imported under a private name."""
    source = _base_source()
    if source is None:
        from test_s2_numerics import _skip_or_fail

        _skip_or_fail(
            f"cannot read {BASE_PATH} at {BASE_COMMIT} / {BASE_REF}; this suite "
            "needs the base branch in git to compare against"
        )
    # The base module imports `modal` and `s2_contract` at module scope, so the
    # container stubs must already be in place.
    from test_s2_service_import import Recorder, _install_stubs

    _install_stubs(Recorder())
    if str(MODAL_DIR) not in sys.path:
        sys.path.insert(0, str(MODAL_DIR))
    spec = importlib.util.spec_from_loader("s2_batch_base_283", loader=None)
    module = importlib.util.module_from_spec(spec)
    # A module built from a string has no file for `inspect.getsource` to read,
    # and one test compares the base loop's statements. Registering the source
    # under the synthetic path makes the base code inspectable like any other.
    synthetic = str(MODAL_DIR / "_s2_batch_base_283.py")
    module.__file__ = synthetic
    linecache.cache[synthetic] = (
        len(source), None, source.splitlines(keepends=True), synthetic
    )
    try:
        exec(compile(source, synthetic, "exec"), module.__dict__)
    except Exception as err:  # pragma: no cover - depends on the checkout
        pytest.skip(f"the base module could not be executed: {err}")
    # The base module also gets its sampler from `gpu_image.imports()`, which
    # does not run outside the container. Bind the same upstream functions so
    # the comparison is between two engines, not two missing names.
    from test_s2_numerics import _upstream_inference_functions

    names = _upstream_inference_functions()
    if names:
        module.logits_to_probs = names["logits_to_probs"]
        module.multinomial_sample_one_no_sync = names[
            "multinomial_sample_one_no_sync"
        ]
    return module


@pytest.fixture
def v9_engine():
    """The shipped module imported with `S2C_ENGINE` unset (the deployed default)."""
    from test_s2_service_import import Recorder, _install_stubs

    for key in ("S2C_ENGINE", "S2B_WORK_STEAL", "S2B_BUCKET"):
        os.environ.pop(key, None)
    _install_stubs(Recorder())
    sys.path.insert(0, str(MODAL_DIR))
    sys.modules.pop("s2_batch", None)
    try:
        module = importlib.import_module("s2_batch")
        # `gpu_image.imports()` inside the container binds these; a stub image
        # does not, so bind them here to exercise the real sampling function.
        from test_s2_numerics import _upstream_inference_functions

        names = _upstream_inference_functions()
        if names:
            module.logits_to_probs = names["logits_to_probs"]
            module.multinomial_sample_one_no_sync = names[
                "multinomial_sample_one_no_sync"
            ]
        yield module
    finally:
        sys.modules.pop("s2_batch", None)
        if str(MODAL_DIR) in sys.path:
            sys.path.remove(str(MODAL_DIR))


# ── a tiny model both engines can drive ───────────────────────────────────


def _tiny_model(num_codebooks: int = 4, vocab: int = 64, dim: int = 32):
    """Just enough of the S2-Pro shape for `_embed` and the fast transformer.

    Real `nn.Module`s rather than dicts, so `_tune_decoder` and `.modules()` see
    what they would on a real decoder and nothing silently no-ops.
    """
    torch.manual_seed(0)
    cfg = types.SimpleNamespace(
        num_codebooks=num_codebooks,
        codebook_size=vocab,
        semantic_begin_id=100,
        semantic_end_id=100 + vocab - 1,
        scale_codebook_embeddings=True,
        vocab_size=256,
        n_head=4,
        n_local_heads=2,
        head_dim=8,
        dim=dim,
    )
    model = torch.nn.Module()
    model.codebook_embeddings = torch.nn.Embedding(num_codebooks * vocab, dim)
    model.embeddings = torch.nn.Embedding(cfg.vocab_size, dim)
    for param in model.parameters():
        torch.nn.init.normal_(param, std=0.05)
    return types.SimpleNamespace(
        model=model,
        cfg=cfg,
        device=torch.device("cpu"),
        codebook_inv_scale=1.0 / (num_codebooks + 1) ** 0.5,
        # The v10 body reads a preallocated offsets tensor; the base body builds
        # its own. Supplying it lets one fixture drive both.
        codebook_offsets=(
            torch.arange(num_codebooks, dtype=torch.long) * vocab
        )[None, :, None],
        scale_codebook_embeddings=True,
    )


def _inputs(batch: int = 3, num_codebooks: int = 4, vocab: int = 64):
    """A legal `(B, num_codebooks + 1, 1)` decode buffer, mixed text/semantic."""
    torch.manual_seed(7)
    inp = torch.zeros((batch, num_codebooks + 1, 1), dtype=torch.long)
    inp[:, 0, 0] = torch.tensor([100, 101, 5])[:batch]
    inp[:, 1:, 0] = torch.randint(0, vocab, (batch, num_codebooks))
    return inp


# ── the two numeric contracts that actually changed ───────────────────────


def test_v9_embed_is_bitwise_the_base_embed(v9_engine, base_engine_module):
    """`torch.where(cond, vq, 0)` and `x / sqrt(n)` must not be "improved"."""
    shape = _tiny_model()
    inp = _inputs(num_codebooks=shape.cfg.num_codebooks, vocab=shape.cfg.codebook_size)
    ours = v9_engine._BatchEngine._embed(shape, inp)
    theirs = base_engine_module._BatchEngine._embed(shape, inp)
    assert torch.equal(ours, theirs), (
        "the v9 embedding must be the deployed arithmetic bit for bit; a "
        f"difference of {(ours - theirs).abs().max()} would change every take"
    )


def test_v10_embed_is_not_assumed_identical_to_v9(v9_engine, base_engine_module):
    """The v10 rewrite is a *different* arithmetic path, which is why it is gated.

    This is not a complaint about v10; it is the reason the two cannot share a
    default. In bf16 the reciprocal multiply differs from the divide, so a
    "bit-identical" claim about this rewrite would be false.
    """
    shape = _tiny_model()
    inp = _inputs(num_codebooks=shape.cfg.num_codebooks, vocab=shape.cfg.codebook_size)
    # Import the shipped module with the v10 engine selected, rather than
    # flipping a module-global a request could observe.
    import importlib

    os.environ["S2C_ENGINE"] = "v10"
    try:
        sys.modules.pop("s2_batch", None)
        v10_module = importlib.import_module("s2_batch")
        assert v10_module.LEGACY_RENDER is False
        v10 = v10_module._BatchEngine._embed(shape, inp)
    finally:
        os.environ.pop("S2C_ENGINE", None)
        sys.modules.pop("s2_batch", None)
    theirs = base_engine_module._BatchEngine._embed(shape, inp)
    # Close, not equal: this is what "same formula, different rounding" looks like.
    assert torch.allclose(v10, theirs, atol=1e-6)


def test_v9_sampling_matches_the_deployed_function(v9_engine):
    """The v9 path must call upstream's `logits_to_probs`, masked the same way.

    Upstream's function is the reference: the base module also gets it from
    `gpu_image.imports()`, so both call the same upstream code and comparing
    against it is the strongest available statement.
    """
    if not hasattr(v9_engine, "logits_to_probs"):
        from test_s2_numerics import _skip_or_fail

        _skip_or_fail("the pinned upstream sampler is not available")
    torch.manual_seed(13)
    logits = torch.randn(5, 128)
    engine = object.__new__(v9_engine._BatchEngine)
    engine.top_k = 30
    ours = v9_engine._BatchEngine._logits_to_probs(
        engine, logits, torch.tensor(0.8), torch.tensor(0.75)
    )
    # `gpu_image.imports()` is what binds the upstream function in the container;
    # the fixture does the same, so `theirs` is upstream's own code.
    theirs = v9_engine.logits_to_probs(
        logits, temperature=torch.tensor(0.8), top_p=torch.tensor(0.75), top_k=30
    )
    assert torch.equal(ours, theirs), (ours - theirs).abs().max()


def test_the_v9_sampler_failure_names_the_missing_dependency(v9_engine):
    """A missing GPU-image binding must say `fish_speech`, not `logits_to_probs`.

    The deployed path needs `fish_speech.models.text2semantic.inference`, which
    is installed only in the GPU image. If that import block ever fails to run,
    the useful message names the module; a bare `NameError` on a local variable
    sends whoever reads the log looking for a bug in this file.
    """
    engine = object.__new__(v9_engine._BatchEngine)
    engine.top_k = 30
    original = getattr(v9_engine, "logits_to_probs", None)
    try:
        # Remove the container binding, as a stub image would have.
        if original is not None:
            del v9_engine.logits_to_probs
        with pytest.raises(ModuleNotFoundError, match="fish_speech"):
            v9_engine._BatchEngine._logits_to_probs(
                engine, torch.randn(2, 8), torch.tensor(0.8), torch.tensor(0.75)
            )
    finally:
        if original is not None:
            v9_engine.logits_to_probs = original


# ── the schedule, which is the part that changes the audio ────────────────


def test_v9_never_reorders_sections_between_lanes(v9_engine):
    """Lane `r` must own `slots[r]` for the whole call, as the deployed loop does.

    One batched RNG stream means the lane index decides which random draws a
    section gets. A scheduler that assigns lanes by "longest remaining section"
    therefore renders different audio for any book with unequal section lengths —
    most books. This asserts the property directly, without a GPU: the legacy
    path has no scheduler at all, so the only lanes it can use are `0..len-1`, in
    order.
    """
    slots = [[{"text": "x" * 400}], [{"text": "y"}], [{"text": "z" * 50}]]
    # The legacy path indexes `slots[r]` with `r` from `range(BATCH)`; there is no
    # claim order to inspect, which is exactly the guarantee. Prove that by
    # checking the legacy branch does not reference the scheduler.
    import ast
    import inspect
    import textwrap

    tree = ast.parse(textwrap.dedent(inspect.getsource(v9_engine._BatchEngine._render_legacy)))
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    names |= {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    assert "_UnitScheduler" not in names
    assert "choose_batch_width" not in names
    assert "work_steal" not in {node.arg for node in ast.walk(tree) if isinstance(node, ast.arg)}
    # And it still walks sections in index order.
    source = ast.unparse(tree)
    assert "for r in range(b)" in source
    assert len(slots) == 3


def test_v9_uses_the_preallocated_cuda_fast_pos(v9_engine):
    """`torch.tensor([step])` inside the traced step is the `arg10_1` bug."""
    import ast
    import inspect
    import textwrap

    tree = ast.parse(textwrap.dedent(inspect.getsource(v9_engine._BatchEngine._fast_step)))
    legacy = [
        node
        for node in tree.body[0].body
        if isinstance(node, ast.If) and "LEGACY_RENDER" in ast.unparse(node.test)
    ]
    assert legacy, "the legacy branch must stay present and first"
    source = ast.unparse(legacy[0])
    assert "forward_generate_fast" in source
    assert "fast_pos" in source, "v9 sliced the CUDA fast_pos buffer"
    assert "torch.tensor" not in source, "v9 never built a CPU tensor in the step"


def test_v9_kv_rounding_is_the_128_token_step(v9_engine):
    assert v9_engine.LEGACY_RENDER is True
    assert v9_engine.KV_BUCKET == 128
    assert v9_engine.choose_kv_len(0) == 128
    assert v9_engine.choose_kv_len(129) == 256


def test_v9_render_dispatches_to_the_legacy_loop(v9_engine, base_engine_module):
    """The public `render` must reach `_render_legacy` and nothing else."""
    assert v9_engine.LEGACY_RENDER is True
    # Both modules must agree on the loop's constants, or "the same loop" is a
    # claim about a copy that has already drifted.
    assert v9_engine.MAX_NEW_FRAMES == base_engine_module.MAX_NEW_FRAMES
    assert v9_engine.RAS_WIN_SIZE == base_engine_module.RAS_WIN_SIZE
    assert v9_engine.BATCH == base_engine_module.BATCH
    assert v9_engine.EOS_CHECK_EVERY == base_engine_module.EOS_CHECK_EVERY


def test_the_legacy_loop_matches_the_base_loop_source(v9_engine, base_engine_module):
    """Line-for-line on the scheduling-relevant statements.

    A full textual diff would fail on comments and on names this branch renamed.
    What must not differ is the sequence of operations that decides *which*
    section a row renders and *in what order* it claims units, so those
    statements are extracted from both and compared.
    """
    import ast
    import inspect
    import textwrap

    def render_body(module, attr):
        tree = ast.parse(textwrap.dedent(inspect.getsource(attr(module))))
        return ast.unparse(tree)

    ours = render_body(
        v9_engine, lambda m: m._BatchEngine._render_legacy
    )
    theirs = render_body(base_engine_module, lambda m: m._BatchEngine.render)
    # The statements that pin a row to a section and advance its units.
    for marker in (
        "for r in range(b)",              # every row starts in index order
        "next_unit[r] >= len(slots[r])",  # a row only ever runs its own slots
        "codes[r][next_unit[r]] = unit_codes",  # takes land in the row's own slot
        "start(r)",                        # a row refills itself, no scheduler
    ):
        assert marker in ours, f"the legacy loop lost `{marker}`"
        assert marker in theirs, f"the base loop changed around `{marker}`"


def test_v10_is_the_only_engine_with_a_scheduler(v9_engine):
    """A v10-only path, so the legacy one cannot inherit it by accident."""
    import ast
    import inspect
    import textwrap

    tree = ast.parse(textwrap.dedent(inspect.getsource(v9_engine._BatchEngine.render)))
    source = ast.unparse(tree)
    assert "_render_legacy" in source
    assert "_render_pipelined" in source
    # The dispatch reads the switch this module reads once, at import.
    assert "LEGACY_RENDER" in source


# ── executed identity: tokens, not text ───────────────────────────────────
#
# The checks above compare source structure, which cannot see a difference in
# *how many rows* a step runs. PR 283's `_prefill` expands the fast transformer
# to `BATCH` rows; prefilling one row wide consumes fewer draws from the batched
# RNG stream and every later codebook token of the unit comes out different. Only
# running both and comparing tokens catches that.


def _executable_engine(module, model):
    """A `_BatchEngine` from `module` that can prefill and step on the CPU.

    Built by hand rather than by `__init__`, which needs a GPU and the 3.6 B
    checkpoint. Every attribute is one `__init__` also sets, so a missing one
    fails loudly instead of silently taking a default.
    """
    import math

    engine = object.__new__(module._BatchEngine)
    cfg = model.config
    engine.model = model
    engine.cfg = cfg
    engine.device = torch.device("cpu")
    engine.dtype = torch.float32
    engine.im_end_id = cfg.vocab_size - 1
    engine.top_k = 30
    engine.fast_pos = torch.arange(cfg.num_codebooks, dtype=torch.long)
    engine.high_temperature = torch.tensor(1.0)
    engine.high_top_p = torch.tensor(0.9)
    engine._last_audio = {}
    if hasattr(module._BatchEngine, "_kv_cache_len"):
        engine.selftest_stats = {}
        engine.codec_stream = None
    # PR 283's `_embed` builds its own offsets; this branch's v10 body reads a
    # preallocated tensor, so supply it and both work.
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


def _fresh_model(module):
    """A tiny `DualARTransformer` with two caches and a re-seedable RNG."""
    from test_s2_numerics import _fish_source

    source = _fish_source()
    if source is None:
        from test_s2_numerics import _skip_or_fail

        _skip_or_fail("the pinned fish-speech source is not available")
    if source not in sys.path:
        sys.path.insert(0, source)
    from fish_speech.models.text2semantic.llama import (
        DualARModelArgs,
        DualARTransformer,
    )

    args = DualARModelArgs(
        vocab_size=256,
        n_layer=2,
        n_head=4,
        dim=32,
        intermediate_size=64,
        n_local_heads=2,
        head_dim=8,
        num_codebooks=3,
        codebook_size=32,
        semantic_begin_id=100,
        semantic_end_id=131,
        n_fast_layer=2,
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
        # The fast transformer's cache must be exactly `BATCH` rows: `_prefill`
        # expands to that width, and the upstream `KVCache.update` writes a
        # full-width tensor, so a larger cache would not accept it (and a smaller
        # one is what production would never allocate).
        model.setup_caches(
            max_batch_size=module.BATCH, max_seq_len=1024, dtype=torch.float32
        )
    return model


def _clear(model):
    for layer in model.layers:
        layer.attention.kv_cache.k_cache.zero_()
        layer.attention.kv_cache.v_cache.zero_()
    for layer in model.fast_layers:
        layer.attention.kv_cache.k_cache.zero_()
        layer.attention.kv_cache.v_cache.zero_()


def test_prefill_produces_the_same_tokens_as_pr_283(v9_engine, base_engine_module):
    """The first frame **and its codebook tokens**, from a fixed seed.

    This is the assertion the source comparison could not make. `_prefill` ends
    in the fast transformer, which samples; PR 283 ran it over `BATCH` rows and
    kept row 0, so the RNG stream advances by `BATCH` draws per codebook step. A
    one-row prefill is numerically the same frame but leaves the stream in a
    different place, and the next unit's first semantic token already differs.
    """
    if not hasattr(v9_engine, "logits_to_probs"):
        from test_s2_numerics import _skip_or_fail

        _skip_or_fail("the pinned upstream sampler is not available")

    prompt = torch.zeros((4, 6), dtype=torch.long)  # (num_codebooks + 1, T)
    prompt[0] = 101
    prompt[1:] = 3

    def first_frames(module):
        model = _fresh_model(module)
        engine = _executable_engine(module, model)
        _clear(model)
        torch.manual_seed(1234)
        with torch.no_grad():
            return engine._prefill(0, prompt, torch.tensor([0.7]), torch.tensor([0.7]))

    ours = first_frames(v9_engine)
    theirs = first_frames(base_engine_module)
    assert ours.shape == theirs.shape
    assert torch.equal(ours, theirs), (
        "the first frame's tokens differ from PR 283's.\n"
        f"ours:   {ours.tolist()}\n"
        f"theirs: {theirs.tolist()}"
    )


def test_prefill_leaves_the_rng_stream_where_pr_283_leaves_it(
    v9_engine, base_engine_module
):
    """The draw *after* the prefill must also match.

    The frame can be equal while the stream has moved a different distance — that
    is exactly the width bug, and it only shows up on the next sample. So this
    prefills, then draws once from the stream and compares.
    """
    if not hasattr(v9_engine, "logits_to_probs"):
        from test_s2_numerics import _skip_or_fail

        _skip_or_fail("the pinned upstream sampler is not available")

    prompt = torch.zeros((4, 6), dtype=torch.long)
    prompt[0] = 101
    prompt[1:] = 3

    def frame_then_draw(module):
        model = _fresh_model(module)
        engine = _executable_engine(module, model)
        _clear(model)
        torch.manual_seed(4321)
        with torch.no_grad():
            frame = engine._prefill(0, prompt, torch.tensor([0.7]), torch.tensor([0.7]))
            # One draw from the same stream, after the prefill has run.
            following = torch.rand(4)
        return frame, following

    ours_frame, ours_next = frame_then_draw(v9_engine)
    theirs_frame, theirs_next = frame_then_draw(base_engine_module)
    assert torch.equal(ours_next, theirs_next), (
        "the RNG stream moved a different distance through the prefill, so the "
        "next unit's first token would differ even if this frame matched.\n"
        f"ours:   {ours_next.tolist()}\n"
        f"theirs: {theirs_next.tolist()}"
    )
    assert torch.equal(ours_frame, theirs_frame)


def test_the_legacy_prefill_width_is_batch(v9_engine, base_engine_module):
    """A structural backstop for the two executed tests above."""
    assert v9_engine.LEGACY_RENDER is True
    import ast
    import inspect
    import textwrap

    tree = ast.parse(textwrap.dedent(inspect.getsource(v9_engine._BatchEngine._prefill)))
    defaults = [
        ast.unparse(d) for d in tree.body[0].args.kw_defaults if d is not None
    ]
    assert "BATCH" in defaults, (
        "`_prefill` must default to the batch width, as PR 283 expanded to BATCH"
    )
    # And the deployed loop passes it explicitly, so the default cannot drift.
    loop = ast.unparse(
        ast.parse(textwrap.dedent(inspect.getsource(v9_engine._BatchEngine._render_legacy)))
    )
    assert "width=BATCH" in loop
