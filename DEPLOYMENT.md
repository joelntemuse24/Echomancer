# Deployment Guide: Moving Off Localhost

## Quick Deploy to Vercel (Recommended)

### 1. Prepare Environment Variables

Copy your `.env.local` values - you'll need these:

```bash
# Turso Database
TURSO_DATABASE_URL=libsql://echomancer-joelntemuse24.aws-eu-west-1.turso.io
TURSO_AUTH_TOKEN=your-token

# Cloudflare R2
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=echomancer-audio

# Modal F5-TTS
MODAL_TTS_URL=https://ntemusejoel--echomancer-f5-tts-fastapi-app.modal.run/generate_batch

# YouTube API
YOUTUBE_API_KEY=your-youtube-api-key

# App URL (will be provided by Vercel after deploy)
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
```

### 2. Deploy to Vercel

**Option A: Vercel CLI**
```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy
vercel --prod
```

**Option B: GitHub Integration (Easiest)**
1. Go to https://vercel.com/new
2. Import your GitHub repo: `joelntemuse24/Echomancer`
3. Add environment variables from above
4. Click "Deploy"

**Option C: Vercel Dashboard**
1. Go to https://vercel.com/dashboard
2. Click "Add New Project"
3. Import from GitHub
4. Configure build settings:
   - Framework: Next.js
   - Build Command: `npm run build`
   - Output Directory: `.next`
5. Add environment variables
6. Deploy

### 3. Verify Deployment

After deployment, your app will be at:
```
https://echomancer-xxx.vercel.app
```

Test these endpoints:
- `/` - Landing page
- `/dashboard` - Main app
- `/api/jobs` - Should return JSON

### 4. Update Environment Variables

After getting your Vercel URL, update:

```bash
# In Vercel dashboard → Project Settings → Environment Variables
NEXT_PUBLIC_APP_URL=https://echomancer-xxx.vercel.app
```

Redeploy: `vercel --prod` or push to GitHub

---

## Alternative: Netlify

```bash
# Install Netlify CLI
npm i -g netlify-cli

# Login
netlify login

# Initialize
netlify init

# Deploy
netlify deploy --prod
```

---

## Alternative: Self-Hosted (Docker)

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
```

```bash
# Build and run
docker build -t echomancer .
docker run -p 3000:3000 --env-file .env.local echomancer
```

---

## Post-Deployment Checklist

- [ ] App loads at deployed URL
- [ ] Can upload PDFs (R2 working)
- [ ] Can create jobs (Turso working)
- [ ] TTS generation works (Modal working)
- [ ] Can download audiobooks
- [ ] "Warming up" animation shows on first TTS request

---

## Troubleshooting

### Build Fails
```bash
# Check build locally first
npm run build
```

### Environment Variables Not Working
- In Vercel: Settings → Environment Variables
- Must redeploy after adding env vars

### Turso Connection Fails
- Verify `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
- Check Turso dashboard: https://turso.tech

### R2 Upload Fails
- Verify all R2 credentials
- Check bucket exists in Cloudflare dashboard

### Modal TTS Times Out
- Cold start is normal (~60s)
- Check Modal dashboard: https://modal.com/apps
- Verify `MODAL_TTS_URL` is correct

---

## Custom Domain (Optional)

### Vercel
1. Dashboard → Project Settings → Domains
2. Add your domain
3. Update DNS records as instructed

### Cloudflare (Recommended for R2)
If using Cloudflare R2, keeping everything on Cloudflare:
1. Add domain to Cloudflare
2. Create CNAME record → `cname.vercel-dns.com`
3. Configure in Vercel dashboard

---

## Cost Summary (Monthly)

| Service | Free Tier | Your Usage | Cost |
|---------|-----------|------------|------|
| **Vercel** | 100GB bandwidth | Personal use | **FREE** |
| **Turso** | 9GB storage | <1GB | **FREE** |
| **R2** | 10GB storage | <10GB | **FREE** |
| **Modal** | $30 credits | ~30 books | **~$0.60** |
| **YouTube API** | 10k requests/day | <100/day | **FREE** |
| **TOTAL** | | | **~$0.60/month** |
