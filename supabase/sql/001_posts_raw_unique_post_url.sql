-- 001_posts_raw_unique_post_url.sql
-- Enforce one-row-per-post_url in posts_raw

begin;

-- 1) Ensure the column exists and is not null (safe guards; will error if missing)
-- If your schema already has post_url and it's nullable, this will enforce non-null going forward.
alter table if exists public.posts_raw
  alter column post_url set not null;

-- 2) Normalize duplicates before applying uniqueness (optional but safe):
-- If duplicates already exist, this will KEEP the most recent and remove older ones.
-- Comment this block out if you are 100% sure there are no duplicates.
with ranked as (
  select
    ctid,
    post_url,
    row_number() over (
      partition by post_url
      order by last_seen_at desc nulls last, created_at desc nulls last
    ) as rn
  from public.posts_raw
)
delete from public.posts_raw p
using ranked r
where p.ctid = r.ctid
  and r.rn > 1;

-- 3) Add a unique index (safe, fast, and standard for upsert conflict targets)
create unique index if not exists posts_raw_post_url_unique
  on public.posts_raw (post_url);

commit;
