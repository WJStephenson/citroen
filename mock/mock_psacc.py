#!/usr/bin/env python3
"""
Mock psa_car_controller bridge for local PWA development.

Routes match the REAL psa_car_controller (web/view/api.py), NOT the design doc
-- the doc got charge_control wrong. Payloads and *latency* are realistic:
commands sleep 30-90s to imitate the Stellantis SMS wake-up packet, so the PWA's
async states are actually exercisable without touching the car.
Standard library only.

The three sources of vehicle state are modelled separately, because conflating
them is what let the PWA ship a dashboard that was confidently out of date:

    state         what Stellantis holds. Only the CAR changes this, by
                  reporting -- while charging, while preconditioning, or when
                  woken. A parked car changes nothing, for hours.
    bridge_cache  psa_car_controller's `car.status`. A copy taken at the last
                  uncached read; refreshed by nothing else, exactly as upstream
                  refreshes nothing else without -R or -c.
    a read        either of the above, handed over. Never a reason for the car
                  to say anything new.

So `updated_at` does NOT advance because someone refreshed. Use --silent-for to
boot a car that has been quiet for a while and watch the dashboard say so.

    /get_vehicleinfo/<vin>?from_cache=1
    /preconditioning/<vin>/<0|1>
    /charge_control?vin=&percentage=      (also &hour=&minute= -> STOP hour)
    /charge_hour?vin=&hour=&minute=       (START hour)
    /wakeup/<vin>, /charge_now/<vin>/<0|1>, /battery/soh/<vin>

    python mock/mock_psacc.py             # listens on 127.0.0.1:5001
    python mock/mock_psacc.py --fast      # no artificial wake-up delay
    python mock/mock_psacc.py --flaky     # ~25% of commands fail, for error paths
    python mock/mock_psacc.py --silent-for 180
                                          # car last reported 3h ago: the stale
                                          # notice and its wake-up button
    python mock/mock_psacc.py --immediate # charging on IMMEDIATE_CHARGE with a
                                          # schedule stored and ignored

The Vite dev server proxies /api/* here (see vite.config.ts), stripping the
prefix exactly as nginx does in production.
"""

from __future__ import annotations

import argparse
import json
import random
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VIN = "VR3UKZKXZMJ000000"

state = {
    "level": 62.0,
    "autonomy": 214,
    "charging_status": "Disconnected",  # InProgress | Stopped | Finished | Disconnected
    "charging_mode": "No",
    "remaining_time": "PT0M",
    "air_conditioning": "Disabled",
    "cabin_temp": 12.5,
    "mileage": 14732.4,
    "aux_voltage": 12.4,
    "charge_threshold": 100,
    "stop_hour": "08:00",
    "start_hour": "00:30",
    "charge_type": "Delayed",
    "updated_at": datetime.now(timezone.utc),
}
lock = threading.Lock()

# psa_car_controller's `car.status`: None until something reads uncached, then
# whatever that read saw, frozen. Upstream falls through to a live read while it
# is None (`if cache and car.status is not None`), so this does too.
bridge_cache: dict | None = None

args = argparse.Namespace(
    fast=False,
    flaky=False,
    port=5001,
    no_charge_control=False,
    rate_limit=False,
    immediate=False,
)


def wake_delay() -> float:
    """The 30-90s window the doc's UI has to absorb."""
    return 0.4 if args.fast else random.uniform(30, 90)


def as_duration(hhmm: str | None) -> str:
    """
    The PT#H#M shape the car reports next_delayed_time in -- "PT23H" for a
    stored 23:00, and "PT0S" when it holds no delayed time at all. Despite the
    swagger doc, it is a duration shape and not a timestamp; see hhmmFromDuration
    in src/api/client.ts.
    """
    if not hhmm:
        return "PT0S"
    hour, minute = (int(part) for part in hhmm.split(":"))
    if not hour and not minute:
        return "PT0S"
    return "PT" + (f"{hour}H" if hour else "") + (f"{minute}M" if minute else "")


def to_minutes(hhmm: str | None) -> int | None:
    if not hhmm:
        return None
    hour, minute = (int(part) for part in hhmm.split(":"))
    return hour * 60 + minute


def window_open() -> bool:
    """Whether the clock is inside start_hour..stop_hour, wrapping midnight."""
    start = to_minutes(state["start_hour"])
    stop = to_minutes(state["stop_hour"])
    if start is None or stop is None:
        return False
    now = datetime.now()
    return (now.hour * 60 + now.minute - start) % 1440 < (stop - start) % 1440


def settle_charge() -> None:
    """
    Reconcile the charge with the charge *type*, which is the half of a deferred
    start that no endpoint reports back:

      Immediate -- charges the moment it is plugged in, stored hour ignored
      Delayed   -- charges only inside its window

    Which is why setting a start hour on a car that is charging outside that
    window pauses the charge: /charge_hour carries type=delayed with it. The
    stored hour is untouched by any of this and keeps being reported either way,
    exactly as the real car keeps showing it on the dashboard.

    Caller holds the lock.
    """
    if state["charging_status"] not in ("InProgress", "Stopped"):
        return  # unplugged, finished or failed: not this function's business
    charging = state["charge_type"] == "Immediate" or window_open()
    state["charging_status"] = "InProgress" if charging else "Stopped"
    state["charging_mode"] = "Slow" if charging else "No"
    state["remaining_time"] = "PT2H40M" if charging else "PT0M"
    # A charge starting or stopping is an event the car reports on its own.
    report()


def report() -> None:
    """
    The car uploading to Stellantis. Caller holds the lock.

    The only thing that moves `updated_at`, and therefore the only thing that
    makes the dashboard's "car reported N ago" newer. Reads do not call it.
    """
    state["updated_at"] = datetime.now(timezone.utc)


def vehicle_payload(from_cache: bool = False) -> dict:
    global bridge_cache
    with lock:
        if from_cache and bridge_cache is not None:
            s = bridge_cache
        else:
            # An uncached read is what refreshes the bridge's copy -- see
            # PSAClient.get_vehicle_info, which assigns car.status on the way
            # through.
            s = dict(state)
            bridge_cache = s
    return {
        "vin": VIN,
        "energy": [
            {
                "type": "Electric",
                "level": round(s["level"], 1),
                "autonomy": int(s["autonomy"]),
                "updated_at": s["updated_at"].isoformat().replace("+00:00", "Z"),
                "charging": {
                    "status": s["charging_status"],
                    "charging_mode": s["charging_mode"],
                    "charging_rate": 22 if s["charging_status"] == "InProgress" else 0,
                    "remaining_time": s["remaining_time"],
                    # The stored hour, reported whether or not the car is
                    # actually honouring it -- nothing in this payload says
                    # which charge type is in force.
                    "next_delayed_time": as_duration(s["start_hour"]),
                },
            }
        ],
        "battery": {"voltage": round(s["aux_voltage"], 2), "current": -0.4},
        "preconditionning": {
            "air_conditioning": {
                "status": s["air_conditioning"],
                "updated_at": s["updated_at"].isoformat().replace("+00:00", "Z"),
            }
        },
        "timed_odometer": {"mileage": round(s["mileage"], 1)},
        "environment": {"air": {"temp": round(s["cabin_temp"], 1)}},
        "last_position": {
            "geometry": {"type": "Point", "coordinates": [-1.4701, 53.3811, 68]},
            "properties": {
                "updated_at": (
                    s["updated_at"] - timedelta(minutes=12)
                ).isoformat().replace("+00:00", "Z"),
                "heading": 214,
            },
        },
        "service_type": "Electric",
    }


def charging_sessions() -> list:
    """
    Mirrors Charging.get_chargings(): completed sessions, not a charge curve.
    Keys match the real record, including the calculated kw/co2/duration fields.
    """
    now = datetime.now(timezone.utc)
    sessions = []
    for i, (start_level, end_level, mode, hours) in enumerate(
        [
            (22, 80, "Slow", 6.5),
            (44, 100, "Slow", 6.0),
            (63, 80, "Quick", 0.6),
            (18, 92, "Slow", 8.1),
            (55, 80, "Slow", 2.8),
            (31, 100, "Slow", 7.4),
        ]
    ):
        start = now - timedelta(days=i * 3 + 1, hours=hours)
        # 50 kWh usable on the e-C4.
        kwh = (end_level - start_level) / 100 * 50
        sessions.append(
            {
                "start_at": start.isoformat().replace("+00:00", "Z"),
                "stop_at": (start + timedelta(hours=hours)).isoformat().replace("+00:00", "Z"),
                "start_level": start_level,
                "end_level": end_level,
                "charging_mode": mode,
                "vin": VIN,
                "mileage": round(14732.4 - i * 180, 1),
                "price": round(kwh * 0.075, 2),
                # PSACC's "kw" is energy in kWh, not power, despite the name:
                # (level - start_level) / 100 * car.battery_power
                "kw": round(kwh, 2),
                "co2": round(kwh * 0.021, 2),
                "duration_min": round(hours * 60, 1),
                # Real code uses str(timedelta), e.g. "6:30:00".
                "duration_str": str(timedelta(hours=hours)),
            }
        )
    return sessions


def trips() -> list:
    """
    Mirrors Trip.get_info(): one record per completed drive.

    Two things about the real payload matter to the app and are reproduced
    here. Flask's jsonify renders a datetime as an RFC 1123 HTTP-date, not
    ISO 8601 -- if the client ever stops parsing that, the odometer tile's
    week and month figures silently become zero. And there is no `vin` field,
    because Trip.get_info() does not emit one.

    Roughly a commute: two drives on most weekdays, over the last ten weeks, so
    both the Mon-Sun week and the calendar month have something in them
    whenever the mock is run.
    """
    now = datetime.now(timezone.utc)
    records = []
    odometer = state["mileage"]
    # Newest first while walking backwards, so the odometer counts down to what
    # it was; reversed at the end into the chronological order PSACC returns.
    for day in range(0, 70):
        date = now - timedelta(days=day)
        if date.weekday() >= 5:  # weekends are quieter
            if day % 3:
                continue
        for hour, minutes, km in ((17, 34, 18.6), (8, 12, 17.9)):
            start = date.replace(hour=hour, minute=minutes, second=0, microsecond=0)
            if start > now:
                continue
            records.append(
                {
                    "id": 1000 + len(records),
                    # datetime.utcnow() formatting Flask applies to a datetime.
                    "start_at": start.strftime("%a, %d %b %Y %H:%M:%S GMT"),
                    "duration": round(km / 34 * 60, 1),  # minutes, as get_info sends
                    "speed_average": 34.0,
                    "distance": km,
                    "mileage": round(odometer, 1),
                    "consumption": round(km * 0.17, 2),
                    "consumption_km": 17.0,
                    "altitude_diff": 12,
                    "positions": {"lat": [50.8, 50.81], "long": [-1.09, -1.1]},
                }
            )
            odometer -= km
    return list(reversed(records))


def apply_precondition(on: bool) -> None:
    """Cabin warms and the traction battery drains, like the real thing."""
    with lock:
        state["air_conditioning"] = "Enabled" if on else "Disabled"
        report()
    if not on:
        return

    def warm() -> None:
        for _ in range(6):
            time.sleep(2 if args.fast else 20)
            with lock:
                if state["air_conditioning"] != "Enabled":
                    return
                state["cabin_temp"] = min(21.0, state["cabin_temp"] + 1.4)
                state["level"] = max(0.0, state["level"] - 0.3)
                state["autonomy"] = max(0, int(state["level"] * 3.45))
                report()

    threading.Thread(target=warm, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *fmt_args) -> None:
        print(f"  {self.command} {self.path} -> {fmt % fmt_args}")

    def _send(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        query = parse_qs(url.query)

        if not parts:
            self._send(200, {"service": "mock psa_car_controller", "vin": VIN})
            return

        if parts[0] == "get_vehicleinfo":
            # Neither branch reaches the car. from_cache=1 hands back the
            # bridge's own copy and is instant; without it the bridge asks
            # Stellantis, which costs a round trip to their servers and
            # nothing else. Note what is missing from both: any reason for the
            # car to report, and so any change to `updated_at`.
            from_cache = query.get("from_cache", ["0"])[0] == "1"
            if not from_cache:
                time.sleep(0.1 if args.fast else random.uniform(0.6, 2.5))
            self._send(200, vehicle_payload(from_cache))
            return

        if parts[0] == "preconditioning" and len(parts) == 3:
            time.sleep(wake_delay())
            if args.flaky and random.random() < 0.25:
                self._send(504, {"message": "Vehicle did not respond to the wake-up request."})
                return
            apply_precondition(parts[2] == "1")
            self._send(200, {"result": "ok", "status": parts[2]})
            return

        # Real signature: VIN is a query parameter, and the threshold key is
        # `percentage`. hour+minute here sets the STOP hour, not the start.
        if parts[0] == "charge_control":
            if "vin" not in query:
                self._send(400, {"message": "charge_control requires ?vin="})
                return
            # get_charge_control only mutates when a percentage or an hour is
            # present; without one it reads PSACC's own config and answers
            # immediately. Sleeping on that form modelled a wake-up the real
            # bridge never performs, and since every poll reads it alongside
            # get_vehicleinfo, it made a routine refresh look like a minute of
            # waiting on the car.
            mutating = "percentage" in query or ("hour" in query and "minute" in query)
            if mutating:
                time.sleep(wake_delay())
                if args.flaky and random.random() < 0.25:
                    self._send(504, {"message": "Vehicle did not respond to the wake-up request."})
                    return
            if args.no_charge_control:
                # PSACC returns this with HTTP 200 when charge control is not
                # configured for the VIN — a success-shaped failure.
                self._send(200, {"error": "VIN not in list"})
                return
            with lock:
                if "percentage" in query:
                    state["charge_threshold"] = int(query["percentage"][0])
                if "hour" in query and "minute" in query:
                    h, m = int(query["hour"][0]), int(query["minute"][0])
                    # ChargeControl.set_stop_hour treats [0, 0] as "disabled",
                    # so midnight is not a settable stop time.
                    state["stop_hour"] = None if (h, m) == (0, 0) else f"{h:02d}:{m:02d}"
                    settle_charge()
                # ChargeControl's own dict: the stop hour is the private
                # `_stop_hour` pair, and [0, 0] is how it stores "disabled".
                stop = to_minutes(state["stop_hour"])
                config = {
                    "vin": query["vin"][0],
                    "percentage_threshold": state["charge_threshold"],
                    "_stop_hour": [0, 0] if stop is None else [stop // 60, stop % 60],
                }
            self._send(200, config)
            return

        # Remote command to the car: sets the hour charging should START.
        if parts[0] == "charge_hour":
            if not {"vin", "hour", "minute"} <= query.keys():
                self._send(400, {"message": "charge_hour requires ?vin=&hour=&minute="})
                return
            time.sleep(wake_delay())
            if args.flaky and random.random() < 0.25:
                self._send(504, {"message": "Vehicle did not respond to the wake-up request."})
                return
            with lock:
                state["start_hour"] = (
                    f"{int(query['hour'][0]):02d}:{int(query['minute'][0]):02d}"
                )
                # change_charge_hour sends the hour *as* DELAYED_CHARGE -- one
                # message carries both -- so setting an hour also takes the car
                # off immediate charge, and pauses it if it is charging outside
                # the new window.
                state["charge_type"] = "Delayed"
                settle_charge()
            self._send(200, {"result": "ok", "start_hour": state["start_hour"]})
            return

        # The one route that reaches the vehicle: its ECUs come up and it
        # uploads, which is why this is the only GET here that moves
        # `updated_at`. Stellantis rate-limits it, and the bridge reports that
        # as a 200 carrying an error -- see --rate-limit.
        if parts[0] == "wakeup" and len(parts) == 2:
            if args.rate_limit:
                self._send(200, {"error": "Wakeup rate limit exceeded"})
                return
            time.sleep(wake_delay())
            with lock:
                state["aux_voltage"] = round(state["aux_voltage"] - 0.05, 2)
                report()
            self._send(200, {"result": "ok"})
            return

        # Charge type: 1 = immediate (ignores the deferred start), 0 = delayed
        # (back on it). The car keeps its stored hour either way; only the type
        # changes, and nothing reports the type back -- which is the whole
        # reason a car can sit here charging at one in the afternoon with 23:00
        # still on its dashboard.
        if parts[0] == "charge_now" and len(parts) == 3:
            time.sleep(wake_delay())
            if args.flaky and random.random() < 0.25:
                self._send(504, {"message": "Vehicle did not respond to the wake-up request."})
                return
            with lock:
                state["charge_type"] = "Immediate" if parts[2] == "1" else "Delayed"
                settle_charge()
                charge_type = state["charge_type"]
            self._send(200, {"result": "ok", "type": charge_type})
            return

        if parts[:2] == ["battery", "soh"]:
            self._send(200, {"soh": 96.4})
            return

        # Rate-limited commands. PSACC reports throttling as a 200 with an
        # "error" key, not an HTTP error status.
        if parts[0] in ("horn", "lights", "lock_door") and len(parts) == 3:
            time.sleep(0.2 if args.fast else random.uniform(3, 10))
            if args.rate_limit or (args.flaky and random.random() < 0.25):
                label = {"horn": "Horn", "lights": "Lights", "lock_door": "Locks"}[parts[0]]
                self._send(200, {"error": f"{label} rate limit exceeded"})
                return
            self._send(200, {"result": "ok", "command": parts[0], "value": parts[2]})
            return

        if parts == ["vehicles", "chargings"]:
            self._send(200, charging_sessions())
            return

        if parts == ["vehicles", "trips"]:
            self._send(200, trips())
            return

        self._send(404, {"message": f"No mock route for /{'/'.join(parts)}"})


def drift() -> None:
    """
    A charging car, moving.

    This used to run unconditionally and stamp `updated_at` every 30 seconds,
    which meant every car in development was a car that had just spoken. The
    staleness the real one falls into -- parked, quiet, telling nobody anything
    for hours -- could not be reproduced here, so the dashboard was built and
    reviewed against a vehicle that does not exist. A parked car now sits
    exactly as still as the real one, and its numbers stay put.
    """
    while True:
        time.sleep(30)
        with lock:
            if state["charging_status"] != "InProgress":
                continue
            state["level"] = min(100.0, state["level"] + 0.6)
            state["autonomy"] = int(state["level"] * 3.45)
            if state["level"] >= 100:
                state["charging_status"] = "Finished"
                state["remaining_time"] = "PT0M"
            state["cabin_temp"] += random.uniform(-0.2, 0.2)
            state["aux_voltage"] = round(random.uniform(12.2, 12.7), 2)
            report()


def main() -> None:
    global args
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5001)
    parser.add_argument("--fast", action="store_true", help="skip the 30-90s wake-up delay")
    parser.add_argument("--flaky", action="store_true", help="fail ~25%% of commands")
    parser.add_argument(
        "--charging", action="store_true", help="start plugged in and charging"
    )
    parser.add_argument(
        "--rate-limit",
        action="store_true",
        help="always return the rate-limit error for horn/lights/lock_door/wakeup",
    )
    parser.add_argument(
        "--silent-for",
        type=int,
        default=0,
        metavar="MIN",
        help=(
            "boot a car that last reported this many minutes ago -- the ordinary "
            "state of a parked car, and the one the stale notice exists for"
        ),
    )
    parser.add_argument(
        "--immediate",
        action="store_true",
        help=(
            "boot plugged in and charging on IMMEDIATE_CHARGE with 23:00-07:00 stored: "
            "a car ignoring a schedule it is still reporting"
        ),
    )
    parser.add_argument(
        "--no-charge-control",
        action="store_true",
        help="make charge_control return PSACC's 200-with-error response",
    )
    args = parser.parse_args()

    if args.charging or args.immediate:
        state["charging_status"] = "InProgress"
        state["charging_mode"] = "Slow"
        state["remaining_time"] = "PT2H40M"

    if args.immediate:
        state["charge_type"] = "Immediate"
        state["start_hour"] = "23:00"
        state["stop_hour"] = "07:00"

    if args.silent_for:
        state["updated_at"] = datetime.now(timezone.utc) - timedelta(minutes=args.silent_for)

    threading.Thread(target=drift, daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"mock psa_car_controller on http://127.0.0.1:{args.port}  (VIN {VIN})")
    print(f"  wake-up delay: {'off' if args.fast else '30-90s'}   flaky: {args.flaky}")
    print(
        f"  last reported: {args.silent_for} min ago"
        f"{'   (reads will not change this -- only /wakeup will)' if args.silent_for else ''}"
    )
    print(
        f"  charge type: {state['charge_type']}   window: "
        f"{state['start_hour']}-{state['stop_hour']}   status: {state['charging_status']}"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
