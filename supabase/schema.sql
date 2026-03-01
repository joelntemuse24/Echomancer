-- ============================================================
-- Echomancer v2 - Supabase Database Schema
-- Run this in the Supabase SQL Editor to set up your database
-- ============================================================

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ==================== USERS ====================
create table if not exists public.users (
  id uuid primary key default uuid_generate_v4(),
  email text unique not null,
  name text default '',
  credits integer default 1,
  stripe_customer_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ==================== JOBS ====================
create table if not exists public.jobs (
  id uuid primary key default uuid_generate_v4(),
  user_id text not null default 'anonymous',
  book_title text not null default 'Untitled',
  voice_name text not null default 'Custom Voice',
  status text not null default 'queued' check (status in ('queued', 'processing', 'ready', 'failed')),
  progress integer not null default 0 check (progress >= 0 and progress <= 100),
  pdf_storage_path text not null,
  voice_storage_path text default '',
  audio_storage_path text,
  video_id text,
  start_time integer default 0,
  end_time integer default 60,
  error text,
  trigger_task_id text,
  deleted_at timestamptz,
  expires_at timestamptz default now() + interval '30 days',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ==================== VOICES ====================
create table if not exists public.voices (
  id uuid primary key default uuid_generate_v4(),
  user_id text not null,
  name text not null,
  storage_path text not null,
  source text default 'upload' check (source in ('youtube', 'upload')),
  source_video_id text,
  created_at timestamptz default now()
);

-- ==================== USAGE LOGS ====================
create table if not exists public.usage_logs (
  id uuid primary key default uuid_generate_v4(),
  user_id text not null,
  action text not null,
  chars_processed integer default 0,
  cost_usd numeric(10, 6) default 0,
  created_at timestamptz default now()
);

-- ==================== INDEXES ====================
create index if not exists idx_jobs_user_id on public.jobs (user_id);
create index if not exists idx_jobs_status on public.jobs (status);
create index if not exists idx_jobs_created_at on public.jobs (created_at desc);
create index if not exists idx_jobs_user_status on public.jobs (user_id, status, created_at desc);
create index if not exists idx_jobs_not_deleted on public.jobs (user_id, created_at desc) where deleted_at is null;
create index if not exists idx_voices_user_id on public.voices (user_id);
create index if not exists idx_usage_logs_user_id on public.usage_logs (user_id);

-- ==================== ROW LEVEL SECURITY ====================
-- Enable RLS on all tables
alter table public.users enable row level security;
alter table public.jobs enable row level security;
alter table public.voices enable row level security;
alter table public.usage_logs enable row level security;

-- For development: allow all operations via service role key
-- In production, replace these with proper user-scoped policies

-- Jobs: allow all for now (service role bypasses RLS anyway)
create policy "Allow all job operations" on public.jobs
  for all using (true) with check (true);

create policy "Allow all voice operations" on public.voices
  for all using (true) with check (true);

create policy "Allow all usage log operations" on public.usage_logs
  for all using (true) with check (true);

create policy "Allow all user operations" on public.users
  for all using (true) with check (true);

-- ==================== REALTIME ====================
-- Enable realtime on the jobs table so the frontend gets live updates
alter publication supabase_realtime add table public.jobs;

-- ==================== STORAGE ====================
-- Create the audiobooks storage bucket (run separately if needed)
-- insert into storage.buckets (id, name, public)
-- values ('audiobooks', 'audiobooks', true)
-- on conflict do nothing;

-- ==================== UPDATED_AT TRIGGER ====================
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger on_jobs_updated
  before update on public.jobs
  for each row
  execute function public.handle_updated_at();

create trigger on_users_updated
  before update on public.users
  for each row
  execute function public.handle_updated_at();
