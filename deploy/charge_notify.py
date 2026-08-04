#!/usr/bin/env python3
"""
Watches psa_car_controller for a charging session reaching its setpoint and
pushes a Web Push notification to every phone subscribed via the PWA's
Settings sheet.

Runs independently of any browser tab being open — that's the whole point.
The PWA's own poll loop (useVehicle.ts) deliberately suspends whenever the
app is backgrounded, to protect the car's 12V battery, so it cannot be the
thing that notices a charge finishing overnight; nobody has the tab open
then. This is a separate, always-running loop instead.

Two things are read every POLL_SECONDS, both local bridge reads that never
wake or touch the car:

  - GET {PSACC_URL}/get_vehicleinfo/{vin}?from_cache=1
    battery level and charging status, as reported by the car.

  - GET {PSACC_URL}/charge_control?vin={vin}   (no hour/minute/percentage —
    read-only, see get_charge_control in psa_car_controller's api.py)
    PSACC's configured percentage_threshold, if charge control is set up
    for this VIN. This is the *same* field the PWA's Charge limit tile now
    reads live (api/client.ts::fetchChargeControlState) — "the setpoint"
    here means the number the app shows, not a separately configured one.
    Falls back to 100 (full) when charge control isn't configured.

The VIN and the list of subscribed devices both live in the shared settings
store (GET/PUT {SETTINGS_URL}/) rather than here — see sharedSettings.ts /
push.ts. This script only reads the `vin` and `pushSubscriptions` fields out
of that shared blob, and writes `pushSubscriptions` back if a subscription
has expired (the push service answers 404/410 for those; there is no other
signal that a phone stopped listening).

A push fires once per charging session, the first time the level reaches
target while charging (or the car reports Finished outright — it can hit
100% and call itself Finished before a percentage check would even matter).
STATE_PATH tracks whether this session has already been notified, reset
whenever the level drops meaningfully (a new session started) rather than on
a specific status transition, since that is robust to a missed poll or a
watcher restart mid-session in a way that edge-detection is not.
"""

from __future__ import annotations

import json
import os
import time
import traceback
import urllib.error
import urllib.request

from pywebpush import WebPushException, webpush

PSACC_URL = os.environ.get("PSACC_URL", "http://psa_car_controller:5000").rstrip("/")
SETTINGS_URL = os.environ.get("SETTINGS_URL", "http://settings_store:8090").rstrip("/")
STATE_PATH = os.environ.get("STATE_PATH", "/data/state.json")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "300"))
FALLBACK_VIN = os.environ.get("VIN", "")

VAPID_PRIVATE_KEY = os.environ["VAPID_PRIVATE_KEY"]
VAPID_SUBJECT = os.environ["VAPID_SUBJECT"]

REQUEST_TIMEOUT_S = 30
# How long the push service may hold the notification for a phone it cannot
# reach right now. pywebpush defaults this to 0, which means "deliver this
# instant or discard" — the push service still answers 201, it just throws
# the message away. That default is precisely wrong here: an Android phone
# with its screen off is in Doze and unreachable, and a charge finishing
# overnight is the case this whole service exists for. A day is long enough
# to survive a night asleep, and a "charging finished" older than that has
# stopped being news anyway.
PUSH_TTL_SECONDS = 86_400
# A poll landing mid-charge with a slightly noisy reading should not look
# like a new session. A real new session starts from disconnected or from
# whatever level the last one left off well below target, so this only
# needs to be bigger than sensor jitter, not precise.
NEW_SESSION_DROP = 5

# Matches CHARGING_STATUS in api/client.ts.
ACTIVE_STATUSES = {"inprogress", "quickcharge"}
DONE_STATUSES = {"finished"}


def log(message: str) -> None:
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {message}", flush=True)


def http_get(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=REQUEST_TIMEOUT_S) as response:
        return json.loads(response.read().decode())


def http_put(url: str, body: dict) -> None:
    data = json.dumps(body).encode()
    request = urllib.request.Request(
        url, data=data, method="PUT", headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
        response.read()


def load_state() -> dict:
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    directory = os.path.dirname(STATE_PATH) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = f"{STATE_PATH}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_PATH)


def fetch_settings() -> dict:
    try:
        return http_get(f"{SETTINGS_URL}/")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        log("could not reach settings_store, skipping this poll")
        return {}


def fetch_charging(vin: str) -> tuple[str | None, float | None]:
    """(status, level) from get_vehicleinfo, lowercased status."""
    info = http_get(f"{PSACC_URL}/get_vehicleinfo/{vin}?from_cache=1")
    energies = info.get("energy") or [{}]
    energy = next((e for e in energies if str(e.get("type", "")).lower() == "electric"), energies[0])
    charging = energy.get("charging") or {}
    status = charging.get("status")
    return (str(status).lower() if status else None, energy.get("level"))


def fetch_target(vin: str) -> float:
    """The percentage PSACC will stop the charge at, or 100 if uncapped/unconfigured."""
    charge_control = http_get(f"{PSACC_URL}/charge_control?vin={vin}")
    if charge_control.get("error"):
        return 100.0
    threshold = charge_control.get("percentage_threshold")
    if isinstance(threshold, (int, float)) and 0 < threshold < 100:
        return float(threshold)
    return 100.0


def send_push(subscription: dict, payload: dict) -> bool:
    """True on success. False (and the caller should drop the subscription) on 404/410."""
    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps(payload),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": VAPID_SUBJECT},
            ttl=PUSH_TTL_SECONDS,
        )
        return True
    except WebPushException as ex:
        status = ex.response.status_code if ex.response is not None else None
        if status in (404, 410):
            log(f"subscription gone ({status}), dropping: {subscription.get('endpoint', '?')[:60]}")
            return False
        log(f"push failed ({status}): {ex}")
        return True  # not a confirmed-gone subscription — keep it, retry next session


def notify_all(subscriptions: list[dict], payload: dict) -> list[dict]:
    """Sends to every subscription, returns the ones still good afterward."""
    survivors = []
    for subscription in subscriptions:
        if send_push(subscription, payload):
            survivors.append(subscription)
    return survivors


def poll_once(state: dict) -> dict:
    settings = fetch_settings()
    vin = settings.get("vin") or FALLBACK_VIN
    if not vin:
        log("no VIN configured yet (checked settings_store and $VIN), skipping this poll")
        return state

    subscriptions = settings.get("pushSubscriptions") or []
    if not isinstance(subscriptions, list) or not subscriptions:
        # Nothing to notify — still worth tracking level, so a session that
        # starts before anyone subscribes doesn't immediately fire once
        # someone does.
        subscriptions = []

    status, level = fetch_charging(vin)
    target = fetch_target(vin)

    session = state.get(vin, {"notified": False, "last_level": None})
    last_level = session.get("last_level")

    new_session = status == "disconnected" or (
        last_level is not None and level is not None and level < last_level - NEW_SESSION_DROP
    )
    if new_session:
        session["notified"] = False
        session["seen_charging"] = False

    if status in ACTIVE_STATUSES:
        session["seen_charging"] = True

    # Two ways a session ends at its setpoint, and neither alone is enough:
    #
    #   - the car reports Finished. Definitive, but the level it reports at
    #     that moment can be 99 rather than a clean 100, so a level check
    #     alone would sit there waiting for a number that never arrives.
    #   - the level reaches target. This is the only signal when PSACC's
    #     charge control is what stops it: cutting the charge at a threshold
    #     leaves the status Stopped, never Finished.
    #
    # Both are gated on having actually watched this session charge, so a
    # watcher restart next to a car that finished hours ago doesn't announce
    # it as news.
    finished = status in DONE_STATUSES
    hit_target = level is not None and level >= target
    reached = not session["notified"] and session.get("seen_charging", False) and (finished or hit_target)

    if reached:
        log(
            f"{vin} finished at {level}% (target {target}%, status {status}), "
            f"notifying {len(subscriptions)} device(s)"
        )
        payload = {
            "title": "Charging finished" if target >= 100 else f"Charging reached {int(target)}%",
            "body": f"Battery is at {int(level)}%." if level is not None else "Charging has finished.",
            "tag": "charge-status",
        }
        survivors = notify_all(subscriptions, payload)
        if len(survivors) != len(subscriptions):
            try:
                http_put(f"{SETTINGS_URL}/", {"pushSubscriptions": survivors})
            except (urllib.error.URLError, TimeoutError):
                log("could not prune expired subscriptions this round, will retry")
        session["notified"] = True

    session["last_level"] = level
    state[vin] = session
    return state


def main() -> None:
    log(f"charge-notify watching {PSACC_URL}, settings at {SETTINGS_URL}, every {POLL_SECONDS}s")
    state = load_state()
    while True:
        try:
            state = poll_once(state)
            save_state(state)
        except Exception:  # noqa: BLE001 — one bad poll must never kill the loop
            log(f"poll failed:\n{traceback.format_exc()}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
