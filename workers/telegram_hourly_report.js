// workers/telegram_hourly_report.js
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

async function main() {
  if (!isEnabled()) {
    console.log("[hourly-report] TELEGRAM_HOURLY_REPORT_ENABLED is not true; exiting.");
    process.exit(0);
  }

  const monitorId = process.env.REPORT_MONITOR_ID || "dorset_test";

  const supabase = getSupabaseAdmin();

  const now = new Date();
  const since = new Date(now.getTime() - 60 * 60 * 1000);

  const { data, error } = await supabase
    .from("posts_raw")
    .select("post_url,last_seen_at,raw")
    .gte("last_seen_at", since.toISOString())
    .order("last_seen_at", { ascending: false });

  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  const rows = Array.isArray(data) ? data : [];

  const relevant = rows.filter((r) => {
    const mid = r?.raw?.monitor_id || r?.raw?.monitorId;
    return mid === monitorId;
  });

  const byTier = { IGNORE: 0, LOW: 0, MED: 0, HIGH: 0, OTHER: 0 };
  let withServiceMatches = 0;
  let withIntentMatches = 0;

  for (const r of relevant) {
    const tier = String(r?.raw?.tier || "").toUpperCase();
    if (byTier[tier] !== undefined) byTier[tier] += 1;
    else byTier.OTHER += 1;

    const matches = r?.raw?.matches || {};
    if (Array.isArray(matches.intent) && matches.intent.length > 0) withIntentMatches += 1;
    if (Array.isArray(matches.service) && matches.service.length > 0) withServiceMatches += 1;
  }

  const latest = relevant[0]?.last_seen_at ? new Date(relevant[0].last_seen_at) : null;

  const text =
    [
      `🕐 Dorset hourly report (last 60 minutes)`,
      `Monitor: ${monitorId}`,
      `Window: ${formatUtc(since)} → ${formatUtc(now)}`,
      ``,
      `Captured in Supabase (posts_raw): ${relevant.length}`,
      `Tier breakdown: HIGH=${byTier.HIGH} MED=${byTier.MED} LOW=${byTier.LOW} IGNORE=${byTier.IGNORE} OTHER=${byTier.OTHER}`,
      `Matches: intent=${withIntentMatches} service=${withServiceMatches}`,
      latest ? `Latest captured: ${formatUtc(latest)}` : `Latest captured: none`,
    ].join("\n");

  await sendTelegramMessage(text);
  console.log("[hourly-report] sent OK");
}

main().catch((err) => {
  console.error("[hourly-report] fatal:", err);
  process.exit(1);
});
