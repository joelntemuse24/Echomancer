# 🎬 YouTube API Key Setup Guide

## Quick Setup (5 minutes)

### Step 1: Get Your YouTube Data API Key

1. **Go to Google Cloud Console**
   - Visit: https://console.cloud.google.com/
   - Sign in with your Google account

2. **Create a New Project** (or select existing)
   - Click "Select a project" → "New Project"
   - Name it "Echomancer" (or anything you like)
   - Click "Create"

3. **Enable YouTube Data API v3**
   - Go to: https://console.cloud.google.com/apis/library/youtube.googleapis.com
   - Click "Enable"

4. **Create API Credentials**
   - Go to: https://console.cloud.google.com/apis/credentials
   - Click "Create Credentials" → "API Key"
   - Copy your API key (it will look like: `AIzaSy...`)

### Step 2: Add API Key to Backend

1. **Create or edit `backend/.env` file**
   ```bash
   cd backend
   ```

2. **Add your YouTube API key**
   ```env
   YOUTUBE_API_KEY=AIzaSy...your-key-here...
   ```

3. **Restart the backend server**
   ```bash
   # Stop the current backend (Ctrl+C)
   # Then restart:
   npm run dev
   ```

### Step 3: Test It

1. Go to the Voice Selection page
2. Type a search term (e.g., "audiobook narration")
3. Click "Search"
4. You should see YouTube videos appear!

## Troubleshooting

### "YouTube API key not configured" Error

**Solution:** Make sure:
- ✅ You created `backend/.env` file (not `.env.example`)
- ✅ Added `YOUTUBE_API_KEY=your-key-here`
- ✅ Restarted the backend server after adding the key

### "API key not valid" Error

**Solution:**
- Check that you copied the entire API key (no spaces)
- Make sure YouTube Data API v3 is enabled in Google Cloud Console
- Wait a few minutes after enabling the API (it can take time to propagate)

### "Quota exceeded" Error

**Solution:**
- YouTube API has a free quota of 10,000 units per day
- Each search uses 100 units
- You can make ~100 searches per day for free
- For more, you'll need to enable billing in Google Cloud Console

### Still Not Working?

1. **Check backend logs** - Look for error messages
2. **Verify API key** - Test it directly:
   ```bash
   curl "https://www.googleapis.com/youtube/v3/search?part=snippet&q=test&key=YOUR_API_KEY"
   ```
3. **Check browser console** - Press F12 and look for errors

## Security Note

⚠️ **Never commit your `.env` file to Git!**
- The `.env` file is already in `.gitignore`
- Keep your API key secret
- If you accidentally commit it, regenerate the key in Google Cloud Console

## Need Help?

- Google Cloud Console: https://console.cloud.google.com/
- YouTube Data API Docs: https://developers.google.com/youtube/v3
- API Quotas: https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas

