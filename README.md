# Citroën ë-C4 PWA

Installable Android PWA that replaces the MyCitroën app, talking to a self-hosted
`psa_car_controller` bridge through your existing nginx + Cloudflare Tunnel.

Built from `citroen_pwa_design_doc.pdf` v1.0.0. This repo is the **client layer**
only — you already have the domain, tunnel, and nginx container.

| | |
|---|---|
| Stack | Vite + React 19 + TypeScript, no UI framework |
| Output | Static `dist/` — HTML, CSS, JS, icons. No server-side runtime |
| Talks to | `psa_car_controller` via `/api/*`, proxied by your nginx |

---

## What it does

- **Reorderable tile grid** — one scrolling dashboard rather than tabs. Long-press
  any tile (or tap the rearrange button in the app bar) to pick it up and drag it
  somewhere else; the order is kept in `localStorage` under `ec4.widgetOrder`.
  Arrow keys move the focused tile when a keyboard is attached.
- **Charge** — the lead tile fills from the bottom to the state of charge behind a
  wave, and cuts the reading in half at the waterline. Colour carries severity
  (mint / amber / red), and it drifts while energy is actually going in.
- **Readings** — charging state as a four-step plug-in sequence, cabin
  temperature, odometer, and 12V auxiliary voltage on a dial with the band the
  number has to stay inside.
- **A shape per tile**, after Material 3 Expressive's shape set, so the grid is
  legible before a word of it is read: lobed silhouettes for the soft or
  radiating quantities (cabin warmth, moving air, light, sound), a circle where
  the tile's own edge is an instrument (12V), a domed top for anything with a
  fill line in it (charge, and the limit it fills to), and mirrored diagonal
  corners for the counted numbers. Tiles holding a slider or a chart stay
  rectangular — a shaped tile has no corners to put them in.
- **Pre-conditioning toggle** — with a non-blocking overlay that counts elapsed
  seconds against the 30–90s cellular wake-up window, so a slow response reads
  as normal rather than broken.
- **Charge limit** — swipe the tile up and down to set the maximum, 50–100% in
  5% steps, via PSACC's local charge control (needs it configured for your VIN —
  see below). Nothing is sent while the finger is moving; releasing commits it,
  so one decision is one command rather than a dozen wake-ups. Hold still
  instead of swiping and the tile is picked up for rearranging.
- **Charging window** — separate start and stop times, so the car only charges
  inside your off-peak tariff window. These are two unrelated mechanisms in the
  bridge and can fail independently, so each has its own Set button. Both can be
  cleared: *Charge now* cancels a deferred start, *Clear stop* removes the stop
  time.
- **Lights** and **Horn** — one tile each, because they are not the same kind of
  decision: the lights are harmless and fire on the first tap, the horn asks for
  a second one.
- **Charging history** — energy added per session, charted from
  `/vehicles/chargings`, with a table view.
- **Units** — km/miles and °C/°F, switchable in Settings, applied instantly.
- **Pull-to-refresh** — the primary way to get live state, because background
  polling is deliberately throttled (see [Battery safety](#battery-safety)).
- **App lock** — WebAuthn biometrics or a local PIN, re-armed when the app has
  been backgrounded for over a minute.
- **Offline launch** — cache-first service worker; the shell opens instantly
  with no network, then fetches live state.

---

## Quick start (local, no car involved)

Needs Node 20+ (developed on 24.18.1) and Python 3 for the mock.

```bash
npm install
npm run mock      # terminal 1 — python, stdlib only, no deps
npm run dev       # terminal 2 — http://localhost:5173
```

`.env.local` is already set up to point the dev server at the mock and to
prefill the mock's VIN, so this works with no further configuration.

The mock serves the doc's four endpoints with realistic payloads **and realistic
latency** — commands sleep 30–90s, exactly like the real wake-up path, so the
async UI is genuinely exercisable. Useful flags:

```bash
python mock/mock_psacc.py --fast      # skip the wake-up delay while iterating
python mock/mock_psacc.py --flaky     # fail ~25% of commands, to test error paths
python mock/mock_psacc.py --charging  # start plugged in and charging
```

Open Settings (⚙) and set the VIN to `VR3UKZKXZMJ000000` to match the mock.

To develop against your **real** bridge instead, put its address in `.env.local`:

```
VITE_API_PROXY_TARGET=http://192.168.1.50:5000
```

---

## Deploying

**Full step-by-step walkthrough: [`deploy/DEPLOYMENT.md`](deploy/DEPLOYMENT.md)** —
Docker networking, the bridge container, the tunnel, and Cloudflare Access.
The short version follows.

### 1. Build

```bash
npm run build     # -> dist/
```

`dist/` is fully static. `VITE_VIN` can be baked in at build time, but setting
the VIN in the app's Settings sheet is easier — it is stored per-device and
needs no rebuild.

### 2. Copy `dist/` into your nginx container

Whatever you already do for static sites. If nginx serves from a bind mount:

```bash
rsync -av --delete dist/ /srv/nginx/html/citroen/
```

Or straight into a running container:

```bash
docker cp dist/. <nginx-container>:/usr/share/nginx/html/citroen/
```

### 3. Add the server block

[`deploy/nginx-citroen.conf`](deploy/nginx-citroen.conf) is a complete, commented
server block. Edit two lines — `server_name` and `root` — then:

```bash
docker cp deploy/nginx-citroen.conf <nginx-container>:/etc/nginx/conf.d/citroen.conf
docker exec <nginx-container> nginx -t
docker exec <nginx-container> nginx -s reload
```

What it sets up, and why each part matters:

- **`/api/` → `psa_car_controller:5000/`.** The trailing slash on `proxy_pass` is
  what strips the prefix. The dev server does the same rewrite, so app code is
  identical in both environments.
- **120s proxy timeouts on `/api/`.** Waking the car takes 30–90s. Anything
  shorter returns a 504 while the car is still answering. The client gives up at
  115s so the error message is the app's, not nginx's.
- **`no-cache` on `sw.js`, `index.html`, `manifest.webmanifest`.** A stale
  service worker pinned by an intermediary makes the app impossible to update.
- **`immutable` on `/assets/`.** Hashed filenames, safe to cache for a year.
- **SPA fallback** on `/`.
- **`/bridge/`** keeps psa_car_controller's own web UI reachable for the initial
  login wizard and SMS OTP enrolment, without it owning the root path.

If your tunnel currently points at `psa_car_controller` directly, repoint the
Cloudflare Tunnel ingress at nginx and the PWA takes over the hostname.

### 4. Lock down the hostname — do this before installing

**`psa_car_controller` has no authentication of its own.** Anyone who reaches
the tunnel URL can pre-condition and reconfigure charging on your car.

Cloudflare Access is the right control here, and it works well with a PWA: it
sets a `CF_Authorization` cookie on the hostname, which the app sends
automatically (the API client uses `credentials: 'same-origin'`). Set the
session duration to a month or more so the app does not bounce you to a login
page — the whole point of this project is escaping session timeouts.

The in-app biometric/PIN lock is **not** a substitute. It is a local presence
check on the handset with no server-side verification. It stops a borrowed phone
from starting your car; it does not stop anyone who knows the URL.

Service tokens are a poor fit for browser traffic — they suit `curl` and CI, not
a PWA. Use an Access policy with an email OTP or identity provider instead.

### 5. Install on Android

Open the tunnel hostname in Chrome → menu → **Install app** / *Add to Home
screen*. The manifest declares `display: standalone`, so it launches without
browser chrome. Requires HTTPS, which the tunnel already provides.

---

## Battery safety

The doc's §5 constraint drives real behaviour in the code, not just a comment:

- **Background polls read the bridge's cache** (`?from_cache=1`) and never wake
  the car. Only a deliberate pull-to-refresh, the ⟳ button, or the follow-up
  after a command does a live read.
- **Background polling is floored at 20 minutes** (`config.ts:MIN_POLL_MINUTES`).
  The Settings slider cannot go below it. Excessive polling holds the car's ECUs
  awake and flattens the 12V auxiliary battery — a no-start, not an
  inconvenience.
- **Polling stops entirely when the app is not visible.** A PWA left open in the
  background costs nothing.
- **Returning to the app only refetches if the data is actually stale.**
  Foregrounding ten times in a minute is one poll, not ten.
- **Pull-to-refresh is the primary path** to live state, as the doc intends.
- The 12V voltage is shown in the status strip and turns amber below 12.0V.

---

## Architecture notes

```
src/
├── api/
│   ├── client.ts      every psa_car_controller URL, in one place
│   └── types.ts       Raw* (what the bridge sends) vs VehicleState (what the UI renders)
├── hooks/
│   ├── useVehicle.ts  telemetry, polling policy, visibility handling
│   ├── useCommands.ts optimistic updates + the 30-90s latency window
│   └── usePullToRefresh.ts
├── lock/              WebAuthn / PIN local lock
├── units.ts           km/mi and °C/°F conversion; display only
└── components/        presentational; none of them touch a Raw type
    ├── Widget.tsx      the tile shell every section is built from
    ├── WidgetGrid.tsx  long-press pick-up, FLIP-animated reorder, autoscroll
    └── ChargingHistoryWidget.tsx  hand-rolled SVG chart, no chart library
public/sw.js           cache-first shell, network-only /api/*
```

Two deliberate decisions worth knowing about:

**Endpoint paths are centralised in `api/client.ts::endpoints`.** The real
container has drifted from its own documentation before. If a path is wrong,
it is a one-line fix there, not a hunt through components.

**Bridge responses are normalised defensively.** Every field in `RawVehicleInfo`
is optional, because the shape varies by firmware, by trim, and by whether the
car has answered since its last deep sleep. `normalise()` in `client.ts` is the
only place that copes with it; components see a strict `VehicleState`.

### The design doc's API was partly wrong

The endpoints were verified against psa_car_controller's actual source
(`psa_car_controller/web/view/api.py`), not the design doc. Two of the doc's
four endpoints do not exist as written:

| Design doc §3.1 | Reality |
|---|---|
| `GET /get_vehicleinfo/{VIN}` | correct — plus `?from_cache=1` |
| `GET /preconditioning/{VIN}/{0\|1}` | correct |
| `GET /charge_control/{VIN}?single_threshold=` | **wrong twice** — VIN is a *query* param and the key is `percentage`: `/charge_control?vin=…&percentage=80` |
| `GET /charge_control/{VIN}?hour=&minute=` | **wrong endpoint** — that sets the *stop* hour. Deferred *start* is `/charge_hour?vin=…&hour=&minute=` |

The two halves of the charging window are genuinely different things:

- **Start** → `/charge_hour` → `remote_client.change_charge_hour(...)`, a real
  remote command that reprograms the car's own delayed-charge clock.
- **Stop** → `/charge_control?hour=&minute=` → `charge_control.set_stop_hour(...)`,
  which is psa_car_controller watching the charge and cutting it locally.

So the stop time only works while the bridge is running and configured, whereas
the start time survives in the car itself. The UI sets them independently for
that reason.

**Clearing them is asymmetric, and one case is a trap:**

- **Stop** is cleared by sending `hour=0&minute=0`. `ChargeControl.set_stop_hour`
  treats `[0, 0]` as "disabled", so **00:00 cannot be set as a stop time** — it
  clears instead. The client routes 00:00 to the clear path deliberately, and
  the card's button relabels itself to `Clear`, so the UI never claims to have
  set a midnight stop that the bridge silently discarded.
- **Start** has no "unset" at all. The car always holds an hour; what changes is
  the *charge type*. `/charge_now/{VIN}/1` sends `IMMEDIATE_CHARGE`, which makes
  the car ignore the stored hour — that is what "Charge now" does.
  `/charge_now/{VIN}/0` puts it back on `DELAYED_CHARGE` at the stored hour.

### Pre-conditioning is on/off only

There is no temperature setpoint anywhere in the chain — `RemoteClient` exposes
`preconditioning(vin, activate: bool)` and nothing more. The car heats or cools
to its own fixed target, set in the vehicle.

psa_car_controller *does* model scheduled pre-conditioning programs
(`precond_programs[vin]`, falling back to `DEFAULT_PRECONDITIONING_PROGRAM`),
which is how you would get "warm at 07:30 on weekdays". But no HTTP route
exposes them — they are read from PSACC's own stored config, so a program has to
be set in psa_car_controller's UI, not from this app. Adding it would mean
patching the bridge, not the PWA.

Two behaviours worth knowing:

- **`charge_control` is a local PSACC feature**, not a car command. It needs
  charge control configured in psa_car_controller for that VIN, otherwise it
  returns `{"error": "VIN not in list"}` — **with HTTP 200**. The client checks
  for an `error` key in the body precisely because a success status is not a
  success here.
- **`from_cache=1` reads stored state without waking the car.** Background polls
  use it; pull-to-refresh and the ⟳ button omit it for a live read. This matters
  more than the poll interval for 12V battery drain — a cached poll costs the
  car nothing at all.

### The charging curve is not available, and `kw` is not kilowatts

Two traps in the charging data:

- **`kw` is energy in kWh, not power.** PSACC computes it as
  `(level - start_level) / 100 * car.battery_power`, so the name is misleading.
  The client renames it to `energy` on the way in, so nothing downstream can
  plot it as kilowatts.
- **The speed-vs-SoC curve has no HTTP route.** `BatteryChargeCurve` is just
  `{level, speed}` and psa_car_controller does record it, but
  `Charging.get_battery_curve()` reads its SQLite database directly and no
  endpoint returns it. `/vehicles/chargings` gives completed *sessions*, not the
  shape of the charge. Getting the real curve into this app would mean adding a
  route to the bridge.

### Endpoints available but not surfaced in the UI

The bridge also exposes `/wakeup/{VIN}`,
`/lock_door/{VIN}/{0|1}`, `/horn/{VIN}/{count}`, `/lights/{VIN}/{duration}`,
`/battery/soh/{VIN}`, `/position/{VIN}`, `/get_vehicles`, `/vehicles/trips` and
`/vehicles/chargings`. These are outside the design doc's scope, so the UI does
not use them.

### The 12V voltage is often nonsense

`status.battery.voltage` is not dependable. Upstream reports it carrying a
scaled or unrelated value depending on the car
([#765](https://github.com/flobz/psa_car_controller/issues/765)), and on the
ë-C4 it can sit at a constant like `99.0` — neither a plausible 12V reading nor
a plausible traction voltage.

The status strip therefore shows the tile **only when the value could actually
be a 12V battery** (10–15.5V, per `isPlausibleAuxVoltage`). If your car reports
rubbish, the tile is simply absent. A frozen number driving a low-voltage
warning that can never fire is worse than no number: it reads as reassurance.

If you want a real battery health figure instead, `/battery/soh/{VIN}` returns
one — it is not currently surfaced in the UI.

### Things the bridge does not report back

`get_vehicleinfo` returns no charge threshold and no charge schedule, so the app
remembers the last value *it* set and shows it as a hint (`Last set to 80%`).
If you change either from the car or the official app, this display will be
stale. It is labelled as a hint rather than presented as live state.

(`/charge_control` does echo back its own config as JSON, so the threshold could
be read live if you want it — the schedule from `/charge_hour` cannot.)

---

## Verification status

Built and verified on Node 24.18.1 / npm 11.16.0.

- `npm run build` passes, including `tsc -b` under `strict` +
  `noUncheckedIndexedAccess`. Output: 217 kB JS (69 kB gzipped), 8.8 kB CSS.
- The service worker's build stamp is applied at build time, and the build now
  **fails** if the placeholder survives — it silently didn't get replaced the
  first time round.
- The dev server, its `/api` → bridge rewrite, and the Python mock were exercised
  end to end over HTTP.
- Endpoint URLs were checked line by line against psa_car_controller's source,
  and two doc errors were corrected (see above).
- `api/client.ts` was tested against the running mock: endpoint shapes, live
  fetch and normalisation, ISO-8601 duration parsing, multi-energy vehicles,
  charge-limit clamping, the sparse payloads a deep-sleeping car returns,
  PSACC's 200-with-`error` response being surfaced as a failure, and unit
  conversion in both directions.
- The full React tree was mounted in jsdom against the mock and asserted on the
  rendered DOM: battery ring, range, charging state with remaining time, cabin
  temperature, odometer, 12V voltage, and every command card, with no React
  warnings or errors. Switching to miles/°F — including via a change made in
  another tab — re-renders every value live.
- The chart's series colour was checked with a palette validator against the
  card surface, not chosen by eye: the UI mint (`#3ddc97`) sits at OKLCH L 0.797,
  outside the 0.48–0.67 dark-mode band, so the chart uses `#30ae77` — the same
  hue, one validated step darker. The generated SVG was rasterised and inspected
  for label collisions and overflow.

Not verified: real-device install and the WebAuthn lock (both need a real
browser on HTTPS), the nginx config against a live psa_car_controller, and the
exact JSON your car returns — `get_vehicleinfo` passes through the Stellantis
v4 status object, whose fields vary by trim and firmware. `normalise()` is
written to tolerate that, but check the real payload on first run.
