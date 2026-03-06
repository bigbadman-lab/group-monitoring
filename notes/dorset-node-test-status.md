# Dorset node test status (workspace-1)

**Date:** 2026-03-06  
**Node:** workspace-1  
**Facebook profile:** Kat  
**Assignment source:** `runtime/node_assignments/workspace-1.json`  
**Crawler mode:** `--node-assignment=workspace-1`  
**Monitor:** dorset_test  

---

## Current validated status

- Crawler service starts successfully
- Node assignment loads successfully
- SCAN[group] logs are appearing
- Recent unique group coverage was observed
- `data/leads.jsonl` is updating
- `group-monitor-ingest.service` was inactive initially
- `group-monitor-enrich.service` was inactive initially
- Enrich service is now processing posts successfully
- `group-monitor-hourly-report.timer` is disabled
- `group-monitor-hourly-report.service` is failed/inactive
- Telegram hourly reporting is intentionally left off for this controlled test

---

## Known observation

- Priorities in workspace-1 assignment are all 999999 right now

---

## Recommended next validations

- Measure full sweep duration across all 20 groups
- Verify ingest path clearly
- Decide whether to redesign Telegram for per-lead alerts or capped summaries
- Clean up monitor naming so "Dorset Test (Region)" reflects node mode better
