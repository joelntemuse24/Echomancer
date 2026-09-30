# Always-on Whole-book worker

Trigger.dev used to host Whole-book / take-home narration. That role is now
an always-on Node process. **Production host: an Ubuntu VPS running pm2
`echomancer-takehome`, with Caddy terminating HTTPS at
`worker.echomancer.xyz`.** Docker Compose stays as an optional appendix.
Trigger.dev is **legacy fallback only** — not the live Whole-book runner.

**Document extract stays on Cloudflare Workers** (`workers/extract`) with
the Vercel `after()` fallback. Do not parse books on this VM.

TTS still happens at Fish / Edge / Google APIs. The VM only orchestrates:
enqueue → freeze `speakable.txt` / `sections.json` → `process-job` loop →
retries → Turso progress → remux / crossfade / podcast delivery encode (DFN opt-in) → R2.
It does **not** self-host Fish.

## Host sizing

`WORKER_CONCURRENCY=1` is the default. Raise to `2` only after a full
book has mastered without the OOM killer. DeepFilterNet3 is **opt-in**
(`TTS_MASTER_DFN=1` / `TTS_MASTER_DFN_WET>0`); default remaster is
ffmpeg-only and is not the RAM hog.

Production DNS is a Vercel A record for `worker.echomancer.xyz` pointing at
the VPS public IPv4 (apex `echomancer.xyz` uses Vercel nameservers; the
domain is **not** a Cloudflare zone).

## Ports and firewall

| Port | Bind | Open to the internet? |
|------|------|------------------------|
| **22** | SSH | Yes (your IP if you can; otherwise 0.0.0.0/0) |
| **80** | Caddy ACME only | Yes **only** if you use Caddy |
| **443** | Caddy TLS → `127.0.0.1:8788` | Yes **only** if you use Caddy |
| **8788** | Worker | **Never.** Loopback only. |

Vercel must reach `WORKER_URL` over **HTTPS**. There is no webhook back to
Vercel — progress lives in Turso.

If the host has a provider firewall or iptables rules, open 80/443 for
Caddy there too. Do **not** open 8788.

**Require TLS in front of the worker.** Bind `WORKER_HOST=127.0.0.1`
(the pm2 file already does). Production puts **Caddy on 443** and sets
`WORKER_URL=https://worker.echomancer.xyz`. Do not publish 8788 on
`0.0.0.0` or send `WORKER_SECRET` over cleartext HTTP. Vercel egress IPs
are not a stable allowlist.

## Node + ffmpeg + DeepFilter

The worker is TypeScript run with `tsx` — no Next build, no native
rebuild of the app.

| Piece | Notes |
|-------|-----|
| Node 22 | NodeSource `setup_22.x`. Need ≥ 20. |
| `ffmpeg` | Ubuntu `apt` package, **4.4+** (`deesser`, `loudnorm`, concat demuxer). 24.04 ships 6.1. Used for streaming finalize. |
| `deep-filter` 0.5.6 | Official rust CLI, SHA-pinned in `install-oracle.sh` (x86_64 musl or aarch64 gnu). |
| `libatomic1` | Needed by the aarch64 gnu DeepFilter binary. |

Default mastering is **ffmpeg-only** and runs inside the streaming
finalize (high-pass, low-mid cut, presence, light de-ess, loudnorm −16
LUFS). Sections land on disk under `ECHOMANCER_SCRATCH_DIR` (default
`/tmp/echomancer/<jobId>`), ffmpeg streams `full.mp3`, and the dir is
deleted after upload or on failure. Budget about **320 MB of disk per
hour** of audio (44.1 kHz mono s16) plus the MP3. Peak RAM stays in the
low hundreds of MB, so a box shared with another app can finalize
a multi-hour book. DeepFilter opt-in needs a second ~320 MB/hour WAV.
Fail-open: if the delivery chain errors, a loudnorm-only file still
ships. A failed stream does not fall back into an in-memory PCM concat.
DeepFilterNet3 runs only when `TTS_MASTER_DFN=1` and/or
`TTS_MASTER_DFN_WET>0`, as a second pass. Set `TTS_MASTER_SKIP=1` only
if you want to skip a second pass that would otherwise run.

## Deploy (pm2) — primary

```bash
git clone https://github.com/joelntemuse24/Echomancer.git
cd Echomancer
git checkout main
cp env.worker.example .env.worker
# fill Turso, R2, WORKER_SECRET (required). FISH / Google only if those voices run here.
bash scripts/oracle/install-oracle.sh
# edit .env.worker, then:
pm2 start scripts/oracle/ecosystem.config.cjs
pm2 save
sudo env PATH=$PATH:$(dirname "$(command -v node)") pm2 startup systemd -u "$USER" --hp "$HOME"
bash scripts/oracle/smoke-worker.sh
```

`install-oracle.sh` installs Node 22 (if missing), `ffmpeg`,
`libatomic1`, `npm ci`, the arch-correct `deep-filter`, and pm2. It does
not start the process until `.env.worker` has a secret (`--start`).

Optional flags: `--with-caddy`, `--start`.

Update later:

```bash
cd ~/Echomancer
git pull origin main
npm ci
pm2 restart echomancer-takehome
```

`kill_timeout: 120000` in `scripts/oracle/ecosystem.config.cjs` lets an
in-flight section finish before SIGKILL.

## YouTube audio is not downloaded here

Voice-from-YouTube is recorded in the browser. This VM does not run yt-dlp.
`YOUTUBE_API_KEY` stays on Vercel for search.

## TLS — production is Caddy on `worker.echomancer.xyz`

Vercel must reach `WORKER_URL` over **HTTPS**. Production (2026-09-20):

| | |
|--|--|
| Hostname | `worker.echomancer.xyz` |
| Proxy | **Caddy on the VM** → `127.0.0.1:8788` |
| DNS | A record on **Vercel** (apex `echomancer.xyz` uses Vercel nameservers) |
| Cloudflare zone | **None.** The domain is not on Cloudflare as a zone. |
| Vercel env | `WORKER_URL=https://worker.echomancer.xyz` + `WORKER_SECRET` |

Do **not** use `trycloudflare.com` quick tunnels as production `WORKER_URL`
(the hostname changes on every restart).

```bash
bash scripts/oracle/install-oracle.sh --with-caddy
# Vercel dashboard → echomancer.xyz → DNS → A record:
#   worker  →  <VM public IPv4>
sudo cp scripts/oracle/Caddyfile.example /etc/caddy/Caddyfile
# hostname in that file is worker.echomancer.xyz
sudo systemctl reload caddy
# open 80/443 on any host firewall (see above)
```

nginx is the same idea: `proxy_pass http://127.0.0.1:8788;` on 443.

## Worker env

See `env.worker.example`. Same Turso + R2 + TTS keys as Vercel, plus:

| Variable | Default | Meaning |
|----------|---------|---------|
| `WORKER_SECRET` | — | Shared with Vercel. Required unless `INTERNAL_JOB_SECRET` is set. |
| `WORKER_CONCURRENCY` | **1** | Whole books in flight, not sections. `2` only after a mastered book fits in RAM. |
| `TTS_SECTIONS_PER_TICK` | **8** | Sections claimed per tick. Edge/Google honor 8. Fish and clones stay capped at 5 (4 while a live Fish request is in flight). |
| `TTS_EDGE_GOOGLE_SECTION_CONCURRENCY` | **8** | Edge and Google sections in flight for one book (1–8). A 429 or 503 halves this for the process. Fish and clones ignore it. |
| `WORKER_DRAIN_INTERVAL_MS` | 15000 | Turso poll (queued + lease-expired) |
| `WORKER_PORT` | 8788 | Listen port |
| `WORKER_HOST` | `127.0.0.1` via pm2 | Loopback. Do not set `0.0.0.0` on a public NIC. |
| `TTS_VM_WAVE_BUDGET_MS` | 900000 | Wave clock (same idea as Trigger) |
| `DEEP_FILTER_BIN` | `/usr/local/bin/deep-filter` | Set by `install-oracle.sh` / pm2 |
| `TTS_MASTER_FULL_BOOK` | `1` via pm2 | Enable the second-pass remaster on this host when the join did not already apply the chain |
| `TTS_MASTER_DFN` | unset (off) | Set `1` to run DeepFilterNet3 before the delivery chain (wet 0.4 unless `TTS_MASTER_DFN_WET` is set) |
| `TTS_MASTER_DFN_WET` | `0` (ffmpeg-only) | DFN wet mix 0–1. `>0` enables DFN; `0` skips it even if `TTS_MASTER_DFN=1` |
| `OPENROUTER_API_KEY` | same as Vercel | Listen-prep fallback, and section transcript QA (`deepgram/nova-3`). The request runs on a worker thread and is aborted at 5 seconds of wall clock. `TTS_SECTION_QA_ENABLED=0` skips QA even when a key is set (`qa skipped: disabled`). Copy from Vercel. Without it the worker logs `qa skipped: no provider`. |
| `LISTEN_PREP_MODEL` | `xiaomi/mimo-v2.6-flash` | Cleanup model. Temperature 0, reasoning off, strict JSON schema, provider order DeepInfra, Xiaomi, GMICloud (`allow_fallbacks` false). 4000 output tokens, 20s per attempt, one retry on 429 or 5xx. |
| `LISTEN_PREP_REASONING` | `off` for `xiaomi/*`, else `minimal` | `off` or `minimal`. MiMo ignores `minimal` and spends the output budget on reasoning. The DeepSeek fallback stays off. |
| `LISTEN_PREP_FALLBACK_MODEL` | `deepseek/deepseek-v4.1-flash` | Used after the primary attempt fails. Provider order Together then DeepInfra, reasoning off. The prose check stays on. Then the chunk keeps the pre-pass text. |
| `LISTEN_PREP_CONCURRENCY` | `8` | Chunks in flight for one book. |
| `LISTEN_PREP_GLOBAL_CONCURRENCY` | `20` | Requests in flight across books on this worker. |
| `LISTEN_PREP_CHUNK_TIMEOUT_MS` | `20000` | Per attempt. |
| `ECHOMANCER_SCRATCH_DIR` | `os.tmpdir()/echomancer` | Per-job finalize scratch. Removed after upload. |
| `ECHOMANCER_SCRATCH_MAX_AGE_HOURS` | 24 | Startup and periodic sweep of dirs older than this. |
| `ECHOMANCER_SCRATCH_SWEEP_MS` | 900000 | Sweep interval. Values under 60s are ignored. |
| `TTS_FINALIZE_TIMEOUT_MS` | 21600000 | Kills a stuck ffmpeg (6 hours). |

`WORKER=1` marks the process as the Whole-book host (mastering gate,
secrets check). Never set `VERCEL=1` here.

Edge stock (Andrew / Ava / Libby / Ryan, plus legacy Michelle) needs no Fish key. A book
already stored as Clara, and user clones, need `FISH_API_KEY`. Listen-prep fallback uses the same
`OPENROUTER_API_KEY` as Vercel.
A book already stored as Randolph still needs
`GOOGLE_TTS_API_KEY` or `GOOGLE_TTS_ACCESS_TOKEN`. New requests use Ryan on Edge.

## Vercel env (production)

| Variable | Required | Notes |
|----------|----------|--------|
| `WORKER_URL` | **yes** (production) | `https://worker.echomancer.xyz` (no trailing slash). Must be HTTPS. |
| `WORKER_SECRET` | **yes** when `WORKER_URL` is set | Same value as on the VM. Falls back to `INTERNAL_JOB_SECRET` if unset. A URL without a secret is **503**. |
| `TAKEHOME_TRIGGER_FALLBACK` | no | `1` = also fire **legacy** Trigger if the worker POST fails |
| `TRIGGER_SECRET_KEY` | no (legacy) | Only if `WORKER_URL` is unset. Not the production Whole-book runner. |

Vercel dashboard → Project → Settings → Environment Variables →
**Production**:

1. `WORKER_URL=https://worker.echomancer.xyz`
2. `WORKER_SECRET=` the same hex you put in `.env.worker`.
3. Redeploy Production so the functions pick up the values.

Once both are set, `POST /api/jobs` take-home (and retry / `/takehome`)
POSTs `{ jobId }` to `WORKER_URL/jobs` with
`Authorization: Bearer $WORKER_SECRET`. Missing both `WORKER_URL` and
`TRIGGER_SECRET_KEY` in production is **503** `TAKEHOME_NOT_CONFIGURED`
**before insert**. After insert, a failed worker POST leaves the job
`queued` for the VM drain loop (still HTTP 200).

### Keep legacy Trigger drain off

Dropping `TRIGGER_SECRET_KEY` on Vercel does **not** stop Trigger Cloud.
The minute cron `takehome.drain` can still claim `queued` rows. Production
Whole book is the VPS worker; keep drain paused:

1. Pause `takehome.drain` in the Trigger dashboard, **or**
2. Set `TAKEHOME_TRIGGER_DRAIN=0` on the Trigger project.

Leave the task files in the repo as fallback code. Do **not** change
Trigger drain defaults in this repo just to cut over.

## Endpoints

| Method | Path | Auth | Role |
|--------|------|------|------|
| `GET` | `/health` | none | Process liveness (no Turso) |
| `GET` | `/ready` | none | 200 if Turso answers |
| `POST` | `/jobs` | Bearer | `{ "jobId" }` — wake that take-home (404 if missing / not take-home). Body cap 16 KB. |

Logs: `pm2 logs echomancer-takehome` (`[takehome-worker] …`).

## Smoke

On the VM (worker already running):

```bash
bash scripts/oracle/smoke-worker.sh
# or, after TLS:
WORKER_SECRET=… bash scripts/oracle/smoke-worker.sh https://worker.echomancer.xyz
```

The script checks:

1. Required `.env.worker` keys exist (does not print values).
2. `GET /health` → 200 `echomancer-takehome`.
3. `GET /ready` → 200 (503 = Turso creds / network from the VM).
4. `POST /jobs` without a bearer → 401.
5. `POST /jobs` with the secret and a fake id → 404.

Then enqueue **one tiny real book** from the app: paste a paragraph, pick
**Andrew**, Make audiobook. Library should leave
`queued`. `pm2 logs` shows accept / settled. That is the cutover signal
— then disable Trigger drain (above).

## Cancel and concurrency

Unchanged: `POST /api/jobs/[id]/cancel` sets `cancelled` and clears the
lease. `runTakehomeUntilSettled` stops on `ready` / `failed` / `cancelled`.
Two workers cannot synthesize the same section — lease tokens already
gate every progress write. This process also refuses to start a `jobId`
that is already in flight.

## Troubleshooting

| Issue | Check |
|-------|--------|
| Jobs sit at `queued` | VM down, `WORKER_URL` unreachable from Vercel, or Turso creds missing on the VM |
| `TAKEHOME_NOT_CONFIGURED` 503 | Production has neither `WORKER_URL` nor `TRIGGER_SECRET_KEY`, or `WORKER_URL` is set without a secret |
| Worker 401 | `WORKER_SECRET` / `INTERNAL_JOB_SECRET` mismatch |
| `/ready` 503 | `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` on the VM |
| OOM during master | Keep `WORKER_CONCURRENCY=1` |
| 443 times out | Host firewall; Caddy on `worker.echomancer.xyz` |
| `deep-filter` exec format error | Wrong-arch binary — rerun `install-oracle.sh` |
| Extract jobs on this VM | Don't — extract stays on `workers/extract` |

## Production cutover notes

Live TLS is Caddy at `https://worker.echomancer.xyz` (Vercel A record → VM
IPv4). Keep `WORKER_SECRET` matching `.env.worker` and Vercel Production.
After a green tiny job, pause Trigger `takehome.drain` or set
`TAKEHOME_TRIGGER_DRAIN=0` so the minute cron cannot steal `queued` rows.

If you rebuild the box: paste the public IPv4 into the Vercel DNS A record
for `worker`, copy Turso + R2 (+ `FISH_API_KEY` / `GOOGLE_TTS_API_KEY` if
those voices will run) into `.env.worker`, and never commit that file.

## Appendix — Docker (optional)

Joel’s preferred path is pm2 above. Compose is still here if you want it.

```bash
cp env.worker.example .env.worker
# fill secrets
docker compose up -d --build
curl -fsS http://127.0.0.1:8788/health
curl -fsS http://127.0.0.1:8788/ready
```

`restart: unless-stopped` keeps the compose service up across reboots.
`stop_grace_period: 2m` lets an in-flight section finish before SIGKILL.
Compose publishes `127.0.0.1:8788` only — still put **Caddy** in front
(`worker.echomancer.xyz`).

The image installs debian `ffmpeg` and the rust `deep-filter` 0.5.6
binary (SHA-pinned, not Python+torch) and sets `WORKER=1` +
`DEEP_FILTER_BIN`. On arm64, BuildKit `TARGETARCH=arm64` selects the
aarch64 gnu binary. On x86_64 it keeps the musl pin shared with
`trigger.config.ts`.

Without Compose, `npm ci && npm run worker:takehome` is the same process
the pm2 file runs.

Do not run extract in this image.
