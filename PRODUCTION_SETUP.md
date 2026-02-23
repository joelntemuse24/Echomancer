# Echomancer Production Setup Guide

Get your audiobook generator running in production with payments and user accounts.

## Quick Status

| Component | Status | Your Action |
|-----------|--------|-------------|
| Core audiobook generation | ✅ Ready | None |
| Voice cloning (Replicate) | ✅ Ready | Already have token |
| Vast.ai integration | ✅ Ready | Rent GPU when ready |
| Stripe payments | ✅ Code ready | Create Stripe account |
| Supabase database | ✅ Code ready | Create Supabase project |
| Hosting (Render) | ✅ Deployed | Upgrade to paid tier |

---

## Step 1: Supabase Database (15 min)

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project (pick a region close to you)
3. Wait for project to initialize (~2 min)
4. Go to **Settings → API** and copy:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_KEY`

5. Go to **SQL Editor** and run the schema:
   - Open `backend/supabase_schema.sql`
   - Copy entire contents
   - Paste in SQL Editor and click **Run**

6. Add to Render environment variables:
   ```
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_ANON_KEY=eyJ...
   SUPABASE_SERVICE_KEY=eyJ...
   ```

---

## Step 2: Stripe Payments (20 min)

1. Go to [stripe.com](https://stripe.com) and create an account
2. Go to **Developers → API keys** and copy:
   - `Publishable key` → `STRIPE_PUBLISHABLE_KEY`
   - `Secret key` → `STRIPE_SECRET_KEY`

3. Create products and prices:
   - Go to **Products → Add product**
   - Create "Single Audiobook" - one-time, $4.99 (or your price)
   - Create "Unlimited Monthly" - recurring, $9.99/month (or your price)
   - Copy the `price_xxx` IDs for each

4. Set up webhook:
   - Go to **Developers → Webhooks → Add endpoint**
   - URL: `https://echomancer.onrender.com/api/payments/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.deleted`
   - Copy the webhook signing secret → `STRIPE_WEBHOOK_SECRET`

5. Add to Render environment variables:
   ```
   STRIPE_SECRET_KEY=sk_live_xxx
   STRIPE_PUBLISHABLE_KEY=pk_live_xxx
   STRIPE_WEBHOOK_SECRET=whsec_xxx
   STRIPE_PRICE_ID_ONE_TIME=price_xxx
   STRIPE_PRICE_ID_SUBSCRIPTION=price_xxx
   ```

---

## Step 3: Upgrade Render (2 min)

1. Go to your Render dashboard
2. Select Echomancer service
3. Click **Settings → Instance Type**
4. Select **Starter** ($7/month) - gives 512MB → 2GB RAM
5. Save and redeploy

---

## Step 4: (Optional) Vast.ai for Cheaper TTS

Switch from Replicate (~$1.50/book) to Vast.ai (~$0.15/book):

1. Go to [vast.ai](https://vast.ai) and create account
2. Add credits ($10-20 to start)
3. Rent a GPU:
   - Filter: RTX 3060 or better, 30GB+ disk
   - Select PyTorch template
   - Click RENT (~$0.10-0.40/hour)

4. Connect and setup:
   ```bash
   ssh -p <port> root@<ip>
   pip install f5-tts fastapi uvicorn httpx
   # Copy server script from vastai-scripts/README.md
   python f5-tts-server.py
   ```

5. Update Render environment:
   ```
   TTS_PROVIDER=vastai
   VASTAI_URL=http://<vast-ip>:<port>
   ```

**Note:** Vast.ai instances are not persistent. You need to start them when needed, or use a scheduled task.

---

## API Endpoints Added

### Payments
- `POST /api/payments/create-checkout` - Create Stripe checkout session
- `POST /api/payments/webhook` - Stripe webhook handler
- `GET /api/payments/credits/{email}` - Get user credit balance
- `GET /api/payments/config` - Get public Stripe config

### Simple Audiobook (existing)
- `GET /web/simple/` - Upload UI
- `POST /web/simple/generate` - Generate audiobook
- `GET /web/simple/test` - Test TTS config

---

## Testing Checklist

- [ ] Supabase: Can create users via API
- [ ] Stripe: Test checkout with `4242 4242 4242 4242`
- [ ] Webhook: Verify credits added after payment
- [ ] Audiobook: Generate with voice ID `R8_8KAB0VKH`
- [ ] Memory: No crashes on Render paid tier

---

## Cost Summary

| Item | Monthly Cost |
|------|--------------|
| Render Starter | $7 |
| Supabase Free | $0 |
| Stripe | 2.9% + $0.30 per transaction |
| Replicate TTS | ~$1.50 per audiobook |
| **OR** Vast.ai TTS | ~$0.15 per audiobook |

**Breakeven:** ~5 audiobooks/month covers hosting.

---

## Your Saved Voice ID

```
R8_8KAB0VKH
```

Use this in the Voice ID field to skip the $3 cloning fee.
