-- posts_raw: MVP raw ingestion table keyed by post_url

-- Ensure uuid generation is available
create extension if not exists pgcrypto;

create table if not exists public.posts_raw (
  id uuid primary key default gen_random_uuid(),

  -- Upsert key
  post_url text not null,

  -- Minimal metadata (nullable for MVP)
  group_id text,
  group_name text,
  group_url text,
  author_name text,
  text text,
  created_at timestamptz,

  -- Store full object for forensic/debug + future enrichment
  raw jsonb,

  -- Observability
  last_seen_at timestamptz not null default now(),
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Required for upsert(onConflict: "post_url")
create unique index if not exists posts_raw_post_url_uidx
  on public.posts_raw (post_url);

-- Keep updated_at fresh on updates
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_posts_raw_updated_at on public.posts_raw;

create trigger trg_posts_raw_updated_at
before update on public.posts_raw
for each row
execute function public.set_updated_at();

-- Enable RLS (service role bypasses RLS; anon will not read by default)
alter table public.posts_raw enable row level security;
