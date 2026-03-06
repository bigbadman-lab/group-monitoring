#!/usr/bin/env python3
import csv
import json
import sys
from pathlib import Path
from datetime import datetime


REGISTRY_PATH = Path("data/facebook_groups_registry.csv")
OUTPUT_DIR = Path("runtime/node_assignments")

REQUIRED_COLUMNS = [
    "group_url",
    "group_key",
    "group_name",
    "town",
    "county",
    "postcode_area",
    "postcode_district_hint",
    "region",
    "country",
    "enabled",
    "facebook_profile_id",
    "crawler_node_id",
    "priority",
    "added_date",
    "notes",
]


def norm(value: str) -> str:
    return (value or "").strip()


def norm_lower(value: str) -> str:
    return norm(value).lower()


def is_enabled(value: str) -> bool:
    return norm_lower(value) in {"true", "1", "yes"}


def parse_priority(value: str) -> int:
    value = norm(value)
    if not value:
        return 999999
    try:
        return int(value)
    except ValueError:
        return 999999


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: python3 scripts/generate_node_assignment.py <crawler_node_id> <facebook_profile_id>")
        return 1

    crawler_node_id = norm(sys.argv[1])
    facebook_profile_id = norm(sys.argv[2])

    if not REGISTRY_PATH.exists():
        print(f"ERROR: CSV registry not found: {REGISTRY_PATH}")
        return 1

    with REGISTRY_PATH.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = reader.fieldnames or []

    missing_columns = [col for col in REQUIRED_COLUMNS if col not in fieldnames]
    if missing_columns:
        print("ERROR: Missing required columns:")
        for col in missing_columns:
            print(f" - {col}")
        return 1

    selected = []
    for row in rows:
        if norm(row.get("crawler_node_id", "")) != crawler_node_id:
            continue
        if norm(row.get("facebook_profile_id", "")) != facebook_profile_id:
            continue
        if not is_enabled(row.get("enabled", "")):
            continue

        item = {
            "group_key": norm(row.get("group_key", "")),
            "group_url": norm(row.get("group_url", "")),
            "group_name": norm(row.get("group_name", "")),
            "town": norm(row.get("town", "")),
            "county": norm(row.get("county", "")),
            "postcode_area": norm(row.get("postcode_area", "")),
            "postcode_district_hint": norm(row.get("postcode_district_hint", "")),
            "region": norm(row.get("region", "")),
            "country": norm(row.get("country", "")),
            "group_type": norm(row.get("group_type", "")),
            "priority": parse_priority(row.get("priority", "")),
            "facebook_profile_id": norm(row.get("facebook_profile_id", "")),
            "crawler_node_id": norm(row.get("crawler_node_id", "")),
            "added_date": norm(row.get("added_date", "")),
            "notes": norm(row.get("notes", "")),
        }

        selected.append(item)

    if len(selected) != 20:
        print(
            f"ERROR: Expected exactly 20 enabled groups for "
            f"crawler_node_id={crawler_node_id} and facebook_profile_id={facebook_profile_id}, "
            f"found {len(selected)}"
        )
        return 1

    missing_values = []
    for item in selected:
        if not item["group_key"]:
            missing_values.append(f"Missing group_key for group_name={item['group_name']}")
        if not item["group_url"]:
            missing_values.append(f"Missing group_url for group_key={item['group_key']}")
        if not item["group_name"]:
            missing_values.append(f"Missing group_name for group_key={item['group_key']}")

    if missing_values:
        print("ERROR: Missing required values in selected rows:")
        for msg in missing_values:
            print(f" - {msg}")
        return 1

    group_keys = [item["group_key"] for item in selected]
    duplicate_keys = sorted({k for k in group_keys if group_keys.count(k) > 1})
    if duplicate_keys:
        print("ERROR: Duplicate group_key values found:")
        for key in duplicate_keys:
            print(f" - {key}")
        return 1

    selected.sort(key=lambda x: (x["priority"], x["group_name"].lower()))

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / f"{crawler_node_id}.json"

    payload = {
        "generated_at_utc": datetime.utcnow().isoformat() + "Z",
        "source_registry": str(REGISTRY_PATH),
        "crawler_node_id": crawler_node_id,
        "facebook_profile_id": facebook_profile_id,
        "group_count": len(selected),
        "groups": selected,
    }

    with output_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Assignment generated: {output_path}")
    print(f"group_count: {len(selected)}")
    print()
    for item in selected:
        print(f"{item['priority']:>4} | {item['group_key']} | {item['group_name']} | {item['group_url']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())