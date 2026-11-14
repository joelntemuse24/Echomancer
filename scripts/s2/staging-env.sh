# S2-Pro clone: the v10 engine on a dedicated staging app
#
# Source this before any staging command. It does two things:
#
#   1. names a **separate** Modal app and heartbeat dict, so a staging deploy can
#      neither read production's containers nor invalidate its snapshots;
#   2. turns on the v10 decode path, which is off by default.
#
# Production is a different app (`echomancer-s2-clone`) with its own snapshots,
# and it stays on v9 until an operator has run the staged A/B and decided.
#
#   source scripts/s2/staging-env.sh
#   modal deploy modal/s2_clone_service.py
#
# Do not put credentials in this file. The Modal secrets (`echomancer-secrets`,
# `echomancer-s2-api`) supply those.

export S2C_APP_NAME=echomancer-s2-clone-staging
export S2C_HEARTBEAT_DICT=echomancer-s2-clone-heartbeats-staging

# Explicitly NOT production. `S2C_ALLOW_PRODUCTION` is deliberately left unset
# here, and `s2_contract.resolve_app_name` would still send even an explicit
# `S2C_APP_NAME=echomancer-s2-clone` to staging without it — a deploy wipes every
# GPU snapshot of the app it targets, so production has to be a deliberate act.
# The warm script and `scripts/s2/check-input-queue.py` read the same resolver, so
# `source scripts/s2/staging-env.sh` points all three at the same app.

# ── the engine under test ──────────────────────────────────────────────────
#
# `v10` turns on: bucketed active batch width, unit work-stealing, coarse
# pre-warmed CUDA-graph KV buckets, the rewritten fast-transformer step with a
# tensor-only sampling mask, length-sorted codec micro-batches with the codec
# cost frozen off the weights, and the streamed codec/encode/R2 pipeline.
#
# `v9` (the default when this file is not sourced) is exactly the deployed
# behaviour. `S2C_ENGINE` is the single rollback.
export S2C_ENGINE=v10

# ── staging-only sizing ────────────────────────────────────────────────────
#
# One container: the point is a matched before/after, not fanout, and the second
# container in a fanout smoke is its own line item.
export S2C_MAX_CONTAINERS=1
export S2C_LANES=1
# Short idle tail. A back-to-back A/B keeps the container warm; a forgotten
# staging app should stop costing money quickly.
export S2C_SCALEDOWN=45

# Extra CPU for the encode/upload pools. Four extra cores cost about
# $0.000052/s against the H100's $0.001097/s, so they are worth it whenever
# they save more than about 5% of the call's wall time.
export S2C_CPU=8

# ── switches worth an isolated A/B on this staging app ─────────────────────
#
# Each is off by default because it is a measurement, not a known win:
#
#   S2B_SDPA_DECODE=1        folded-GQA SDPA for the slow decode attention
#   S2B_TOPK_FAST_SAMPLE=1   sample over the top-k block, not the vocabulary
#
# Each is on by default under v10 and can be isolated off:
#
#   S2B_WORK_STEAL=0         one unit at a time per section (v9's order)
#   S2B_BUCKET=0             step S2B_BATCH rows per call, as v9 did
#   S2B_PIPELINE_CODEC=0     serial codec → encode → upload
#   S2B_CODEC_TUNING=0       keep weight_norm and rebuild the codec's mask
#   S2B_FAST_DECODE=0        call upstream's fast-transformer step
#   S2B_BATCHED_PREFILL=0    prefill one lane at a time
