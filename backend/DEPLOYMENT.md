# Deployment Guide

## Production Checklist

### 1. Environment Setup

#### Frontend
- [ ] Set `VITE_API_URL` to production API URL
- [ ] Set `VITE_CLERK_PUBLISHABLE_KEY` to production Clerk key
- [ ] Build frontend: `cd frontend && npm run build`
- [ ] Deploy to hosting (Vercel, Netlify, etc.)

#### Backend
- [ ] Set all environment variables in `.env`
- [ ] Configure Clerk secret key
- [ ] Configure Paddle.com production keys
- [ ] Set YouTube API key
- [ ] Configure Redis connection
- [ ] Set Bunny.net credentials
- [ ] Build backend: `cd backend && npm run build`
- [ ] Deploy to hosting (Railway, Render, etc.)

#### Python Worker
- [ ] Install Fish Speech V1.5 (see Fish Speech docs)
- [ ] Configure Redis connection
- [ ] Set Bunny.net credentials
- [ ] Deploy to hosting with GPU support (required for Fish Speech)

### 2. Services Setup

#### Redis
- [ ] Set up Redis instance (Redis Cloud, AWS ElastiCache, etc.)
- [ ] Configure connection string
- [ ] Set up persistence if needed

#### Bunny.net CDN
- [ ] Create storage zone
- [ ] Configure CDN pull zone
- [ ] Set up API keys
- [ ] Configure CORS if needed

#### Clerk Authentication
- [ ] Create Clerk application
- [ ] Configure allowed origins
- [ ] Set up webhooks if needed

#### Paddle.com
- [ ] Create Paddle account
- [ ] Set up products:
  - One-time: €4
  - Subscription: €15/month
- [ ] Configure webhook endpoint
- [ ] Test payment flows

#### YouTube Data API
- [ ] Create Google Cloud project
- [ ] Enable YouTube Data API v3
- [ ] Create API key
- [ ] Set up quota limits

### 3. Fish Speech Setup

Fish Speech V1.5 requires:
- Python 3.11+
- CUDA-capable GPU (for production)
- Specific dependencies (see Fish Speech repo)

```bash
cd python-worker
# Follow Fish Speech installation guide
# https://github.com/fishaudio/fish-speech
```

### 4. Docker Deployment

```bash
# Build and run with docker-compose
docker-compose up -d

# Or build individually
docker build -t echomancer-backend ./backend
docker build -t echomancer-worker ./python-worker
```

### 5. Monitoring

- Set up error tracking (Sentry, etc.)
- Configure logging
- Set up health checks
- Monitor queue processing
- Track API usage

### 6. Security

- [ ] Enable HTTPS everywhere
- [ ] Configure CORS properly
- [ ] Set up rate limiting
- [ ] Validate all inputs
- [ ] Secure API keys
- [ ] Set up firewall rules

### 7. Scaling

- Horizontal scaling for backend
- Multiple Python workers for queue processing
- Redis cluster for high availability
- CDN caching for static assets
- Load balancing

## Environment Variables Reference

See `.env.example` files in each directory for required variables.

