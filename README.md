# Echomancer v2

Transform PDFs into audiobooks with custom AI voices from YouTube.

## Architecture

```
Frontend:    Next.js App Router on Vercel (zero-config deployment)
Database:    Supabase (Postgres + Realtime + Storage)
Background:  Trigger.dev (serverless job orchestration)
TTS:         F5-TTS via Replicate API (open-source voice cloning)
Payments:    Stripe (optional)
```

**Zero server management** — all services auto-scale.

## Project Structure

```
src/
├── app/
│   ├── page.tsx                      # Landing page
│   ├── layout.tsx                    # Root layout (dark theme, Toaster)
│   ├── api/
│   │   ├── pdf/upload/route.ts       # PDF upload → Supabase Storage
│   │   ├── youtube/search/route.ts   # YouTube Data API proxy
│   │   ├── audio/upload/route.ts     # Voice sample upload → Supabase Storage
│   │   └── jobs/route.ts             # Job CRUD + Trigger.dev dispatch
│   └── dashboard/
│       ├── layout.tsx                # Sidebar navigation
│       ├── page.tsx                  # PDF upload (step 1)
│       ├── voice/
│       │   ├── page.tsx              # Voice selection (step 2)
│       │   └── clip/page.tsx         # Voice clipping (step 3)
│       ├── queue/page.tsx            # Job queue (Supabase Realtime)
│       ├── player/[id]/page.tsx      # Audio player
│       ├── subscription/page.tsx     # Stripe billing
│       └── resources/page.tsx        # Help & FAQ
├── components/
│   ├── Logo.tsx
│   └── ui/                           # shadcn/ui components
├── lib/
│   ├── utils.ts                      # cn() helper
│   └── supabase/
│       ├── client.ts                 # Browser Supabase client
│       ├── server.ts                 # Server Supabase client (service role)
│       └── types.ts                  # TypeScript types for DB tables
└── trigger/
    └── generate-audiobook.ts         # Trigger.dev background task

supabase/
└── schema.sql                        # Database migration (run in Supabase SQL Editor)
```

## Quick Start

### 1. Set Up Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run `supabase/schema.sql`
3. Go to **Storage** and create a bucket called `audiobooks` (set to public)
4. Go to **Settings → API** and copy your keys

### 2. Set Up Trigger.dev

1. Create an account at [trigger.dev](https://trigger.dev)
2. Create a new project
3. Copy the secret key from **Project → API Keys**

### 3. Get API Keys

| Service | Purpose | URL |
|---------|---------|-----|
| Supabase | Database + Storage + Realtime | https://supabase.com |
| Replicate | F5-TTS voice cloning | https://replicate.com/account/api-tokens |
| YouTube Data API | Video search | https://console.cloud.google.com/apis/credentials |
| Trigger.dev | Background jobs | https://trigger.dev |

### 4. Configure Environment

```bash
cp .env.example .env.local
# Fill in your API keys
```

### 5. Install & Run

```bash
npm install
npm run dev
```

Open http://localhost:3000

### 6. Start Trigger.dev Dev Server

In a separate terminal:

```bash
npx trigger.dev@latest dev
```

## How It Works

1. **Upload PDF** → Stored in Supabase Storage, text extracted
2. **Select Voice** → Search YouTube or upload audio sample
3. **Clip Voice** → Select time range for voice reference
4. **Create Job** → Job record created in Supabase, Trigger.dev task dispatched
5. **Background Processing** → Trigger.dev runs F5-TTS via Replicate API
6. **Real-time Updates** → Supabase Realtime pushes status to frontend
7. **Download/Play** → Generated audio streamed from Supabase Storage

## Key Features

- **Background Processing**: Trigger.dev runs jobs serverlessly — no workers to manage
- **Persistent Storage**: All files in Supabase Storage, all data in Postgres
- **Real-time Updates**: Supabase Realtime pushes job status changes instantly
- **Proper Routing**: Next.js App Router with file-based routes and deep linking

## Deployment

### Vercel (Frontend + API)

```bash
npx vercel
```

Set environment variables in Vercel dashboard.

### Trigger.dev (Background Jobs)

```bash
npx trigger.dev@latest deploy
```

## Costs

| Service | Free Tier | Paid |
|---------|-----------|------|
| Vercel | 100GB bandwidth/mo | $20/mo |
| Supabase | 500MB DB, 1GB storage | $25/mo |
| Trigger.dev | 10k runs/mo | $25/mo |
| Replicate | Pay-per-use | ~$0.10-0.50/audiobook |

## License

Private - All rights reserved
