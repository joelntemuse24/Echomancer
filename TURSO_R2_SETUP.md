# Turso + R2 Setup

Echomancer keeps **metadata in Turso** (edge SQLite) and **bytes in Cloudflare R2**
(S3-compatible, no egress fees). Nothing else is required — no Postgres, no
separate queue, no object CDN.

| Concern | Store | Notes |
|---------|-------|-------|
| Jobs, uploads, usage, rate-limit counters | Turso | Small rows and JSON only |
| Uploaded document + extracted text | R2 | `pdfs/<uploadId>/source.*`, `pdfs/<uploadId>/content.txt` |
| Audio sections + assembled book | R2 | `audiobooks/<jobId>/sections/NNNN.*`, `audiobooks/<jobId>/full.*` |
| Local development | Filesystem | `STORAGE_PATH` is used whenever R2 credentials are absent |

Audio is **never** stored in Turso. The browser **PUTs** source documents to R2
through a short-lived presigned URL (R2 secrets stay on the server). Reads still
go through `/api/storage/**`, which resolves each key back to its owning job or
upload and refuses anything the caller does not own.

---

## 1. Create the Turso database

**Dashboard**

1. <https://turso.tech> → sign in
2. **New Database**, name `echomancer`, pick the region closest to your users
3. Copy the connection URL and create an auth token

**CLI**

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso db create echomancer --region lhr
turso db show echomancer
turso db tokens create echomancer
```

## 2. Create the R2 bucket

1. <https://dash.cloudflare.com> → **R2 Object Storage** → **Create bucket**
2. Name it `echomancer-audio`
3. **Manage R2 API Tokens** → **Create API Token**
   - Permissions: **Object Read & Write**
   - Scope it to the `echomancer-audio` bucket only
   - Copy the Access Key ID and Secret Access Key

Do **not** enable public access on the bucket. The app is the only reader, and
public objects would bypass the ownership checks in `/api/storage`.

### Bucket CORS (required for Whole-book upload)

The landing page PUTs the file from the browser to
`https://<accountid>.r2.cloudflarestorage.com`. Without CORS that PUT fails
even when the presigned URL is valid (Safari/Chrome then surface
`TypeError: Failed to fetch`).

In the bucket → **Settings** → **CORS policy**:

```json
[
  {
    "AllowedOrigins": [
      "https://echomancer.xyz",
      "https://www.echomancer.xyz",
      "https://*.vercel.app",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["PUT", "HEAD", "GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length"],
    "MaxAgeSeconds": 86400
  }
]
```

R2 allows one `*` wildcard per origin, so `https://*.vercel.app` covers preview
deployments. If the dashboard rejects that form, add the production Vercel
hostname explicitly (`https://<project>.vercel.app`) or, for a credential-less
PUT, `AllowedOrigins: ["*"]` with the same methods/headers.

The signed PUT includes `Content-Type` and `Content-Length`. The client must
send that exact `Content-Type`; `Content-Length` is filled by the browser from
the `File`.

## 3. Environment

```bash
# === TURSO ===
TURSO_DATABASE_URL=libsql://echomancer-YOUR-ORG.turso.io
TURSO_AUTH_TOKEN=...

# === R2 ===
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=echomancer-audio
R2_PUBLIC_URL=          # Optional; not required for presigned PUTs
```

With no R2 credentials the storage layer falls back to `STORAGE_PATH`
(`./data/storage` by default). That is a development convenience only: Vercel's
filesystem is ephemeral, so a deploy without R2 loses every audiobook.

## 4. Schema

There is no migrator service. `ensureTtsJobColumns()`
(`src/lib/tts/schema-migrate.ts`) runs on request paths and creates whatever is
missing. It is **additive only** — `CREATE TABLE IF NOT EXISTS` plus
`ALTER TABLE ADD COLUMN` — so it is safe against live data.

To pre-create everything:

```bash
turso db shell echomancer < migrate-turso.sql
```

`migrate-turso.sql` contains no `DROP` and is safe to re-run.

### Tables

| Table | Role |
|-------|------|
| `jobs` | One narration attempt: document + voice + progress + worker lease |
| `uploads` | Which session uploaded which document — the ownership proof for `pdfStoragePath` |
| `usage_logs` | Characters synthesized per action, for cost accounting |
| `rate_limits` | Shared counters; an in-process map enforces nothing across serverless isolates |

### Adding a column

SQLite has no `ADD COLUMN IF NOT EXISTS`, so add it to the `JOB_COLUMNS` list in
`schema-migrate.ts` rather than to the SQL file. That keeps one source of truth
and tolerates the duplicate-column race between concurrent requests.

### Rebuilding from scratch

Destroys data — never run against production:

```sql
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS uploads;
DROP TABLE IF EXISTS usage_logs;
DROP TABLE IF EXISTS rate_limits;
```

Then re-run `migrate-turso.sql` or just start the app.

---

## Using the data layer from code

```typescript
import { query, queryOne, execute, transaction } from "@/lib/turso";

// Always scope reads by owner — see src/lib/auth/guard.ts for the helpers
// that do this for you (requireOwnedJob, ownsStoragePath).
const jobs = await query(
  "SELECT * FROM jobs WHERE user_id = ? AND deleted_at IS NULL",
  [session.userId]
);
```

```typescript
import { uploadFile, downloadFile, deleteFile, listFiles } from "@/lib/storage";

// Picks R2 or the local filesystem automatically.
const { path } = await uploadFile(
  `audiobooks/${jobId}`,
  "sections/0000.mp3",
  buffer,
  "audio/mpeg"
);
```

Deleting a job removes `audiobooks/<jobId>/` eagerly, but only removes
`pdfs/<uploadId>/` when no other non-deleted job still references it — a chapter
preview and a full book are separate jobs over the same upload.

---

## Free-tier headroom

| Turso | R2 |
|-------|-----|
| 9GB storage | 10GB storage |
| 1B row reads / month | 1M Class A ops / month |
| 25M row writes / month | 10M Class B ops / month |
| — | **$0 egress** |

For ~100 audiobooks a month at ~50MB each, both stay inside the free tier. Note
that playback issues many ranged reads per section, so Class B operations grow
with listening rather than with generation.

---

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `TURSO_DATABASE_URL is not defined` | Missing env var; restart `next dev` after editing `.env.local` |
| `R2 credentials not configured` | One of the three R2 vars is missing, so the app fell back to local disk |
| Audio 404s through `/api/storage` | The object belongs to another session, or the session cookie was not sent |
| Uploads work but jobs cannot find them | `uploads` row missing — check the upload route succeeded, not just the R2 write |
| Slow first query | Turso connections warm up; subsequent queries are fast |
