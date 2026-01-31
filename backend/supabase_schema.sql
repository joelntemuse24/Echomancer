-- Supabase SQL Schema for Echomancer
-- Run this in your Supabase SQL Editor: https://supabase.com/dashboard/project/_/sql

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============== USERS ==============
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    credits INTEGER DEFAULT 1,  -- Start with 1 free audiobook
    stripe_customer_id TEXT,
    subscription_status TEXT DEFAULT 'free',  -- free, active, cancelled
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for email lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============== VOICES ==============
-- Stores cloned voices so users can reuse them
CREATE TABLE IF NOT EXISTS voices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    voice_id TEXT NOT NULL,  -- The ID from Replicate/Minimax
    name TEXT NOT NULL,
    provider TEXT DEFAULT 'replicate',  -- replicate, vastai
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for user voice lookups
CREATE INDEX IF NOT EXISTS idx_voices_user ON voices(user_id);
CREATE INDEX IF NOT EXISTS idx_voices_voice_id ON voices(voice_id);

-- ============== AUDIOBOOKS ==============
-- Tracks generated audiobooks
CREATE TABLE IF NOT EXISTS audiobooks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    voice_id TEXT,
    status TEXT DEFAULT 'processing',  -- processing, completed, failed
    audio_url TEXT,  -- CDN URL when stored
    file_size_bytes INTEGER,
    duration_seconds INTEGER,
    char_count INTEGER,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for user audiobook lookups
CREATE INDEX IF NOT EXISTS idx_audiobooks_user ON audiobooks(user_id);
CREATE INDEX IF NOT EXISTS idx_audiobooks_status ON audiobooks(status);

-- ============== USAGE LOGS ==============
-- For analytics and cost tracking
CREATE TABLE IF NOT EXISTS usage_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    action TEXT NOT NULL,  -- voice_clone, speech_generation, credit_purchased, etc.
    chars_processed INTEGER DEFAULT 0,
    cost_usd DECIMAL(10, 4) DEFAULT 0,
    provider TEXT,  -- replicate, vastai
    metadata JSONB,  -- Additional data
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for user usage lookups
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_action ON usage_logs(action);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at);

-- ============== ROW LEVEL SECURITY ==============
-- Enable RLS on all tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE voices ENABLE ROW LEVEL SECURITY;
ALTER TABLE audiobooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own data
CREATE POLICY "Users can view own data" ON users
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can view own voices" ON voices
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can view own audiobooks" ON audiobooks
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can view own usage" ON usage_logs
    FOR SELECT USING (auth.uid() = user_id);

-- Policy: Service role can do everything (for backend)
CREATE POLICY "Service role full access users" ON users
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access voices" ON voices
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access audiobooks" ON audiobooks
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access usage" ON usage_logs
    FOR ALL USING (auth.role() = 'service_role');

-- ============== FUNCTIONS ==============
-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_audiobooks_updated_at
    BEFORE UPDATE ON audiobooks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
