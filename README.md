# Citroën ë-C4 PWA

Installable Android PWA that replaces the MyCitroën app, talking to a self-hosted
`psa_car_controller` bridge through your existing nginx + Cloudflare Tunnel.

Built from `citroen_pwa_design_doc.pdf` v1.0.0. This repo is the **client layer**
only — you already have the domain, tunnel, and nginx container.

| | |
|---|---|
| Stack | Vite + React 19 + TypeScript, no UI framework |
| Output | Static `dist/` — HTML, CSS, JS, icons |
| Talks to | `psa_car_controller` via `/api/*`, proxied by your nginx |
| Shared state | A tiny stdlib-Python sidecar via `/settings/`, so household settings agree across phones — see [Shared settings](#shared-settings-across-devices) |

---

## What it does

- **Reorderable tile grid** — one scrolling dashboard rather than tabs. Long-press
  any tile (or tap the rearrange button in the app bar) to pick it up and drag it
  somewhere else; the order is shared across every device controlling this car
  (see [Shared settings](#shared-settings-across-devices)), not stored per-browser.
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
  fill line in it (charge, and the limit it fills to), a domed foot for the two
  tiles about time (the window you schedule, the record of what happened), and
  mirrored diagonal corners for the counted numbers. Tiles holding a slider or a
  chart stay rectangular — a shaped tile has no corners to put them in.
- **Pre-conditioning toggle** — with a non-blocking overlay that counts elapsed
  seconds against the 30–90s cellular wake-up window, so a slow response reads
  as normal rather than broken.
- **Charge limit** — swipe the tile up and down to set the maximum, 50–100% in
  5% steps, via PSACC's local charge control (needs it configured for your VIN —
  see below). Nothing is sent while the finger is moving; releasing commits it,
  so one decision is one command rather than a dozen wake-ups. Hold still
  instead of swiping and the tile is picked up for rearranging.
- **Charging window** — separate start and stop times, so the car only charges
  inside your off-peak tariff hours, drawn as an arc on a 24-hour dial with a
  marker for the present, so a window crossing midnight reads as a shape rather
  than as a caveat. These are two unrelated mechanisms in the bridge and can
  fail independently, so each time has its own confirm mark, which lights only
  when that field differs from what the car was last told. Both can be cleared:
  *Charge now* cancels a deferred start, *Clear stop* removes the stop time.
- **Lights** and **Horn** — one tile each, because they are not the same kind of
  decision: the lights are harmless and fire on the first tap, the horn asks for
  a second one.
- **Charging history** — energy added per session, charted from
  `/vehicles/chargings`, over a strip of totals, with a table view. Tap a bar
  for that session's detail: where in the battery it charged (20→80% is not the
  same event as 60→100%), how long it took, and what it cost.
- **Electricity tariff** — day and night rates in p/kWh plus the hours the night
  rate applies, and each session's cost is split across the two by the time it
  spent in each. The bridge's own flat-rate figure is the fallback. See
  [Session cost](#session-cost-is-worked-out-in-the-app-not-taken-from-the-bridge).
  There is one electricity contract for the car, so the tariff is shared across
  devices too.
- **Units** — km/miles and °C/°F, switchable in Settings, applied instantly.
  Kept per-device, deliberately — see
  [Shared settings](#shared-settings-across-devices).
- **Pull-to-refresh** — the primary way to get live state, because background
  polling is deliberately throttled (see [Battery safety](#battery-safety)). It
  stands down while the settings sheet is open or the grid is being rearranged,
  since those want the same downward drag.
- **App lock** — WebAuthn biometrics or a local PIN, re-armed when the app has
  been backgrounded for over a minute.
- **Offline launch** — cache-first service worker; the shell opens instantly
  with no network, then fetches live state.

---

## Quick start (local, no car involved)

Needs Node 20+ (developed on 24.18.1) and Python 3 for the mock.

```bash
npm install
npm run mock             # terminal 1 — mock bridge, python stdlib only
npm run settings-store   # terminal 2 — shared settings store, same style
npm run dev              # terminal 3 — http://localhost:5173
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
the VIN in the app's Settings sheet is easier — it is picked up by every
device from the shared settings store (below) and needs no rebuild.

### 1b. Start the shared settings store

```bash
docker compose -f deploy/docker-compose.settings.yml up -d
```

This is what lets every phone controlling the car see the same VIN, tariff,
dashboard layout and charge hints, instead of each browser keeping its own —
see [Shared settings](#shared-settings-across-devices). It needs
`deploy/settings_store.py` copied alongside the compose file on the server,
same as `nginx-citroen.conf` needs to sit next to `DEPLOYMENT.md`.

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
│   ├── client.ts          every psa_car_controller URL, in one place
│   ├── types.ts           Raw* (what the bridge sends) vs VehicleState (what the UI renders)
│   └── sharedSettings.ts  syncs VIN/tariff/layout/charge-hints with the settings store
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

### Session cost is worked out in the app, not taken from the bridge

`/vehicles/chargings` returns a `price` per session, but PSACC computes it from
the single flat rate in its own config. That is wrong for any time-of-use
tariff, and wrong in the direction that matters: it prices a charge that ran
entirely inside the cheap overnight window at the day rate, which hides exactly
the saving the charging window was set up to make.

So **Settings → Electricity** takes a day rate, a night rate and the hours the
night rate applies, all in p/kWh and local wall-clock time. `src/tariff.ts` then
splits each session's energy across the two rates in proportion to the minutes
it spent in each (`nightMinutes` handles a window that crosses midnight, and a
session that runs past more than one night). The bridge's `price` is used only
when no tariff has been entered.

Two caveats:

- **The split is pro rata by time**, which assumes constant power for the whole
  session. Charging tapers as the battery fills, so a session that leaves the
  cheap window in its last hour is charged slightly more day-rate energy here
  than it really used. Fixing this properly needs the charging curve, which the
  bridge records but does not expose — see above.
- **The tariff window is not the charging window.** The tariff says what power
  costs; the charging window on the dashboard says when the car draws it. They
  are usually set to overlap, but nothing forces that, and the cost is computed
  from when the car actually charged.

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
remembers the last value *any device* set and shows it as a hint (`Last set to
80%`). That hint is shared across devices the same way the tariff and layout
are — see [Shared settings](#shared-settings-across-devices) — since it
describes the car, not whichever phone last touched it. If you change either
from the car or the official app, this display will be stale either way. It is
labelled as a hint rather than presented as live state.

(`/charge_control` does echo back its own config as JSON, so the threshold could
be read live if you want it — the schedule from `/charge_hour` cannot.)

---

## Shared settings across devices

Everyone in the household controls the same one car, so the settings that
describe *the car* — VIN, background poll interval, electricity tariff,
dashboard layout, and the "last set" charge start/stop/limit hints — are
shared across every phone, not stored per-browser. Settings that describe the
*viewer* instead — theme, distance/temperature units, the app lock's PIN or
biometric enrolment — stay in that browser's own `localStorage`, since there is
no single correct answer for those across a household (and a shared PIN would
defeat the point of a *local* presence check).

This is the one place the PWA is no longer purely static: a small sidecar,
`deploy/settings_store.py`, holds the shared settings as one JSON file and is
reached at `/settings/` the same way `psa_car_controller` is reached at
`/api/` — see `deploy/docker-compose.settings.yml` and the matching nginx
location. It has no schema of its own; each client module
(`config.ts`, `tariff.ts`, `useWidgetOrder.ts`, the charge widgets) validates
the slice it reads defensively, the same stance `api/client.ts` already takes
with the bridge's own payloads, so a stale or malformed field never crashes the
app — it just falls back to that field's default.

`src/api/sharedSettings.ts` fetches the blob once at boot and again whenever
the app is foregrounded, mirrors it to `localStorage` so the app still opens
instantly offline (the same cache-first stance the service worker takes with
the shell), and applies local edits optimistically before sending them to the
store in the background. It is last-write-wins: good enough for a few people
sharing one car, not built for simultaneous editors. A device that is briefly
offline keeps its own change; the next successful read or write from any
device reconciles it.

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
