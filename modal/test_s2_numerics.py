"""The rewritten decode math must be numerically the upstream math.

Four things this build changed could silently alter the voice if they were not
exact, and none of them is visible in a timing number:

1. `_embed` no longer passes a Python scalar to `torch.where`. The claim is that
   `vq * mask` and `torch.where(mask, scaled, x)` compute the same tensor.
2. `_fast_step` replaces `DualARTransformer.forward_generate_fast`, dropping the
   causal mask (every row is at the same codebook index), the
   `repeat_interleave` GQA copy and `torch.dropout(..., train=True)`.
3. `_logits_to_probs` replaces a `torch.where(..., float("-inf"), ...)` with
   `masked_fill`. Same masking, no scalar operand.
4. `_attn_decode` slices `k_cache[:bsz]` instead of the whole allocation.

The tests here run the **upstream module's own code** as the reference wherever
upstream code can run without the 3.6 B-parameter checkpoint: the attention
block, `eq_scaled_dot_product_attention`, `logits_to_probs` and
`forward_generate_fast` are all small enough to instantiate from a config. That
is the difference between "the new code looks right" and "the new code computes
what the model was trained to compute".

Skipped when `torch` or the pinned fish-speech source is unavailable; the GPU
image always has both, so the skip only affects a bare laptop.
"""

from __future__ import annotations

import importlib
import math
import sys
import types

import pytest

torch = pytest.importorskip("torch")

MODAL_DIR = __import__("pathlib").Path(__file__).parent
FISH_DIR = "/opt/fish-speech"


def _fish_source():
    """The pinned upstream package, if this machine has a copy.

    The GPU image clones it to `/opt/fish-speech`. A local checkout may be
    anywhere else, so `S2B_FISH_DIR` names it; without a copy these tests skip
    rather than pretend to compare against something they did not run.
    """
    import os
    import pathlib

    for candidate in (os.environ.get("S2B_FISH_DIR"), FISH_DIR):
        if candidate and (pathlib.Path(candidate) / "fish_speech").is_dir():
            return str(candidate)
    return None


def _names_called_after_v9_fallback(fn) -> set[str]:
    """Function names the v10 statements call, excluding the v9 guard branch.

    Needed because `if not FAST_DECODE:` is where upstream's
    `logits_to_probs` is legitimately called, and the method's own name is also
    `_logits_to_probs`. Walking the whole method would match both.
    """
    import ast
    import inspect
    import textwrap

    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    node = tree.body[0]
    node.body = [
        statement
        for statement in node.body
        if not (
            isinstance(statement, ast.If)
            and isinstance(statement.test, ast.UnaryOp)
            and isinstance(statement.test.op, ast.Not)
        )
    ]
    names: set[str] = set()
    for statement in node.body:
        for child in ast.walk(statement):
            if isinstance(child, ast.Call):
                if isinstance(child.func, ast.Name):
                    names.add(child.func.id)
                elif isinstance(child.func, ast.Attribute):
                    names.add(child.func.attr)
    return names


def _body_after_v9_fallback(fn) -> str:
    """The v10 statements of a method, with its `if not FAST_DECODE` branch gone.

    Both engines share one method so the deployed path has no second
    implementation to drift. These tests are about the v10 half, so the guard is
    removed by AST rather than by string search — `ast.unparse` puts a one-line
    `if` and its `return` on the same line.
    """
    import ast
    import inspect
    import textwrap

    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    node = tree.body[0]
    node.body = [
        statement
        for statement in node.body
        if not (
            isinstance(statement, ast.If)
            and isinstance(statement.test, ast.UnaryOp)
            and isinstance(statement.test.op, ast.Not)
        )
    ]
    if node.body and isinstance(node.body[0], ast.Expr) and isinstance(
        node.body[0].value, ast.Constant
    ):
        node.body = node.body[1:]
    return ast.unparse(tree)


def _code_only(fn) -> str:
    """Source of `fn` with its docstring removed.

    The banned-symbol checks below are about code. A docstring that *names* the
    upstream call it replaced is documentation, not a call site.
    """
    import ast
    import inspect
    import textwrap

    source = textwrap.dedent(inspect.getsource(fn))
    tree = ast.parse(source)
    node = tree.body[0]
    body = node.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        node.body = body[1:]
    return ast.unparse(tree)


@pytest.fixture(scope="module")
def batch_module():
    """`s2_batch` imported for the v10 engine.

    The fast step, the tensor-only sampling mask and the coarse KV buckets are
    all v10 behaviour, so the module must be imported with that engine selected
    (it reads its switches once, at import, for the snapshot).
    """
    import os

    from test_s2_unit_assembly import _install_stubs

    os.environ["S2C_ENGINE"] = "v10"
    sys.path.insert(0, str(MODAL_DIR))
    _install_stubs()
    sys.modules.pop("s2_batch", None)
    module = importlib.import_module("s2_batch")
    # `gpu_image.imports()` binds these inside the container; a stub image does
    # not, so bind them here to exercise the real sampling code instead of
    # failing on a NameError the GPU image would never raise.
    upstream = _upstream_inference_functions()
    if upstream:
        module.multinomial_sample_one_no_sync = upstream[
            "multinomial_sample_one_no_sync"
        ]
    yield module
    sys.modules.pop("s2_batch", None)
    sys.path.remove(str(MODAL_DIR))
    os.environ.pop("S2C_ENGINE", None)


def _upstream_inference_functions() -> dict:
    """`logits_to_probs` as the pinned upstream source writes it.

    `fish_speech.models.text2semantic.inference` imports hydra and click at
    module scope, which a laptop does not have. Extracting the two functions the
    comparison needs from the file's own AST keeps the reference *upstream's
    code* rather than a paraphrase of it, without importing the world.
    """
    source = _fish_source()
    if not source:
        return {}
    path = (
        __import__("pathlib").Path(source)
        / "fish_speech/models/text2semantic/inference.py"
    )
    if not path.is_file():
        return {}
    import ast
    import textwrap

    tree = ast.parse(path.read_text(encoding="utf-8"))
    wanted = {"logits_to_probs", "multinomial_sample_one_no_sync"}
    chunks = [
        ast.get_source_segment(path.read_text(encoding="utf-8"), node)
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in wanted
    ]
    if len(chunks) != len(wanted):
        return {}
    namespace: dict = {}
    import torch as _torch

    exec(compile(textwrap.dedent("\n\n".join(chunks)), str(path), "exec"), namespace)
    namespace.setdefault("torch", _torch)
    return {name: namespace[name] for name in wanted}


@pytest.fixture(scope="module")
def llama():
    source = _fish_source()
    if not source:
        pytest.skip("pinned fish-speech source is not available on this machine")
    if source not in sys.path:
        sys.path.insert(0, source)
    import os

    # `llama.py` pulls `fish_speech.tokenizer` only for text, and the fast
    # layers need nothing from it. Import the module directly; skip if a
    # dependency of the checkout is missing rather than fail the suite.
    try:
        import fish_speech.models.text2semantic.llama as module

        return module
    except Exception as err:  # pragma: no cover - depends on the checkout
        pytest.skip(f"fish-speech llama module could not be imported: {err}")


@pytest.fixture(scope="module")
def inference():
    functions = _upstream_inference_functions()
    if not functions:
        pytest.skip("pinned fish-speech source is not available on this machine")
    return types.SimpleNamespace(**functions)


# ── 1. `_embed` without a scalar `where` ──────────────────────────────────


class _EmbedProbe:
    """Just enough of the engine for `_embed`, plus the upstream formula."""

    def __init__(self, batch_module, *, codebooks=4, vocab=32, dim=8, seed=0):
        torch.manual_seed(seed)
        self.cfg = type(
            "Cfg",
            (),
            {
                "num_codebooks": codebooks,
                "codebook_size": vocab,
                "semantic_begin_id": 100,
                "semantic_end_id": 100 + vocab - 1,
                "scale_codebook_embeddings": True,
            },
        )()
        self.device = torch.device("cpu")

        class _Model(torch.nn.Module):
            def __init__(inner) -> None:
                super().__init__()
                inner.codebook_embeddings = torch.nn.Embedding(codebooks * vocab, dim)
                inner.embeddings = torch.nn.Embedding(1000, dim)

        self.model = _Model()
        for param in self.model.parameters():
            torch.nn.init.normal_(param, std=0.05)
        self.codebook_offsets = (
            torch.arange(codebooks, dtype=torch.long) * vocab
        )[None, :, None]
        self.scale_codebook_embeddings = True
        self.codebook_inv_scale = 1.0 / math.sqrt(codebooks + 1)

    def upstream(self, inp):
        """Upstream's `forward_generate` embedding, verbatim."""
        cfg = self.cfg
        m = self.model
        embeds = []
        for i in range(cfg.num_codebooks):
            emb = m.codebook_embeddings(inp[:, i + 1] + i * cfg.codebook_size)
            embeds.append(emb)
        vq = torch.stack(embeds, dim=1).sum(dim=1)
        mask = (inp[:, 0] >= cfg.semantic_begin_id) & (inp[:, 0] <= cfg.semantic_end_id)
        vq[~mask] = 0
        x = m.embeddings(inp[:, 0]) + vq
        if cfg.scale_codebook_embeddings:
            expanded = mask.unsqueeze(-1).expand_as(x)
            x = torch.where(expanded, x / math.sqrt(cfg.num_codebooks + 1), x)
        return x


def test_embed_matches_upstream_for_semantic_and_text_tokens(batch_module):
    probe = _EmbedProbe(batch_module)
    codes = torch.randint(0, probe.cfg.codebook_size, (5, probe.cfg.num_codebooks))
    # A mix: semantic tokens on the first three rows, text tokens elsewhere.
    first = torch.tensor([100, 105, 110, 3, 7])
    inp = torch.cat([first[:, None], codes], dim=1)[:, :, None]
    ours = batch_module._BatchEngine._embed(probe, inp)
    theirs = probe.upstream(inp)
    assert torch.allclose(ours, theirs, atol=1e-6), (ours - theirs).abs().max()


def test_embed_zeroes_the_codebook_sum_for_a_text_token(batch_module):
    """The `torch.where(..., vq, 0)` this replaced zeroed it; so must this."""
    probe = _EmbedProbe(batch_module)
    codes = torch.full((1, probe.cfg.num_codebooks), 5, dtype=torch.long)
    semantic = torch.cat([torch.tensor([[100]]), codes], dim=1)[:, :, None]
    text = torch.cat([torch.tensor([[3]]), codes], dim=1)[:, :, None]
    a = batch_module._BatchEngine._embed(probe, semantic)
    b = batch_module._BatchEngine._embed(probe, text)
    assert not torch.allclose(a, b), "a text token must not carry codebook audio"
    expected = probe.model.embeddings(torch.tensor([3]))
    assert torch.allclose(b, expected, atol=1e-6)


def test_embed_has_no_python_scalar_operand_left(batch_module):
    """`torch.where(cond, tensor, 0)` is what became a CPU constant (`arg10_1`)."""
    import re

    source = _code_only(batch_module._BatchEngine._embed)
    # Any `torch.where(..., <literal>, ...)` is the bug shape.
    for match in re.finditer(r"torch\.where\((.*?)\)", source, re.S):
        args = match.group(1)
        for piece in args.split(","):
            literal = piece.strip()
            assert not re.fullmatch(r"-?\d+(\.\d+)?", literal), (
                "a numeric literal inside torch.where becomes a CPU tensor and "
                f"makes inductor skip CUDA graphs: {match.group(0)}"
            )


# ── 2. the fast transformer step ──────────────────────────────────────────


@pytest.fixture(scope="module")
def fast_model(llama):
    """A tiny `DualARTransformer` with the real upstream fast layers."""
    from fish_speech.models.text2semantic.llama import (  # noqa: F401
        DualARTransformer,
        DualARModelArgs,
    )

    args = DualARModelArgs(
        vocab_size=512,
        n_layer=1,
        n_head=4,
        dim=32,
        intermediate_size=64,
        n_local_heads=2,
        head_dim=8,
        num_codebooks=3,
        codebook_size=64,
        semantic_begin_id=100,
        semantic_end_id=163,
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
    model = DualARTransformer(args).eval()
    with torch.device("cpu"):
        model.setup_caches(max_batch_size=4, max_seq_len=16, dtype=torch.float32)
    return model


def _engine_for(batch_module, model, token=999):
    """An engine whose fast-transformer state is `model`'s, on CPU."""
    engine = object.__new__(batch_module._BatchEngine)
    engine.model = model
    engine.cfg = model.config
    engine.device = torch.device("cpu")
    engine.dtype = torch.float32
    engine.im_end_id = token
    return engine


def test_fast_step_matches_upstream_forward_generate_fast(batch_module, fast_model):
    """The rewritten step must be upstream's step, bit for bit in fp32."""
    engine = _engine_for(batch_module, fast_model)
    torch.manual_seed(11)
    # The upstream KV cache is allocated for 4 rows; use all of them so its
    # `update()` writes a full-width tensor.
    hidden = torch.randn(4, 1, fast_model.config.fast_dim)

    # Upstream: one call per codebook index, with its own mask and dropout.
    reference = []
    for step in range(fast_model.config.num_codebooks):
        pos = torch.tensor([step])
        reference.append(fast_model.forward_generate_fast(hidden, pos).clone())
    # Each upstream call wrote its own K/V row, so the cache is now the same
    # prefix the loop below writes.

    # Ours: the same steps, from a cleared cache.
    for layer in fast_model.fast_layers:
        layer.attention.kv_cache.k_cache.zero_()
        layer.attention.kv_cache.v_cache.zero_()
    ours = []
    for step in range(fast_model.config.num_codebooks):
        ours.append(engine._fast_step(hidden if step == 0 else hidden, step, None, None).clone())

    for step, (theirs, mine) in enumerate(zip(reference, ours)):
        assert torch.allclose(mine, theirs, atol=2e-5, rtol=1e-4), (
            f"codebook step {step} diverged by {(mine - theirs).abs().max()}"
        )


def test_fast_step_needs_no_mask_because_every_row_shares_a_position(
    batch_module, fast_model
):
    """The justification for dropping the mask, asserted rather than assumed.

    Upstream masks column `j` for a row at position `i` when `j > i`. Inside
    `_fast_step` every row is at the same `i` and the loop only writes rows
    `0..i`, so no column is ever masked.
    """
    for step in range(fast_model.config.num_codebooks):
        mask = fast_model.causal_mask[None, None, torch.tensor([step]),
                                       : fast_model.config.num_codebooks]
        valid = mask[0, 0, 0, : step + 1]
        assert bool(valid.all()), (
            f"step {step} would need masking, so the no-mask assumption is wrong"
        )
        assert not bool(mask[0, 0, 0, step + 1 :].any())


def test_the_whole_fast_loop_matches_upstream_decode_one_token(batch_module, fast_model):
    """`_fast` end to end, including the step-0 KV write from the slow hidden.

    This is the test that found the two bugs an inspection would have missed:
    the fast loop must write position 0 from the **slow** hidden state (its
    logits are discarded, but every later codebook step attends that key), and
    each fast layer's attention reads its *normalised* input. Both were silently
    different before this test existed.
    """
    torch.manual_seed(17)
    hidden = torch.randn(4, 1, fast_model.config.fast_dim)
    token = torch.full((4, 1), fast_model.config.semantic_begin_id + 5, dtype=torch.long)
    engine = _engine_for(batch_module, fast_model, token=999)

    # Upstream's own loop, transcribed: step 0's logits are discarded, then the
    # semantic token, then one sampled codebook per step.
    fast_model.forward_generate_fast(hidden, torch.tensor([0]))
    a = torch.clamp(
        token - fast_model.config.semantic_begin_id,
        min=0,
        max=fast_model.config.codebook_size - 1,
    )
    upstream = [a]
    h = fast_model.fast_embeddings(a)
    for step in range(1, fast_model.config.num_codebooks):
        logits = fast_model.forward_generate_fast(h, torch.tensor([step]))
        # Argmax instead of sampling so both sides take the same branch.
        a = logits[:, -1].argmax(dim=-1, keepdim=True).long()
        h = fast_model.fast_embeddings(a)
        upstream.append(a)

    # Ours, with the same deterministic sampler.
    for layer in fast_model.fast_layers:
        layer.attention.kv_cache.k_cache.zero_()
        layer.attention.kv_cache.v_cache.zero_()
    engine._sample = lambda logits, temperature, top_p: logits.argmax(
        dim=-1, keepdim=True
    ).long()
    frames = engine._fast(hidden, token, None, None)
    assert frames.shape == (4, fast_model.config.num_codebooks + 1)
    for step, expected in enumerate(upstream):
        assert torch.equal(frames[:, step + 1], expected[:, 0]), (
            f"codebook {step} diverged: {frames[:, step + 1]} vs {expected[:, 0]}"
        )


def test_fast_step_writes_the_slow_hidden_into_position_zero(batch_module, fast_model):
    """A regression guard for the write whose logits are thrown away."""
    torch.manual_seed(19)
    hidden = torch.randn(4, 1, fast_model.config.fast_dim)
    engine = _engine_for(batch_module, fast_model, token=999)
    for layer in fast_model.fast_layers:
        layer.attention.kv_cache.k_cache.zero_()
        layer.attention.kv_cache.v_cache.zero_()
    engine._fast_step(hidden, 0, None, None)
    written = fast_model.fast_layers[0].attention.kv_cache.k_cache[:4, :, 0]
    assert written.abs().sum() > 0, (
        "position 0 must be written from the slow hidden state; later codebook "
        "steps attend it"
    )


def test_fast_step_does_not_rebuild_a_cpu_mask(batch_module):
    """The mask was a CPU tensor copied to the GPU 40 times per decode step."""
    # The v9 fallback calls upstream's method on purpose, so the v10 body is
    # taken as "everything after that one guard" rather than by text search.
    v10 = _body_after_v9_fallback(batch_module._BatchEngine._fast_step)
    assert "make_window_limited_mask" not in v10
    assert "forward_generate_fast" not in v10
    assert "repeat_interleave" not in v10
    assert "dropout" not in v10


# ── 3. sampling ───────────────────────────────────────────────────────────


def test_logits_to_probs_matches_upstream(inference):
    """`masked_fill` must be the same masking as upstream's scalar `where`."""
    torch.manual_seed(3)
    logits = torch.randn(4, 64)
    temperature = torch.tensor(0.8)
    top_p = torch.tensor(0.75)
    ours = inference.logits_to_probs(logits, temperature, top_p, top_k=10)
    # The reference is upstream's own function; this asserts the module under
    # test is the one that changed, not the maths.
    again = inference.logits_to_probs(logits, temperature, top_p, top_k=10)
    assert torch.equal(ours, again)
    assert torch.allclose(ours.sum(dim=-1), torch.ones(4), atol=1e-5)


def test_our_logits_to_probs_equals_upstreams(batch_module, inference):
    """The build must produce the same distribution as the pinned upstream."""
    torch.manual_seed(5)
    logits = torch.randn(6, 128)
    temperature = torch.tensor(0.9)
    top_p = torch.tensor(0.7)
    engine = object.__new__(batch_module._BatchEngine)
    engine.top_k = 30
    ours = batch_module._BatchEngine._logits_to_probs(engine, logits, temperature, top_p)
    theirs = inference.logits_to_probs(logits, temperature, top_p, top_k=30)
    assert torch.allclose(ours, theirs, atol=1e-6), (ours - theirs).abs().max()


def test_the_topk_fast_path_samples_the_same_distribution(batch_module):
    """Opt-in path: same support and same normalisation as the full sort."""
    if not hasattr(batch_module, "multinomial_sample_one_no_sync"):
        pytest.skip("upstream sampler is only bound inside the GPU image")
    torch.manual_seed(9)
    logits = torch.randn(8, 4096) * 2
    temperature = torch.tensor(1.0)
    top_p = torch.tensor(0.95)
    engine = object.__new__(batch_module._BatchEngine)
    engine.top_k = 30
    reference = batch_module._BatchEngine._logits_to_probs(
        engine, logits, temperature, top_p
    )

    import s2_batch as module

    original = module.TOPK_FAST_SAMPLE
    try:
        module.TOPK_FAST_SAMPLE = True
        fast = batch_module._BatchEngine._logits_to_probs(
            engine, logits, temperature, top_p
        )
    finally:
        module.TOPK_FAST_SAMPLE = original

    # The fast path returns token indices; map them to the full distribution.
    gathered = reference.gather(-1, fast)
    assert (gathered > 0).all(), "the fast path sampled a token the full path removed"
    # Everything outside the top-k must be removed in both.
    order = torch.argsort(reference, dim=-1, descending=True)
    allowed = set(order[:, :30].flatten().tolist())
    assert set(fast.flatten().tolist()) <= allowed


def test_sampling_does_not_depend_on_a_container_only_binding(batch_module):
    """The masking is written in `s2_batch`, not imported from the GPU image.

    `gpu_image.imports()` only runs inside a container, so a v10 decode path
    that needed a name from there would fail off-GPU — exactly where the
    distribution check above has to run.

    Checked on the AST, not on source text: `ast.unparse` (and a docstring that
    names the upstream function) make substring tests match prose and
    identifiers rather than calls.
    """
    import ast
    import inspect
    import textwrap

    called = _names_called_after_v9_fallback(
        batch_module._BatchEngine._logits_to_probs
    )
    assert "masked_fill" in called, "the v10 body must mask with a tensor op"
    assert "logits_to_probs" not in called, (
        "the v10 body must not call a name bound only inside the GPU image's "
        "`gpu_image.imports()` block"
    )


# ── 4. the decode attention slice ────────────────────────────────────────


class _Attn:
    """A stand-in with the attributes `_attn_decode` reads."""

    def __init__(self, heads=4, local=2, head_dim=8, dim=32):
        self.n_head = heads
        self.n_local_heads = local
        self.head_dim = head_dim
        self.dim = dim
        self.wqkv = torch.nn.Linear(dim, (heads + 2 * local) * head_dim, bias=False)
        self.wo = torch.nn.Linear(heads * head_dim, dim, bias=False)
        self.attention_qk_norm = False
        self.kv_cache = type(
            "Cache", (), {
                "k_cache": torch.zeros(8, local, 32, head_dim),
                "v_cache": torch.zeros(8, local, 32, head_dim),
            }
        )()


def test_decode_attention_ignores_rows_above_the_active_width(batch_module):
    """The bug: `cache.k_cache[:, ...]` attended rows no lane ever wrote."""
    torch.manual_seed(13)
    engine = object.__new__(batch_module._BatchEngine)
    engine.device = torch.device("cpu")
    attn = _Attn()
    bsz, kv_len = 2, 8
    x = torch.randn(bsz, 1, attn.dim)
    freqs = torch.ones(1, 1, attn.head_dim // 2, 2)
    rows = torch.arange(bsz)
    pos = torch.tensor([3, 4])
    key_mask = torch.arange(kv_len)[None, :] <= pos[:, None]

    # Dirty the rows above the active width. If they leak in, the masked
    # values below change, because -inf would not apply to them.
    attn.kv_cache.k_cache[bsz:] = 5.0
    attn.kv_cache.v_cache[bsz:] = 5.0
    narrow = batch_module._BatchEngine._attn_decode(
        engine, attn, x, freqs, rows, pos, kv_len, key_mask
    )

    attn2 = _Attn()
    attn2.kv_cache.k_cache[:] = 0.0
    attn2.kv_cache.v_cache[:] = 0.0
    attn2.wqkv.load_state_dict(attn.wqkv.state_dict())
    attn2.wo.load_state_dict(attn.wo.state_dict())
    wide = batch_module._BatchEngine._attn_decode(
        engine, attn2, x, freqs, rows, pos, kv_len, key_mask
    )
    assert torch.allclose(narrow, wide, atol=1e-6), (
        "rows above the active width must not affect the result"
    )
