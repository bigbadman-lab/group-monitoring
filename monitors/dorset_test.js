#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'regions', 'dorset.json');

let raw;
try {
  raw = fs.readFileSync(CONFIG_PATH, 'utf8');
} catch (e) {
  if (e.code === 'ENOENT') {
    console.error('Error: regions/dorset.json not found');
  } else {
    console.error('Error: failed to read regions/dorset.json:', e.message);
  }
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(raw);
} catch (e) {
  console.error('Error: regions/dorset.json is not valid JSON:', e.message);
  process.exit(1);
}

if (!cfg || typeof cfg.region === 'undefined') {
  console.error('Error: config must have "region"');
  process.exit(1);
}

if (!cfg.towns) {
  console.error('Error: config must have "towns"');
  process.exit(1);
}

let enabledGroups = [];

if (Array.isArray(cfg.towns)) {
  for (const t of cfg.towns) {
    if (!t || typeof t !== 'object' || !('town' in t) || !Array.isArray(t.groups)) {
      console.error('Error: each town must have "town" and "groups" array');
      process.exit(1);
    }
    const town = t.town;
    for (const g of t.groups) {
      if (g && g.enabled === true) {
        enabledGroups.push({ town, name: g.name || '', url: g.url || '' });
      }
    }
  }
} else if (typeof cfg.towns === 'object' && cfg.towns !== null) {
  for (const [town, groups] of Object.entries(cfg.towns)) {
    if (!Array.isArray(groups)) {
      console.error('Error: each town must have a "groups" array');
      process.exit(1);
    }
    for (const g of groups) {
      if (g && g.enabled === true) {
        enabledGroups.push({ town, name: g.name || '', url: g.url || '' });
      }
    }
  }
} else {
  console.error('Error: "towns" must be an array or object');
  process.exit(1);
}

console.log('Dorset test: ' + enabledGroups.length + ' groups enabled');
for (const { town, name, url } of enabledGroups) {
  console.log(town + ' | ' + name + ' | ' + url);
}
process.exit(0);
