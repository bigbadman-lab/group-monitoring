const fs = require('fs');
const path = require('path');
const { writeEvidence } = require('./utils/evidence');

const DEBUG = process.argv.includes('--debug');
const DAEMON = process.argv.includes('--daemon');
const SEEN_PATH = './seen_posts.json';
const DATA_DIR = './data';
const LEADS_PATH = './data/leads.jsonl';
const SCAN_TIMEOUT_MS = 90000;
const SCAN_SLOW_MS = 60000;

/** Step labels for scan budget expiry reporting */
const SCAN_EXPIRED_STEP = {
  GOTO: 'goto',
  RETRY_DELAY: 'retry_delay',
  SCROLL: 'scroll',
  COLLECT: 'collect',
  RECOVER: 'recover',
  DETAIL_ENRICHMENT: 'detail_enrichment',
};

function createScanBudget(budgetMs) {
  const deadlineMs = Date.now() + budgetMs;
  return {
    deadlineMs,
    remainingMs() {
      return Math.max(0, deadlineMs - Date.now());
    },
    isExpired() {
      return Date.now() >= deadlineMs;
    },
  };
}

function clampTimeout(requestedMs, budget) {
  if (!budget) return requestedMs;
  return Math.min(requestedMs, Math.max(0, budget.remainingMs()));
}

let testPostUrl = null;
for (const arg of process.argv) {
  if (arg.startsWith('--test-post=')) {
    testPostUrl = arg.slice('--test-post='.length).trim();
    break;
  }
}

let intervalMinutes = 5;
for (const arg of process.argv) {
  if (arg.startsWith('--interval=')) {
    const n = parseInt(arg.slice('--interval='.length), 10);
    if (!isNaN(n) && n > 0) intervalMinutes = n;
    break;
  }
}

let scoreFilePath = null;
for (const arg of process.argv) {
  if (arg.startsWith('--score-file=')) {
    scoreFilePath = arg.slice('--score-file='.length).trim();
    break;
  }
}

const notifyTest = process.argv.includes('--notify-test');
const emitLeads = process.argv.includes('--emit-leads');

let onlyMonitorId = null;
for (const arg of process.argv) {
  if (arg.startsWith('--only-monitor=')) {
    onlyMonitorId = arg.slice('--only-monitor='.length).trim();
    break;
  }
}

let regionName = null;
for (let i = 0; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--region=')) {
    regionName = arg.slice('--region='.length).trim();
    break;
  }
  if (arg === '--region' && process.argv[i + 1]) {
    regionName = process.argv[i + 1].trim();
    break;
  }
}

let nodeAssignmentId = null;
for (let i = 0; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--node-assignment=')) {
    nodeAssignmentId = arg.slice('--node-assignment='.length).trim();
    break;
  }
  if (arg === '--node-assignment' && process.argv[i + 1]) {
    nodeAssignmentId = process.argv[i + 1].trim();
    break;
  }
}

/** When --region is set, flat list of enabled group URLs (normalized with trailing /). Otherwise null. */
let regionGroupUrls = null;
/** When --region is set, cfg.defaults from region file for scheduler. Otherwise null. */
let regionSchedulingDefaults = null;
/** Persisted scheduler state across runSweep calls (keyed by monitor.id). Used only when useScheduler is true. */
let schedulerStateByMonitor = {};
if (regionName) {
  const regionPath = path.resolve(process.cwd(), 'regions', regionName + '.json');
  let raw;
  try {
    raw = fs.readFileSync(regionPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(`Error: region file not found: regions/${regionName}.json`);
    } else {
      console.error(`Error: failed to read regions/${regionName}.json:`, e.message);
    }
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error(`Error: regions/${regionName}.json is not valid JSON:`, e.message);
    process.exit(1);
  }
  if (!cfg || !cfg.towns) {
    console.error('Error: region config must have "towns"');
    process.exit(1);
  }
  const towns = cfg.towns;
  if (!Array.isArray(towns) && (typeof towns !== 'object' || towns === null)) {
    console.error('Error: region "towns" must be an array or object');
    process.exit(1);
  }
  const flat = [];
  if (Array.isArray(towns)) {
    for (const t of towns) {
      if (!t || !Array.isArray(t.groups)) {
        console.error('Error: each town must have a "groups" array');
        process.exit(1);
      }
      for (const g of t.groups) {
        if (g && g.enabled === true && typeof g.url === 'string') {
          flat.push(g.url.endsWith('/') ? g.url : g.url + '/');
        }
      }
    }
  } else {
    for (const _town of Object.keys(towns)) {
      const groups = towns[_town];
      if (!Array.isArray(groups)) {
        console.error('Error: each town must have a "groups" array');
        process.exit(1);
      }
      for (const g of groups) {
        if (g && g.enabled === true && typeof g.url === 'string') {
          flat.push(g.url.endsWith('/') ? g.url : g.url + '/');
        }
      }
    }
  }
  regionGroupUrls = flat;
  regionSchedulingDefaults = (cfg.defaults && typeof cfg.defaults === 'object') ? cfg.defaults : null;
  console.log(`Region mode enabled: ${regionName} (${regionGroupUrls.length} enabled groups)`);
}

if (!regionName && nodeAssignmentId) {
  const assignmentPath = path.join(__dirname, 'runtime', 'node_assignments', nodeAssignmentId + '.json');
  let raw;
  try {
    raw = fs.readFileSync(assignmentPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(`Error: node assignment file not found: runtime/node_assignments/${nodeAssignmentId}.json`);
    } else {
      console.error(`Error: failed to read runtime/node_assignments/${nodeAssignmentId}.json:`, e.message);
    }
    process.exit(1);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    console.error(`Error: runtime/node_assignments/${nodeAssignmentId}.json is not valid JSON:`, e.message);
    process.exit(1);
  }
  if (!Array.isArray(json.groups)) {
    console.error('Error: node assignment must have "groups" array');
    process.exit(1);
  }
  const flat = [];
  for (const g of json.groups) {
    const url = g && typeof g.group_url === 'string' ? g.group_url.trim() : '';
    if (!url) continue;
    flat.push(url.endsWith('/') ? url : url + '/');
  }
  regionGroupUrls = flat;
  regionSchedulingDefaults = null;
  console.log(`Node assignment mode enabled: ${nodeAssignmentId} (${regionGroupUrls.length} groups)`);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanWait(page, minMs, maxMs, budget = null) {
  const desired = randInt(minMs, maxMs);
  const delay = budget ? clampTimeout(desired, budget) : desired;
  if (delay > 0) await page.waitForTimeout(delay);
}

async function gotoWithRetry(page, url, { timeoutMs = 120000, waitUntil = 'domcontentloaded', retries = 1, label = 'goto', budget = null } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (budget && budget.isExpired()) {
      return { ok: false, error: lastErr || new Error('navigation failed'), budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.GOTO };
    }
    try {
      if (attempt > 0) {
        const retryDelay = budget ? clampTimeout(2000, budget) : 2000;
        if (retryDelay <= 0) {
          return { ok: false, error: lastErr, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.RETRY_DELAY };
        }
        console.log(`${label}: retrying (${attempt}/${retries}) url=${url}`);
        await page.waitForTimeout(retryDelay);
        if (budget && budget.isExpired()) {
          return { ok: false, error: lastErr, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.RETRY_DELAY };
        }
      }
      const timeout = budget ? clampTimeout(timeoutMs, budget) : timeoutMs;
      if (timeout <= 0) {
        return { ok: false, error: lastErr, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.GOTO };
      }
      await page.goto(url, { waitUntil, timeout });
      return { ok: true };
    } catch (err) {
      lastErr = err;
      const msg = err && err.message ? err.message : String(err);
      console.log(`${label}: goto failed attempt=${attempt}/${retries} url=${url} err=${msg}`);
      if (budget && budget.isExpired()) {
        return { ok: false, error: lastErr, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.GOTO };
      }
    }
  }
  return { ok: false, error: lastErr };
}

function loadSeen() {
  try {
    const data = fs.readFileSync(SEEN_PATH, 'utf8');
    return JSON.parse(data);
  } catch (_) {
    return {};
  }
}

function saveSeen(seen) {
  const tempPath = SEEN_PATH + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(seen, null, 2), 'utf8');
  fs.renameSync(tempPath, SEEN_PATH);
}

function appendLead(leadObj) {
  try {
    fs.appendFileSync(LEADS_PATH, JSON.stringify(leadObj) + '\n', 'utf8');
  } catch (err) {
    console.warn('LEAD-SAVE fail', err.message || err);
  }
}

function cleanFacebookUrlForShare(urlStr) {
  if (!urlStr) return null;
  try {
    const u = new URL(urlStr);
    const keep = new URLSearchParams();
    const fbid = u.searchParams.get('fbid');
    const set = u.searchParams.get('set');
    if (fbid) keep.set('fbid', fbid);
    if (set && set.startsWith('gm.')) keep.set('set', set);
    const q = keep.toString();
    return u.origin + u.pathname + (q ? `?${q}` : '');
  } catch (_) {
    return urlStr;
  }
}

const FAKE_POST_URL_OFFLINE = 'https://www.facebook.com/groups/1536046086634463/posts/TEST1234567890/';

const DEFAULT_REPLY_SOFT = "Hi! I'm local and can help with that. Happy to give a quick quote — roughly how many bedrooms is the house, and are the gutters easy to access?";
const DEFAULT_REPLY_DIRECT = "Hi — I can get your gutters cleaned this week. If you send your postcode + a quick photo of the front/back, I'll confirm price and availability today.";

function escapeHtml(s) {
  if (s == null || typeof s !== 'string') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function tierEmoji(tier) {
  if (tier === 'HIGH') return '🔥';
  if (tier === 'MED') return '🟠';
  return '⚪';
}

function fmtUtc(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function clamp(s, n) {
  return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().slice(0, n);
}

function buildDraftReplies(item, scored) {
  const loc = (item.lead_matches?.location && item.lead_matches.location[0]) ? item.lead_matches.location[0] : '';
  const locPhrase = loc ? ` in ${loc}` : '';
  const soft =
    `Hi! I can help with gutter clearing${locPhrase}.\n` +
    `If you'd like, send me your postcode and whether it's a bungalow/2-storey, and I'll give you a quick quote + availability.`;
  const hard =
    `Hi — happy to clear the gutters${locPhrase}.\n` +
    `Can you share your postcode + property height (1/2 storey) + any access notes? I can quote today and book you in.`;
  return { soft, hard };
}

function formatTelegramLeadMessage({ item, monitor, scored, shareUrl, isOffline }) {
  const tier = scored?.tier || item?.tier || 'MED';
  const score = scored?.score ?? item?.score ?? '';
  const emoji = tier === 'HIGH' ? '🔥' : tier === 'MED' ? '🟠' : '⚪';
  const monitorName = monitor?.name || monitor?.id || item?.monitor_name || item?.monitor_id || 'Unknown';
  const lines = [];
  lines.push(`<b>${emoji} NEW LEAD — ${escapeHtml(tier)} (${escapeHtml(String(score))})</b>`);
  if (isOffline) lines.push('<b>🧪 OFFLINE PREVIEW</b>');
  lines.push('');
  lines.push(`<b>Monitor:</b> ${escapeHtml(monitorName)}`);
  const whenTs = item?.timestamp ?? item?.ts ?? new Date();
  lines.push(`<b>When:</b> ${fmtUtc(whenTs)}`);
  const groupUrl = item?.group_url || monitor?.group_url || '';
  const groupAnchor = escapeHtml(item?.group_name || item?.group_title || 'Open group');
  if (groupUrl) {
    lines.push(`<b>Group:</b> <a href="${escapeHtml(groupUrl)}">${groupAnchor}</a>`);
  } else {
    lines.push(`<b>Group:</b> ${groupAnchor}`);
  }
  if (shareUrl) {
    lines.push(`<b>Post:</b> <a href="${escapeHtml(shareUrl)}">Open on Facebook</a>`);
  } else {
    lines.push(`<b>Post:</b> (missing url)`);
  }
  lines.push('');
  const matchesObj = item?.lead_matches || item?.matches || {};
  let matchesStr = typeof matchesObj === 'string' ? matchesObj : '';
  if (!matchesStr && matchesObj && typeof matchesObj === 'object') {
    const parts = [];
    for (const key of ['intent', 'service', 'location', 'negative']) {
      const arr = matchesObj[key];
      if (Array.isArray(arr) && arr.length) {
        const vals = arr.map((m) => (typeof m === 'string' ? m : (m && (m.phrase || m.hit || m)) != null ? String(m.phrase || m.hit || m) : '')).filter(Boolean);
        if (vals.length) parts.push(`${key}: ${vals.join(', ')}`);
      }
    }
    matchesStr = parts.join(' | ');
  }
  const bulletEntries = matchesStr.split('|').map((s) => escapeHtml(s.trim())).filter(Boolean).slice(0, 6);
  lines.push('<b>Why it matched</b>');
  for (const b of bulletEntries) {
    lines.push('• ' + b);
  }
  if (bulletEntries.length === 0) lines.push('• —');
  lines.push('');
  const excerptSrc = clamp(item?.excerpt || item?.text || '', 280);
  lines.push('<b>Lead</b>');
  lines.push('<i>' + escapeHtml(excerptSrc || '—') + '</i>');
  lines.push('');
  const draftReplies = buildDraftReplies(item, scored);
  const replySoft = item?.reply_soft != null ? item.reply_soft : draftReplies.soft;
  const replyDirect = item?.reply_direct != null ? item.reply_direct : draftReplies.hard;
  lines.push('<b>Reply (Soft)</b>');
  lines.push('<pre>' + escapeHtml(replySoft) + '</pre>');
  lines.push('');
  lines.push('<b>Reply (Direct)</b>');
  lines.push('<pre>' + escapeHtml(replyDirect) + '</pre>');
  return lines.join('\n');
}

/** Dorset-only: compact triage format. Town/group_name omitted if not available. */
function formatDorsetTelegramMessage({ item, monitor, scored, shareUrl }) {
  const tier = scored?.tier || item?.tier || 'LOW';
  const lines = [];
  lines.push(`<b>Dorset Lead (${escapeHtml(tier)})</b>`);
  const town = item?.town ?? null;
  if (town) lines.push(`Town: ${escapeHtml(town)}`);
  const groupLabel = item?.group_name || item?.group_title || item?.group_url || 'Open group';
  const groupUrl = item?.group_url || '';
  if (groupUrl) {
    lines.push(`Group: <a href="${escapeHtml(groupUrl)}">${escapeHtml(groupLabel)}</a>`);
  } else {
    lines.push(`Group: ${escapeHtml(groupLabel)}`);
  }
  if (shareUrl) {
    lines.push(`Post: <a href="${escapeHtml(shareUrl)}">Open on Facebook</a>`);
  } else {
    lines.push(`Post: (missing url)`);
  }
  const matchesObj = item?.lead_matches || item?.matches || {};
  let reasonStr = '';
  if (matchesObj && typeof matchesObj === 'object') {
    const parts = [];
    for (const key of ['intent', 'service', 'location']) {
      const arr = matchesObj[key];
      if (Array.isArray(arr) && arr.length) {
        const vals = arr.map((m) => (typeof m === 'string' ? m : (m && (m.phrase || m.hit || m)) != null ? String(m.phrase || m.hit || m) : '')).filter(Boolean);
        if (vals.length) parts.push(`${key}: ${vals.slice(0, 3).join(', ')}`);
      }
    }
    reasonStr = parts.join(' | ');
  }
  if (reasonStr) lines.push(`Why: ${escapeHtml(reasonStr)}`);
  const snippet = (item?.text || item?.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  lines.push(`Snippet: <i>${escapeHtml(snippet || '—')}</i>`);
  const whenVal = item?.timestamp ?? item?.ts ?? new Date();
  const whenStr = whenVal instanceof Date ? whenVal.toISOString() : (typeof whenVal === 'string' ? whenVal : new Date().toISOString());
  lines.push(`When: ${whenStr}`);
  lines.push('Reply with: YES / NO / LATER');
  return lines.join('\n');
}

async function sendTelegramLead(chatId, messageText, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN env var');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = new URLSearchParams();
  body.set('chat_id', String(chatId));
  body.set('text', messageText);
  body.set('parse_mode', 'HTML');
  body.set('disable_web_page_preview', 'true');
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(url, { method: 'POST', body });
      const json = await resp.json().catch(() => null);
      if (resp.ok && json && json.ok) return true;
      const msg = json && json.description ? json.description : `HTTP ${resp.status}`;
      throw new Error(msg);
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

// Patterns for post permalinks (match relative or absolute hrefs)
const PERMLINK_PATTERNS = [
  /\/groups\/\d+\/posts\/\d+/,
  /\/groups\/\d+\/permalink\/\d+/,
  /permalink\.php\?story_fbid=\d+/,
  /\/permalink\/\d+/,
  /\/photo\/\?fbid=\d+/,
  /photo\.php\?fbid=\d+/,
  /set=gm\.\d+/,
];

function hrefMatchesPermalink(href) {
  if (!href || typeof href !== 'string') return false;
  let pathAndQuery = href;
  try {
    if (href.startsWith('http')) pathAndQuery = new URL(href).pathname + new URL(href).search;
  } catch (_) {}
  return PERMLINK_PATTERNS.some(re => re.test(pathAndQuery));
}

const TARGETED_PERMLINK_SELECTOR = [
  'a[href*="/posts/"]',
  'a[href*="/permalink/"]',
  'a[href*="permalink.php?story_fbid="]',
  'a[href*="/photo/?fbid="]',
  'a[href*="photo.php?fbid="]',
  'a[href*="set=gm."]',
].join(', ');

const MAX_TEXT_LENGTH = 1500;
const NEW_EXCERPT_LENGTH = 200;

const UI_CHROME_PHRASES = [
  'Unread Chats',
  'Number of unread notifications',
  'All reactions',
  'Like',
  'Comment',
  'Share',
];

const gutterMonitor = {
  threshold_high: 4,
  threshold_medium: 3,
  threshold_low: 2,
  weights: {
    intent_hit_strong: 2,
    service_hit: 2,
    location_hit: 1,
    negative_hit: -3,
  },
  caps: {
    intent_hits: 2,
    service_hits: 2,
    location_hits: 1,
    negative_hits: 1,
  },
  intent_keywords: [
    'looking for', 'need', 'needs', 'any recommendations', 'recommend', 'recommendations',
    'anyone recommend', 'can anyone recommend', 'anyone know', 'who do people use',
    'quote', 'quotes', 'price', 'cost', 'how much', 'availability', 'can someone',
  ],
  service_keywords: [
    'gutter', 'gutters', 'guttering', 'gutter cleaning', 'gutter clearing', 'clear gutters',
    'gutters cleaned', 'roof and gutters', 'downpipe', 'fascia', 'soffit', 'moss removal', 'roof cleaning',
  ],
  negative_keywords: [
    'for sale', 'selling', 'job vacancy', 'hiring', 'diy', 'supplies', 'parts', 'guard', 'installer',
  ],
  locations: ['bridport', 'west bay'],
};

const generalIntentMonitor = {
  threshold_high: 6,
  threshold_medium: 3,
  threshold_low: 2,
  weights: {
    intent_hit_strong: 2,
    service_hit: 1,
    location_hit: 0,
    negative_hit: -3,
  },
  caps: {
    intent_hits: 6,
    service_hits: 4,
    location_hits: 0,
    negative_hits: 2,
  },
  intent_keywords: [
    'looking for', 'need', 'needs', 'recommend', 'recommendation', 'anyone recommend',
    'can anyone recommend', 'someone to', 'anyone know', 'suggest', 'suggestions',
    'quote', 'quotation', 'estimate', 'price', 'cost', 'how much', 'help with',
    'help needed', 'urgent', 'asap', 'this week', 'today', 'tomorrow',
  ],
  service_keywords: [
    'clean', 'repair', 'fix', 'install', 'replace', 'remove', 'build',
    'plumber', 'electrician', 'roofer', 'handyman', 'gardener', 'builder',
    'decorator', 'locksmith', 'painter', 'tiler', 'carpenter', 'heating', 'boiler',
  ],
  negative_keywords: [],
  locations: [],
};

const MONITORS_PATH = './monitors.json';

function getTemplateConfig(templateName) {
  if (templateName === 'gutter_cleaning') {
    return {
      threshold_high: 4,
      threshold_medium: 3,
      threshold_low: 2,
      weights: { ...gutterMonitor.weights },
      caps: { ...gutterMonitor.caps },
      intent_keywords: [...gutterMonitor.intent_keywords],
      service_keywords: [...gutterMonitor.service_keywords],
      negative_keywords: [...gutterMonitor.negative_keywords],
      locations: [],
    };
  }
  if (templateName === 'general_intent') {
    return {
      threshold_high: generalIntentMonitor.threshold_high,
      threshold_medium: generalIntentMonitor.threshold_medium,
      threshold_low: generalIntentMonitor.threshold_low,
      weights: { ...generalIntentMonitor.weights },
      caps: { ...generalIntentMonitor.caps },
      intent_keywords: [...generalIntentMonitor.intent_keywords],
      service_keywords: [...generalIntentMonitor.service_keywords],
      negative_keywords: [...generalIntentMonitor.negative_keywords],
      locations: [...generalIntentMonitor.locations],
    };
  }
  throw new Error(`Unknown template: ${templateName}`);
}

function buildMonitorConfig(monitorFromJson) {
  const template = getTemplateConfig(monitorFromJson.template || 'gutter_cleaning');
  const config = {
    threshold_high: monitorFromJson.threshold_high != null ? monitorFromJson.threshold_high : template.threshold_high,
    threshold_medium: monitorFromJson.threshold_medium != null ? monitorFromJson.threshold_medium : template.threshold_medium,
    threshold_low: monitorFromJson.threshold_low != null ? monitorFromJson.threshold_low : template.threshold_low,
    weights: template.weights,
    caps: template.caps,
    intent_keywords: template.intent_keywords,
    service_keywords: template.service_keywords,
    negative_keywords: template.negative_keywords,
    locations: Array.isArray(monitorFromJson.locations) && monitorFromJson.locations.length > 0
      ? monitorFromJson.locations
      : template.locations,
  };
  return config;
}

function loadMonitors() {
  let raw;
  try {
    raw = fs.readFileSync(MONITORS_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`${MONITORS_PATH} not found`);
    throw new Error(`Failed to read ${MONITORS_PATH}: ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${MONITORS_PATH} invalid JSON: ${e.message}`);
  }
  const list = data && data.monitors;
  if (!Array.isArray(list)) throw new Error(`${MONITORS_PATH} must have a "monitors" array`);
  return list.filter((m) => m.enabled === true);
}

/** Register synthetic dorset_test monitor (same behavior as general_intent; groups come from --region). */
function ensureDorsetTestMonitor(monitors) {
  const general = monitors.find((m) => m.id === 'general_leads_test');
  const base = general
    ? JSON.parse(JSON.stringify(general))
    : {
        template: 'general_intent',
        threshold_high: 6,
        threshold_medium: 3,
        threshold_low: 2,
        notify: { telegram: { enabled: false, chat_id: null } },
        negative_phrases: [],
        negative_regex: [],
        negative_action: 'cap_low',
        groups: [],
      };
  base.id = 'dorset_test';
  base.name = 'Dorset Test (Region)';
  base.enabled = true;
  monitors.push(base);
}

function normalizeText(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasPhrase(normalizedText, phrase) {
  const normalizedPhrase = normalizeText(phrase);
  if (normalizedPhrase.includes(' ')) {
    return normalizedText.includes(normalizedPhrase);
  }
  const re = new RegExp('\\b' + escapeRegex(normalizedPhrase) + '\\b');
  return re.test(normalizedText);
}

function countHits(normalizedText, phrases) {
  const matched = [];
  for (const p of phrases) {
    if (hasPhrase(normalizedText, p)) matched.push(p);
  }
  return { count: matched.length, matched };
}

/** Returns lowercased string for safe comparisons. */
function normalizeTextForNegative(s) {
  return (s == null || typeof s !== 'string' ? '' : String(s)).toLowerCase();
}

/**
 * Per-monitor negative filter: phrases (case-insensitive substring) and regex (JS source, 'i' flag).
 * Returns array of strings like "phrase:event" or "regex:pattern".
 */
function findNegativeHits(text, monitor) {
  if (!monitor) return [];
  const hits = [];
  const textLower = normalizeTextForNegative(text);
  const phrases = monitor.negative_phrases;
  if (Array.isArray(phrases)) {
    for (const phrase of phrases) {
      const phraseLower = normalizeTextForNegative(phrase);
      if (phraseLower && textLower.includes(phraseLower)) hits.push(`phrase:${phrase}`);
    }
  }
  const regexList = monitor.negative_regex;
  if (Array.isArray(regexList)) {
    for (const rxStr of regexList) {
      if (typeof rxStr !== 'string') continue;
      try {
        const re = new RegExp(rxStr, 'i');
        if (re.test(text || '')) hits.push(`regex:${rxStr}`);
      } catch (_) {}
    }
  }
  return hits;
}

/** Mutates scored: appends negativeHits to scored.negative, then applies negative_action (cap_low | ignore). */
function applyNegativeRules(scored, negativeHits, monitor) {
  if (!negativeHits || negativeHits.length === 0) return;
  scored.negative = [...(scored.negative || []), ...negativeHits];
  const action = monitor?.negative_action || 'cap_low';
  if (action === 'ignore') {
    scored.tier = 'IGNORE';
    scored.score = 0;
  } else {
    if (scored.tier === 'HIGH' || scored.tier === 'MED') scored.tier = 'LOW';
  }
}

function scorePost(text, config) {
  const norm = normalizeText(text);
  const intent = countHits(norm, config.intent_keywords);
  const service = countHits(norm, config.service_keywords);
  const location = countHits(norm, config.locations);
  const negative = countHits(norm, config.negative_keywords);
  const intentCapped = Math.min(intent.count, config.caps.intent_hits);
  const serviceCapped = Math.min(service.count, config.caps.service_hits);
  const locationCapped = Math.min(location.count, config.caps.location_hits);
  const negativeCapped = Math.min(negative.count, config.caps.negative_hits);
  const score =
    intentCapped * config.weights.intent_hit_strong +
    serviceCapped * config.weights.service_hit +
    locationCapped * config.weights.location_hit +
    negativeCapped * config.weights.negative_hit;
  let tier = 'IGNORE';
  if (score >= config.threshold_high) tier = 'HIGH';
  else if (score >= config.threshold_medium) tier = 'MED';
  else if (score >= config.threshold_low) tier = 'LOW';
  if (intent.count === 0 && tier !== 'IGNORE') tier = 'LOW';
  const excerpt = (text || '').trim().slice(0, 160);
  return {
    tier,
    score,
    intent: intent.matched,
    service: service.matched,
    location: location.matched,
    negative: negative.matched,
    excerpt,
  };
}

async function extractPostTextFromPostPage(context, detailPage, postUrl, options = {}) {
  try {
    const budget = options.budget || null;
    if (DEBUG) console.log(`ENRICH: extractPostTextFromPostPage start url=${postUrl}`);
    if (!options.skipGotoAndInitialWait) {
      if (budget && budget.isExpired()) return '';
      const gotoTimeout = budget ? clampTimeout(60000, budget) : 60000;
      if (gotoTimeout <= 0) return '';
      await detailPage.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: gotoTimeout });
      if (DEBUG) console.log(`ENRICH: post goto complete final=${detailPage.url()}`);
      if (budget && budget.isExpired()) return '';
      const selTimeout = budget ? clampTimeout(15000, budget) : 15000;
      if (selTimeout > 0) await detailPage.waitForSelector('[role="main"]', { timeout: selTimeout }).catch(() => {});
      if (budget && budget.isExpired()) return '';
      const wait3500 = budget ? clampTimeout(3500, budget) : 3500;
      if (wait3500 > 0) await detailPage.waitForTimeout(wait3500);
    }
    const finalUrl = detailPage.url();
    const groupPostMatch = String(postUrl).match(/\/posts\/(\d+)/);
    if (groupPostMatch) {
      const expectedPostId = groupPostMatch[1];
      if (!finalUrl.includes(expectedPostId)) {
        console.warn(`WARN: postUrl redirected, expected ${expectedPostId}, got ${finalUrl} (continuing extraction)`);
      }
    }
    if (budget && budget.isExpired()) return '';
    await detailPage.evaluate(() => {
      const re = /see more|more/i;
      const buttons = document.querySelectorAll('button, [role="button"]');
      let clicked = 0;
      for (const el of buttons) {
        if (clicked >= 5) break;
        try {
          const text = (el.innerText || '').trim();
          if (re.test(text)) {
            el.click();
            clicked++;
          }
        } catch (_) {}
      }
    });
    const wait500 = budget ? clampTimeout(500, budget) : 500;
    if (wait500 > 0) await detailPage.waitForTimeout(wait500);
    if (budget && budget.isExpired()) return '';
    const returnStats = !!options.debugStats;
    const META_BOILERPLATE = ['Log in', 'Sign up', 'Facebook', 'See posts, photos and more', 'Join group', "This content isn't available", 'You must log in'];
    const evalTimeoutMs = budget ? clampTimeout(30000, budget) : 30000;
    let raw;
    try {
      raw = evalTimeoutMs > 0
        ? await Promise.race([
            detailPage.evaluate(({ maxLen, uiPhrases, returnStats, metaBoilerplate }) => {
      function clean(s) {
        return (s || '').replace(/\s+/g, ' ').trim();
      }
      function hasChrome(text) {
        const t = String(text);
        return uiPhrases.some(phrase => t.includes(phrase));
      }
      function getMetaText() {
        const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content');
        if (ogDesc && ogDesc.trim().length >= 20) {
          const t = clean(ogDesc).slice(0, maxLen);
          if (!metaBoilerplate.some(p => t.toLowerCase().includes(p.toLowerCase()))) return t;
        }
        const twDesc = document.querySelector('meta[name="twitter:description"]')?.getAttribute('content');
        if (twDesc && twDesc.trim().length >= 20) {
          const t = clean(twDesc).slice(0, maxLen);
          if (!metaBoilerplate.some(p => t.toLowerCase().includes(p.toLowerCase()))) return t;
        }
        const desc = document.querySelector('meta[name="description"]')?.getAttribute('content');
        if (desc && desc.trim().length >= 20) {
          const t = clean(desc).slice(0, maxLen);
          if (!metaBoilerplate.some(p => t.toLowerCase().includes(p.toLowerCase()))) return t;
        }
        return '';
      }
      function getMetaStats() {
        const get = (sel, attr) => {
          const el = document.querySelector(sel);
          return (el && el.getAttribute(attr)) || null;
        };
        return {
          ogTitle: get('meta[property="og:title"]', 'content'),
          ogDescription: get('meta[property="og:description"]', 'content'),
          metaDescription: get('meta[name="description"]', 'content'),
          twitterDescription: get('meta[name="twitter:description"]', 'content'),
          documentTitle: document.title || null,
          bodyInnerTextLength: (document.body && document.body.innerText) ? document.body.innerText.length : 0,
        };
      }
      const uiBlockRe = /Like|Comment|Share|All reactions|Write a comment|See more|Send message|Photos|Most relevant|Top contributor|Edited/i;
      const pureCountRe = /^\d+$/;
      let dataAdPreviewCount = 0;
      let dirAutoDivCount = 0;
      let dirAutoSpanCount = 0;
      let roleArticleCount = 0;
      let bestArticleInnerTextLength = 0;
      let metaStats = null;
      if (returnStats) metaStats = getMetaStats();
      try {
        const root = document.querySelector('[role="main"]') || document;
        const msgNodes = document.querySelectorAll('[data-ad-preview="message"]');
        dataAdPreviewCount = msgNodes.length;
        if (msgNodes && msgNodes.length > 0) {
          const candidates = [...msgNodes]
            .map(n => clean(n.innerText || ''))
            .filter(t => t.length >= 20);
          if (candidates.length > 0) {
            const best = candidates.reduce((a, b) => (a.length >= b.length ? a : b), '');
            const text = best.slice(0, maxLen);
            if (returnStats) {
              dirAutoDivCount = root.querySelectorAll('div[dir="auto"]').length;
              dirAutoSpanCount = root.querySelectorAll('span[dir="auto"]').length;
              const articles = Array.from(document.querySelectorAll('[role="article"]'));
              roleArticleCount = articles.length;
              if (articles.length > 0) {
                bestArticleInnerTextLength = Math.max(...articles.map(a => (a.innerText || '').length));
              }
              return { text, dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength, ...metaStats };
            }
            return text;
          }
        }
        const dirAuto = root.querySelectorAll('div[dir="auto"], span[dir="auto"]');
        dirAutoDivCount = root.querySelectorAll('div[dir="auto"]').length;
        dirAutoSpanCount = root.querySelectorAll('span[dir="auto"]').length;
        let candidates = [...dirAuto]
          .map(n => clean(n.innerText || ''))
          .filter(t => t.length >= 30)
          .filter(t => !hasChrome(t));
        let deduped = [...new Set(candidates)];
        if (deduped.length > 0) {
          const best = deduped.reduce((a, b) => (a.length >= b.length ? a : b), '');
          const text = best.slice(0, maxLen);
          if (returnStats) {
            const articles = Array.from(document.querySelectorAll('[role="article"]'));
            roleArticleCount = articles.length;
            if (articles.length > 0) {
              bestArticleInnerTextLength = Math.max(...articles.map(a => (a.innerText || '').length));
            }
            return { text, dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength, ...metaStats };
          }
          return text;
        }
        const articles = Array.from(document.querySelectorAll('[role="article"]'));
        roleArticleCount = articles.length;
        if (articles.length === 0) {
          const metaText = getMetaText();
          if (metaText) {
            if (returnStats) return { text: metaText, dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength, ...metaStats };
            return metaText;
          }
          if (returnStats) return { text: '', dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength, ...metaStats };
          return '';
        }
        const bestArticle = articles.reduce((a, b) => {
          const al = (a.innerText || '').length;
          const bl = (b.innerText || '').length;
          return al >= bl ? a : b;
        });
        bestArticleInnerTextLength = (bestArticle.innerText || '').length;
        const blocks = bestArticle.querySelectorAll('div, span');
        candidates = [...blocks]
          .map(n => clean(n.innerText || ''))
          .filter(t => t.length >= 40)
          .filter(t => !uiBlockRe.test(t))
          .filter(t => !pureCountRe.test(t.trim()));
        deduped = [...new Set(candidates)];
        if (deduped.length === 0) {
          const metaText = getMetaText();
          if (metaText) {
            if (returnStats) return { text: metaText, dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength, ...metaStats };
            return metaText;
          }
          if (returnStats) return { text: '', dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength, ...metaStats };
          return '';
        }
        const best = deduped.reduce((a, b) => (a.length >= b.length ? a : b), '');
        const text = best.slice(0, maxLen);
        if (returnStats) return { text, dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength, ...metaStats };
        return text;
      } catch (_) {
        if (returnStats) return { text: '', dataAdPreviewCount, dirAutoDivCount, dirAutoSpanCount, roleArticleCount, bestArticleInnerTextLength, ...(metaStats || {}) };
        return '';
      }
    }, { maxLen: MAX_TEXT_LENGTH, uiPhrases: UI_CHROME_PHRASES, returnStats, metaBoilerplate: META_BOILERPLATE }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('detail_eval_timeout')), evalTimeoutMs)),
          ])
        : '';
    } catch (_) {
      raw = '';
    }
    let result = (raw && typeof raw === 'string') ? raw : (raw && raw.text !== undefined ? raw.text : '');
    const stats = raw && typeof raw === 'object' && raw.text !== undefined ? raw : null;
    if (result === '' && groupPostMatch) {
      const locatorBudgetMs = budget ? clampTimeout(15000, budget) : 15000;
      if (locatorBudgetMs > 0) {
        try {
          await Promise.race([
            (async () => {
              const main = detailPage.locator('[role="main"]');
              await main.first().waitFor({ timeout: Math.min(15000, locatorBudgetMs) }).catch(() => {});
              if (budget && budget.isExpired()) return;
              const msgNodes = detailPage.locator('[data-ad-preview="message"]');
              const msgTexts = await msgNodes.allTextContents();
              const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
              const msgCandidates = msgTexts.map(clean).filter((t) => t.length >= 20);
              if (msgCandidates.length > 0) {
                const best = msgCandidates.reduce((a, b) => (a.length >= b.length ? a : b), '');
                result = best.slice(0, MAX_TEXT_LENGTH);
              }
              if (result === '' && (!budget || !budget.isExpired())) {
                const spanTexts = await main.locator('span').allTextContents();
                const uiRe = /Like|Comment|Share|All reactions|Write a comment|See more/i;
                const spanCandidates = spanTexts.map(clean).filter((t) => t.length >= 30).filter((t) => !uiRe.test(t));
                if (spanCandidates.length > 0) {
                  const best = spanCandidates.reduce((a, b) => (a.length >= b.length ? a : b), '');
                  result = best.slice(0, MAX_TEXT_LENGTH);
                }
              }
            })(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('locator_fallback_timeout')), locatorBudgetMs)),
          ]);
        } catch (_) {
          // leave result as is
        }
      }
      if (result !== '' && !DEBUG) {
        console.log('INFO: locator fallback used for', postUrl);
      }
    }
    if (postUrl.includes('/posts/') && result === '') {
      const axBudgetMs = budget ? clampTimeout(15000, budget) : 15000;
      if (axBudgetMs > 0) {
        try {
          const axResult = await Promise.race([
            (async () => {
              const { names: axNames, axMethod, axError, axNodeCount, nodes: axNodes } = await getAxNamesAndMethod(detailPage);
              if (axError === 'Unexpected AX tree shape') {
                console.warn(`WARN: AX tree shape unexpected for ${postUrl}; continuing to other fallbacks`);
              }
              if (axMethod === 'cdp' && Array.isArray(axNodes)) {
                const cdpBest = getCdpAxBest(axNodes, 1500);
                if (cdpBest.text && cdpBest.text.length >= 30) return cdpBest.text;
              }
              const fallback = getAccessibilityFallbackFromNames(axNames, MAX_TEXT_LENGTH);
              const axBest = fallback.text ? fallback.text.slice(0, MAX_TEXT_LENGTH) : '';
              if (axBest && axBest.length >= 30) return axBest.slice(0, 1500);
              return '';
            })(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('ax_fallback_timeout')), axBudgetMs)),
          ]);
          if (axResult && typeof axResult === 'string' && axResult.length >= 30) {
            result = axResult;
            console.log(`INFO: AX/CDP text used for ${postUrl} (len=${result.length})`);
            return result;
          }
        } catch (_) {
          // leave result as is
        }
      }
    }
    console.log(`INFO: DOM extraction empty, trying AX methods for ${postUrl}`);
    if (result === '' && postUrl.includes('/posts/')) {
      const cdpBudgetMs = budget ? clampTimeout(15000, budget) : 15000;
      if (cdpBudgetMs > 0) {
        try {
          const cdpAx = await Promise.race([
            extractTextViaCdpAx(context, detailPage),
            new Promise((_, reject) => setTimeout(() => reject(new Error('cdp_ax_timeout')), cdpBudgetMs)),
          ]);
          if (cdpAx.error) {
            if (!DEBUG) console.warn(`WARN: CDP AX failed for ${postUrl} err=${cdpAx.error}`);
          } else if (cdpAx.text && cdpAx.text.length >= 30) {
            result = cdpAx.text;
            console.log(`INFO: AX/CDP text used for ${postUrl} (len=${result.length})`);
          }
        } catch (_) {
          // leave result as is
        }
      }
    }
    if (result === '' && groupPostMatch) {
      console.warn(`WARN: empty post text for ${postUrl} final=${finalUrl}`);
    }
    return result;
  } catch (e) {
    console.warn(`WARN: extractPostTextFromPostPage exception url=${postUrl} now=${detailPage.url()} err=${e?.message || e}`);
    return '';
  }
}

function collectAxNames(node, out) {
  if (!node) return;
  const name = node.name;
  if (typeof name === 'string' && name.trim().length > 0) out.push(name);
  const children = node.children || [];
  for (const c of children) collectAxNames(c, out);
}

const AX_BOILERPLATE_RE = /Like|Comment|Share|Write a comment|All reactions|Notifications|Unread|Facebook|See more|Most relevant|Reply|Send message|people/i;

function getAccessibilityFallbackFromNames(names, maxLen = 1500) {
  if (!names || names.length === 0) return { text: '', bestLength: 0 };
  const cleaned = names
    .map((n) => (n || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 30)
    .filter((t) => !AX_BOILERPLATE_RE.test(t));
  const deduped = [...new Set(cleaned)];
  if (deduped.length === 0) return { text: '', bestLength: 0 };
  const best = deduped.reduce((a, b) => (a.length >= b.length ? a : b), '');
  const text = best.slice(0, maxLen);
  return { text, bestLength: text.length };
}

function getAccessibilityFallbackFromSnapshot(ax, maxLen = 1500) {
  if (!ax) return { text: '', bestLength: 0 };
  const names = [];
  collectAxNames(ax, names);
  return getAccessibilityFallbackFromNames(names, maxLen);
}

const CDP_AX_BOILERPLATE_RE = /Facebook|Notifications|Messenger|Menu|Close|Like|Comment|Share|Write a comment|All reactions|Most relevant|Reply|Send message|Settings/i;
const SIX_LETTERS_RE = /[A-Za-z].*[A-Za-z].*[A-Za-z].*[A-Za-z].*[A-Za-z].*[A-Za-z]/;

async function extractTextViaCdpAx(context, page) {
  try {
    const client = await context.newCDPSession(page);
    await client.send('Accessibility.enable').catch(() => {});
    const ax = await client.send('Accessibility.getFullAXTree');
    const nodes = ax?.nodes || ax;
    const nodeCount = Array.isArray(nodes) ? nodes.length : 0;
    const cands = [];
    for (const n of Array.isArray(nodes) ? nodes : []) {
      const v = n?.name?.value;
      if (v && typeof v === 'string') cands.push(v);
      const d = n?.description?.value;
      if (d && typeof d === 'string') cands.push(d);
    }
    const cleaned = cands.map((c) => (c || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length >= 30).filter((t) => !CDP_AX_BOILERPLATE_RE.test(t));
    const best = cleaned.length > 0 ? cleaned.reduce((a, b) => (a.length >= b.length ? a : b), '') : '';
    return {
      text: best ? best.slice(0, 1500) : '',
      nodeCount,
      bestLen: best ? best.length : 0,
      bestPreview: best ? best.slice(0, 200) : '',
    };
  } catch (e) {
    return { text: '', nodeCount: 0, bestLen: 0, bestPreview: '', error: String(e?.message != null ? e.message : e) };
  }
}

function getCdpAxBest(nodes, maxLen = 1500) {
  const cands = [];
  for (const n of nodes || []) {
    const v = n?.name?.value;
    if (v && typeof v === 'string') cands.push(v);
    const d = n?.description?.value;
    if (d && typeof d === 'string') cands.push(d);
  }
  const cleaned = cands.map((c) => (c || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length >= 40).filter((t) => SIX_LETTERS_RE.test(t)).filter((t) => !CDP_AX_BOILERPLATE_RE.test(t));
  const deduped = [...new Set(cleaned)];
  if (deduped.length === 0) return { text: '', axBestLen: 0, axBestPreview: '' };
  const candidate = deduped.reduce((a, b) => (a.length >= b.length ? a : b), '');
  const text = candidate.slice(0, maxLen);
  return { text, axBestLen: text.length, axBestPreview: candidate.slice(0, 200) };
}

async function getAxNamesAndMethod(page) {
  let axMethod = 'none';
  let axError = '';
  let names = [];
  let axNodeCount = undefined;
  let nodes = undefined;
  if (page.accessibility && typeof page.accessibility.snapshot === 'function') {
    const ax = await page.accessibility.snapshot({ interestingOnly: false }).catch(() => null);
    if (ax) {
      collectAxNames(ax, names);
      axMethod = 'playwright';
      return { names, axMethod, axError, axNodeCount, nodes };
    }
  }
  if (typeof page.accessibility === 'function') {
    const axObj = page.accessibility();
    if (axObj?.snapshot) {
      const ax = await axObj.snapshot({ interestingOnly: false }).catch(() => null);
      if (ax) {
        collectAxNames(ax, names);
        axMethod = 'playwright';
        return { names, axMethod, axError, axNodeCount, nodes };
      }
    }
  }
  try {
    const ctx = page.context();
    const client = await ctx.newCDPSession(page);
    await client.send('Accessibility.enable').catch(() => {});
    const ax = await client.send('Accessibility.getFullAXTree');
    const nodesArr = ax?.nodes || ax;
    axMethod = 'cdp';
    axNodeCount = Array.isArray(nodesArr) ? nodesArr.length : 0;
    if (!Array.isArray(nodesArr)) {
      axError = 'Unexpected AX tree shape';
      return { names: [], axMethod, axError, axNodeCount, nodes: undefined };
    }
    nodes = nodesArr;
    for (const n of nodes) {
      const v = n?.name?.value;
      if (v && typeof v === 'string') names.push(v);
      const d = n?.description?.value;
      if (d && typeof d === 'string') names.push(d);
    }
    return { names, axMethod, axError, axNodeCount, nodes };
  } catch (e) {
    axError = String(e && e.message != null ? e.message : e);
    return { names: [], axMethod: 'none', axError, axNodeCount: 0, nodes: undefined };
  }
}

function parseGroupIdFromGroupUrl(groupUrl) {
  const m = String(groupUrl).match(/\/groups\/(\d+)/);
  return m ? m[1] : null;
}

function toStructuredItem(sourceUrl, groupUrl) {
  const u = sourceUrl.split('#')[0];
  const groupId = parseGroupIdFromGroupUrl(groupUrl);
  const item = { group_url: groupUrl, source_url: u, post_url: u, post_id: null, type: 'group_post', aliases: [] };

  const groupsPostsMatch = u.match(/\/groups\/(\d+)\/posts\/(\d+)/);
  if (groupsPostsMatch) {
    item.type = 'group_post';
    item.post_id = groupsPostsMatch[2];
    item.post_url = `https://www.facebook.com/groups/${groupsPostsMatch[1]}/posts/${item.post_id}/`;
    item.aliases = [];
    return item;
  }
  const setGmMatch = u.match(/set=gm\.(\d+)/);
  if (setGmMatch) {
    item.type = 'group_post';
    item.post_id = setGmMatch[1];
    item.post_url = groupId
      ? `https://www.facebook.com/groups/${groupId}/posts/${item.post_id}/`
      : u;
    const fbidInUrl = u.match(/fbid=(\d+)/);
    item.aliases = fbidInUrl
      ? [`https://www.facebook.com/photo/?fbid=${fbidInUrl[1]}`]
      : [];
    return item;
  }
  const fbidMatch = u.match(/fbid=(\d+)/);
  if (fbidMatch && !u.includes('set=gm.')) {
    item.type = 'photo';
    item.post_id = fbidMatch[1];
    item.post_url = `https://www.facebook.com/photo/?fbid=${item.post_id}`;
    item.aliases = [];
    return item;
  }
  const storyFbidMatch = u.match(/story_fbid=(\d+)/);
  if (storyFbidMatch) item.post_id = storyFbidMatch[1];
  else {
    const permalinkMatch = u.match(/\/permalink\/(\d+)/);
    if (permalinkMatch) item.post_id = permalinkMatch[1];
  }
  item.post_url = u;
  item.aliases = [];
  return item;
}

const baseUrl = 'https://www.facebook.com';

function normalizeGroupUrl(url) {
  return (url && typeof url === 'string') ? (url.trim().replace(/\/?$/, '/') || '/') : '/';
}

function stripUrlQueryAndHash(href) {
  try {
    if (!href || typeof href !== "string") return href;
    const u = new URL(href);
    // Keep origin + pathname only
    const clean = `${u.origin}${u.pathname}`;
    // Remove trailing slash for consistency (optional but helps)
    return clean.endsWith("/") ? clean.slice(0, -1) : clean;
  } catch {
    // Fallback: remove query/hash manually
    if (!href || typeof href !== "string") return href;
    const noHash = href.split("#")[0];
    const noQuery = noHash.split("?")[0];
    return noQuery.endsWith("/") ? noQuery.slice(0, -1) : noQuery;
  }
}

async function recoverGroupPostHrefFromArticle(itemEl) {
  try {
    // Walk up to the closest feed card / article container
    const article = await itemEl.evaluateHandle((el) => {
      return el.closest('[role="article"]') || el.closest('div[role="feed"]') || el;
    });

    // Within the same card, look for canonical group post links
    const href = await article.evaluate((root) => {
      const anchors = Array.from(root.querySelectorAll('a[href]'));
      const candidates = anchors
        .map((a) => a.href)
        .filter(Boolean)
        .filter((h) => h.includes('/groups/') && (h.includes('/posts/') || h.includes('/permalink/')));

      // Prefer /posts/ first, then /permalink/
      const post = candidates.find((h) => h.includes('/posts/')) || candidates.find((h) => h.includes('/permalink/'));
      return post || null;
    });

    await article.dispose?.();
    return href || null;
  } catch {
    return null;
  }
}

/**
 * Process one group: goto, scroll, collect permalinks, enrich items, score, notify.
 * Returns { navFailed, error?, budgetExpired?, expiredStep? }. Execution outcome only; no terminal log semantics.
 */
async function processOneGroup(monitor, groupUrl, page, context, scoringConfig, stats, budget = null) {
  console.log(`SCAN[group] ${groupUrl ?? "(missing_url)"}`);
  if (budget && budget.isExpired()) {
    return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.GOTO };
  }
  const gotoResult = await gotoWithRetry(page, groupUrl, { timeoutMs: 120000, waitUntil: 'domcontentloaded', retries: 1, label: 'GROUP_GOTO', budget });
  if (!gotoResult.ok) {
    if (gotoResult.budgetExpired && gotoResult.expiredStep) {
      return { navFailed: true, error: gotoResult.error, budgetExpired: true, expiredStep: gotoResult.expiredStep };
    }
    return { navFailed: true, error: gotoResult.error || new Error('navigation failed') };
  }
  if (budget && budget.isExpired()) {
    return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.GOTO };
  }
  await humanWait(page, 900, 2400, budget);

  if (DEBUG) {
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
      console.log('LOGIN/CHECKPOINT DETECTED');
      return { navFailed: false };
    }
    const waitMs = budget ? clampTimeout(1500, budget) : 1500;
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    const selMs = budget ? clampTimeout(15000, budget) : 15000;
    if (selMs > 0) await page.waitForSelector('[role="feed"], [role="main"]', { timeout: selMs }).catch(() => {});
  }
  console.log('STEP[scroll_start]');
  const scrolls = randInt(3, 7);
  for (let i = 0; i < scrolls; i++) {
    if (budget && budget.isExpired()) {
      return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.SCROLL };
    }
    await page.mouse.wheel(0, randInt(1800, 4200));
    await humanWait(page, 700, 1600, budget);
  }
  if (budget && budget.isExpired()) {
    return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.SCROLL };
  }
  await humanWait(page, 900, 2000, budget);
  console.log('STEP[scroll_end]');
  if (budget && budget.isExpired()) {
    return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.SCROLL };
  }

  console.log('STEP[collect_start]');
  if (budget && budget.isExpired()) {
    return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.COLLECT };
  }
  let hrefsWithText, fallbackHrefs;
  try {
    const collectBudgetMs = budget ? Math.max(5000, budget.remainingMs()) : 60000;
    await Promise.race([
      (async () => {
        hrefsWithText = await page.$$eval(TARGETED_PERMLINK_SELECTOR, (links, maxLen) => {
    return links.map(a => {
      let text = '';
      try {
        const container = a.closest('[role="article"]') || a.closest('div[role="article"]') || a.closest('div');
        if (container) {
          let raw = '';
          const msgNodes = container.querySelectorAll('[data-ad-preview="message"]');
          if (msgNodes && msgNodes.length > 0) {
            const parts = [...msgNodes].map(n => (n.innerText || '').trim()).filter(t => t.length > 0);
            raw = [...new Set(parts)].join(' ');
          } else {
            const dirAuto = container.querySelectorAll('div[dir="auto"]');
            if (dirAuto && dirAuto.length > 0) {
              const parts = [...dirAuto].map(n => (n.innerText || '').trim()).filter(t => t.length >= 20);
              raw = parts.join(' ');
            }
          }
          if (!raw) raw = (container.innerText || '').trim();
          text = raw.replace(/\s+/g, ' ').trim().slice(0, maxLen);
        }
      } catch (_) {}
      return { href: a.getAttribute('href'), text };
    });
  }, MAX_TEXT_LENGTH);
        fallbackHrefs = await page.$$eval('a[href]', links => links.map(a => a.getAttribute('href')));
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('collect_timeout')), collectBudgetMs)),
    ]);
  } catch (err) {
    if (budget && budget.isExpired()) {
      return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.COLLECT };
    }
    throw err;
  }
  if (budget && budget.isExpired()) {
    return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.COLLECT };
  }
  const targetedHrefs = hrefsWithText.map(x => x.href);
  const combinedRaw = [...new Set([...targetedHrefs, ...fallbackHrefs.filter(h => hrefMatchesPermalink(h))])];
  const normalized = new Set();
  for (const href of combinedRaw) {
    if (!hrefMatchesPermalink(href)) continue;
    try {
      const absolute = new URL(href, baseUrl).toString();
      const withoutHash = absolute.split('#')[0];
      normalized.add(withoutHash);
    } catch (_) {}
  }
  const textMap = new Map();
  for (const { href, text } of hrefsWithText) {
    try {
      const key = new URL(href, baseUrl).toString().split('#')[0];
      if (!textMap.has(key) || (text && !textMap.get(key))) textMap.set(key, text || '');
    } catch (_) {}
  }
  console.log(`STEP[collect_end] items=${normalized.size}`);

  if (budget && budget.isExpired()) {
    return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.COLLECT };
  }
  console.log('STEP[recover_start]');
  if (budget && budget.isExpired()) {
    return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.RECOVER };
  }
  let photoLinks;
  try {
    const recoverQueryMs = budget ? Math.max(5000, budget.remainingMs()) : 30000;
    photoLinks = await Promise.race([
      page.$$('a[href*="facebook.com/photo/?fbid="]'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('recover_query_timeout')), recoverQueryMs)),
    ]);
  } catch (err) {
    if (budget && budget.isExpired()) {
      return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.RECOVER };
    }
    throw err;
  }
  const seenPhotoUrls = new Set();
  const recoveryMap = {};
  const recoverTimeoutMs = (el) => (budget ? Math.min(15000, Math.max(1000, budget.remainingMs())) : 15000);
  for (const el of photoLinks) {
    if (budget && budget.isExpired()) {
      await el.dispose().catch(() => {});
      break;
    }
    try {
      const timeoutMs = recoverTimeoutMs(el);
      await Promise.race([
        (async () => {
          const href = await el.evaluate((a) => a.href);
          const absolute = new URL(href, baseUrl).toString().split('#')[0];
          if (seenPhotoUrls.has(absolute)) {
            await el.dispose();
            return;
          }
          seenPhotoUrls.add(absolute);
          const recovered = await recoverGroupPostHrefFromArticle(el);
          await el.dispose();
          if (recovered && recovered !== absolute) {
            const cleanedRecovered = stripUrlQueryAndHash(recovered);
            recoveryMap[absolute] = cleanedRecovered;
            console.log(`[RECOVER] photo -> group_post ${absolute} => ${cleanedRecovered}`);
          }
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('recover_element_timeout')), timeoutMs)),
      ]);
    } catch (_) {
      await el.dispose().catch(() => {});
    }
  }
  console.log(`STEP[recover_end] items=${Object.keys(recoveryMap).length}`);
  if (budget && budget.isExpired()) {
    return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.RECOVER };
  }
  for (const [photoUrl, recovered] of Object.entries(recoveryMap)) {
    if (normalized.has(photoUrl)) {
      normalized.delete(photoUrl);
      normalized.add(recovered);
      if (textMap.has(photoUrl) && !textMap.has(recovered)) textMap.set(recovered, textMap.get(photoUrl));
    }
  }

  // Always normalize canonical post/group URLs to avoid duplicates (?comment_id, tracking)
  const toNormalize = [...normalized];
  for (const url of toNormalize) {
    if (url && url.includes("facebook.com/groups/")) {
      const cleaned = stripUrlQueryAndHash(url);
      if (cleaned !== url) {
        normalized.delete(url);
        normalized.add(cleaned);
        if (textMap.has(url) && !textMap.has(cleaned)) textMap.set(cleaned, textMap.get(url));
      }
    }
  }

  const permalinks = [...normalized];
  let structured = permalinks.map(sourceUrl => toStructuredItem(sourceUrl, groupUrl));
  for (const item of structured) {
    item.text = (textMap.get(item.source_url) || textMap.get(item.post_url) || '').trim();
  }
  const byPostUrl = new Map();
  const order = [];
  for (const item of structured) {
    const key = item.post_url;
    if (!byPostUrl.has(key)) {
      byPostUrl.set(key, item);
      order.push(key);
    } else if (item.type === 'group_post' && byPostUrl.get(key).type === 'photo') {
      byPostUrl.set(key, item);
    }
  }
  structured = order.map(k => byPostUrl.get(k));

  const byPostId = new Map();
  const orderIds = [];
  const noIdItems = [];
  for (const item of structured) {
    if (!item.post_id) {
      noIdItems.push(item);
      continue;
    }
    const pid = item.post_id;
    if (!byPostId.has(pid)) {
      byPostId.set(pid, item);
      orderIds.push(pid);
    } else if (item.type === 'group_post' && byPostId.get(pid).type === 'photo') {
      byPostId.set(pid, item);
    }
  }
  structured = [...orderIds.map(pid => byPostId.get(pid)), ...noIdItems];
  for (const item of structured) {
    item.monitor_id = monitor.id;
    item.monitor_name = monitor.name;
    item.monitor_template = monitor.template;
  }

  if (!DEBUG) {
    const nGroupPost = structured.filter(i => i.type === 'group_post').length;
    const nPhoto = structured.filter(i => i.type === 'photo').length;
    console.log(`Type breakdown: group_post=${nGroupPost}, photo=${nPhoto}`);
  }

  if (DEBUG) {
    console.log(`Found ${permalinks.length} post permalinks`);
    console.log(`Found ${structured.length} structured items (deduped)`);
    structured.slice(0, 10).forEach(obj => console.log(JSON.stringify(obj, null, 2)));
  } else {
    const seen = loadSeen();
    let newCount = 0;
    const isPhotoUrl = (u) => typeof u === 'string' && u.includes('facebook.com/photo/?fbid=');
    const isGroupPostUrl = (u) => typeof u === 'string' && /facebook\.com\/groups\/[^/]+\/posts\/\d+\/?/.test(u);
    for (const item of structured) {
      if (seen[item.post_url] != null) continue;
      const alreadySeenViaAlias = (item.aliases || []).some(alias => seen[alias] != null);
      if (alreadySeenViaAlias) continue;
      if (monitor.id === 'dorset_test' && stats.dorset_cycle_items_seen != null) stats.dorset_cycle_items_seen++;
      let shouldPrintNewBlock = true;
      if (item.type === 'group_post') {
        if (monitor.id === 'dorset_test') {
          const rawUrl = item.source_url || item.post_url;
          const enrichUrl = item.post_url;
          if (isPhotoUrl(rawUrl) && !isGroupPostUrl(enrichUrl)) {
            const timestamp = new Date().toISOString();
            seen[item.post_url] = timestamp;
            for (const alias of (item.aliases || [])) seen[alias] = timestamp;
            newCount++;
            if (stats.dorset_cycle_skipped_photo != null) stats.dorset_cycle_skipped_photo++;
            console.log(`DORSET_PHOTO_SKIP: skipping pure photo item (no permalink) url=${rawUrl}`);
            continue;
          }
        }
        if (budget && budget.isExpired()) {
          saveSeen(seen);
          const seenTotal = Object.keys(seen).length;
          console.log(`Found ${structured.length} items, NEW: ${newCount}, Seen total: ${seenTotal}`);
          return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.DETAIL_ENRICHMENT };
        }
        console.log(`STEP[detail_start] ${item.post_url}`);
        const postPage = await context.newPage();
        try {
          console.log('ENRICH: opening post page for', item.post_url);
          const t0 = Date.now();
          const text = await extractPostTextFromPostPage(context, postPage, item.post_url, { budget });
          item.text = text || '';
          if (budget && budget.isExpired()) {
            await postPage.close().catch(() => {});
            saveSeen(seen);
            const seenTotal = Object.keys(seen).length;
            console.log(`Found ${structured.length} items, NEW: ${newCount}, Seen total: ${seenTotal}`);
            return { navFailed: false, budgetExpired: true, expiredStep: SCAN_EXPIRED_STEP.DETAIL_ENRICHMENT };
          }
          stats.posts_enriched++;
          if (DEBUG) console.log(`ENRICH: finished ${item.post_url} in ${Date.now() - t0}ms len=${(item.text || '').length}`);
          const scored = scorePost(item.text, scoringConfig);
          const negativeHits = findNegativeHits(item.text, monitor);
          if (negativeHits.length > 0) stats.suppressed_negative++;
          applyNegativeRules(scored, negativeHits, monitor);
          if (scored.tier === 'HIGH') stats.scored_high++;
          if (scored.tier === 'MED') stats.scored_med++;
          item.lead_tier = scored.tier;
          item.lead_score = scored.score;
          item.lead_matches = {
            intent: scored.intent?.matched || scored.intent || [],
            service: scored.service?.matched || scored.service || [],
            location: scored.location?.matched || scored.location || [],
            negative: scored.negative?.matched || scored.negative || [],
          };
          console.log(`SCORE[${item.monitor_id}] tier=${scored.tier} score=${scored.score} url=${item.post_url}`);
          if (monitor.id === 'dorset_test') {
            if (stats.dorset_cycle_ignore != null) stats.dorset_cycle_ignore += (scored.tier === 'IGNORE' ? 1 : 0);
            if (stats.dorset_cycle_low != null) stats.dorset_cycle_low += (scored.tier === 'LOW' ? 1 : 0);
            if (stats.dorset_cycle_med != null) stats.dorset_cycle_med += (scored.tier === 'MED' ? 1 : 0);
            if (stats.dorset_cycle_high != null) stats.dorset_cycle_high += (scored.tier === 'HIGH' ? 1 : 0);
          }
          const isDorsetTest = monitor.id === 'dorset_test';
          const tierSendsTelegram = isDorsetTest
            ? (scored.tier === 'HIGH' || scored.tier === 'MED' || scored.tier === 'LOW')
            : (scored.tier === 'HIGH' || scored.tier === 'MED');
          shouldPrintNewBlock = tierSendsTelegram || (scored.tier === 'HIGH' || scored.tier === 'MED');
          if (tierSendsTelegram) {
            console.log(`LEAD[${item.monitor_id}][${scored.tier}] score=${scored.score} url=${item.post_url}`);
            console.log(`matches intent=${JSON.stringify(item.lead_matches.intent)} service=${JSON.stringify(item.lead_matches.service)} location=${JSON.stringify(item.lead_matches.location)} negative=${JSON.stringify(item.lead_matches.negative)}`);
            if (monitor.notify?.telegram?.enabled && monitor.notify.telegram.chat_id != null) {
              const shareUrl = cleanFacebookUrlForShare(item.post_url || item.source_url || '') || item.post_url || item.source_url || '';
              const messageText = isDorsetTest
                ? formatDorsetTelegramMessage({ item, monitor, scored, shareUrl })
                : formatTelegramLeadMessage({ item, monitor, scored, shareUrl, isOffline: false });
              const notifyTimeoutMs = budget ? Math.min(10000, Math.max(0, budget.remainingMs())) : 10000;
              if (notifyTimeoutMs <= 0) {
                console.log('STEP[notify_timeout]');
              } else {
                try {
                  await Promise.race([
                    sendTelegramLead(monitor.notify.telegram.chat_id, messageText),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('notify_timeout')), notifyTimeoutMs)),
                  ]);
                  stats.notified_telegram++;
                  if (monitor.id === 'dorset_test' && stats.dorset_cycle_telegram != null) stats.dorset_cycle_telegram++;
                  console.log(`NOTIFY[telegram] ok monitor=${monitor.id} tier=${scored.tier} url=${item.post_url}`);
                } catch (err) {
                  if (err && err.message === 'notify_timeout') {
                    console.log('STEP[notify_timeout]');
                  } else {
                    console.log('STEP[notify_error]');
                    console.warn(`NOTIFY[telegram] fail monitor=${monitor.id} err=${(err && err.message) || err} url=${item.post_url}`);
                  }
                }
              }
            }
            const lead = {
              ts: new Date().toISOString(),
              monitor_id: item.monitor_id || null,
              monitor_name: item.monitor_name || null,
              monitor_template: item.monitor_template || null,
              tier: scored.tier,
              score: scored.score,
              matches: item.lead_matches || { intent: [], service: [], location: [], negative: [] },
              group_url: item.group_url || null,
              post_url: item.post_url,
              post_id: item.post_id || null,
              excerpt: (item.text || '').replace(/\s+/g, ' ').trim().slice(0, 300),
              text: (item.text || '').slice(0, 2000),
            };
            appendLead(lead);
            console.log(`LEAD-SAVED ok tier=${scored.tier} score=${scored.score} url=${item.post_url}`);
          } else if (DEBUG) {
            console.log(`SKIP[${item.monitor_id}][${scored.tier}] score=${scored.score} url=${item.post_url}`);
          }
        } finally {
          console.log(`STEP[detail_end] ${item.post_url}`);
          await postPage.close().catch(() => {});
        }
      } else {
        item.text = '';
      }
      if (shouldPrintNewBlock) {
        console.log('[NEW]', item.post_url);
        if (item.post_id) console.log('post_id:', item.post_id);
        console.log('type:', item.type);
        if (item.type === 'group_post') {
          if (item.text && item.text.length > 0) {
            console.log('text excerpt:', item.text.slice(0, NEW_EXCERPT_LENGTH));
          } else {
            console.log('text: (none)');
            console.warn('WARN: group_post text empty after enrichment');
          }
        }
      }
      const timestamp = new Date().toISOString();
      seen[item.post_url] = timestamp;
      for (const alias of (item.aliases || [])) {
        seen[alias] = timestamp;
      }
      newCount++;
    }
    saveSeen(seen);
    const seenTotal = Object.keys(seen).length;
    console.log(`Found ${structured.length} items, NEW: ${newCount}, Seen total: ${seenTotal}`);
  }
  console.log('STEP[scan_done]');
  return { navFailed: false };
}

/**
 * Single scan wrapper: creates budget, runs processOneGroup, maps execution outcome to exactly one terminal state.
 * Does NOT emit SCAN logs; caller must log SCAN[start] and exactly one of SCAN[end] | SCAN[timeout] | SCAN[error].
 */
async function runOneGroupScan(monitor, groupUrl, page, context, scoringConfig, stats) {
  const budget = createScanBudget(SCAN_TIMEOUT_MS);
  const scanStartMs = Date.now();
  let result;
  try {
    result = await processOneGroup(monitor, groupUrl, page, context, scoringConfig, stats, budget);
  } catch (err) {
    const duration_ms = Date.now() - scanStartMs;
    return { terminalState: 'error', error: err, duration_ms };
  }
  const duration_ms = Date.now() - scanStartMs;
  if (result.budgetExpired) {
    return { terminalState: 'timeout', expiredStep: result.expiredStep, duration_ms };
  }
  return { terminalState: 'end', result, duration_ms };
}

/**
 * One bounded sweep: one full pass over the assigned group list. Logs SWEEP[start] and exactly one of SWEEP[end] | SWEEP[aborted].
 * The outer daemon/scheduler loop must NOT be the sweep boundary; it calls runSweep repeatedly.
 * schedulerStateByMonitor: optional object keyed by monitor.id to persist groupState between sweeps (for scheduler mode).
 */
async function runSweep(context, page, monitors, schedulerStateByMonitor = null) {
  let sweepOutcome = 'end';
  const sweepStartMs = Date.now();
  const sweepGroupCount = monitors.reduce(
    (sum, m) => sum + (regionGroupUrls !== null ? regionGroupUrls.length : (m.groups || []).length),
    0
  );
  try {
    console.log(`SWEEP[start] groups=${sweepGroupCount}`);
    for (const monitor of monitors) {
      const stats = { posts_scanned: 0, posts_enriched: 0, scored_high: 0, scored_med: 0, notified_telegram: 0, suppressed_negative: 0, suppressed_rate_limit: 0, group_nav_failures: 0 };
      if (monitor.id === 'dorset_test') {
        stats.dorset_cycle_items_seen = 0;
        stats.dorset_cycle_skipped_photo = 0;
        stats.dorset_cycle_ignore = 0;
        stats.dorset_cycle_low = 0;
        stats.dorset_cycle_med = 0;
        stats.dorset_cycle_high = 0;
        stats.dorset_cycle_telegram = 0;
        stats.dorset_last_log_at = Date.now();
      }
      let scoringConfig = buildMonitorConfig(monitor);
      if (monitor.id === 'dorset_test') {
        scoringConfig = { ...scoringConfig, threshold_low: Math.floor(scoringConfig.threshold_low * 0.8) };
      }
      const groupsToUse = regionGroupUrls !== null ? regionGroupUrls : (monitor.groups || []);

      const useScheduler = regionGroupUrls !== null && regionSchedulingDefaults != null;
      let groupState = null;
      if (useScheduler) {
        const key = monitor.id;
        if (schedulerStateByMonitor && schedulerStateByMonitor[key]) {
          groupState = schedulerStateByMonitor[key];
        } else {
          groupState = {};
          for (const u of groupsToUse) {
            const url = normalizeGroupUrl(u);
            groupState[url] = {
              url,
              consecutive_failures: 0,
              next_run_at: Date.now(),
              last_success_at: null,
              last_error: null,
            };
          }
          if (schedulerStateByMonitor) schedulerStateByMonitor[key] = groupState;
        }
      }

      if (useScheduler) {
        const cfg = regionSchedulingDefaults;
        const scanIntervalMs = (cfg.scan_interval_seconds || 180) * 1000;
        const perGroupBackoff = cfg.per_group_backoff_seconds || 600;
        const cooldownSec = cfg.cooldown_seconds || 3600;
        const maxFailures = cfg.max_consecutive_failures_before_cooldown != null ? cfg.max_consecutive_failures_before_cooldown : 3;
        const now = Date.now();
        const sorted = [...groupsToUse].sort((a, b) => groupState[normalizeGroupUrl(a)].next_run_at - groupState[normalizeGroupUrl(b)].next_run_at);
        for (const groupUrl of sorted) {
          const state = groupState[normalizeGroupUrl(groupUrl)];
          if (state.next_run_at > now) continue;
          console.log(`SCHED: running ${groupUrl} failures=${state.consecutive_failures}`);
          console.log('\n==============================');
          console.log('Checking group:', groupUrl);
          console.log('==============================\n');
          console.log(`SCAN[start] ${groupUrl}`);
          const out = await runOneGroupScan(monitor, groupUrl, page, context, scoringConfig, stats);
          if (out.terminalState === 'timeout') {
            console.log(`SCAN[timeout] ${groupUrl} duration_ms=${out.duration_ms}${out.expiredStep ? ` step=${out.expiredStep}` : ''}`);
          } else if (out.terminalState === 'error') {
            console.log(`SCAN[error] ${groupUrl} duration_ms=${out.duration_ms} err=${(out.error && out.error.message) || String(out.error)}`);
          } else {
            console.log(`SCAN[end] ${groupUrl} duration_ms=${out.duration_ms}`);
            if (out.duration_ms > SCAN_SLOW_MS) console.log(`SCAN[slow] ${groupUrl} duration_ms=${out.duration_ms}`);
            const result = out.result;
            if (result.navFailed) {
              try {
                const evidencePath = await writeEvidence({
                  region: regionName || 'default',
                  monitor_id: monitor.id,
                  town: null,
                  group_name: null,
                  group_url: groupUrl,
                  error: result.error,
                  page,
                });
                if (evidencePath) console.log(`EVIDENCE: saved ${evidencePath}`);
                else console.log('EVIDENCE: capture failed (non-fatal)');
              } catch (_) {
                console.log('EVIDENCE: capture failed (non-fatal)');
              }
              state.consecutive_failures++;
              state.last_error = (result.error && result.error.message) ? result.error.message : (result.error != null ? String(result.error) : 'navigation failed');
              let delaySec = perGroupBackoff * Math.pow(2, state.consecutive_failures - 1);
              if (delaySec > cooldownSec) delaySec = cooldownSec;
              if (state.consecutive_failures >= maxFailures) delaySec = cooldownSec;
              state.next_run_at = now + delaySec * 1000;
              console.log(`SCHED: backoff ${groupUrl} failures=${state.consecutive_failures} next_in=${delaySec}s err=${state.last_error}`);
              stats.group_nav_failures++;
            } else {
              state.consecutive_failures = 0;
              state.last_success_at = now;
              state.last_error = null;
              state.next_run_at = now + scanIntervalMs;
            }
          }
          if (monitor.id === 'dorset_test' && stats.dorset_last_log_at != null && (Date.now() - stats.dorset_last_log_at >= 600000)) {
            console.log(`DORSET_SUMMARY: items_seen=${stats.dorset_cycle_items_seen || 0} skipped_photo=${stats.dorset_cycle_skipped_photo || 0} IGNORE=${stats.dorset_cycle_ignore || 0} LOW=${stats.dorset_cycle_low || 0} MED=${stats.dorset_cycle_med || 0} HIGH=${stats.dorset_cycle_high || 0} telegram_sent=${stats.dorset_cycle_telegram || 0}`);
            stats.dorset_cycle_items_seen = 0;
            stats.dorset_cycle_skipped_photo = 0;
            stats.dorset_cycle_ignore = 0;
            stats.dorset_cycle_low = 0;
            stats.dorset_cycle_med = 0;
            stats.dorset_cycle_high = 0;
            stats.dorset_cycle_telegram = 0;
            stats.dorset_last_log_at = Date.now();
          }
        }
      } else {
        for (const groupUrl of groupsToUse) {
          console.log('\n==============================');
          console.log('Checking group:', groupUrl);
          console.log('==============================\n');
          console.log(`SCAN[start] ${groupUrl}`);
          const out = await runOneGroupScan(monitor, groupUrl, page, context, scoringConfig, stats);
          if (out.terminalState === 'timeout') {
            console.log(`SCAN[timeout] ${groupUrl} duration_ms=${out.duration_ms}${out.expiredStep ? ` step=${out.expiredStep}` : ''}`);
          } else if (out.terminalState === 'error') {
            console.log(`SCAN[error] ${groupUrl} duration_ms=${out.duration_ms} err=${(out.error && out.error.message) || String(out.error)}`);
          } else {
            console.log(`SCAN[end] ${groupUrl} duration_ms=${out.duration_ms}`);
            if (out.duration_ms > SCAN_SLOW_MS) console.log(`SCAN[slow] ${groupUrl} duration_ms=${out.duration_ms}`);
            const result = out.result;
            if (result.navFailed) {
              try {
                const evidencePath = await writeEvidence({
                  region: regionName || 'default',
                  monitor_id: monitor.id,
                  town: null,
                  group_name: null,
                  group_url: groupUrl,
                  error: result.error,
                  page,
                });
                if (evidencePath) console.log(`EVIDENCE: saved ${evidencePath}`);
                else console.log('EVIDENCE: capture failed (non-fatal)');
              } catch (_) {
                console.log('EVIDENCE: capture failed (non-fatal)');
              }
              stats.group_nav_failures++;
              console.log(`GROUP_GOTO_FAIL monitor_id=${monitor.id} group=${groupUrl}`);
            }
          }
          if (monitor.id === 'dorset_test' && stats.dorset_last_log_at != null && (Date.now() - stats.dorset_last_log_at >= 600000)) {
            console.log(`DORSET_SUMMARY: items_seen=${stats.dorset_cycle_items_seen || 0} skipped_photo=${stats.dorset_cycle_skipped_photo || 0} IGNORE=${stats.dorset_cycle_ignore || 0} LOW=${stats.dorset_cycle_low || 0} MED=${stats.dorset_cycle_med || 0} HIGH=${stats.dorset_cycle_high || 0} telegram_sent=${stats.dorset_cycle_telegram || 0}`);
            stats.dorset_cycle_items_seen = 0;
            stats.dorset_cycle_skipped_photo = 0;
            stats.dorset_cycle_ignore = 0;
            stats.dorset_cycle_low = 0;
            stats.dorset_cycle_med = 0;
            stats.dorset_cycle_high = 0;
            stats.dorset_cycle_telegram = 0;
            stats.dorset_last_log_at = Date.now();
          }
        }
      }
      console.log(`STATS[${monitor.id}] scanned=${stats.posts_scanned} enriched=${stats.posts_enriched} high=${stats.scored_high} med=${stats.scored_med} telegram=${stats.notified_telegram} neg_suppressed=${stats.suppressed_negative} rate_suppressed=${stats.suppressed_rate_limit} group_nav_fail=${stats.group_nav_failures}`);
    }
  } catch (err) {
    sweepOutcome = 'aborted';
    throw err;
  } finally {
    const sweepDurationMs = Date.now() - sweepStartMs;
    if (sweepOutcome === 'end') {
      console.log(`SWEEP[end] groups=${sweepGroupCount} duration_ms=${sweepDurationMs}`);
    } else {
      console.log(`SWEEP[aborted] groups=${sweepGroupCount} duration_ms=${sweepDurationMs}`);
    }
    await page.close();
  }
}

async function runOnce(context) {
  let monitors = loadMonitors();
  ensureDorsetTestMonitor(monitors);
  if (onlyMonitorId === 'dorset_test' && regionGroupUrls === null) {
    console.error('dorset_test requires --region=dorset');
    process.exit(1);
  }
  if (onlyMonitorId) {
    const filtered = monitors.filter((m) => m.id === onlyMonitorId);
    if (filtered.length === 0) {
      console.error(`No monitor with id "${onlyMonitorId}" found. Available: ${monitors.map((m) => m.id).join(', ') || 'none'}.`);
      process.exit(1);
    }
    monitors = filtered;
  }
  if (monitors.length === 1 && monitors[0].id === 'dorset_test') {
    console.log('Monitor selected: dorset_test');
    console.log('DORSET_TUNING: LOW cutoff relaxed by 20%');
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const page = await context.newPage();
  await runSweep(context, page, monitors, schedulerStateByMonitor);
}

(async () => {
  if (emitLeads && !scoreFilePath) {
    console.error('--emit-leads requires --score-file');
    process.exit(1);
  }
  if (scoreFilePath) {
    if (emitLeads) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    let firstTelegramMonitor = null;
    if (emitLeads) {
      const monitors = loadMonitors();
      firstTelegramMonitor = monitors.find((m) => m.notify?.telegram?.enabled && m.notify.telegram.chat_id != null) || null;
    }
    const content = fs.readFileSync(scoreFilePath, 'utf8');
    const posts = content.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    for (const post of posts) {
      const result = scorePost(post, gutterMonitor);
      const parts = [`tier=${result.tier}`, `score=${result.score}`];
      if (result.intent.length) parts.push(`intent=[${result.intent.join(', ')}]`);
      if (result.service.length) parts.push(`service=[${result.service.join(', ')}]`);
      if (result.location.length) parts.push(`location=[${result.location.join(', ')}]`);
      if (result.negative.length) parts.push(`negative=[${result.negative.join(', ')}]`);
      console.log(parts.join(' '));
      console.log(result.excerpt);
      console.log('');
      if (emitLeads && (result.tier === 'HIGH' || result.tier === 'MED')) {
        const excerpt = (post || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        const lead = {
          ts: new Date().toISOString(),
          monitor_id: 'offline_test',
          monitor_name: 'Offline Test',
          monitor_template: 'gutter_cleaning',
          tier: result.tier,
          score: result.score,
          matches: { intent: result.intent || [], service: result.service || [], location: result.location || [], negative: result.negative || [] },
          group_url: null,
          post_url: null,
          post_id: null,
          excerpt,
          text: (post || '').slice(0, 2000),
        };
        appendLead(lead);
        console.log(`OFFLINE-LEAD-SAVED ok tier=${result.tier} score=${result.score}`);
        if (firstTelegramMonitor && process.env.TELEGRAM_BOT_TOKEN) {
          console.log('OFFLINE PREVIEW: sending premium Telegram layout');
          const fakeShareUrl = 'https://www.facebook.com/groups/1536046086634463/posts/TEST1234567890/';
          const scored = result;
          const offlineItem = {
            offline_preview: true,
            monitor_id: 'offline_test',
            monitor_name: 'Offline Test',
            monitor_template: 'gutter_cleaning',
            group_url: null,
            post_url: fakeShareUrl,
            post_id: null,
            ts: new Date().toISOString(),
            tier: result.tier,
            score: result.score,
            text: post,
            excerpt: (post || '').replace(/\s+/g, ' ').trim().slice(0, 280),
            matches: {
              intent: result.intent?.matched || result.intent || [],
              service: result.service?.matched || result.service || [],
              location: result.location?.matched || result.location || [],
              negative: result.negative?.matched || result.negative || [],
            },
          };
          offlineItem.lead_matches = offlineItem.matches;
          const draftReplies = buildDraftReplies(offlineItem, scored);
          offlineItem.reply_soft = draftReplies.soft;
          offlineItem.reply_direct = draftReplies.hard;
          const offlineMonitor = { name: 'Offline Test', id: 'offline_test' };
          const messageText = formatTelegramLeadMessage({ item: offlineItem, monitor: offlineMonitor, scored, shareUrl: fakeShareUrl, isOffline: true });
          const chatId = firstTelegramMonitor.notify.telegram.chat_id;
          try {
            await sendTelegramLead(chatId, messageText);
            console.log(`OFFLINE-NOTIFY ok tier=${result.tier}`);
          } catch (err) {
            console.warn('OFFLINE-NOTIFY fail', err.message);
          }
        }
      }
    }
    process.exit(0);
  }

  if (notifyTest) {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.error('Missing TELEGRAM_BOT_TOKEN env var');
      process.exit(1);
    }
    const os = require('os');
    const monitors = loadMonitors();
    for (const monitor of monitors) {
      if (monitor.notify?.telegram?.enabled && monitor.notify.telegram.chat_id != null) {
        const chatId = monitor.notify.telegram.chat_id;
        const messageText = `🧪 NOTIFY TEST — ${monitor.name}\nVM: ${os.hostname()}\nTime: ${new Date().toISOString()}`;
        try {
          await sendTelegramLead(chatId, messageText);
          console.log(`NOTIFY-TEST ok monitor=${monitor.id} chat_id=${chatId}`);
        } catch (err) {
          console.error(`NOTIFY-TEST fail monitor=${monitor.id} err=${err.message}`);
          process.exit(1);
        }
      } else {
        console.log(`NOTIFY-TEST skip monitor=${monitor.id} (telegram not enabled)`);
      }
    }
    process.exit(0);
  }

  const { chromium } = require('playwright');
  const context = await chromium.launchPersistentContext('./profile', {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  if (testPostUrl) {
    const page = await context.newPage();
    const resp = await page.goto(testPostUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (resp) {
      console.log('resp.status():', resp.status());
      console.log('resp.url():', resp.url());
    }
    console.log('page.url() after navigation:', page.url());
    await page.waitForTimeout(8000);
    await page.waitForFunction(() => document.body && document.body.innerText && document.body.innerText.length > 0, { timeout: 15000 }).catch(() => {});
    const htmlContent = await page.content();
    const htmlLength = htmlContent.length;
    const docTitle = await page.title();
    console.log('HTML length:', htmlLength);
    console.log('document.title:', docTitle ?? '(none)');

    let extractedText = '';
    try {
      const client = await context.newCDPSession(page);
      await client.send('Accessibility.enable').catch(() => {});
      const ax = await client.send('Accessibility.getFullAXTree');
      const nodes = ax?.nodes || ax;
      console.log('ax method: cdp');
      console.log('ax nodes:', Array.isArray(nodes) ? nodes.length : 0);
      const cdpBoilerplateRe = /Facebook|Notifications|Messenger|Menu|Close|Like|Comment|Share|Write a comment|All reactions|Most relevant|Reply|Send message|Settings/i;
      const cands = [];
      for (const n of Array.isArray(nodes) ? nodes : []) {
        const v = n?.name?.value;
        if (v && typeof v === 'string') cands.push(v);
        const d = n?.description?.value;
        if (d && typeof d === 'string') cands.push(d);
      }
      const cleaned = cands.map((c) => (c || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length >= 40).filter((t) => !cdpBoilerplateRe.test(t));
      const axBest = cleaned.length > 0 ? cleaned.reduce((a, b) => (a.length >= b.length ? a : b), '') : '';
      console.log('ax best length:', axBest ? axBest.length : 0);
      console.log('ax best preview:', axBest ? axBest.slice(0, 200) : '(none)');
      extractedText = axBest || '';
    } catch (e) {
      console.log('ax error:', e && e.message != null ? e.message : e);
      extractedText = '';
    }

    console.log('Extracted text length:', (extractedText || '').length);
    console.log('Extracted text preview:', (extractedText && extractedText.length > 0) ? extractedText.slice(0, 500) : '(none)');
    const extractedLen = (extractedText || '').length;

    const text = await extractPostTextFromPostPage(context, page, testPostUrl, { skipGotoAndInitialWait: true });
    console.log('Test URL:', testPostUrl);
    console.log('Final URL:', page.url());
    console.log('Extracted text length:', (text || '').length);
    console.log('Extracted text preview:', (text && text.length > 0) ? text.slice(0, 500) : '(none)');
    if (extractedLen === 0 || htmlLength < 2000) {
      await page.screenshot({ path: './test_post.png', fullPage: true });
      fs.writeFileSync('./test_post.html', htmlContent, 'utf8');
      console.log('Saved screenshot: ./test_post.png');
      console.log('Saved html: ./test_post.html');
    }
    await page.close();
    await context.close();
    process.exit(0);
  }

  if (DAEMON) {
    console.log(`Daemon mode enabled. Interval: ${intervalMinutes} minutes`);
    let cycleCount = 0;
    let nextLongIdleAt = randInt(10, 20);
    while (true) {
      try {
        await runOnce(context);
      } catch (err) {
        console.error('Cycle error:', err);
      }
      cycleCount++;
      if (cycleCount >= nextLongIdleAt) {
        const idleMinutes = randInt(20, 40);
        console.log(`Long idle for ${idleMinutes} minutes...`);
        await new Promise((r) => setTimeout(r, idleMinutes * 60 * 1000));
        cycleCount = 0;
        nextLongIdleAt = randInt(10, 20);
      } else {
        const jitter = (Math.random() * 2 - 1) * (intervalMinutes * 0.3);
        let sleepMinutes = intervalMinutes + jitter;
        if (sleepMinutes < 1) sleepMinutes = 1;
        console.log(`Sleeping for ${sleepMinutes.toFixed(1)} minutes...`);
        await new Promise((r) => setTimeout(r, sleepMinutes * 60 * 1000));
      }
    }
  } else {
    await runOnce(context);
    await context.close();
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
