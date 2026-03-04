'use strict';

const fs = require('fs');
const path = require('path');

const EVIDENCE_BASE = 'evidence';
const MAX_RETENTION = 5;

function sanitizeSegment(str) {
  if (str == null || typeof str !== 'string') return 'unknown';
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'unknown';
}

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (_) {}
}

function enforceRetention(groupBaseDir, max = MAX_RETENTION) {
  try {
    if (!groupBaseDir || !fs.existsSync(groupBaseDir)) return;
    const entries = fs.readdirSync(groupBaseDir, { withFileTypes: true });
    const dirs = entries.filter((d) => d.isDirectory()).map((d) => path.join(groupBaseDir, d.name));
    if (dirs.length <= max) return;
    const withMtime = dirs.map((d) => ({ path: d, mtime: fs.statSync(d).mtimeMs }));
    withMtime.sort((a, b) => b.mtime - a.mtime);
    for (let i = max; i < withMtime.length; i++) {
      try {
        fs.rmSync(withMtime[i].path, { recursive: true });
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * Write evidence for a group navigation failure. Never throws.
 * @param {{ region?: string, monitor_id?: string, town?: string, group_name?: string, group_url?: string, error?: Error|string, page?: { screenshot?(opts: any): Promise<Buffer>, content?(): Promise<string> } }}
 * @returns {Promise<string|null>} Full evidence folder path or null
 */
async function writeEvidence({ region, monitor_id, town, group_name, group_url, error, page }) {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
    const rand6 = Math.random().toString(36).slice(2, 8);
    const regionDir = sanitizeSegment(region != null ? String(region) : 'default');
    const groupSlug = group_name
      ? sanitizeSegment(group_name)
      : sanitizeSegment(group_url && String(group_url).replace(/\/$/, '').split('/').pop());
    const groupBaseDir = path.join(process.cwd(), EVIDENCE_BASE, regionDir, dateStr, groupSlug);
    const runDir = path.join(groupBaseDir, `${timeStr}-${rand6}`);

    ensureDir(runDir);

    const errorMessage = error != null ? (typeof error === 'string' ? error : (error.message || String(error))) : null;
    const errorStack = error && typeof error === 'object' && error.stack ? error.stack : null;
    const errorPayload = {
      timestamp_iso: now.toISOString(),
      region: region != null ? String(region) : 'default',
      monitor_id: monitor_id != null ? String(monitor_id) : null,
      town: town != null ? String(town) : null,
      group_name: group_name != null ? String(group_name) : null,
      group_url: group_url != null ? String(group_url) : null,
      error_message: errorMessage,
      error_stack: errorStack,
    };

    fs.writeFileSync(path.join(runDir, 'error.json'), JSON.stringify(errorPayload, null, 2), 'utf8');

    if (page && typeof page.screenshot === 'function') {
      try {
        await page.screenshot({ path: path.join(runDir, 'screenshot.png'), fullPage: true });
      } catch (_) {}
    }
    if (page && typeof page.content === 'function') {
      try {
        const html = await page.content();
        fs.writeFileSync(path.join(runDir, 'page.html'), html, 'utf8');
      } catch (_) {}
    }

    enforceRetention(groupBaseDir, MAX_RETENTION);
    return runDir;
  } catch (_) {
    return null;
  }
}

module.exports = { writeEvidence };
