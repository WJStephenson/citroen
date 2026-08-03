#!/usr/bin/env python3
"""
Shared settings store for the e-C4 PWA.

Every phone controlling the car talks to the same one of these, so the VIN,
poll interval, tariff, dashboard layout and the "last set" charge hints stay
in sync across users instead of living separately in each browser's own
localStorage.

No schema is enforced here beyond "valid JSON object". Each field is
validated defensively by whichever client module reads it (config.ts,
tariff.ts, useWidgetOrder.ts, the charge widgets) — the same stance
api/client.ts already takes with the bridge's own payloads, rather than this
store also having to agree on a shape. It only owns getting the same bytes to
everyone and not losing them.

    GET  /   -> the current settings object
    PUT  /   -> body is a JSON object, shallow-merged into the stored one;
                responds with the merged result

nginx strips the /settings/ prefix before proxying here (see
deploy/nginx-citroen.conf), so both routes are just "/".

Standard library only, matching mock/mock_psacc.py.

    python deploy/settings_store.py                                    # prod: PORT / SETTINGS_STORE_PATH env vars
    python deploy/settings_store.py --port 5002 --path settings-data/settings.json   # local dev
"""

from __future__ import annotations

import argparse
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
store_path = "./settings.json"


def load() -> dict:
    try:
        with open(store_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save(data: dict) -> None:
    # Write to a temp file and rename over the real one, so a crash or power
    # cut mid-write can never leave the one shared copy of everyone's
    # settings truncated or half-written.
    directory = os.path.dirname(store_path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = f"{store_path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, store_path)


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
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        with lock:
            self._send(200, load())

    def do_PUT(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            patch = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"message": "Body must be JSON"})
            return
        if not isinstance(patch, dict):
            self._send(400, {"message": "Body must be a JSON object"})
            return

        with lock:
            merged = {**load(), **patch}
            save(merged)
            self._send(200, merged)


def main() -> None:
    global store_path
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8090)))
    parser.add_argument(
        "--path", default=os.environ.get("SETTINGS_STORE_PATH", "./settings.json")
    )
    args = parser.parse_args()
    store_path = args.path

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"settings store on :{args.port}, persisting to {store_path}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
