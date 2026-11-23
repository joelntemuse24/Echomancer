# Splitting the S2 GPU app from its control plane

Status: **plan + the parts that need no GPU to validate.** The physical split
needs one deploy against staging and an owner decision; see "What is not done"
at the bottom for exactly which steps those are.

## Why

**About 92% of GPU spend since 17 November was snapshot rebuilds.** Every
`modal deploy modal/s2_clone_service.py` invalidates *every* GPU memory snapshot
of the app it targets, and the next placement pays a full compile — 8–16 minutes
of H100 at ~$0.0011/s, roughly $0.55–$1.05 per rebuild — before a single section
is spoken.

The cause is structural, not a mistake in any one deploy: `render_batch` lives on
`S2CloneWorker`, which is decorated with `enable_memory_snapshot=True`. Modal keys
a snapshot to the **function's code and configuration**. So editing *any* line of
`s2_clone_service.py` — including the CPU-only `s2_control` submit/poll/cancel
handler, the `/ready` payload, or a docstring in a helper they share — changes
the GPU function's identity and throws the snapshot away.

That is what makes a five-line change to a health endpoint cost a GPU compile.

## The shape this moves toward

Two apps, one for each thing that changes on a different clock:

| | GPU app | Control app |
|---|---|---|
| Contents | `S2CloneWorker` (`render_batch`, `status`) | `s2_control`, `ready`, `_fleet` |
| Changes when | the decode engine, the model, or the mastering chain changes | a payload field, a probe, a token, an endpoint |
| Frequency | weeks | days |
| Snapshot | yes, one per worker variant | none (CPU only) |
| `min_containers` | 0 | 0 |
| `max_containers` | 1 (owner approval to raise) | as today |

A control-plane deploy then costs **nothing** on the GPU side, and the snapshot
survives.

## The hard part: the GPU class must not import the control plane

The split is only real if the two apps share no import edge. Today they share
one module, so a change anywhere in it is a change to the GPU function.

The intended end state is:

```
modal/
  s2_gpu_app.py        # App("…-gpu") + S2CloneWorker + its enter/exit hooks
  s2_control_app.py    # App("…-control") + s2_control + ready + _fleet
  s2_gpu_worker.py     # the class body, imported by the GPU app only
  s2_contract.py       # shared, stdlib-only, NO modal import at module scope
  s2_endpoints.py      # shared URL rules, stdlib-only
  s2_hostinfo.py       # stdlib-only boot report
```

`S2CloneWorker` is reached from the control plane only through
`modal.Cls.from_name(<gpu app>, "S2CloneWorker")` and `FunctionCall.from_id` — the
same client RPC the warm script already uses, with no import of the class. That
is already how `s2_clone_warm.py` works, so the mechanism is proven; what is
missing is moving the class out of the shared module.

`_BUILD_ENV` is the other coupling: both apps currently bake the same dict. The
GPU app needs it (the snapshot is built from those values). The control app needs
only `_IDENTITY`, `S2C_BUILD` (to report it), and the two Dict names. Splitting
the dict is what lets a control-plane variable change without touching the build
id.

## What this PR actually does

Only the parts that can be validated without a GPU, plus the plan:

1. **`s2_batch.release_scratch()`** — returns allocator-cached blocks to the
   driver before the snapshot is captured, and reports
   `reserved_before_gb` / `reserved_after_gb` so the effect is a measurement
   rather than a claim. `S2B_SNAPSHOT_TRIM=0` is the A/B control. This
   shortens a *rebuild*, which is the cost this whole exercise is about.
2. **`s2_contract.validate_reference_duration`** — a reference clip past the
   prompt's context is now a loud 422 instead of a silent truncation that makes
   the clone drift. Staging's `truncated_units: 2` is the same class of cut on
   the output side; this is the input side, where nothing reported it at all.
3. **The corrected KV-cache figure** (`kv_cache_bytes` / `kv_cache_gb`): ~18 GiB
   at this shape, not the 0.02 GB published with PR 324. Its own tests pin the
   mistake.
4. **This runbook**, including the exact deploy order and the checks that say
   the split worked.

## What is *not* done, and would need a GPU

These are deliberate omissions, not oversights. Each one needs a staging deploy
to answer, and getting it wrong costs a rebuild rather than a test failure:

- **Moving the class into its own app.** The code move is mechanical, but the
  *snapshot* it produces is not: `S2C_BUILD` includes the app name
  (`snapshot_fingerprint`), so the move changes every build id, and the first
  placement in the new app compiles from scratch regardless. That is a one-off
  cost the owner should schedule, not something to slip into a refactor.
- **Freezing the GPU image and env.** Removing `fastapi` from the GPU image is
  the real win (it is only there for the web endpoints), but the class still
  serves two `@modal.fastapi_endpoint` methods today. Deleting them is a
  breaking change for any caller without `MODAL_S2_CONTROL_URL` set — and the
  synchronous GPU POST is the documented fallback when it is not. Needs a
  staging run of `scripts/s2/staging-smoke.mjs` against a control-only worker.
- **Meta-device init with correct non-persistent buffers.** The idea is sound
  (allocate weights on `meta`, then `to_empty` + copy, so peak host memory
  during a build drops), but "non-persistent buffers rematerialise correctly" is
  exactly the kind of claim that has to be *proved by matching outputs*, and
  proving it means a GPU run comparing generated audio against the current
  build. `modal/test_s2_numerics.py` is where that comparison lives; it cannot
  run here.
- **Shortening the warm-up.** `warm_up()` currently does four renders (narrow,
  wide, wide-with-reference, long-KV). A smaller full-pipeline render would
  shorten a rebuild, but which graphs a *customer* call then records mid-request
  is a GPU question — the v10 work exists precisely because a missing warmed
  shape used to be recorded on someone's section.

## Deploy order (for whenever the split lands)

Nothing here is run by an agent. `modal deploy` and every autoscaler write are
owner-only.

1. **Control plane first, and it is free.**
   ```bash
   S2C_ALLOW_PRODUCTION=1 modal deploy <control app module>
   ```
   No snapshot is touched, because the GPU app is not in this deploy.
2. **Point the worker at it and restart — this is the cutover.**
   ```bash
   # worker .env
   MODAL_S2_CONTROL_URL=https://<workspace>--<control-app>-s2-control.modal.run
   MODAL_S2_READY_URL=https://<workspace>--<control-app>-ready.modal.run
   pm2 restart <takehome-worker>
   ```
3. **GPU app only when the engine actually changed.** This is the step that
   invalidates snapshots, so it is the one to batch:
   ```bash
   S2C_ALLOW_PRODUCTION=1 modal deploy <gpu app module>
   bash scripts/s2/post-deploy-cover.sh         # one cold restore, max_containers 1
   python3 -m modal run modal/s2_clone_warm.py::snapshot_state
   ```
4. **Prove the split held.** After step 1 alone, `snapshot_age_s` in `status()`
   must be **older** than the control deploy's timestamp. If it is younger, the
   deploy still rebuilt the GPU — which means an import edge survived.

## Rollback

Nothing in this PR changes a deploy target, a URL, an autoscaler value, or a
sound. `S2B_SNAPSHOT_TRIM=0` disables the trim; the reference cap is a validation
that only rejects clips the prompt could not have carried intact. The split
itself is not in this PR, so there is nothing to roll back.

## Cost model, for the decision

Per rebuild avoided (one H100 container, compile-dominated):

| | |
|---|---|
| Compile | 8–16 min |
| H100 list | ~$0.0011/s |
| **Per rebuild** | **~$0.55–$1.05** |
| Deploys since 17 Nov | enough that rebuilds were ~92% of GPU spend |

The leverage is not in making a compile faster. It is in not compiling at all
when the only thing that changed was a health endpoint.
