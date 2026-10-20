"""
Fetch the Yale Doorman L3's BLE offline key, slot and MAC — PLAN.md phase 1.

The ESP32 needs these three to drive the lock locally over Bluetooth without the
Yale cloud. They come once from the Yale cloud lock detail. Use a **dedicated
Yale owner account** for this (e.g. ha@<domain>) that is never logged into the
Yale Home phone app — app logins can rotate the key and break BLE (PLAN.md).

Token: same source as the yale repo's export scripts — a JSON file (default
/tmp/yale_token.json, or $YALE_TOKEN_FILE) holding the OAuth access_token, i.e.
the object Home Assistant stores under
`.storage/core.config_entries → yale → data.token`.

    python -I fetch_offline_key.py                 # prints key/slot/mac per lock
    python -I fetch_offline_key.py --raw           # also dumps the full lock detail

Needs `yalexs` and `aiohttp` (already in the yale repo's .venv).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

import aiohttp
from yalexs.api_async import ApiAsync
from yalexs.const import Brand


def load_access_token() -> str:
    path = Path(os.environ.get("YALE_TOKEN_FILE", "/tmp/yale_token.json"))
    data = json.loads(path.read_text())
    # Accept either {"access_token": ...} or HA's nested {"token": {"access_token": ...}}.
    token = data.get("access_token") or data.get("token", {}).get("access_token")
    if not token:
        raise SystemExit(f"No access_token found in {path}")
    return token


def extract_offline_key(raw: dict) -> list[dict]:
    """Pull every usable offline key out of a lock-detail payload.

    The Yale/August cloud returns them under `OfflineKeys` as `created`/`loaded`
    lists of {key, slot, ...}. `loaded` keys are the ones provisioned into the
    lock and usable over BLE; prefer those. Field names can drift between
    firmware versions, so --raw is there when this comes up empty.
    """
    keys = []
    offline = raw.get("OfflineKeys") or raw.get("offlineKeys") or {}
    for bucket in ("loaded", "created"):
        for k in offline.get(bucket, []) or []:
            if k.get("key") and k.get("slot") is not None:
                keys.append({"slot": k["slot"], "key": k["key"], "bucket": bucket})
    return keys


async def main(show_raw: bool) -> None:
    token = load_access_token()
    async with aiohttp.ClientSession() as session:
        api = ApiAsync(session, brand=Brand.YALE_HOME)
        locks = await api.async_get_operable_locks(token)
        if not locks:
            raise SystemExit("No locks on this account.")

        for lock in locks:
            detail = await api.async_get_lock_detail(token, lock.device_id)
            raw = getattr(detail, "raw", None) or getattr(detail, "_data", {})
            mac = (
                raw.get("macAddress")
                or raw.get("MACAddress")
                or getattr(detail, "mac_address", None)
            )
            print(f"\n=== {lock.device_name} ({lock.device_id}) ===")
            print(f"  mac: {mac}")
            keys = extract_offline_key(raw)
            if keys:
                for k in keys:
                    print(f"  offline key (slot {k['slot']}, {k['bucket']}): {k['key']}")
            else:
                print("  no offline key found — run with --raw and inspect the payload")
            if show_raw:
                print(json.dumps(raw, indent=2, sort_keys=True))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--raw", action="store_true", help="dump the full lock detail JSON")
    asyncio.run(main(ap.parse_args().raw))
