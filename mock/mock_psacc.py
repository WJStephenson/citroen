#!/usr/bin/env python3
"""
Mock psa_car_controller bridge for local PWA development.

Routes match the REAL psa_car_controller (web/view/api.py), NOT the design doc
-- the doc got charge_control wrong. Payloads and *latency* are realistic:
commands sleep 30-90s to imitate the Stellantis SMS wake-up packet, so the PWA's
async states are actually exercisable without touching the car.
Standard library only.

    /get_vehicleinfo/<vin>?from_cache=1
    /preconditioning/<vin>/<0|1>
    /charge_control?vin=&percentage=      (also &hour=&minute= -> STOP hour)
    /charge_hour?vin=&hour=&minute=       (START hour)
    /wakeup/<vin>, /charge_now/<vin>/<0|1>, /battery/soh/<vin>

    python mock/mock_psacc.py          # listens on 127.0.0.1:5001
    python mock/mock_psacc.py --fast   # no artificial wake-up delay
    python mock/mock_psacc.py --flaky  # ~25% of commands fail, for error paths

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

args = argparse.Namespace(
    fast=False, flaky=False, port=5001, no_charge_control=False, rate_limit=False
)


def wake_delay() -> float:
    """The 30-90s window the doc's UI has to absorb."""
    return 0.4 if args.fast else random.uniform(30, 90)


def vehicle_payload() -> dict:
    with lock:
        s = dict(state)
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
                    "next_delayed_time": "PT0S",
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
        state["updated_at"] = datetime.now(timezone.utc)
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
                state["updated_at"] = datetime.now(timezone.utc)

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
            # from_cache=1 answers from stored state without waking the car, so
            # it is instant. A live read has to reach the vehicle.
            if query.get("from_cache", ["0"])[0] != "1":
                time.sleep(0.2 if args.fast else random.uniform(3, 12))
            self._send(200, vehicle_payload())
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
                config = {
                    "vin": query["vin"][0],
                    "percentage_threshold": state["charge_threshold"],
                    "stop_hour": state["stop_hour"],
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
            self._send(200, {"result": "ok", "start_hour": state["start_hour"]})
            return

        if parts[0] == "wakeup" and len(parts) == 2:
            time.sleep(wake_delay())
            self._send(200, {"result": "ok"})
            return

        # Charge type: 1 = immediate (cancels the deferred start), 0 = delayed.
        # The car keeps its stored hour either way; only the type changes.
        if parts[0] == "charge_now" and len(parts) == 3:
            time.sleep(wake_delay())
            immediate = parts[2] == "1"
            with lock:
                state["charge_type"] = "Immediate" if immediate else "Delayed"
                if immediate:
                    state["charging_status"] = "InProgress"
                state["updated_at"] = datetime.now(timezone.utc)
            self._send(200, {"result": "ok", "type": state["charge_type"]})
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
    """Slowly move telemetry so repeated refreshes are not identical."""
    while True:
        time.sleep(30)
        with lock:
            if state["charging_status"] == "InProgress":
                state["level"] = min(100.0, state["level"] + 0.6)
                state["autonomy"] = int(state["level"] * 3.45)
                if state["level"] >= 100:
                    state["charging_status"] = "Finished"
                    state["remaining_time"] = "PT0M"
            state["cabin_temp"] += random.uniform(-0.2, 0.2)
            state["aux_voltage"] = round(random.uniform(12.2, 12.7), 2)
            state["updated_at"] = datetime.now(timezone.utc)


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
        help="always return the rate-limit error for horn/lights/lock_door",
    )
    parser.add_argument(
        "--no-charge-control",
        action="store_true",
        help="make charge_control return PSACC's 200-with-error response",
    )
    args = parser.parse_args()

    if args.charging:
        state["charging_status"] = "InProgress"
        state["charging_mode"] = "Slow"
        state["remaining_time"] = "PT2H40M"

    threading.Thread(target=drift, daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"mock psa_car_controller on http://127.0.0.1:{args.port}  (VIN {VIN})")
    print(f"  wake-up delay: {'off' if args.fast else '30-90s'}   flaky: {args.flaky}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
