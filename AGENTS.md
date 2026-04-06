# Echomancer v2 - AI Coding Agent Guide

> Transform PDFs into audiobooks with custom AI voices from YouTube.

---

## Project Overview

Echomancer v2 is a full-stack web application that converts PDF documents into audiobooks using voice cloning technology. Users can upload PDFs, select voice samples from YouTube or upload their own audio, and generate audiobooks with AI-synthesized speech that matches the voice sample.

### Core Features

- **PDF Processing**: Extract text from uploaded PDF documents
- **Voice Cloning**: Use audio samples from YouTube or direct uploads
- **Voice Clipping**: Select specific time ranges from audio samples
- **AI-Directed Narration**: LLM analyzes text to adjust pacing and speed dynamically
- **Background Processing**: Async audiobook generation with real-time progress updates
- **Audio Enhancement**: Automatic vocal isolation and audio cleaning

---

## Technology Stack

### Frontend
- **Framework**: Next.js 16.1.6 with App Router
- **Language**: TypeScript 5.x with strict mode enabled
- **UI Library**: React 19.2.3 with shadcn/ui components
- **Styling**: Tailwind CSS 4 with custom dark theme
- **State**: React hooks (no external state management)
- **Real-time**: Supabase Realtime for live job updates

### Backend
- **API Routes**: Next.js API routes (Edge-compatible)
- **Database**: Supabase (PostgreSQL) with Row Level Security
- **Storage**: Supabase Storage for PDFs, audio, and generated audiobooks
- **Background Jobs**: Direct async processing via `generateAudiobookV2()`
- **PDF Parsing**: `unpdf` library for text extraction
- **Validation**: Zod schemas for all API inputs

### AI/ML Infrastructure (Modal)
- **Platform**: Modal.com (serverless GPU infrastructure)
- **Primary TTS**: F5-TTS on L4 GPU
- **Audio Cleaning**: Demucs + Silero VAD for vocal isolation
- **LLM Director**: Advanced Emotion Director v3 (28 emotions + Sarcasm, Irony, Dry Wit, Melancholy, Resignation, Longing) for professional audiobook narration
- **Legacy TTS**: Zonos (kept for reference)

---

## Project Structure

```
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── api/                      # API Routes
│   │   │   ├── audio/upload/         # Audio file upload endpoint
│   │   │   ├── jobs/                 # Job CRUD + generation trigger
│   │   │   ├── pdf/upload/           # PDF upload endpoint
│   │   │   └── youtube/              # YouTube search & download
│   │   ├── dashboard/                # Main application UI
│   │   │   ├── page.tsx              # New audiobook (PDF upload)
│   │   │   ├── voice/page.tsx        # Voice selection (YouTube search)
│   │   │   ├── voice/clip/page.tsx   # Voice clipping UI
│   │   │   ├── queue/page.tsx        # Job queue with realtime updates
│   │   │   ├── player/[id]/page.tsx  # Audiobook player
│   │   │   ├── subscription/page.tsx # Billing/subscription
│   │   │   └── resources/page.tsx    # Help & FAQ
│   │   ├── layout.tsx                # Root layout (fonts, theme, Toaster)
│   │   ├── page.tsx                  # Landing/marketing page
│   │   └── globals.css               # Global styles
│   ├── components/
│   │   ├── ui/                       # shadcn/ui components (reusable)
│   │   ├── Logo.tsx                  # Application logo
│   │   ├── theme-provider.tsx        # Dark/light mode provider
│   │   └── theme-toggle.tsx          # Theme switcher button
│   └── lib/                          # Utility libraries
│       ├── generate-audiobook-v2.ts  # Core audiobook generation logic
│       ├── supabase/
│       │   ├── client.ts             # Browser Supabase client
│       │   ├── server.ts             # Server-side client (service role)
│       │   └── types.ts              # TypeScript types for DB tables
│       ├── env.ts                    # Environment variable validation (Zod)
│       ├── errors.ts                 # Custom error classes
│       ├── utils.ts                  # cn() helper for Tailwind
│       └── validation.ts             # Zod schemas for API validation
├── modal/                            # Modal.com deployment scripts
│   ├── f5_tts_server_fixed.py        # Primary TTS server (F5-TTS)
│   ├── audio_cleaner.py              # Vocal isolation & audio cleaning
│   ├── llm_director.py               # LLM-based pacing/speed control
│   ├── zonos_server.py               # Legacy Zonos server
│   └── fish_speech_server.py         # Legacy Fish Speech server
├── supabase/
│   └── schema.sql                    # Database schema migration
├── .env.local                        # Environment variables (not in git)
├── next.config.ts                    # Next.js configuration with security headers
├── package.json                      # Dependencies and scripts
├── tsconfig.json                     # TypeScript configuration
└── netlify.toml                      # Netlify deployment config
```

---

## Architecture

### Data Flow

```
1. User uploads PDF → Supabase Storage (audiobooks bucket)
2. User selects voice source:
   a. YouTube: Search → Download → Store in Supabase
   b. Upload: Direct upload to Supabase Storage
3. User clips voice sample (start/end time selection)
4. Create Job → Insert into Supabase `jobs` table
5. Background Generation (generateAudiobookV2):
   a. Download PDF → Extract text (unpdf)
   b. Download voice sample → Send to Audio Cleaner (Modal)
   c. For each text chunk:
      i. Call LLM Director for pacing/speed (Modal)
      ii. Generate audio with Zonos TTS (Modal)
      iii. Upload checkpoint chunk to Supabase
   d. Validate all checkpoints exist
   e. Concatenate chunks (strip ID3 headers from non-first)
   f. Upload final audiobook
   g. Update job status to "ready"
6. Frontend receives realtime updates via Supabase Realtime
7. User plays/downloads completed audiobook
```

### Database Schema

**Key Tables:**
- `users`: User accounts with credits
- `jobs`: Audiobook generation jobs (status: queued/processing/ready/failed)
- `voices`: Saved voice samples (source: youtube/upload)
- `job_checkpoints`: Partial progress for resume capability
- `voice_samples`: Multiple samples per voice (future feature)
- `usage_logs`: Billing/usage tracking

---

## Build and Development Commands

```bash
# Install dependencies
npm install

# Development server (Next.js)
npm run dev

# Production build
npm run build

# Start production server
npm run start

# Linting
npm run lint

# Deploy Modal servers (run from modal/ directory)
cd modal && modal deploy zonos_server.py
cd modal && modal deploy audio_cleaner.py
cd modal && modal deploy llm_director.py
```

### Development Workflow

1. **Start Next.js dev server**: `npm run dev` (http://localhost:3000)
2. **Environment setup**: Copy `.env.local` template and fill in API keys
3. **Database**: Run `supabase/schema.sql` in Supabase SQL Editor
4. **Storage**: Create `audiobooks` bucket (public) in Supabase
5. **Modal**: Deploy TTS servers and update URLs in `.env.local`

---

## Environment Variables

Required in `.env.local`:

```bash
# Supabase (Required)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Modal TTS Services
MODAL_TTS_URL=https://yourname--zonos-tts-zonoserver.modal.run
MODAL_AUDIO_CLEANER_URL=https://yourname--audio-cleaner-audiocleaner.modal.run
MODAL_LLM_DIRECTOR_URL=https://yourname--echomancer-llm-director-llmdirector.modal.run

# YouTube Data API
YOUTUBE_API_KEY=your-youtube-api-key

# Optional
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Environment validation is handled in `src/lib/env.ts` using Zod schema.

---

## Code Style Guidelines

### TypeScript
- **Strict mode enabled**: `strict: true` in tsconfig.json
- **No unchecked indexed access**: `noUncheckedIndexedAccess: true`
- **Path alias**: Use `@/*` for imports from `src/`
- **Type safety**: All API inputs validated with Zod

### Naming Conventions
- **Components**: PascalCase (e.g., `DashboardLayout.tsx`)
- **Utilities**: camelCase (e.g., `generateAudiobookV2`)
- **Constants**: UPPER_SNAKE_CASE for configuration
- **Database**: snake_case columns (e.g., `storage_path`)
- **Files**: kebab-case for routes (e.g., `voice/clip/page.tsx`)

### Error Handling
- Use custom `AppError` class for API errors (`src/lib/errors.ts`)
- Always use `handleApiError()` in API routes
- Log errors with job ID prefix for traceability: `[Job ${jobId}] ...`
- Non-critical errors should warn, not throw

### Security Headers
Configured in `next.config.ts`:
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- Strict-Transport-Security (HSTS)
- Permissions-Policy (restricts camera/mic/geolocation)

---

## Testing Instructions

### Manual Testing Checklist

1. **PDF Upload**
   - Upload various PDF sizes
   - Verify text extraction quality
   - Test with scanned PDFs (should fail gracefully)

2. **Voice Selection**
   - YouTube search functionality
   - Audio upload with various formats
   - Voice clipping UI (time range selection)

3. **Job Creation**
   - Create job with valid inputs
   - Verify job appears in queue with realtime updates
   - Test job cancellation

4. **Audio Generation**
   - Monitor progress via realtime updates
   - Verify checkpoint uploads (visible in Supabase Storage)
   - Download final audiobook
   - Check audio quality and concatenation smoothness

5. **Error Handling**
   - Test with invalid PDF (image-based)
   - Test with short voice sample (<3 seconds)
   - Test with oversized voice sample (>15MB)
   - Verify graceful failure with clear error messages

### Testing Modal Endpoints

```bash
# Test Zonos TTS
curl -X POST $MODAL_TTS_URL \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello, this is a test.",
    "reference_audio_base64": "'$(base64 -w 0 sample.wav)'",
    "speed": 1.0
  }'

# Test Audio Cleaner
curl -X POST $MODAL_AUDIO_CLEANER_URL \
  -H "Content-Type: application/json" \
  -d '{"audio_base64": "'$(base64 -w 0 sample.wav)'"}'

# Test LLM Director
curl -X POST $MODAL_LLM_DIRECTOR_URL \
  -H "Content-Type: application/json" \
  -d '{"text": "This is a test sentence for pacing analysis."}'
```

---

## Deployment

### Vercel (Recommended)

```bash
npx vercel
```

Set environment variables in Vercel dashboard.

### Netlify

Configured via `netlify.toml`. Build command: `npm run build`

### Modal Servers

```bash
# Deploy all services
cd modal
modal deploy zonos_server.py
modal deploy audio_cleaner.py  
modal deploy llm_director.py
```

After deployment, update URLs in `.env.local` and Vercel dashboard.

---

## Known Issues and Limitations

### Critical (Fixed in v2)
- Voice clipping metadata was previously ignored
- No partial failure recovery (lost all progress on error)
- Memory exhaustion with large voice samples
- Temporary file leaks on Modal servers

### Current Limitations
- **No rate limiting**: API endpoints could be abused
- **No duplicate detection**: Users can submit identical jobs
- **Audio validation**: Only checks file extension, not magic bytes
- **No checkpoint table**: Resume capability requires `job_checkpoints` table

### Modal-Specific Issues
- **Cold start**: First request after idle takes 30-60 seconds
- **GPU scaling**: L4 GPU availability varies
- **TorchCodec issues**: Resolved in current Zonos deployment

---

## Security Considerations

### Data Handling
- PDFs and audio stored in Supabase Storage (public bucket)
- Service role key only used server-side
- Row Level Security enabled but policies allow all (development mode)

### API Security
- No rate limiting implemented
- File uploads validated by type and extension
- YouTube API key exposed to server only

### Production Hardening Needed
1. Implement proper RLS policies (user-scoped)
2. Add rate limiting to API routes
3. Validate file magic bytes, not just extensions
4. Add request size limits
5. Implement authentication (currently anonymous)

---

## Cost Considerations

| Service | Free Tier | Paid Usage |
|---------|-----------|------------|
| Vercel | 100GB bandwidth/mo | $20/mo |
| Supabase | 500MB DB, 1GB storage | $25/mo |
| Modal | $30/mo credits | Pay-per-use GPU time |
| YouTube API | 10k requests/day | N/A |

Typical audiobook generation cost: ~$0.03-0.07 per book (depends on length)

---

## Related Documentation

- `README.md`: User-facing setup and usage guide
- `SWITCH_TO_ZONOS.md`: Migration guide from F5-TTS to Zonos
- `CODE_REVIEW_BUGS.md`: Detailed bug analysis and fixes
- `ISSUES_SUMMARY.md`: Current system status and issues
- `TTS_MODEL_GUIDE.md`: Comparison of TTS models

---

## Useful Commands

```bash
# Check Modal deployments
modal app list

# View Modal logs
modal app logs <app-name>

# Stop Modal app
modal app stop <app-name>

# Test local audio processing
python test-zonos.py
```

---

*Last updated: April 2026*
