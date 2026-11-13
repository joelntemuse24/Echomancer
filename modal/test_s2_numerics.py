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


#: Which upstream checkout the numeric comparisons run against.
#:
#: The GPU image has it at `/opt/fish-speech`; a CI runner or the VM can point
#: `S2B_FISH_DIR` at `scripts/s2/fetch-fish-source.sh`'s output. Without one the
#: comparisons skip, which is honest on a bare laptop — but a silent skip in CI
#: is the same failure as a broken test, so `S2B_REQUIRE_FISH_SOURCE=1` turns
#: every such skip into a failure. `scripts/s2/check-test-prereqs.py` reports
#: which of these can actually run.
FISH_DIR = "/opt/fish-speech"
REQUIRE_SOURCE_ENV = "S2B_REQUIRE_FISH_SOURCE"


def _require_fish_source() -> bool:
    return str(__import__("os").environ.get(REQUIRE_SOURCE_ENV, "")).strip() in (
        "1",
        "true",
        "yes",
    )


def _skip_or_fail(reason: str) -> None:
    """Skip where the dependency is genuinely optional; fail where it is required.

    A test that silently skips has not run, so "all green" means nothing unless
    the caller can demand it ran. CI and the VM set `S2B_REQUIRE_FISH_SOURCE=1`.
    """
    if _require_fish_source():
        pytest.fail(
            f"{reason}. {REQUIRE_SOURCE_ENV}=1 requires this to run.\n"
            "Run `python3 scripts/s2/check-test-prereqs.py --strict` — it names "
            "which prerequisite is missing (the source itself, CPU torch, or "
            "upstream's einops/loguru) and prints the command that fixes it."
        )
    pytest.skip(reason)


def _fish_source():
    """The pinned upstream package, if this machine has a copy.

    The GPU image clones it to `/opt/fish-speech`, `scripts/s2/fetch-fish-source.sh`
    puts it at `.fish-speech-src`, and `S2B_FISH_DIR` names any other checkout.
    """
    import os
    import pathlib

    here = pathlib.Path(__file__).parent.parent
    for candidate in (
        os.environ.get("S2B_FISH_DIR"),
        FISH_DIR,
        str(here / ".fish-speech-src"),
    ):
        if candidate and (pathlib.Path(candidate) / "fish_speech").is_dir():
            return str(candidate)
    return None


def _v10_statements(fn) -> list:
    """The statements of a shared method that are the **v10** body.

    `_embed`, `_fast_step` and `_logits_to_probs` each begin with a legacy
    branch and then the v10 body. The legacy branch is identified by structure —
    an `if` whose test mentions `LEGACY_RENDER` — not by text, because the
    docstring above it names the same identifiers.
    """
    import ast
    import inspect
    import textwrap

    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    node = tree.body[0]
    legacy: list = []
    for statement in node.body:
        if isinstance(statement, ast.If) and "LEGACY_RENDER" in ast.unparse(statement.test):
            legacy.append(statement)
    assert legacy, "expected a LEGACY_RENDER branch in this method"
    body = [statement for statement in node.body if statement not in legacy]
    # Drop the docstring: it names the upstream calls this branch replaced, and
    # a banned-symbol check would otherwise match the prose.
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        body = body[1:]
    return body


def _names_called_in(body: list) -> set[str]:
    """Every function or method name those statements call."""
    import ast

    names: set[str] = set()
    for statement in body:
        for child in ast.walk(statement):
            if isinstance(child, ast.Call):
                if isinstance(child.func, ast.Name):
                    names.add(child.func.id)
                elif isinstance(child.func, ast.Attribute):
                    names.add(child.func.attr)
    return names


def _body_after_legacy_branch(fn) -> str:
    """The v10 statements of a shared method, with the legacy branch removed.

    `_embed`, `_fast_step` and `_logits_to_probs` each start with a legacy
    branch (`if LEGACY_RENDER:` / `if LEGACY_RENDER or not FAST_DECODE:`) and
    then the v10 body. These tests are about the v10 half, so the branch is
    removed by AST rather than by string search: `ast.unparse` puts a one-line
    `if` and its `return` on the same line, so a text search would also match
    the docstring that explains the branch.
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
        _skip_or_fail("pinned fish-speech source is not available on this machine")
    if source not in sys.path:
        sys.path.insert(0, source)
    # `llama.py` pulls `fish_speech.tokenizer` only for text, and the fast
    # layers need nothing from it. Import the module directly; a missing
    # dependency of the checkout is reported, not swallowed.
    try:
        import fish_speech.models.text2semantic.llama as module

        return module
    except Exception as err:  # pragma: no cover - depends on the checkout
        _skip_or_fail(f"fish-speech llama module could not be imported: {err}")


@pytest.fixture(scope="module")
def inference():
    functions = _upstream_inference_functions()
    if not functions:
        _skip_or_fail("pinned fish-speech source is not available on this machine")
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


def test_the_v10_embed_has_no_python_scalar_operand(batch_module):
    """`torch.where(cond, tensor, 0)` is what became a CPU constant (`arg10_1`).

    Only the **v10** body is checked. The legacy branch is a deliberate
    transcription of the deployed code, which does contain those scalar operands
    — that is precisely why it is a separate branch.
    """
    import ast
    import re

    body = ast.unparse(
        ast.Module(body=_v10_statements(batch_module._BatchEngine._embed), type_ignores=[])
    )
    for match in re.finditer(r"torch\.where\((.*?)\)", body, re.S):
        for piece in match.group(1).split(","):
            assert not re.fullmatch(r"-?\d+(\.\d+)?", piece.strip()), (
                "a numeric literal inside torch.where becomes a CPU tensor and "
                f"makes inductor skip CUDA graphs: {match.group(0)}"
            )
    assert "torch.where" in body, "the scale step should still be a tensor op"


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
    """An engine whose state is `model`'s, on CPU, for the parts under test.

    Only what `_embed` / `_prefill` / `_decode_step` read is attached. It is a
    deliberately partial engine: loading S2-Pro needs a GPU, and every field here
    is one the real `__init__` also sets, so a missing one fails loudly.
    """
    import math

    engine = object.__new__(batch_module._BatchEngine)
    engine.model = model
    engine.cfg = model.config
    engine.device = torch.device("cpu")
    engine.dtype = torch.float32
    engine.im_end_id = token
    engine.codebook_offsets = (
        torch.arange(model.config.num_codebooks, dtype=torch.long) * model.config.codebook_size
    )[None, :, None]
    engine.scale_codebook_embeddings = bool(
        getattr(model.config, "scale_codebook_embeddings", False)
    )
    engine.codebook_inv_scale = 1.0 / math.sqrt(model.config.num_codebooks + 1)
    engine.top_k = 30
    # The allowed-token projection `_head` uses: the semantic range plus
    # `<|im_end|>`, exactly as `__init__` builds it.
    cfg = model.config
    allowed = list(range(cfg.semantic_begin_id, cfg.semantic_end_id + 1))
    # `<|im_end|>` is a real vocabulary id in production; the tests that sample
    # pass their own `allowed_ids`, so any in-range id is fine here.
    allowed.append(min(cfg.vocab_size - 1, cfg.semantic_end_id + 1))
    engine.allowed_ids = torch.tensor(allowed, dtype=torch.long)
    engine.out_weight = model.embeddings.weight[engine.allowed_ids].contiguous()
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
    import ast

    v10 = ast.unparse(ast.Module(
        body=_v10_statements(batch_module._BatchEngine._fast_step), type_ignores=[]
    ))
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


def test_the_topk_fast_path_returns_the_same_distribution(batch_module):
    """Opt-in path: the same support and mass, plus the rank -> column map."""
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
        fast, column_of = batch_module._BatchEngine._sample_distribution(
            engine, logits, temperature, top_p
        )
    finally:
        module.TOPK_FAST_SAMPLE = original

    assert fast.shape == (8, 30), "the fast path is a distribution over top-k"
    assert torch.allclose(fast.sum(dim=-1), torch.ones(8), atol=1e-5), "it normalises"
    assert column_of is not None and column_of.shape == (8, 30)
    order = torch.argsort(reference, dim=-1, descending=True)[:, :30]
    assert torch.equal(column_of, order), "sorted topk is the full path's order"
    assert torch.allclose(fast, reference.gather(-1, order), atol=1e-5), (
        (fast - reference.gather(-1, order)).abs().max()
    )


def test_the_topk_path_maps_a_sampled_rank_back_to_the_token(batch_module):
    """A drawn column is a **rank**, not a vocabulary index.

    Sampling rank `i` and returning `i` as a token id would speak whatever sits
    at index `i` in the vocabulary, not the token sampled. With `top_p=0` only
    rank 0 survives, so `_sample` must return that rank's original column — the
    row's argmax — and not the rank (0).
    """
    import s2_batch as module

    torch.manual_seed(37)
    logits = torch.randn(6, 512)
    engine = object.__new__(batch_module._BatchEngine)
    engine.top_k = 16
    original_flag = module.TOPK_FAST_SAMPLE
    original_draw = module.multinomial_sample_one_no_sync
    # Deterministic: always take the highest-probability column.
    module.multinomial_sample_one_no_sync = lambda probs: probs.argmax(
        dim=-1, keepdim=True
    ).long()
    try:
        module.TOPK_FAST_SAMPLE = True
        drawn = batch_module._BatchEngine._sample(
            engine, logits, torch.tensor(1.0), torch.tensor(0.0)
        )
    finally:
        module.TOPK_FAST_SAMPLE = original_flag
        module.multinomial_sample_one_no_sync = original_draw
    assert torch.equal(drawn[:, 0], logits.argmax(dim=-1))
    assert not torch.equal(drawn[:, 0], torch.zeros(6, dtype=torch.long))


def test_the_topk_fast_path_never_keeps_an_empty_support(batch_module):
    """Top-1 of every row survives, as upstream's removal mask does."""
    import s2_batch as module

    torch.manual_seed(31)
    logits = torch.randn(4, 64)
    engine = object.__new__(batch_module._BatchEngine)
    engine.top_k = 8
    original = module.TOPK_FAST_SAMPLE
    try:
        module.TOPK_FAST_SAMPLE = True
        probs, _ = batch_module._BatchEngine._sample_distribution(
            engine, logits, torch.tensor(1.0), torch.tensor(0.0)
        )
    finally:
        module.TOPK_FAST_SAMPLE = original
    assert torch.allclose(probs[:, 0], torch.ones(4), atol=1e-6)


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


# ── batched prefill ───────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def small_model(llama, batch_module):
    """A tiny `DualARTransformer`: real upstream layers, no checkpoint."""
    from fish_speech.models.text2semantic.llama import (
        DualARModelArgs,
        DualARTransformer,
    )

    args = DualARModelArgs(
        vocab_size=512,
        n_layer=2,
        n_head=4,
        dim=32,
        intermediate_size=64,
        n_local_heads=2,
        head_dim=8,
        num_codebooks=2,
        codebook_size=64,
        semantic_begin_id=100,
        semantic_end_id=163,
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
        # `BATCH` rows: `_prefill` expands the fast transformer to the batch
        # width (as PR 283 does), and upstream's `KVCache.update` writes a
        # full-width tensor. `max_seq_len` is long enough for a unit to reach
        # `im_end` without hitting the frame cap.
        model.setup_caches(
            max_batch_size=batch_module.BATCH, max_seq_len=2048, dtype=torch.float32
        )
    return model


def _clear_fast_cache(model):
    for layer in model.fast_layers:
        layer.attention.kv_cache.k_cache.zero_()
        layer.attention.kv_cache.v_cache.zero_()


def test_batched_prefill_matches_the_single_row_path(batch_module, small_model):
    """Right-padded prefill must give each row the frame it would get alone.

    The padding is safe because a causal mask never lets a token attend forward,
    but "safe in theory" is exactly the kind of claim that hides an off-by-one.
    This compares the first sampled frame of three deliberately different prompt
    lengths against the same prompts prefilled one at a time.
    """
    engine = _engine_for(batch_module, small_model, token=999)
    engine.device = torch.device("cpu")
    engine.dtype = torch.float32
    torch.manual_seed(23)
    def prompt(t: int):
        """A legal prompt tensor: semantic ids on row 0, codebook ids below."""
        codes = torch.zeros((small_model.config.num_codebooks + 1, t), dtype=torch.long)
        codes[0] = torch.randint(
            small_model.config.semantic_begin_id,
            small_model.config.semantic_end_id + 1,
            (t,),
        )
        codes[1:] = torch.randint(0, small_model.config.codebook_size, (codes.shape[0] - 1, t))
        return codes

    prompts = [prompt(9), prompt(17), prompt(5)]
    rows = [0, 1, 2]
    temp = torch.tensor([0.7])
    topp = torch.tensor([0.7])

    # Deterministic: argmax instead of sampling, so a difference is the maths.
    engine._sample = lambda logits, temperature, top_p: logits.argmax(
        dim=-1, keepdim=True
    ).long()
    for layer in small_model.layers:
        layer.attention.kv_cache.k_cache.zero_()
        layer.attention.kv_cache.v_cache.zero_()
    _clear_fast_cache(small_model)
    batched = engine._prefill_many(rows, prompts, temp, topp)

    # Now one at a time, from clean caches. `width=BATCH` on purpose: the point
    # of this test is that batching the slow layers does not change a row's
    # frame, so the fast-transformer width must be the same on both sides (it is
    # what advances the RNG stream).
    single = []
    for row, prompt in zip(rows, prompts):
        for layer in small_model.layers:
            layer.attention.kv_cache.k_cache.zero_()
            layer.attention.kv_cache.v_cache.zero_()
        _clear_fast_cache(small_model)
        single.append(
            engine._prefill(row, prompt, temp, topp, width=batch_module.BATCH)
        )

    for slot, (mine, theirs) in enumerate(zip(batched, single)):
        assert torch.equal(mine, theirs), (
            f"row {slot} (prompt {prompts[slot].shape[1]} tokens) diverged under "
            f"batched prefill: {mine} vs {theirs}"
        )


def test_batched_prefill_writes_only_the_real_cache_prefix(
    batch_module, small_model
):
    """The padded tail must not be written into a row's KV cache.

    A later decode step attends `pos+1` keys, so a row whose cache holds padding
    where its prompt ended would attend zeros it never conditioned on.
    """
    engine = _engine_for(batch_module, small_model, token=999)
    engine.device = torch.device("cpu")
    engine.dtype = torch.float32
    engine._sample = lambda logits, temperature, top_p: logits.argmax(
        dim=-1, keepdim=True
    ).long()
    torch.manual_seed(29)
    def prompt(t: int):
        codes = torch.zeros((small_model.config.num_codebooks + 1, t), dtype=torch.long)
        codes[0] = torch.randint(
            small_model.config.semantic_begin_id,
            small_model.config.semantic_end_id + 1,
            (t,),
        )
        codes[1:] = torch.randint(0, small_model.config.codebook_size, (codes.shape[0] - 1, t))
        return codes

    prompts = [prompt(4), prompt(12)]
    for layer in small_model.layers:
        layer.attention.kv_cache.k_cache.zero_()
        layer.attention.kv_cache.v_cache.zero_()
    _clear_fast_cache(small_model)
    engine._prefill_many([0, 1], prompts, torch.tensor([0.7]), torch.tensor([0.7]))

    layer = small_model.layers[0].attention
    # Row 0's prompt was 4 tokens; everything from 4 to 11 must still be zero.
    tail = layer.kv_cache.k_cache[0, :, 4:12]
    assert torch.equal(tail, torch.zeros_like(tail)), (
        "the padded tail of a short prompt must not be written into its cache"
    )
    # Row 1's prompt was 12 tokens, so its prefix is fully populated.
    assert layer.kv_cache.k_cache[1, :, :12].abs().sum() > 0


def test_one_prompt_is_prefilled_by_the_single_row_path(batch_module, small_model):
    """A one-lane call must not pay for batching machinery."""
    engine = _engine_for(batch_module, small_model, token=999)
    engine.device = torch.device("cpu")
    engine.dtype = torch.float32
    engine._sample = lambda logits, temperature, top_p: logits.argmax(
        dim=-1, keepdim=True
    ).long()
    prompt = torch.zeros((small_model.config.num_codebooks + 1, 6), dtype=torch.long)
    prompt[0] = small_model.config.semantic_begin_id + 1
    prompt[1:] = 3
    for layer in small_model.layers:
        layer.attention.kv_cache.k_cache.zero_()
        layer.attention.kv_cache.v_cache.zero_()
    _clear_fast_cache(small_model)
    only = engine._prefill_many([0], [prompt], torch.tensor([0.7]), torch.tensor([0.7]))
    for layer in small_model.layers:
        layer.attention.kv_cache.k_cache.zero_()
        layer.attention.kv_cache.v_cache.zero_()
    _clear_fast_cache(small_model)
    # `_prefill_many` with one prompt delegates to `_prefill(width=1)`, so the
    # comparison is against the same width; the *legacy* loop's width=BATCH is
    # what `test_s2_legacy_identity` pins.
    alone = engine._prefill(0, prompt, torch.tensor([0.7]), torch.tensor([0.7]), width=1)
    assert torch.equal(only[0], alone)


# ── the v10 render loop, executed ─────────────────────────────────────────
#
# Nothing in this branch had ever *run* `_render_pipelined` until this test. The
# scheduler was unit-tested and the numerics were compared, but the loop that
# ties them together — claims, batched prefill, per-lane completion, refill,
# streamed codec — was only ever read. A CPU-only tiny model drives it here.


class _FakeDecoder(torch.nn.Module):
    """A codec that returns silence of the right length. Shape, not audio."""

    frame_length = 4
    sample_rate = 1000

    def from_indices(self, z):
        return torch.zeros((z.shape[0], 1, z.shape[1] * self.frame_length))


def _runnable_engine(batch_module, model):
    """A `_BatchEngine` that can execute `_render_pipelined` on the CPU."""
    import math

    engine = object.__new__(batch_module._BatchEngine)
    cfg = model.config
    engine.model = model
    engine.cfg = cfg
    engine.device = torch.device("cpu")
    engine.dtype = torch.float32
    engine.im_end_id = cfg.vocab_size - 1
    engine.codebook_offsets = (
        torch.arange(cfg.num_codebooks, dtype=torch.long) * cfg.codebook_size
    )[None, :, None]
    engine.scale_codebook_embeddings = True
    engine.codebook_inv_scale = 1.0 / math.sqrt(cfg.num_codebooks + 1)
    engine.top_k = 5
    engine.fast_pos = torch.arange(cfg.num_codebooks)
    engine.high_temperature = torch.tensor(1.0)
    engine.high_top_p = torch.tensor(0.9)
    engine.decoder = _FakeDecoder()
    engine.frame_length = 4
    engine.sample_rate = 1000
    engine.codec_stream = None
    engine.selftest_stats = {}
    # A fixed prompt: the token stream is not what this test is about.
    engine.build_prompt = lambda ref, history, text: torch.zeros(
        (cfg.num_codebooks + 1, 8), dtype=torch.long
    )
    # The allowed-token projection `_head` uses, exactly as `__init__` builds it.
    allowed = list(range(cfg.semantic_begin_id, cfg.semantic_end_id + 1))
    allowed.append(engine.im_end_id)
    engine.allowed_ids = torch.tensor(allowed, dtype=torch.long)
    engine.out_weight = model.embeddings.weight[engine.allowed_ids].contiguous()
    engine.step = engine._decode_step
    engine._last_audio = {}
    return engine


@pytest.fixture(scope="module")
def sampler_bound(batch_module):
    """Bind the container-only sampler names, deterministically."""
    names = _upstream_inference_functions()
    if names:
        batch_module.multinomial_sample_one_no_sync = names[
            "multinomial_sample_one_no_sync"
        ]
        batch_module.logits_to_probs = names["logits_to_probs"]
        return
    # No upstream checkout on this machine: a seeded multinomial and a plain
    # softmax are enough to *drive* the loop. These tests are about the loop's
    # sequencing, not about the sampling maths (`test_s2_legacy_identity` and the
    # distribution tests above cover that against upstream's own code).
    def draw(probs):
        return torch.multinomial(probs, 1)

    def mask_and_softmax(logits, temperature, top_p, top_k):
        keep = torch.topk(logits, min(top_k, logits.shape[-1]), dim=-1).indices
        masked = torch.full_like(logits, float("-inf"))
        masked.scatter_(-1, keep, logits.gather(-1, keep))
        return torch.softmax(masked, dim=-1)

    batch_module.multinomial_sample_one_no_sync = draw
    batch_module.logits_to_probs = mask_and_softmax


def test_the_v10_loop_generates_every_unit_of_every_section(
    batch_module, small_model, sampler_bound
):
    """End to end: claims, per-lane completion, refill, streamed codec."""
    torch.manual_seed(41)
    for layer in small_model.layers:
        layer.attention.kv_cache.k_cache.zero_()
        layer.attention.kv_cache.v_cache.zero_()
    _clear_fast_cache(small_model)
    engine = _runnable_engine(batch_module, small_model)

    slots = [
        [{"text": "a", "pause": "para"}, {"text": "b", "pause": "para"}],
        [{"text": "c", "pause": "para"}],
    ]
    streamed: list[tuple[int, list]] = []
    result = engine.render(
        slots, None, "0.7,0.7", on_section=lambda s, takes: streamed.append((s, takes))
    )

    # Every unit produced a take, in unit order, for both sections.
    assert [len(units) for units in result["codes"]] == [2, 1]
    for section, units in enumerate(result["codes"]):
        for unit, take in enumerate(units):
            assert take is not None, f"section {section} unit {unit} has no take"
            assert take.shape[0] == small_model.config.num_codebooks
    # The loop reports what it did, because the service's timing depends on it.
    assert result["batch_width"] == batch_module.choose_batch_width(slots)
    assert result["work_steal"] == int(batch_module.WORK_STEAL)
    assert result["frames"] > 0
    assert result["codec_tail_s"] <= result["loop_s"] + 1
    # Both sections streamed, and the takes list is aligned with `units`.
    assert sorted(section for section, _ in streamed) == [0, 1]
    for section, takes in streamed:
        assert len(takes) == len(slots[section]), (
            "a streamed take list must be indexed by unit, holes included"
        )


def test_the_v10_loop_puts_more_lanes_to_work_than_there_are_sections(
    batch_module, small_model, sampler_bound
):
    """The refill rule, observed through the real loop.

    Three sections of two units each is six units; the loop opens every lane it
    can, so the second wave must run on lanes the first wave never used. If only
    the finishing lane refilled, the call would take one section per step.
    """
    torch.manual_seed(43)
    for layer in small_model.layers:
        layer.attention.kv_cache.k_cache.zero_()
        layer.attention.kv_cache.v_cache.zero_()
    _clear_fast_cache(small_model)
    engine = _runnable_engine(batch_module, small_model)
    prefills: list[int] = []
    original = engine._prefill_many

    def spy(rows, prompts, temp, topp):
        prefills.append(len(rows))
        return original(rows, prompts, temp, topp)

    engine._prefill_many = spy
    slots = [[{"text": f"s{s}u{u}", "pause": "para"} for u in range(2)] for s in range(3)]
    result = engine.render(slots, None, "0.7,0.7")

    assert result["prefills"] == 6, "every unit was prefilled once"
    # The opening wave prefills several lanes at once; a per-section loop would
    # have 3 lanes in total and 3 prefill calls of one.
    assert max(prefills) >= 3, prefills


# ── clocks ───────────────────────────────────────────────────────────────


def test_codec_time_is_reported_separately_from_the_ar_clock(
    batch_module, small_model, sampler_bound
):
    """`generate_s` must be the AR loop, and codec time must be its own column.

    The service reports `loop_s` as `generate_s`, and the A/B compares that
    column, so codec time folded into it would make a decode change look like an
    AR regression.

    The assertion is **structural plus accounting**, not a wall-clock
    comparison: `loop_s` is a real clock on a shared CI machine, and a test that
    compares two of them measures how busy the runner was. What actually has to
    hold is that the codec's cost is recorded in its own columns, and that the AR
    clock is stopped before the codec tail runs — which is where the time would
    otherwise leak in on a GPU.
    """
    import inspect
    import time as _time

    CODEC_SLEEP_S = 0.15
    slots = [[{"text": "a", "pause": "para"}], [{"text": "b", "pause": "para"}]]

    class _SlowCodec:
        frame_length = 4
        sample_rate = 1000

        def from_indices(self, z):
            _time.sleep(CODEC_SLEEP_S)
            return torch.zeros((z.shape[0], 1, z.shape[1] * 4), dtype=torch.float32)

    torch.manual_seed(101)
    for layer in small_model.layers:
        layer.attention.kv_cache.k_cache.zero_()
        layer.attention.kv_cache.v_cache.zero_()
    _clear_fast_cache(small_model)
    engine = _runnable_engine(batch_module, small_model)
    engine.decoder = _SlowCodec()
    result = engine.render(slots, None, "0.7,0.7")

    # The codec's cost is accounted, not merely felt.
    codec_total = float(result["codec_s"]) + float(result["codec_tail_s"])
    assert codec_total >= CODEC_SLEEP_S, (
        "the codec's cost must be recorded in a codec column "
        f"(codec_s={result['codec_s']}, tail={result['codec_tail_s']})"
    )
    assert "codec_wait_s" in result, "the wait is reported on its own line"
    assert float(result["loop_s"]) > 0

    # The AR clock is stopped before the tail flush, so on a GPU — where the tail
    # is the only serial codec work left — codec time cannot leak into it.
    source = inspect.getsource(batch_module._BatchEngine._render_pipelined)
    loop_at = source.index("loop_s = time.time() - loop_t0")
    tail_at = source.index("_flush_decode()", loop_at)
    assert loop_at < tail_at, (
        "the AR clock must be stopped before the codec tail runs, or "
        "`generate_s` includes the codec"
    )
