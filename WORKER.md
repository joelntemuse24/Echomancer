# Always-on Whole-book worker

Trigger.dev used to host Whole-book / take-home narration. That role is now
an always-on Node process. **Production host (2026-09-20): Oracle Cloud
Always Free + pm2 `echomancer-takehome`, with Caddy terminating HTTPS at
`worker.echomancer.xyz`.** Docker Compose stays as an optional appendix.
Trigger.dev is **legacy fallback only** — not the live Whole-book runner.

**Document extract stays on Cloudflare Workers** (`workers/extract`) with
the Vercel `after()` fallback. Do not parse books on this VM.

TTS still happens at Fish / Edge / Google APIs. The VM only orchestrates:
enqueue → freeze `speakable.txt` / `sections.json` → `process-job` loop →
retries → Turso progress → remux / crossfade / loudnorm / DFN master → R2.
It does **not** self-host Fish.

## Oracle Always Free shape

Stay on **Always Free**. Do not pick a paid shape. Do not convert a free
tenancy to Pay As You Go just to get more Ampere — that is how a $0 box
starts billing.

| | Always Free (use this) | Do not use |
|--|------------------------|------------|
| Shape | **`VM.Standard.A1.Flex`** (Ampere ARM) | `VM.Standard.E2.1.Micro` (1 GB — too small) |
| Size | **2 OCPU / 12 GB** (current Always Free cap, Aug 2026) | 4 OCPU / 24 GB on a free tenancy (Oracle may terminate or bill) |
| Disk | **50 GB** boot volume (Ampere minimum is 47 GB; tenancy has 200 GB total) | Extra paid block volume |
| OS | **Canonical Ubuntu 22.04 or 24.04 aarch64** | Oracle Linux is fine but this runbook assumes Ubuntu (`ubuntu` user) |
| Region | Home region; if "Out of capacity", retry another AD, then another region | Paid capacity reservations |

Older docs (and some Oracle pages) still mention 4 OCPU / 24 GB. That was
the previous Always Free Ampere allotment. **New free tenancies get 2 / 12.**
If a tenancy already has 4 / 24 grandfathered, it will work — do not
*create* 4 / 24 on a new free account.

`WORKER_CONCURRENCY=1` on 2 OCPU / 12 GB. DeepFilterNet3 + a long-book WAV
buffer is the RAM hog. Raise to `2` only after a full book has mastered
without the OOM killer.

### Console steps (Compute → Instances → Create)

1. Image: Canonical Ubuntu 22.04 or 24.04 (**aarch64**).
2. Shape: Ampere → `VM.Standard.A1.Flex` → **2 OCPU / 12 GB**.
3. Networking: assign a public IPv4 (ephemeral is fine). Note the IP —
   that is the **Caddy** target. Production DNS is a Vercel A record for
   `worker.echomancer.xyz` (apex `echomancer.xyz` uses Vercel nameservers;
   the domain is **not** a Cloudflare zone).
4. SSH key. Default user on Ubuntu images is `ubuntu`.
5. Boot volume 50 GB.

Capacity is often exhausted in popular ADs. Retry; do not upgrade the
shape to paid to "get it to launch."

## Ports and firewall

| Port | Bind | Open to the internet? |
|------|------|------------------------|
| **22** | SSH | Yes (your IP if you can; otherwise 0.0.0.0/0) |
| **80** | Caddy ACME only | Yes **only** if you use Caddy |
| **443** | Caddy TLS → `127.0.0.1:8788` | Yes **only** if you use Caddy |
| **8788** | Worker | **Never.** Loopback only. |

Vercel must reach `WORKER_URL` over **HTTPS**. There is no webhook back to
Vercel — progress lives in Turso.

Oracle has **two** firewalls. Opening only one of them looks like a
dead port.

1. **VCN security list / NSG** (Console → the subnet or the VNIC):
   ingress TCP 22, and 80/443 if Caddy. Do **not** add 8788.
2. **iptables on the VM** (Oracle Ubuntu images reject new ports by
   default). After Caddy is installed:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save   # or: sudo iptables-save | sudo tee /etc/iptables/rules.v4
```

Oracle Linux uses `firewall-cmd` instead. A **Cloudflare tunnel** needs
neither 80 nor 443 in the NSG or iptables.

**Require TLS in front of the worker.** Bind `WORKER_HOST=127.0.0.1`
(the pm2 file already does). Production puts **Caddy on 443** and sets
`WORKER_URL=https://worker.echomancer.xyz`. Do not publish 8788 on
`0.0.0.0` or send `WORKER_SECRET` over cleartext HTTP. Vercel egress IPs
are not a stable allowlist.

## ARM notes (Node + ffmpeg + DeepFilter)

Ampere is `aarch64`. The worker is TypeScript run with `tsx` — no Next
build, no native rebuild of the app.

| Piece | ARM |
|-------|-----|
| Node 22 | NodeSource `setup_22.x` ships `arm64`. Need ≥ 20. |
| `ffmpeg` | Ubuntu `apt` aarch64 package. Used for concat / loudnorm. |
| `deep-filter` 0.5.6 | Official `aarch64-unknown-linux-gnu` rust CLI (SHA-pinned in `install-oracle.sh`). **Not** the Dockerfile's x86_64 musl binary. |
| `@libsql/client` | Lockfile already has `@libsql/linux-arm64-gnu`. `npm ci` is enough. |
| `libatomic1` | Install on ARM — the gnu DeepFilter binary is dynamically linked. |

Mastering is fail-open: if `deep-filter` is missing, the dry concat still
ships. Set `TTS_MASTER_SKIP=1` only if you want to skip the attempt.

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

Optional flags: `--with-caddy`, `--with-cloudflared`, `--start`.

Update later:

```bash
cd ~/Echomancer
git pull origin main
npm ci
pm2 restart echomancer-takehome
```

`kill_timeout: 120000` in `scripts/oracle/ecosystem.config.cjs` lets an
in-flight section finish before SIGKILL.

### systemd instead of pm2

```bash
sudo cp scripts/oracle/echomancer-takehome.service /etc/systemd/system/
# edit User, WorkingDirectory, EnvironmentFile if the clone is not
# /home/ubuntu/Echomancer (Oracle Linux user is opc).
sudo systemctl daemon-reload
sudo systemctl enable --now echomancer-takehome
sudo systemctl status echomancer-takehome
```

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

### A. Caddy on 443 (production)

```bash
bash scripts/oracle/install-oracle.sh --with-caddy
# Vercel dashboard → echomancer.xyz → DNS → A record:
#   worker  →  <VM public IPv4>
sudo cp scripts/oracle/Caddyfile.example /etc/caddy/Caddyfile
# hostname in that file is worker.echomancer.xyz
sudo systemctl reload caddy
# open 80/443 on the NSG *and* iptables (see above)
```

nginx is the same idea: `proxy_pass http://127.0.0.1:8788;` on 443.

### B. Named Cloudflare tunnel (optional; not production)

A named tunnel needs a hostname on a **Cloudflare DNS zone**.
`echomancer.xyz` is on Vercel nameservers, so this path is **blocked**
unless you add a Cloudflare zone (or use a different domain that already
is one). Do not set `trycloudflare.com` URLs as `WORKER_URL`.

```bash
bash scripts/oracle/install-oracle.sh --with-cloudflared
cloudflared tunnel login
cloudflared tunnel create echomancer-takehome
# only works if the hostname's zone is on Cloudflare:
cloudflared tunnel route dns echomancer-takehome worker.echomancer.xyz
# copy scripts/oracle/cloudflared.yml.example → /etc/cloudflared/config.yml
# fill tunnel id + credentials-file
sudo cloudflared service install
```

## Worker env

See `env.worker.example`. Same Turso + R2 + TTS keys as Vercel, plus:

| Variable | Default | Meaning |
|----------|---------|---------|
| `WORKER_SECRET` | — | Shared with Vercel. Required unless `INTERNAL_JOB_SECRET` is set. |
| `WORKER_CONCURRENCY` | **1** on Always Free | Jobs in flight. `2` only after a mastered book fits in 12 GB. |
| `WORKER_DRAIN_INTERVAL_MS` | 15000 | Turso poll (queued + lease-expired) |
| `WORKER_PORT` | 8788 | Listen port |
| `WORKER_HOST` | `127.0.0.1` via pm2 | Loopback. Do not set `0.0.0.0` on a public NIC. |
| `TTS_VM_WAVE_BUDGET_MS` | 900000 | Wave clock (same idea as Trigger) |
| `DEEP_FILTER_BIN` | `/usr/local/bin/deep-filter` | Set by `install-oracle.sh` / pm2 |
| `TTS_MASTER_FULL_BOOK` | `1` via pm2 | Enable remaster (light DFN + loudnorm + 44.1 kHz ~192 kbps) on this host |
| `OPENROUTER_API_KEY` | same as Vercel | Required for Whole-book Fish / clone cue tagging. Copy from Vercel. |
| `FISH_CUE_TAGGER_MODEL` | `openai/gpt-oss-20b` | OpenRouter chat model. Production worker: `nvidia/nemotron-3.5-lightning:free`. |
| `FISH_CUE_TAGGER_TIMEOUT_MS` | `40000` | Max wait for the one-shot full-speakable tagger (clamp 1s–120s). Returns as soon as the model answers. |
| `FISH_CUE_TAGGER` | unset (on) | Set `0` to skip tagging. |

`WORKER=1` marks the process as the Whole-book host (mastering gate,
secrets check). Never set `VERCEL=1` here.

Edge stock (Standard / Michelle) needs no Fish or Google key. Clara /
clones need `FISH_API_KEY` and, for Whole-book cue tagging, the same
`OPENROUTER_API_KEY` as Vercel. Randolph needs `GOOGLE_TTS_API_KEY` or
`GOOGLE_TTS_ACCESS_TOKEN`.

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
Whole book is the Oracle VM; keep drain paused:

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
**Standard** or **Michelle**, Make audiobook. Library should leave
`queued`. `pm2 logs` shows accept / settled. That is the cutover signal
— then disable Trigger drain (above).

## Cancel and concurrency

Unchanged: `POST /api/jobs/[id]/cancel` sets `cancelled` and clears the
lease. `runTakehomeUntilSettled` stops on `ready` / `failed` / `cancelled`.
Two workers cannot synthesize the same section — lease tokens already
gate every progress write. This process also refuses to start a `jobId`
that is already in flight.

## Migration

1. Launch the Always Free A1 Flex VM. Run `install-oracle.sh`, fill
   `.env.worker`, `pm2 start` + `pm2 startup`.
2. Confirm `bash scripts/oracle/smoke-worker.sh`.
3. Put TLS in front (`127.0.0.1:8788`) with **Caddy**. Set Vercel
   **Production** `WORKER_URL=https://worker.echomancer.xyz` +
   `WORKER_SECRET`. Redeploy.
4. Create a small Whole-book job. Library should leave `queued` without
   a Trigger run. Worker logs show accept / settled.
5. **Disable Trigger drain** (`TAKEHOME_TRIGGER_DRAIN=0` on the Trigger
   project, or pause `takehome.drain`). Otherwise the minute cron can
   still claim `queued` rows.
6. Optional: `TAKEHOME_TRIGGER_FALLBACK=1` for a week, then drop
   `TRIGGER_SECRET_KEY` on Vercel.

Extract is unchanged: `EXTRACT_WORKER_URL` still points at Cloudflare.
The Vercel `/api/cron/process-jobs` operator fallback remains.

## Troubleshooting

| Issue | Check |
|-------|--------|
| Jobs sit at `queued` | VM down, `WORKER_URL` unreachable from Vercel, or Turso creds missing on the VM |
| `TAKEHOME_NOT_CONFIGURED` 503 | Production has neither `WORKER_URL` nor `TRIGGER_SECRET_KEY`, or `WORKER_URL` is set without a secret |
| Worker 401 | `WORKER_SECRET` / `INTERNAL_JOB_SECRET` mismatch |
| `/ready` 503 | `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` on the VM |
| OOM during master | Keep `WORKER_CONCURRENCY=1` on 12 GB |
| Out of capacity (launch) | Other AD / region; stay on Always Free 2 / 12 |
| 443 times out | NSG **and** iptables; Caddy on `worker.echomancer.xyz`. Named CF tunnel needs a Cloudflare zone (production does not have one). |
| `deep-filter` exec format error | x86 musl binary on Ampere — rerun `install-oracle.sh` |
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
(`worker.echomancer.xyz`). A named Cloudflare tunnel is not production.

The image installs debian `ffmpeg` and the rust `deep-filter` 0.5.6
binary (SHA-pinned, not Python+torch) and sets `WORKER=1` +
`DEEP_FILTER_BIN`. On Ampere, BuildKit `TARGETARCH=arm64` selects the
aarch64 gnu binary. On x86_64 it keeps the musl pin shared with
`trigger.config.ts`.

Without Compose, `npm ci && npm run worker:takehome` is the same process
the pm2 file runs.

Do not run extract in this image.
