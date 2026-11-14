# Drew and Walter on the shared Kokoro CPU app

Two changes shipped together:

- **Drew** is a new narrator and the app's **default** for new books. It is a
  fine-tuned Kokoro-82M (StyleTTS2) with **its own full kmodel weights** and
  its own voice pack. It replaces **Andrew** (Edge `en-US-AndrewNeural`).
- **Sowell is renamed Walter.** Only the listed name changed. The catalog id is
  still `sowell`, stored books are untouched, and the committed sample is still
  `public/voice-previews/sowell.mp3`.

Both live on the existing `echomancer-sowell` Modal app next to George. The S2
clone GPU app (`echomancer-s2-clone`) is not involved and must not be touched.

## Drew's weights are private and are not in the image

The repository is public. The two files are uploaded to a Modal **Volume**, not
baked into the Docker image and not committed.

| What | Volume | Path inside the volume |
|---|---|---|
| kmodel (313 MB, `KModel(model=path)` state dict) | `andrew-distill` | `/kokoro/retrain_v3/stageA/step00900_kmodel.pth` |
| voice pack (`.pt`, shape `(510, 1, 256)`, float32) | `andrew-distill` | `/kokoro/retrain_v3/stageA/step00900_voice.pt` |

The app mounts that volume at **`/andrew-distill`**, so the container reads:

```
/andrew-distill/kokoro/retrain_v3/stageA/step00900_kmodel.pth
/andrew-distill/kokoro/retrain_v3/stageA/step00900_voice.pt
```

Both are overridable. `DREW_VOLUME_NAME` (default `andrew-distill`) and
`DREW_VOLUME_MOUNT` (default `/andrew-distill`) name the volume and mount;
`DREW_KMODEL_RELATIVE_PATH` and `DREW_VOICE_RELATIVE_PATH` move the files
inside it. `scripts/sowell/drew.py` is the one place those defaults live, and
`DREW_KMODEL_PATH` / `DREW_VOICE_PACK_PATH` in `src/lib/tts/drew-voice.ts`
mirror them for documentation and for the rollout checklist.

Upload (from a machine with the Modal CLI and the files):

```bash
# 1. Create the volume once. `create_if_missing=True` in the app does this too.
modal volume create andrew-distill

# 2. Put each file at the documented path. `modal volume put` creates the
#    intermediate directories, so one call per file is enough.
modal volume put andrew-distill /local/path/step00900_kmodel.pth \
  /kokoro/retrain_v3/stageA/step00900_kmodel.pth
modal volume put andrew-distill /local/path/step00900_voice.pt \
  /kokoro/retrain_v3/stageA/step00900_voice.pt

# 3. Confirm the layout before deploying.
modal volume ls andrew-distill /kokoro/retrain_v3/stageA
```

`scripts/sowell/drew.py` checks the layout at load time: the voice pack must be
a float32 `(510, 1, 256)` tensor with no non-finite values, and the kmodel must
load through `KModel(model=...)`. A wrong or partial upload fails the load with
`DrewPackError`; it does not silently produce audio that is not Drew.

**Missing volume is not fatal to the app.** A container without the volume
still serves Walter and George. Only Drew answers `503 DREW_UNAVAILABLE`, and
the Next.js route with `DREW_ENABLED` unset hides the card entirely.

## Memory

Walter and George share one stock Kokoro kmodel (about 330 MB). Drew is a
**second** kmodel of its own, so the container ceiling moved **4 GB → 6 GB**
(`memory=6144` in `modal/sowell_worker.py`). CPU (2), `max_containers` (2),
`min_containers` (0) and `@modal.concurrent(max_inputs=1)` are unchanged: this
is the same fleet, one more resident model.

## Deploy

```bash
# Same app as before. This does not deploy echomancer-cpu or
# echomancer-s2-clone.
SOWELL_MAX_CONTAINERS=2 \
SOWELL_SCALEDOWN_SECONDS=300 \
modal deploy modal/sowell_worker.py
```

Then set the Next.js/worker environment. Drew needs all three:

```bash
DREW_ENABLED=1
DREW_URL=https://<workspace>--echomancer-sowell-speaker-speak.modal.run
DREW_TOKEN=<the same secret as SOWELL_TOKEN>
```

Host only, no path: `DREW_URL` is rejected by both the client and the test
harness if it carries a path. The handler accepts either `SOWELL_TOKEN` or
`DREW_TOKEN` as the bearer, so the same secret value works for both.

Drew is the default the moment those three are set. **Before** they are set,
`getDefaultCatalogVoice()` returns **Ava**, so a no-voice request is never
stored pointing at an endpoint that cannot speak.

## Speed: 0.88 is Drew's native 1x

Drew at Kokoro speed **0.88** is real Andrew's natural pace. That is applied
**once**, in the container:

```
request speed (app units, 1.0 = natural)  ×  0.88  =  Kokoro speed
```

- `scripts/sowell/drew.py` → `drew_speed()` is that multiply. It clamps to
  `0.5–2.0` and treats a missing/zero/NaN value as 1.0.
- `scripts/sowell/engine.py` calls `KPipeline.infer(..., kokoro_speed)`, where
  `kokoro_speed` is `drew_speed(speed)` for Drew and a flat `1.0` for Walter and
  George.
- TypeScript sends the app speed unchanged. `initialNarrationSpeed` returns
  **1.0** for `drew`, and the per-section `calibrateNarrationSpeed` step is
  skipped for `provider: "drew"` exactly as it is for Paradee. That is what
  keeps Drew out of the drift that walked later Andrew sections down to ~0.85.

Do **not** apply 0.88 in TypeScript as well. `drewKokoroSpeed()` in
`src/lib/tts/drew-voice.ts` exists so the mapping can be tested and documented;
the request path does not use it.

## Cache

Drew sections use `drew-kokoro82m-ft-stageA-step00900-v1`. Andrew's Edge takes
stay under the Edge key and are never replayed as Drew. Bump `DREW_WEIGHTS_ID`
in `src/lib/tts/drew-voice.ts` when the volume gets a different checkpoint —
that is a different model, so its audio must not be found under this key.

## Preview

The committed sample is **`public/voice-previews/drew.mp3`**: `PREVIEW_TEXT`
rendered with Drew at app speed 1.0 (Kokoro 0.88, 24 kHz mono). `"drew"` is
in `COMMITTED_PREVIEW_IDS`. Re-record it when `PREVIEW_TEXT` or the volume
checkpoint changes.

Walter's sample is unchanged: `public/voice-previews/sowell.mp3`, a local CPU
take of `PREVIEW_TEXT` with `am_sowell`. Re-record it when `PREVIEW_TEXT`
changes.

## Rollback

Unset `DREW_ENABLED`. The card disappears, a request naming Drew returns 503
`DREW_NOT_CONFIGURED`, and the default falls back to Ava. Stored Drew audio
still plays from object storage. Walter, George, Ava, Libby and every stored
Andrew/Ryan book are unaffected.

## Smoke

Use a short original note, not a customer book.

1. `GET /api/tts/voices` lists `drew` first with `displayName: "Drew"`, and no
   `standard` row.
2. Press play on Drew: the first play may render; a second play is instant if
   the static preview has been added.
3. Make a one-page audiobook with Drew. Confirm the raw object is WAV from this
   provider and the section cache key contains `drew-kokoro82m-ft-stageA`.
4. Confirm two paragraphs of a Drew section come back at the pace you expect —
   not slower than Andrew. A double-applied 0.88 is the failure to listen for.
5. Choose Walter: the card reads "Walter", and a book made with it still
   resolves `catalogVoiceId: "sowell"`.
6. Open a book already made with Andrew: it plays its stored audio and is not
   re-spoken.
