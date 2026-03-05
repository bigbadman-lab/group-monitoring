// workers/enrich_posts_with_llm.js
const fs = require("fs");
const path = require("path");
const { getSupabaseAdmin } = require("../lib/supabase");

const SCHEMA_PATH = path.join(process.cwd(), "llm/schema/post_enrichment_v1.schema.json");
const BATCH_SIZE = 50;
const SLEEP_WHEN_WORK_MS = 5000;
const SLEEP_WHEN_IDLE_MS = 30000;

function env(name, required = true) {
  const v = process.env[name];
  if (required && (!v || !String(v).trim())) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function isEnrichmentEnabled() {
  return String(process.env.DORSET_ENRICHMENT_ENABLED ?? "true").toLowerCase() !== "false";
}

function isDryRun() {
  return String(process.env.ENRICH_DRY_RUN || "").toLowerCase() === "true";
}

function getDryRunLlmJson(postText) {
  const trimmed = (postText || "").trim();
  const summary = trimmed.length > 0 ? trimmed.slice(0, 120) : "(no text)";
  return {
    summary,
    language: "en",
    is_meaningful_text: trimmed.length > 0,
    is_service_request: false,
    request_type: "not_a_request",
    service_domains: [],
    problem_symptoms: [],
    property_context: "unknown",
    location_mentioned: [],
    location_confidence: "none",
    lead_strength: "noise",
    urgency: "low",
    timeframe: "unknown",
    confidence: 0.2,
    reasons: ["dry_run"],
    recommended_next_step: "ignore",
    reply_seed: ["dry_run"],
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMinimalErrorLlmJson(errMessage) {
  return {
    summary: "(error)",
    language: "en",
    is_meaningful_text: false,
    is_service_request: false,
    request_type: "not_a_request",
    service_domains: [],
    problem_symptoms: [],
    property_context: "unknown",
    location_mentioned: [],
    location_confidence: "none",
    lead_strength: "noise",
    urgency: "low",
    timeframe: "unknown",
    confidence: 0,
    reasons: [errMessage ? errMessage.slice(0, 140) : "Enrichment failed"],
    recommended_next_step: "ignore",
    reply_seed: ["(no reply)"],
  };
}

async function callOpenAIForEnrichment(postText, schema, apiKey, model) {
  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model: model || "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a classifier for Facebook group posts from Dorset, UK. Extract structured data about service requests, recommendations, and lead quality. Output valid JSON only, matching the provided schema.",
      },
      {
        role: "user",
        content: `Analyze this post and output the enrichment JSON:\n\n${(postText || "").slice(0, 8000)}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "post_enrichment_v1",
        strict: true,
        schema: schema,
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI empty content");
  return JSON.parse(content);
}

async function mainLoop() {
  if (!isEnrichmentEnabled()) {
    console.log("[enrich] DORSET_ENRICHMENT_ENABLED is false; exiting.");
    process.exit(0);
  }

  const monitorId = process.env.ENRICH_MONITOR_ID || "dorset_test";
  const apiKey = isDryRun() ? null : env("OPENAI_API_KEY", true);

  if (!isDryRun()) {
    if (!fs.existsSync(SCHEMA_PATH)) {
      console.error(`[enrich] Schema not found: ${SCHEMA_PATH}`);
      process.exit(1);
    }
  }
  const schema = isDryRun() ? null : JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));

  const supabase = getSupabaseAdmin();
  const model = process.env.OPENAI_ENRICH_MODEL || "gpt-4o-mini";

  console.log(`[enrich] started monitor_id=${monitorId} batch_size=${BATCH_SIZE} dry_run=${isDryRun()}`);

  while (true) {
    try {
      // 1) Fetch candidates from posts_raw (monitor_id lives in raw jsonb; filter in DB)
      const { data: rawRows, error: rawError } = await supabase
        .from("posts_raw")
        .select("post_url, text, raw, last_seen_at")
        .filter("raw->>monitor_id", "eq", monitorId)
        .order("last_seen_at", { ascending: false })
        .limit(BATCH_SIZE);

      if (rawError) throw new Error(`posts_raw query: ${rawError.message}`);
      const forMonitor = Array.isArray(rawRows) ? rawRows : [];
      const candidateUrls = forMonitor.map((r) => r.post_url).filter(Boolean);

      if (candidateUrls.length === 0) {
        console.log("[enrich] no candidates; sleeping", SLEEP_WHEN_IDLE_MS, "ms");
        await sleep(SLEEP_WHEN_IDLE_MS);
        continue;
      }

      // 2) Fetch existing post_urls from posts_enriched
      const { data: existingRows, error: existingError } = await supabase
        .from("posts_enriched")
        .select("post_url")
        .in("post_url", candidateUrls);

      if (existingError) throw new Error(`posts_enriched query: ${existingError.message}`);
      const existingSet = new Set((existingRows || []).map((r) => r.post_url));

      // 3) Missing = to enrich
      const toEnrich = forMonitor.filter((r) => !existingSet.has(r.post_url));
      if (toEnrich.length === 0) {
        console.log("[enrich] batch already enriched; sleeping", SLEEP_WHEN_IDLE_MS, "ms");
        await sleep(SLEEP_WHEN_IDLE_MS);
        continue;
      }

      console.log(`[enrich] enriching ${toEnrich.length} posts`);

      for (const row of toEnrich) {
        const postUrl = row.post_url;
        const postText = row.text || (row.raw && (row.raw.text || row.raw.excerpt)) || "";

        let llmJson;
        let status = "ok";
        let errorMessage = null;

        if (isDryRun()) {
          llmJson = getDryRunLlmJson(postText);
        } else {
          try {
            llmJson = await callOpenAIForEnrichment(postText, schema, apiKey, model);
          } catch (err) {
            status = "error";
            errorMessage = (err && (err.message || String(err))) || "Unknown error";
            if (errorMessage.length > 500) errorMessage = errorMessage.slice(0, 500);
            llmJson = getMinimalErrorLlmJson(errorMessage);
          }
        }

        const { error: upsertErr } = await supabase
          .from("posts_enriched")
          .upsert(
            {
              post_url: postUrl,
              schema_version: "v1",
              model,
              enriched_at: new Date().toISOString(),
              llm_json: llmJson,
              status,
              error_message: errorMessage,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "post_url" }
          );

        if (upsertErr) {
          console.error(`[enrich] upsert failed ${postUrl}:`, upsertErr.message);
        } else {
          console.log(`[enrich] ok ${postUrl} status=${status}`);
        }
      }

      await sleep(SLEEP_WHEN_WORK_MS);
    } catch (err) {
      console.error("[enrich] fatal:", err);
      await sleep(SLEEP_WHEN_IDLE_MS);
    }
  }
}

mainLoop();
