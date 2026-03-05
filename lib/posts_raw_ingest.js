// lib/posts_raw_ingest.js
const { getSupabaseAdmin, isSupabaseIngestEnabled } = require("./supabase");

/**
 * Minimal upsert into posts_raw keyed by post_url.
 *
 * Expected table (later) has a UNIQUE constraint on post_url.
 * For now, this function can exist safely even before the table exists,
 * as long as it is not called (or SUPABASE_INGEST_ENABLED=false).
 */
async function upsertPostsRaw(posts) {
  if (!isSupabaseIngestEnabled()) {
    return { skipped: true, reason: "SUPABASE_INGEST_ENABLED is not true" };
  }

  if (!Array.isArray(posts) || posts.length === 0) {
    return { skipped: true, reason: "no posts provided" };
  }

  const supabase = getSupabaseAdmin();

  // Normalize and keep payload minimal for MVP
  const rows = posts
    .filter((p) => p && typeof p === "object")
    .map((p) => ({
      post_url: p.post_url || null,
      group_id: p.group_id || null,
      group_name: p.group_name || null,
      group_url: p.group_url || null,
      author_name: p.author_name || null,
      text: p.text || null,
      created_at: p.created_at || null, // if you have it; otherwise null
      raw: p.raw || p, // store the full object for now (MVP)
      last_seen_at: new Date().toISOString(),
    }))
    .filter((r) => r.post_url); // must have post_url

  if (rows.length === 0) {
    return { skipped: true, reason: "no valid rows (missing post_url)" };
  }

  const { data, error } = await supabase
    .from("posts_raw")
    .upsert(rows, { onConflict: "post_url" })
    .select("post_url");

  if (error) {
    const err = new Error(`Supabase upsert posts_raw failed: ${error.message}`);
    err.cause = error;
    throw err;
  }

  return { ok: true, upserted: data?.length || 0 };
}

module.exports = { upsertPostsRaw };
