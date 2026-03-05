// workers/telegram_hourly_report.js
const fs = require("fs");
const path = require("path");
const { getSupabaseAdmin } = require("../lib/supabase");

function env(name, required = true) {
  const v = process.env[name];
  if (required && (!v || !String(v).trim())) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function isEnabled() {
  return String(process.env.TELEGRAM_HOURLY_REPORT_ENABLED || "").toLowerCase() === "true";
}

async function sendTelegramMessage(text) {
  const botToken = env("TELEGRAM_BOT_TOKEN", true);
  const chatId = env("TELEGRAM_CHAT_ID", true);

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = json?.description || res.statusText;
    throw new Error(`Telegram send failed: ${res.status} ${msg}`);
  }
}

function formatUtc(dt) {
  return dt.toISOString().replace("T", " ").replace("Z", " UTC");
}

function normalizeUrl(url) {
  if (!url || typeof url !== "string") return null;
  const u = url.trim();
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

function loadJsonSafe(p, fallback) {
  try {
    if (!p) return fallback;
    if (!fs.existsSync(p)) return fallback;
    const s = fs.readFileSync(p, "utf8");
    if (!s.trim()) return fallback;
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function excerptFromRaw(raw, maxLen = 200) {
  const s = raw?.excerpt ?? raw?.text ?? "";
  const collapsed = String(s).replace(/\s+/g, " ").trim();
  return collapsed.length > maxLen ? collapsed.slice(0, maxLen) + "…" : collapsed;
}

function isNullMonitor(r) {
  const mid = r?.raw?.monitor_id ?? r?.raw?.monitorId;
  return mid == null || String(mid).trim() === "";
}

function isServiceLead(row, mid) {
  const raw = row?.raw || {};
  const rowMid = raw.monitor_id ?? raw.monitorId;
  if (rowMid !== mid) return false;
  const tier = String(raw.tier || "").toUpperCase();
  const matches = raw.matches || {};
  const serviceArr = Array.isArray(matches.service) ? matches.service : [];
  if (tier === "MED" || tier === "HIGH") return true;
  if (tier === "LOW" && serviceArr.length > 0) return true;
  return false;
}

async function main() {
  if (!isEnabled()) {
    console.log("[hourly-report] TELEGRAM_HOURLY_REPORT_ENABLED is not true; exiting.");
    process.exit(0);
  }

  const monitorId = process.env.REPORT_MONITOR_ID || "dorset_test";

  const areaMapPath =
    process.env.GROUP_URL_TO_AREA_PATH ||
    path.join(process.cwd(), "data", "group_url_to_area.json");
  const rawAreaMap = loadJsonSafe(areaMapPath, {});
  const areaMap = {};
  for (const [k, v] of Object.entries(rawAreaMap)) {
    const nk = normalizeUrl(k);
    if (nk && v) areaMap[nk] = String(v);
  }

  const supabase = getSupabaseAdmin();

  const now = new Date();
  const since60 = new Date(now.getTime() - 60 * 60 * 1000);
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from("posts_raw")
    .select("post_url,last_seen_at,raw")
    .gte("last_seen_at", since60.toISOString())
    .order("last_seen_at", { ascending: false });

  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  const rowsLast60All = Array.isArray(data) ? data : [];
  const rowsLast60Dorset = rowsLast60All.filter((r) => {
    const mid = r?.raw?.monitor_id ?? r?.raw?.monitorId;
    return mid === monitorId;
  });
  const rowsLast60NullMonitor = rowsLast60All.filter(isNullMonitor);

  const byTier = { IGNORE: 0, LOW: 0, MED: 0, HIGH: 0, OTHER: 0 };
  let withServiceMatches = 0;
  let withIntentMatches = 0;

  for (const r of rowsLast60Dorset) {
    const tier = String(r?.raw?.tier || "").toUpperCase();
    if (byTier[tier] !== undefined) byTier[tier] += 1;
    else byTier.OTHER += 1;

    const matches = r?.raw?.matches || {};
    if (Array.isArray(matches.intent) && matches.intent.length > 0) withIntentMatches += 1;
    if (Array.isArray(matches.service) && matches.service.length > 0) withServiceMatches += 1;
  }

  const latest = rowsLast60Dorset[0]?.last_seen_at ? new Date(rowsLast60Dorset[0].last_seen_at) : null;

  const lines = [
    `🕐 Dorset hourly report (last 60 minutes)`,
    `Monitor: ${monitorId}`,
    `Window: ${formatUtc(since60)} → ${formatUtc(now)}`,
    ``,
    `Captured in Supabase (posts_raw): ${rowsLast60All.length} total, dorset=${rowsLast60Dorset.length}, null_monitor=${rowsLast60NullMonitor.length}`,
    `Tier breakdown: HIGH=${byTier.HIGH} MED=${byTier.MED} LOW=${byTier.LOW} IGNORE=${byTier.IGNORE} OTHER=${byTier.OTHER}`,
    `Matches: intent=${withIntentMatches} service=${withServiceMatches}`,
    latest ? `Latest captured: ${formatUtc(latest)}` : `Latest captured: none`,
  ];

  const { data: data24, error: error24 } = await supabase
    .from("posts_raw")
    .select("post_url,last_seen_at,raw")
    .gte("last_seen_at", since24h.toISOString())
    .order("last_seen_at", { ascending: false });

  if (error24) throw new Error(`Supabase 24h query failed: ${error24.message}`);

  const rows24 = Array.isArray(data24) ? data24 : [];
  const serviceLeads24h = rows24.filter((r) => isServiceLead(r, monitorId));
  const leadsToShow = serviceLeads24h.slice(0, 10);

  const areaCounts = {};
  for (const lead of serviceLeads24h) {
    const groupUrl = lead?.raw?.group_url;
    const nk = normalizeUrl(groupUrl);
    const area = (nk && areaMap[nk]) ? areaMap[nk] : "Unknown";
    areaCounts[area] = (areaCounts[area] || 0) + 1;
  }
  const areasSorted = Object.entries(areaCounts)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 12);

  lines.push(``);
  lines.push(`Dorset service leads (last 24h): ${serviceLeads24h.length}`);
  lines.push(``);
  lines.push(`📍 Leads by area (last 24h)`);
  for (const [areaName, count] of areasSorted) {
    lines.push(`${areaName}: ${count}`);
  }

  for (const lead of leadsToShow) {
    const raw = lead?.raw || {};
    const at = lead?.last_seen_at ? formatUtc(new Date(lead.last_seen_at)) : "—";
    const tier = raw.tier ?? "—";
    const score = raw.score != null ? ` score=${raw.score}` : "";
    const excerpt = excerptFromRaw(raw);
    lines.push(``);
    lines.push(`• ${at} ${tier}${score}`);
    if (excerpt) lines.push(`  ${excerpt}`);
    lines.push(`  ${lead.post_url || ""}`);
    if (raw.group_url) lines.push(`  ${raw.group_url}`);
  }

  const text = lines.join("\n");

  await sendTelegramMessage(text);
  console.log("[hourly-report] sent OK");
}

main().catch((err) => {
  console.error("[hourly-report] fatal:", err);
  process.exit(1);
});
