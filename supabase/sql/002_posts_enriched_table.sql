-- 002_posts_enriched_table.sql
-- LLM enrichment storage for captured posts (1 row per post_url)

begin;

create table if not exists public.posts_enriched (
  id uuid primary key default gen_random_uuid(),

  -- Canonical identity (matches posts_raw.post_url)
  post_url text not null,

  -- Enrichment metadata
  schema_version text not null default 'v1',
  model text null,
  enriched_at timestamptz not null default now(),

  -- Result payload
  llm_json jsonb not null,

  -- Status for retries/debug
  status text not null default 'ok', -- ok | error
  error_message text null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ensure 1:1 per post_url
create unique index if not exists posts_enriched_post_url_unique
  on public.posts_enriched (post_url);

-- Helpful for querying recent enrichments
create index if not exists posts_enriched_enriched_at_idx
  on public.posts_enriched (enriched_at desc);

-- Optional: basic FK-ish guard if posts_raw exists (does not enforce true FK unless desired)
-- You can add a real FK later if you want strict referential integrity.
-- alter table public.posts_enriched
--   add constraint posts_enriched_post_url_fk
--   foreign key (post_url) references public.posts_raw(post_url)
--   on delete cascade;

commit;
