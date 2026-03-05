// scripts/generate_group_map.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function normalizeGroupUrl(url) {
  if (!url || typeof url !== "string") return null;
  const u = url.trim();
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

function stableId(prefix, url) {
  const h = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
  return `${prefix}_${h}`;
}

function main() {
  const regionPath = process.argv[2] || path.join(process.cwd(), "regions", "dorset.json");
  const outPath = process.argv[3] || path.join(process.cwd(), "data", "group_url_to_id.json");
  const prefix = process.argv[4] || "dorset";

  if (!fs.existsSync(regionPath)) {
    console.error(`Region file not found: ${regionPath}`);
    process.exit(1);
  }

  const region = JSON.parse(fs.readFileSync(regionPath, "utf8"));

  // Try a few likely shapes without assuming exact schema.
  // We collect any strings that look like facebook group URLs.
  const urls = new Set();

  function collect(node) {
    if (!node) return;
    if (typeof node === "string") {
      const s = node;
      if (s.includes("facebook.com/groups/")) {
        const n = normalizeGroupUrl(s);
        if (n) urls.add(n);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const x of node) collect(x);
      return;
    }
    if (typeof node === "object") {
      for (const v of Object.values(node)) collect(v);
    }
  }

  collect(region);

  const mapping = {};
  for (const url of Array.from(urls).sort()) {
    mapping[url] = stableId(prefix, url);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(mapping, null, 2));

  console.log(`Wrote ${Object.keys(mapping).length} mappings to ${outPath}`);
}

main();
