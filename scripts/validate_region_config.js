#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/validate_region_config.js <path-to-region.json>');
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`Error: file does not exist: ${filePath}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
} catch (e) {
  console.error(`Error: invalid JSON: ${e.message}`);
  process.exit(1);
}

const towns = data.towns;
if (!towns || typeof towns !== 'object') {
  console.error('Error: missing or invalid "towns"');
  process.exit(1);
}

const townNames = Array.isArray(towns) ? towns.map((t) => (t && t.name) || t) : Object.keys(towns);
if (townNames.length !== 5) {
  console.error(`Error: towns length must be 5, got ${townNames.length}`);
  process.exit(1);
}

const FB_GROUPS_RE = /^https:\/\/www\.facebook\.com\/groups\/[^/]+\/?$/;
let totalEnabled = 0;

for (const townName of townNames) {
  const groups = Array.isArray(towns) ? towns.find((t) => (t && t.name) === townName)?.groups : towns[townName];
  if (!Array.isArray(groups) || groups.length !== 5) {
    console.error(`Error: town "${townName}" must have exactly 5 groups, got ${groups ? groups.length : 0}`);
    process.exit(1);
  }

  let enabledCount = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g || typeof g !== 'object') {
      console.error(`Error: town "${townName}" group ${i + 1} is not an object`);
      process.exit(1);
    }
    if (typeof g.name !== 'string' || g.name.trim() === '') {
      console.error(`Error: town "${townName}" group ${i + 1} missing or empty "name"`);
      process.exit(1);
    }
    if (typeof g.url !== 'string') {
      console.error(`Error: town "${townName}" group ${i + 1} missing or invalid "url"`);
      process.exit(1);
    }
    if (typeof g.enabled !== 'boolean') {
      console.error(`Error: town "${townName}" group ${i + 1} missing or invalid "enabled"`);
      process.exit(1);
    }
    const urlNorm = g.url.trim().replace(/\/?$/, '/');
    if (!FB_GROUPS_RE.test(urlNorm)) {
      console.error(`Error: town "${townName}" group ${i + 1} url must match https://www.facebook.com/groups/<id_or_slug>/`);
      process.exit(1);
    }
    if (g.enabled) {
      if (g.url.includes('TODO_MISSING_URL') || g.url.includes('TODO')) {
        console.error(`Error: town "${townName}" group ${i + 1} enabled=true but url contains TODO`);
        process.exit(1);
      }
      enabledCount++;
    }
  }

  if (enabledCount < 3 || enabledCount > 5) {
    console.error(`Error: town "${townName}" enabled count must be between 3 and 5 (inclusive), got ${enabledCount}`);
    process.exit(1);
  }

  totalEnabled += enabledCount;
  console.log(`${townName}: enabled=${enabledCount}`);
}

if (totalEnabled < 1) {
  console.error('Error: total enabled groups in region must be >= 1');
  process.exit(1);
}

console.log('OK');
console.log(`total_enabled=${totalEnabled}`);
