# Turso + R2 Setup Guide for Echomancer

## Why Turso + R2?

| Feature | Local SQLite | Supabase | **Turso + R2** |
|---------|-------------|----------|----------------|
| **Database** | Local file | PostgreSQL | **Edge SQLite** |
| **Query Latency** | 0ms | ~100ms | **<50ms** |
| **File Storage** | Local disk | 1GB limit | **10GB free, no egress** |
| **Cost** | Free | $25/mo after free tier | **FREE** |
| **Multi-region** | ❌ | ✅ | **✅** |
| **Code Changes** | None | Significant | **Minimal** |
| **Backups** | Manual | Automatic | **Automatic** |

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Next.js App   │────▶│    Turso     │     │   Cloudflare    │
│   (Vercel)      │     │  (Edge DB)   │     │      R2         │
└─────────────────┘     └──────────────┘     │  (File Storage) │
         │                                     └─────────────────┘
         │                                            ▲
         │                                            │
         └────────────────────────────────────────────┘
                    Presigned URLs (no egress fees)
```

## Setup Steps

### 1. Create Turso Database

**Option A: Web Dashboard (Easiest)**
1. Go to https://turso.tech
2. Sign up with GitHub
3. Click "New Database"
4. Name: `echomancer`
5. Region: Choose closest to your users (e.g., `lhr` for London)
6. Copy the connection URL and auth token

**Option B: CLI**
```bash
# Install Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash

# Login
turso auth login

# Create database
turso db create echomancer --region lhr

# Get connection details
turso db show echomancer
turso db tokens create echomancer
```

### 2. Create Cloudflare R2 Bucket

1. Go to https://dash.cloudflare.com
2. Navigate to **R2 Object Storage**
3. Click **Create bucket**
4. Name: `echomancer-audio`
5. Location: Automatic (or choose region)
6. Create R2 API Token:
   - Go to **Manage R2 API Tokens**
   - **Create API Token**
   - Permissions: **Object Read & Write**
   - Bucket: **echomancer-audio** only
   - Copy Access Key ID and Secret Access Key

### 3. Update Environment Variables

Edit `.env.local`:

```bash
# === TURSO DATABASE ===
TURSO_DATABASE_URL=libsql://echomancer-YOUR-USERNAME.turso.io
TURSO_AUTH_TOKEN=turso-token-from-dashboard

# === CLOUDFLARE R2 ===
R2_ACCOUNT_ID=your-account-id-from-cloudflare
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=echomancer-audio
R2_PUBLIC_URL=https://pub-xxx.r2.dev  # Optional: for public access
```

### 4. Initialize Database Schema

Run this in the Turso dashboard SQL editor:

```sql
-- Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    credits INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Jobs table
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    pdf_name TEXT NOT NULL,
    pdf_storage_path TEXT NOT NULL,
    voice_sample_path TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    audiobook_path TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Voices table
CREATE TABLE IF NOT EXISTS voices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    sample_rate INTEGER,
    duration_seconds REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
```

### 5. Migrate Existing Data (Optional)

If you have existing local data:

```bash
# Install tsx for running TypeScript
npm install -g tsx

# Run migration
npx tsx migrate-to-turso.ts
```

## Code Usage

### Database Queries

```typescript
import { query, queryOne, execute, transaction } from "@/lib/turso";

// Simple query
const jobs = await query(
  "SELECT * FROM jobs WHERE user_id = ? AND status = ?",
  [userId, "pending"]
);

// Single result
const job = await queryOne(
  "SELECT * FROM jobs WHERE id = ?",
  [jobId]
);

// Insert/update
await execute(
  "INSERT INTO jobs (id, user_id, pdf_name) VALUES (?, ?, ?)",
  [id, userId, pdfName]
);

// Transaction
await transaction(async (tx) => {
  await tx.execute("INSERT INTO users ...", [...]);
  await tx.execute("INSERT INTO jobs ...", [...]);
});
```

### File Storage

```typescript
import { upload, download, getUrl, remove } from "@/lib/storage";

// Upload file (auto-detects R2 vs local)
const result = await upload(
  "pdfs",           // type: pdfs | voices | audiobooks | temp
  userId,
  "document.pdf",
  pdfBuffer,
  "application/pdf"
);
console.log(result.url);  // R2 URL or local path

// Download file
const buffer = await download(key);

// Get presigned URL (for temporary access)
const url = await getUrl(key, 3600);  // 1 hour expiry

// Delete file
await remove(key);
```

## Cost Comparison

### Turso Free Tier
- 500 databases
- 9GB total storage
- 1 billion row reads/month
- 25 million row writes/month

### R2 Free Tier
- 10GB storage
- 1 million Class A operations/month
- 10 million Class B operations/month
- **$0 egress fees** (vs $0.09/GB for AWS S3)

### Real-World Estimate
**For 100 audiobooks/month (avg 50MB each):**
- Storage: 5GB → **FREE**
- Database operations: ~10k → **FREE**
- Bandwidth: Unlimited → **FREE** (R2 has no egress)

**Total: $0/month**

## Monitoring

### Turso Dashboard
- URL: https://turso.tech
- Monitor: Query latency, storage usage, connections

### Cloudflare Dashboard
- URL: https://dash.cloudflare.com
- Monitor: Storage used, request counts, egress (should be $0!)

## Troubleshooting

### "TURSO_DATABASE_URL is not defined"
- Check `.env.local` has the correct variables
- Restart Next.js dev server after editing `.env.local`

### "R2 credentials not configured"
- Verify all R2 environment variables are set
- Check R2 API token has correct permissions

### Slow queries
- Turso is edge-distributed, but first query may be slower
- Consider keeping the connection warm with periodic pings

### Files not uploading
- Check R2 bucket permissions (Object Read & Write)
- Verify bucket name matches `R2_BUCKET_NAME`

## Switching Back to Local

Simply comment out the Turso and R2 environment variables:

```bash
# TURSO_DATABASE_URL=...
# TURSO_AUTH_TOKEN=...
# R2_ACCOUNT_ID=...
```

The app will automatically fall back to local SQLite and file storage.
