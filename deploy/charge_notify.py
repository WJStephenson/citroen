#!/usr/bin/env python3
"""
Watches psa_car_controller and does two things nobody's phone can be relied on
to do: pushes the charging notifications, and re-arms the car's delayed-charge
schedule every time the car is unplugged.

Runs independently of any browser tab being open — that's the whole point.
The PWA's own poll loop (useVehicle.ts) deliberately suspends whenever the
app is backgrounded, to protect the car's 12V battery, so it cannot be the
thing that notices a charge finishing overnight; nobody has the tab open
then. This is a separate, always-running loop instead.

Two things are read every POLL_SECONDS, neither of which touches the car:

  - GET {PSACC_URL}/get_vehicleinfo/{vin}
    battery level and charging status, as last reported by the car to
    Stellantis. Uncached deliberately — see fetch_charging.

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
signal that a phone stopped listening). Each entry in that list carries its
own `events` object saying which of the two notifications that device wants;
see wants_event for what a missing one means.

It writes one other field there, `chargeLocations` — where the car was
standing on the poll where a charge was first seen starting. That is the one
thing about a session /vehicles/chargings does not record and nobody can
recover afterwards, and this watcher is the only thing running at the moment
it can be observed: the PWA's own recorder (src/hooks/useChargeLocationLog.ts)
only sees the charges that begin while somebody has the app open, which
overnight is none of them. See src/chargeLocations.ts, which owns the shape
and reads it back into the charging history's detail panel.

There are two notifications, each sent only to the devices that asked for it:

  - "charging started", on the poll where the status first becomes active
    having been seen inactive. A pure edge, so a watcher whose state file is
    missing does not announce a charge that began hours ago; the trade is
    that a car pausing and resuming mid-session announces itself twice,
    which is at least true. The same edge is what records where the car is
    standing — see record_charge_location.

  - "charging finished", once per session, the first time the level reaches
    target while charging (or the car reports Finished outright — it can hit
    100% and call itself Finished before a percentage check would even
    matter). STATE_PATH tracks whether this session has already been
    notified, reset whenever the level drops meaningfully (a new session
    started) rather than on a specific status transition, since that is
    robust to a missed poll or a watcher restart mid-session in a way that
    edge-detection is not.

And one thing is *written*, which makes this the only part of the project
outside the PWA's own buttons that commands the car:

  - GET {PSACC_URL}/charge_now/{vin}/0 on the poll where the car is first
    seen unplugged, re-sending the stored hour as DELAYED_CHARGE.

    A deferred start is two settings in the car and only one of them lasts.
    The hour survives everything and is reported back in next_delayed_time;
    the charge *type* does not survive being unplugged, so a schedule set on
    Monday is honoured for Monday's charge and then quietly dropped, while
    every reading — this app, the car's own dashboard, Stellantis's — goes on
    showing the hour as though it were still in force. Nothing can be done
    about that in the car: /VehCharge carries one hour and one type and has
    no notion of a repeating program (see the README). So it is re-sent
    instead, once per unplug, which is what turns a schedule that lasts one
    charge into one that lasts.

    On unplug, deliberately, and not when the car is plugged back in. Both
    moments would work, but only this one leaves the last word with whoever
    is standing at the car: press the charge-now button on the vehicle (or
    Charge now in the app) after plugging in and nothing here will contradict
    it, because by then the re-arm has already happened. Re-arming at plug-in
    would undo that override a few minutes after it was made, which is the
    one behaviour worse than the problem being fixed.

    Two guards. A car reporting no stored hour at all ("PT0S") has nothing to
    re-arm and is left alone, rather than being sent the 00:00 that
    charge_now would otherwise read out of PSACC's cache. And the whole
    behaviour is off if the shared settings say so — `rearmScheduleOnUnplug`
    (Settings → Charging), which defaults to on when absent, matching
    getRearmOnUnplug in src/config.ts.
"""

from __future__ import annotations

import json
import os
import re
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
# The one status that means no cable. Every other status the bridge reports —
# charging, stopped, finished, and anything unforeseen — means plugged in, so
# the test is written that way round: an unknown status must not read as
# "unplugged" and fire a re-arm at a car that is sitting on a charger.
UNPLUGGED_STATUS = "disconnected"
# Where the car was, as recorded on the start edge. These three have to agree
# with src/chargeLocations.ts, which reads the same list back and appends to it
# from the app: both writers see the same charge start and neither can tell the
# other's record from a second charge without them.
#   - two recordings this close in time and this close in space are the same
#     charge seen twice (0.0003 degrees is roughly 33m),
#   - five decimal places is about a metre, which is finer than a parked car's
#     GPS and finer than this needs,
#   - and the list is carried in a blob every phone fetches at boot, so it is
#     capped — well over a year of daily charging, oldest dropped first.
LOCATION_DEDUPE_MS = 45 * 60 * 1000
LOCATION_SAME_PLACE_DEGREES = 0.0003
LOCATION_COORD_DP = 5
MAX_CHARGE_LOCATIONS = 300

# A re-arm that the bridge refuses, or that cannot be sent at all, is retried
# on the following polls — a car unplugged and driven away is a car whose
# radio may not answer for a minute. It is not retried forever: after this
# many failures the log says so and the unplug is let go, rather than the
# watcher spending the week sending commands into a car that is not listening.
MAX_REARM_ATTEMPTS = 3


def log(message: str) -> None:
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {message}", flush=True)


def http_get(url: str) -> dict | bool:
    """
    The bridge's answer, parsed.

    Not always an object: the read routes return one, but /charge_now answers
    a bare `true` (jsonify of RemoteClient.charge_now's return value) — and
    answers a *dict* carrying an "error" key for the failures it reports with
    an HTTP 200. Callers that read fields check the shape; see rearm_schedule
    for the one that has to tell those two answers apart.
    """
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
        settings = http_get(f"{SETTINGS_URL}/")
        return settings if isinstance(settings, dict) else {}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        log("could not reach settings_store, skipping this poll")
        return {}


def hour_from_duration(value: object) -> str | None:
    """
    The stored delayed-charge hour as HH:MM, from the PT#H#M shape
    next_delayed_time actually carries — "PT23H" is the hour 23:00, not a time
    23 hours away. Same parse, and the same "PT0S" case, as hhmmFromDuration in
    src/api/client.ts: a duration carrying neither hours nor minutes is a car
    holding no hour at all, which is not midnight.
    """
    if not isinstance(value, str):
        return None
    match = re.match(r"^PT(?:(\d+)H)?(?:(\d+)M)?", value)
    if not match or (match[1] is None and match[2] is None):
        return None
    return f"{int(match[1] or 0):02d}:{int(match[2] or 0):02d}"


def position_from_info(info: dict) -> tuple[float, float] | None:
    """
    (lat, lon) from last_position, or None if the car has never given a fix.

    GeoJSON orders its coordinates [lon, lat, altitude] — the transposition
    parseLocation in src/api/client.ts exists to keep in exactly one place.
    This is the other one, and it makes the same two checks: a pair that is not
    two numbers is not a position, and (0, 0) is the bridge's "no fix yet"
    sentinel rather than a spot in the Gulf of Guinea.
    """
    geometry = (info.get("last_position") or {}).get("geometry") or {}
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        return None
    lon, lat = coordinates[0], coordinates[1]
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (lon, lat)):
        return None
    if lon == 0 and lat == 0:
        return None
    return (float(lat), float(lon))


def fetch_charging(vin: str) -> tuple[str | None, float | None, str | None, tuple[float, float] | None]:
    """
    (status, level, stored delayed hour, position) from get_vehicleinfo,
    lowercased status.

    The position rides along on this read rather than getting one of its own:
    the same payload already carries last_position, and it is only ever wanted
    on a poll this call has just made anyway.

    Read WITHOUT from_cache, which it used to use. The cached read returns
    psa_car_controller's in-memory copy, and nothing refreshes that copy unless
    the bridge runs with -R or something makes an uncached read. Overnight,
    with every phone's app backgrounded, nothing did — so this watcher spent
    the night re-reading one frozen number and could not see the charge it
    exists to announce. Uncached asks Stellantis instead, which still never
    touches the car (see src/api/client.ts::fetchVehicleState) and is the
    difference between watching the car and watching a snapshot of it.

    Uncached matters for the re-arm too, and not only for freshness: an
    uncached read is what assigns psa_car_controller's own `car.status`
    (psacc/application/psa_client.py), and /charge_now reads the hour it
    re-sends straight out of that copy. So this read, every poll, is also what
    keeps the hour the bridge would send in step with the one the car holds.
    """
    info = http_get(f"{PSACC_URL}/get_vehicleinfo/{vin}")
    if not isinstance(info, dict):
        return (None, None, None, None)
    energies = info.get("energy") or [{}]
    energy = next((e for e in energies if str(e.get("type", "")).lower() == "electric"), energies[0])
    charging = energy.get("charging") or {}
    status = charging.get("status")
    return (
        str(status).lower() if status else None,
        energy.get("level"),
        hour_from_duration(charging.get("next_delayed_time")),
        position_from_info(info),
    )


def fetch_target(vin: str) -> float:
    """The percentage PSACC will stop the charge at, or 100 if uncapped/unconfigured."""
    charge_control = http_get(f"{PSACC_URL}/charge_control?vin={vin}")
    if not isinstance(charge_control, dict) or charge_control.get("error"):
        return 100.0
    threshold = charge_control.get("percentage_threshold")
    if isinstance(threshold, (int, float)) and 0 < threshold < 100:
        return float(threshold)
    return 100.0


def rearm_enabled(settings: dict) -> bool:
    """
    Whether to re-arm the schedule on unplug.

    Absent means on. The setting exists to be turned *off* — by someone whose
    charger does its own scheduling, or who wants the car left exactly as the
    last person set it — and a household that has never opened the switch has
    no stored value for it. Same default as getRearmOnUnplug in src/config.ts;
    the two have to agree or the switch would show a state the server isn't in.
    """
    value = settings.get("rearmScheduleOnUnplug")
    return value is not False


def rearm_schedule(vin: str) -> bool:
    """
    Puts the car back on DELAYED_CHARGE at its stored hour. True if the bridge
    took the command.

    /charge_now/{vin}/0 re-sends the hour the bridge is holding for this car
    with the type set back to delayed — one MQTT message, the same one the
    tile's Schedule button sends. It does not wake the car the way /wakeup
    does and costs nothing at Stellantis beyond the message itself.

    "Took the command" is as much as can ever be claimed here. The bridge
    answers `true` as soon as it has published, the car acts a minute or so
    later, and no endpoint anywhere reports the charge type back — so there is
    nothing to read to confirm it. What can be seen is the car's behaviour at
    the next plug-in, which is why that moment gets a log line of its own.
    """
    try:
        answer = http_get(f"{PSACC_URL}/charge_now/{vin}/0")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as ex:
        log(f"re-arm could not be sent: {ex}")
        return False
    # PSACC reports several failures as a 200 carrying {"error": ...} — "VIN
    # not in list", rate limiting — rather than as an HTTP error, exactly as
    # api/client.ts::command has to allow for.
    if isinstance(answer, dict) and answer.get("error"):
        log(f"re-arm refused by the bridge: {answer['error']}")
        return False
    return True


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


def wants_event(subscription: dict, event: str) -> bool:
    """
    Whether this device asked to hear about `event` ("start" or "finish").

    A subscription with no `events` field predates the setting existing, and
    every one of those was made by tapping "notify when charging finishes" —
    so that, and not both, is what it means. Same default in push.ts.
    """
    events = subscription.get("events")
    if not isinstance(events, dict):
        return event == "finish"
    return events.get(event) is True


def parse_charge_locations(raw: object) -> list[dict]:
    """
    The stored list, keeping only entries that are actually three numbers.

    Defensive for the same reason every client module is: the settings store
    enforces no schema, and a field written by an older or newer version of the
    app is not a reason for this loop to stop watching the car.
    """
    if not isinstance(raw, list):
        return []
    kept = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        values = (entry.get("at"), entry.get("lat"), entry.get("lon"))
        if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in values):
            kept.append({"at": values[0], "lat": values[1], "lon": values[2]})
    return sorted(kept, key=lambda record: record["at"])


def record_charge_location(
    settings: dict, position: tuple[float, float] | None, now_ms: int
) -> None:
    """
    Writes down where the car is standing, as the charge it has just started.

    This is the only moment the fact exists to be caught. /vehicles/chargings
    has no position field, so a session whose start nobody was watching has no
    place attached to it and never will — which is why the app's own detail
    panel says "no location recorded" rather than treating it as an error.

    Read-modify-write against a store that merges whole fields, so two writers
    racing lose one entry. That is the right trade here: the other writer is a
    phone that saw the same start (src/hooks/useChargeLocationLog.ts), the
    entry it would have written is the one being written now, and the dedupe
    below would have thrown one of them away regardless.
    """
    if position is None:
        log("charge started but the car has reported no position — nothing to record")
        return

    lat = round(position[0], LOCATION_COORD_DP)
    lon = round(position[1], LOCATION_COORD_DP)
    records = parse_charge_locations(settings.get("chargeLocations"))
    if any(
        abs(record["at"] - now_ms) <= LOCATION_DEDUPE_MS
        and abs(record["lat"] - lat) <= LOCATION_SAME_PLACE_DEGREES
        and abs(record["lon"] - lon) <= LOCATION_SAME_PLACE_DEGREES
        for record in records
    ):
        return

    records = sorted([*records, {"at": now_ms, "lat": lat, "lon": lon}], key=lambda r: r["at"])
    records = records[-MAX_CHARGE_LOCATIONS:]
    try:
        http_put(f"{SETTINGS_URL}/", {"chargeLocations": records})
    except (urllib.error.URLError, TimeoutError):
        # Not retried. By the next poll the car is still in the same place, but
        # the start edge has passed and re-recording it then would date the
        # entry to a moment that is no longer the start of anything.
        log("could not store where this charge started — it will have no map")
        return
    log(f"charge started at {lat}, {lon}")


def notify(subscriptions: list[dict], event: str, payload: dict) -> list[dict]:
    """
    Sends `payload` to every subscription that wants `event`, and returns the
    full list minus any the push service confirmed is gone — pruning is about
    the subscription being dead, so it applies to the whole list regardless of
    which devices this particular event went to.
    """
    wanted = sum(1 for s in subscriptions if wants_event(s, event))
    if wanted == 0:
        return subscriptions

    log(f"sending '{event}' to {wanted} of {len(subscriptions)} subscribed device(s)")
    survivors = []
    for subscription in subscriptions:
        if wants_event(subscription, event) and not send_push(subscription, payload):
            continue
        survivors.append(subscription)

    if len(survivors) != len(subscriptions):
        try:
            http_put(f"{SETTINGS_URL}/", {"pushSubscriptions": survivors})
        except (urllib.error.URLError, TimeoutError):
            log("could not prune expired subscriptions this round, will retry")
            return subscriptions
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

    status, level, stored_hour, position = fetch_charging(vin)
    target = fetch_target(vin)

    session = state.get(vin, {"notified": False, "last_level": None})
    last_level = session.get("last_level")

    new_session = status == UNPLUGGED_STATUS or (
        last_level is not None and level is not None and level < last_level - NEW_SESSION_DROP
    )
    if new_session:
        session["notified"] = False
        session["seen_charging"] = False

    # Charging just started, as an edge rather than a state: "the car is
    # charging" is true for hours, so only the transition into it is news.
    # `was_charging` is None on the very first poll for this VIN (nothing on
    # disk yet, or a wiped state file) and no announcement is made then —
    # there is no way to tell a charge that started seconds ago from one
    # that started overnight, and announcing the wrong one is worse.
    charging_now = status in ACTIVE_STATUSES
    started = charging_now and session.get("was_charging") is False
    session["was_charging"] = charging_now

    if charging_now:
        session["seen_charging"] = True

    if started:
        log(f"{vin} started charging at {level}% (target {target}%, status {status})")
        # Before the push, because this is the half that cannot be done later:
        # a notification nobody was sent is a missed message, but a position
        # nobody wrote down is a session that can never have one.
        record_charge_location(settings, position, int(time.time() * 1000))
        subscriptions = notify(
            subscriptions,
            "start",
            {
                "title": "Charging started",
                "body": (
                    f"Battery at {int(level)}%, charging to {int(target)}%."
                    if level is not None
                    else f"Charging to {int(target)}%."
                ),
                "tag": "charge-status",
            },
        )

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
        log(f"{vin} finished at {level}% (target {target}%, status {status})")
        subscriptions = notify(
            subscriptions,
            "finish",
            {
                "title": "Charging finished" if target >= 100 else f"Charging reached {int(target)}%",
                "body": f"Battery is at {int(level)}%." if level is not None else "Charging has finished.",
                "tag": "charge-status",
            },
        )
        session["notified"] = True

    session = rearm_on_unplug(vin, status, stored_hour, session, rearm_enabled(settings))

    session["last_level"] = level
    state[vin] = session
    return state


def rearm_on_unplug(
    vin: str, status: str | None, stored_hour: str | None, session: dict, enabled: bool
) -> dict:
    """
    Re-sends the stored hour as DELAYED_CHARGE once per unplug, so the schedule
    is in force again before the car is next plugged in. See the module
    docstring for why unplugging is the moment chosen.

    An edge, like the "started charging" notification and for the same reason:
    `plugged` is None until this watcher has seen the car at least once, and no
    re-arm is sent on that first poll. A watcher restarting next to a car that
    has been sitting unplugged on the drive since Tuesday has no idea whether
    the schedule was already re-armed when it was unplugged, and sending a
    command to find out is not free.

    Retries live here rather than inside rearm_schedule because the retry
    interval that makes sense is the poll interval — a car that has just been
    unplugged is often being driven away, and five minutes later it is parked
    somewhere with a better signal.
    """
    if status is None:
        # The car reported no charging status at all. That is not the same as
        # reporting no cable, and must not be read as one — whatever the plug
        # state was, it still is, and a poll that learned nothing is not an
        # unplug.
        return session

    plugged = status != UNPLUGGED_STATUS
    was_plugged = session.get("plugged")
    session["plugged"] = plugged

    if plugged:
        if was_plugged is False:
            # The one line that says whether any of this worked. If the car
            # then starts charging outside its window, the "started charging"
            # line follows within a poll or two and the pair of them is the
            # evidence that the re-arm did not stick.
            log(
                f"{vin} plugged in (status {status}); schedule last re-armed "
                f"{session.get('rearmed_at') or 'never'}"
            )
        # Whatever happens from here is this plug-in's business; the next
        # unplug gets its own re-arm and its own attempts.
        session["rearm_due"] = False
        session["rearm_attempts"] = 0
        return session

    if was_plugged:
        log(f"{vin} unplugged")
        session["rearm_due"] = True
        session["rearm_attempts"] = 0

    if not session.get("rearm_due"):
        return session

    if not enabled:
        # Off in Settings. Dropped rather than held, so turning it back on
        # mid-week does not fire a command about an unplug from days ago.
        session["rearm_due"] = False
        return session

    if stored_hour is None:
        # Nothing to put the car back on. charge_now would still send
        # something — PSACC reads the hour out of its own cached status and a
        # car holding none parses as [0, 0] — and midnight is a schedule
        # nobody asked for.
        log(f"{vin} holds no delayed-charge hour, nothing to re-arm")
        session["rearm_due"] = False
        return session

    session["rearm_attempts"] = session.get("rearm_attempts", 0) + 1
    if rearm_schedule(vin):
        log(f"{vin} re-armed on {stored_hour} for the next charge")
        session["rearm_due"] = False
        session["rearmed_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    elif session["rearm_attempts"] >= MAX_REARM_ATTEMPTS:
        log(
            f"{vin} could not be re-armed after {MAX_REARM_ATTEMPTS} attempts — "
            f"the car will charge as soon as it is plugged in unless {stored_hour} "
            "is set again from the app"
        )
        session["rearm_due"] = False

    return session


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
