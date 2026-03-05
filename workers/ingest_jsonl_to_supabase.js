// workers/ingest_jsonl_to_supabase.js
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { upsertPostsRaw } = require("../lib/posts_raw_ingest");
const { isSupabaseIngestEnabled } = require("../lib/supabase");

// IMPORTANT: adjust these only if your JSONL path differs
const JSONL_PATH = process.env.LEADS_JSONL_PATH || path.join(process.cwd(), "data", "leads.jsonl");
const STATE_PATH =
  process.env.INGEST_STATE_PATH || path.join(process.cwd(), "data", "supabase_ingest_state.json");

// Optional local mapping (MVP): group_url -> group_id
const GROUP_MAP_PATH =
  process.env.GROUP_MAP_PATH || path.join(process.cwd(), "data", "group_url_to_id.json");

// Tuneable batch size for upserts
const BATCH_SIZE = Number(process.env.SUPABASE_INGEST_BATCH_SIZE || "25");

function loadJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const s = fs.readFileSync(p, "utf8");
    if (!s.trim()) return fallback;
    return JSON.parse(s);
  } catch (e) {
    return fallback;
  }
}

function saveJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function getFileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Extract a stable "raw post" object from whatever JSONL line structure exists.
 * We keep this forgiving to avoid breaking on format changes.
 */
function normalizeLineToPostRaw(lineObj, groupUrlToId) {
  // Common possibilities:
  // - lineObj.post_url
  // - lineObj.postUrl
  // - lineObj.url
  const post_url = lineObj.post_url || lineObj.postUrl || lineObj.url || null;
  if (!post_url) return null;

  const group_url = lineObj.group_url || lineObj.groupUrl || lineObj.group || null;
  const group_name = lineObj.group_name || lineObj.groupName || null;

  const group_id =
    lineObj.group_id ||
    lineObj.groupId ||
    (group_url && groupUrlToId[group_url]) ||
    null;

  const text = lineObj.text || lineObj.post_text || lineObj.message || null;
  const author_name = lineObj.author_name || lineObj.author || lineObj.user_name || null;

  // If your crawler has a timestamp, keep it; otherwise null
  const created_at = lineObj.created_at || lineObj.createdAt || null;

  return {
    post_url,
    group_id,
    group_name,
    group_url,
    author_name,
    text,
    created_at,
    raw: lineObj,
  };
}

async function ingestOnceFromOffset() {
  if (!isSupabaseIngestEnabled()) {
    console.log("[ingest] SUPABASE_INGEST_ENABLED is not true; exiting.");
    process.exit(0);
  }

  if (!fs.existsSync(JSONL_PATH)) {
    console.error(`[ingest] JSONL file not found: ${JSONL_PATH}`);
    process.exit(1);
  }

  const groupUrlToId = loadJsonSafe(GROUP_MAP_PATH, {});
  const state = loadJsonSafe(STATE_PATH, { offset: 0 });

  const fileSize = getFileSize(JSONL_PATH);

  // Handle truncation/rotation: if file shrank, reset offset
  let offset = Number(state.offset || 0);
  if (fileSize < offset) {
    console.log(`[ingest] file size (${fileSize}) < offset (${offset}); resetting offset to 0`);
    offset = 0;
  }

  console.log(`[ingest] starting at offset=${offset}, fileSize=${fileSize}, jsonl=${JSONL_PATH}`);

  const stream = fs.createReadStream(JSONL_PATH, { encoding: "utf8", start: offset });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let batch = [];
  let bytesRead = 0;

  // Track bytes based on UTF-8 byte length of each line + newline
  for await (const line of rl) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for newline
    bytesRead += lineBytes;

    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const post = normalizeLineToPostRaw(obj, groupUrlToId);
    if (!post) continue;

    batch.push(post);

    if (batch.length >= BATCH_SIZE) {
      const res = await upsertPostsRaw(batch);
      console.log(`[ingest] upsert batch size=${batch.length}:`, res);
      batch = [];
    }
  }

  if (batch.length > 0) {
    const res = await upsertPostsRaw(batch);
    console.log(`[ingest] upsert final batch size=${batch.length}:`, res);
  }

  const newOffset = offset + bytesRead;
  saveJson(STATE_PATH, { offset: newOffset, updated_at: new Date().toISOString() });

  console.log(`[ingest] done. saved offset=${newOffset} to ${STATE_PATH}`);
}

ingestOnceFromOffset().catch((err) => {
  console.error("[ingest] fatal:", err);
  process.exit(1);
});
