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
- **Odometer** — tap it to cycle the total, this week's distance and this
  month's, summed from `/vehicles/trips`. The periods are calendar ones —
  Monday to Sunday, the 1st of the month onward — rather than a trailing 30
  days, so the figure means the same thing each time you look at it. Trips are
  fetched on the first tap, not on load: each one carries its whole GPS track.
- **Efficiency** — kWh/100km over the same calendar week and month, in miles per
  kWh if that is the unit you have chosen, because the two are quoted opposite
  ways up and printing "kWh/100mi" would read as a foreign number. Summed energy
  over summed distance, never an average of the bridge's per-trip rates, so a
  motorway run counts for more than a crawl to the shops. It shares the
  odometer's trip data: one tap on either loads it for both, and a session where
  neither is touched never pays for the largest read the app makes.
- **Battery health** — what the traction battery still holds against what it
  left the factory with, from `/battery/soh/{VIN}`. Read once a session, since
  it moves by a percent or two a year, and shown only when the bridge has a
  figure that could actually be a state of health. Under 70% it turns amber:
  that is the floor the battery warranty is written to, so a reading below it is
  a claim rather than a curiosity.
- **A shape per tile**, after Material 3 Expressive's shape set, so the grid is
  legible before a word of it is read: lobed silhouettes for the soft or
  radiating quantities (cabin warmth, moving air, light, sound), a circle where
  the tile's own edge is an instrument (12V), a domed top for anything with a
  fill line in it (charge, and the limit it fills to), a domed foot for the two
  tiles about time (the window you schedule, the record of what happened), and
  mirrored diagonal corners for the counted numbers. Tiles holding a slider or a
  chart stay rectangular — a shaped tile has no corners to put them in.
- **Pre-conditioning** — tap the tile twice to start the climate, twice again to
  stop it; while it is actually running the tile's outline stays lit with one
  slow highlight travelling round it. Both directions ask twice because both
  mistakes cost something: starting it drains a parked car, stopping it throws
  away a warm cabin you cannot get back before you leave. A non-blocking overlay
  counts elapsed seconds against the 30–90s cellular wake-up window, so a slow
  response reads as normal rather than broken, and the tile holds what you asked
  for until the car confirms it — see
  [Pre-conditioning](#pre-conditioning-is-onoff-only).
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
  when that field differs from what the car was last told. *Clear stop* removes
  the stop time.
- **Charge type**, on the same tile — whether the car is *using* that window
  (`DELAYED_CHARGE`) or charging the moment it is plugged in (`IMMEDIATE_CHARGE`),
  as a two-way switch rather than the one-way *Charge now* button this used to
  be. The two are separate settings in the car and only the hour is ever
  reported back, so a car left on immediate goes on showing 23:00 on its own
  dashboard, on this tile, and in `next_delayed_time` while charging at one in
  the afternoon. The switch is lit by what the car is *doing*, not by what was
  last tapped — outside its own window the two types are told apart by whether
  it charges or waits, and the tile says which it saw ("Plugged in and waiting
  for 23:00", "On immediate charge — 23:00 stays stored but unused") rather than
  asserting a setting nothing reports. See
  [Things the bridge does not report back](#things-the-bridge-does-not-report-back).
- **Lights** and **Horn** — one tile each, because they are not the same kind of
  decision: the lights are harmless and fire on the first tap, the horn asks for
  a second one.
- **Charging history** — energy added per session, charted from
  `/vehicles/chargings`, over a strip of totals, with a table view. The window
  is 10, 30 or every session the bridge holds: the shape of a year is a
  different question from the shape of a month, and a battery taking less energy
  per session is only visible from further back. Above it, month-to-date energy
  and spend against the calendar — the period an electricity bill actually
  arrives for, and the one figure here that does not move when the window does.
  Pick a session, from the chart or from the table, for its detail: where in the
  battery it charged (20→80% is not the same event as 60→100%), how long it
  took, and what it cost.
- **Electricity tariff** — day and night rates in p/kWh plus the hours the night
  rate applies, and each session's cost is split across the two by the time it
  spent in each. The bridge's own flat-rate figure is the fallback. See
  [Session cost](#session-cost-is-worked-out-in-the-app-not-taken-from-the-bridge).
  There is one electricity contract for the car, so the tariff is shared across
  devices too.
- **Home screen widget**, from the optional Android wrapper in `android/` — the
  charge ring and range on the launcher, without opening anything. No browser
  can put a widget on an Android home screen, so this is a small native app
  that runs the same PWA as a Trusted Web Activity and carries the widget
  alongside it. See [The Android wrapper](#the-android-wrapper).
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
  with no network, then fetches live state. The last successful reading is kept
  on the device, so a cold start with no signal at all opens on the charge,
  range and location the car last reported, under a banner saying how old that
  is — a car park is exactly where someone wonders what the charge was. Being
  offline is reported as itself rather than as a broken bridge, polls are not
  attempted into a dead radio, and the app refreshes on its own the moment
  signal returns.
- **Charging notifications** — Web Push when a charge starts, and when the
  battery reaches the Charge limit tile's setpoint (100% if that isn't
  configured), delivered even with the app closed and the phone asleep —
  see [Deploying](#deploying) and `deploy/charge_notify.py`. Two independent
  switches, both off by default and both chosen per device, since not everyone
  in the household necessarily wants to hear about either.

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
python mock/mock_psacc.py --immediate # charging on IMMEDIATE_CHARGE with 23:00–07:00
                                      # stored: a schedule reported but ignored
```

The mock models the charge *type* as well as the hours, since the two together
are what make a deferred start work or silently not (see [The design doc's API
was partly wrong](#the-design-docs-api-was-partly-wrong)). `--immediate` is
that failure standing still: the window is set, `next_delayed_time` reports it,
and the car charges anyway. `/charge_now/{VIN}/0` from the tile's charge-type
switch stops it, and — as on the real car — so does setting any start hour,
which is the confusing part worth being able to see.

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
│   ├── sharedSettings.ts  syncs VIN/tariff/layout/charge-hints with the settings store
│   └── snapshot.ts        the last reading, kept on the device for a cold start
├── hooks/
│   ├── useVehicle.ts  telemetry, polling policy, visibility handling
│   ├── useCommands.ts optimistic updates + the 30-90s latency window
│   ├── useTrips.ts    one trip fetch, shared by the odometer and efficiency
│   ├── useOnline.ts   whether the device has a radio, not whether the bridge answers
│   └── usePullToRefresh.ts
├── lock/              WebAuthn / PIN local lock
├── units.ts           km/mi and °C/°F conversion; display only
├── periods.ts         calendar week/month boundaries; distance and energy summed over them
└── components/        presentational; none of them touch a Raw type
    ├── Widget.tsx      the tile shell every section is built from
    ├── WidgetGrid.tsx  long-press pick-up, FLIP-animated reorder, autoscroll
    └── ChargingHistoryWidget.tsx  hand-rolled SVG chart, no chart library
public/sw.js           cache-first shell, network-only /api/*
```

Three deliberate decisions worth knowing about:

**Endpoint paths are centralised in `api/client.ts::endpoints`.** The real
container has drifted from its own documentation before. If a path is wrong,
it is a one-line fix there, not a hunt through components.

**Bridge responses are normalised defensively.** Every field in `RawVehicleInfo`
is optional, because the shape varies by firmware, by trim, and by whether the
car has answered since its last deep sleep. `normalise()` in `client.ts` is the
only place that copes with it; components see a strict `VehicleState`.

**The dashboard opens on what it last knew, not on nothing.** Every successful
poll writes a `VehicleState` to `localStorage`; `useVehicle` opens on it and
replaces it when the first poll of the session lands. Only a reading is ever
stored — the optimistic patches applied while a command is in flight are
expectations, and persisting one would be the app remembering something the car
never confirmed. A snapshot belonging to a different VIN is discarded rather
than shown.

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

**The type is a setting, not a momentary override, and it is invisible.** Both
directions are one message with one field swapped — `RemoteClient` sends the
hour and the type together — which has three consequences worth stating plainly,
because between them they produce a car that ignores a schedule it is still
displaying:

- `IMMEDIATE_CHARGE` persists across unplugging. A "Charge now" pressed once to
  get a charge going this evening is still in force next week.
- Nothing reports the type back. `next_delayed_time` carries the stored *hour*
  and keeps carrying it either way, so the car's dashboard, the bridge and this
  app all go on showing a window that is not being used.
- `/charge_hour` carries `type=delayed` with the hour, so setting *any* start
  time silently takes the car off immediate charge — and pauses the charge
  running at the time if it is outside the new window. That is why re-setting the
  schedule looks like it fixes the problem: it does, but as a side effect.

The charge-type switch on the tile is the direct way back, and
`observeChargeType` (`src/chargeWindow.ts`) is how the app tells you it is
needed without a field to read.

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

Whether it is *running*, though, is reported: `preconditionning.air_conditioning
.status` in the vehicle payload, mapped to on / off / finished / unknown in
`api/client.ts`. So the tile shows what the car says, not what was last asked of
it — which is why it can light its outline for a session someone started from
another phone, and why it goes dark on its own when the car stops.

The one exception is the few minutes after a command. The post-command refresh
usually lands while the car is still waking, and the car honestly reports the
*old* status — so the tile holds what was asked for over the reported value
until the car agrees, or for four minutes, whichever comes first. Unbounded, a
request the car quietly dropped would leave the tile lying about it forever.

Two more behaviours worth knowing:

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

`/position/{VIN}` and `/get_vehicles` are outside the design doc's scope, so the
UI does not use them.

`/battery/soh/{VIN}` used to be on this list and now feeds the Battery health
tile. It is read defensively, because unlike the routes above it its response
shape is not pinned down anywhere this app can rely on: a bare number, a `{soh}`
object and a list of dated readings are all accepted, the newest wins, and
anything else — including a value outside 50–100%, which cannot be a state of
health on a car that still drives — resolves to no tile at all. It never
contacts the car, so it costs nothing but the request.

One caveat on `/vehicles/trips`, which the odometer and efficiency tiles both
use: `Trip.get_info()` emits no `vin`, so on a PSACC instance serving more than
one car the trips cannot be told apart and the week/month figures would cover
all of them. This app is single-VIN, so it does not arise here. The response
also carries per-trip `consumption` (kWh) and `consumption_km`; the efficiency
tile sums the former against `distance` rather than averaging the latter, and a
trip missing either number is left out of both halves of the ratio instead of
contributing distance the car apparently covered on no energy.

Note also that Flask serialises each `start_at` as an RFC 1123 HTTP-date (`Wed, 05 Aug 2026 07:12:33
GMT`) rather than ISO 8601 on Flask &lt; 2.3 — `new Date` reads both, and the
mock sends the RFC 1123 form so that path stays exercised.

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

Door lock state, mainly — `get_vehicleinfo` has no field for it, so Lock is
fire-and-forget like Horn and Lights: the tile has no idea whether the doors
are actually locked, only what was last asked for.

Charge threshold and charge schedule *used to* be on this list too, and the
app used to paper over it the same way: remember the last value any device
sent and show that as a hint, labelled as such rather than presented as live
state. That was wrong in a way that mattered — a stop hour PSACC silently
dropped (a re-auth after a connectivity outage does this; see
`docker-compose.yml`'s `app_decoder.py` patch in the bridge's own deploy
notes) kept showing as still set, with nothing to make the drift visible.

Both are read live now instead:

- **Charge limit / stop hour** — `/charge_control?vin=` with no
  hour/minute/percentage params is read-only (`get_charge_control` in the
  bridge's `api.py` only mutates when those are present) and echoes back its
  current config either way. `api/client.ts::fetchChargeControlState` calls
  it every poll.
- **Charge start hour** — `get_vehicleinfo`'s `next_delayed_time` field
  *does* carry it, just not as the RFC3339 timestamp its own swagger doc
  claims — in practice it's the same `PT#H#M` duration shape
  `remaining_time` uses (`"PT23H"` for a 23:00 stored hour), confirmed
  against the bridge's own `parse_hour` (`common/utils.py`), which every
  `charge_now`/`get_charge_hour` call relies on to read this exact field
  the same way. See `hhmmFromDuration` in `api/client.ts`. A car holding no
  delayed time at all sends `"PT0S"`, which is *not* midnight — both parts of
  the shape are optional, and a duration carrying neither is no hour.

Both tiles fall back to "not configured" honestly (see `chargeControlConfigured`
on `VehicleState`) rather than showing a number nothing on the car is
actually holding.

**The charge type is still on this list, and cannot be taken off it.** Whether
the car is on `IMMEDIATE_CHARGE` or `DELAYED_CHARGE` decides whether the start
hour above means anything, and no endpoint reports it — `next_delayed_time`
carries the stored hour in both cases. A schedule silently stops being honoured
and every reading, including the car's own dashboard, goes on agreeing that it
is set.

So it is the one thing here that is *inferred*, in `src/chargeWindow.ts`. The
inference rests on a single fact: **outside its own window, the two types
behave differently**, and that difference is reported.

- **Charging out there → `IMMEDIATE_CHARGE`.** It is not honouring the hour;
  there is no other way to read it, and the tile says so in warning colour.
- **Plugged in and waiting out there → `DELAYED_CHARGE`.** A car on immediate
  would have started when it was plugged in.

Where no stop hour bounds the window, "outside" means more than 12 hours past
the start (`ASSUMED_MAX_CHARGE` — about half again what an e-C4 needs to fill
from empty on 7 kW). Three readings are excluded rather than guessed at: inside
the window both types charge; a car at or above its limit has a reason to be
idle that has nothing to do with the hour; and rapid charging starts on
handshake whatever the schedule says, so a Quick session outside the window is
not evidence and warning about it would fire on every motorway stop.

The second reading is the weaker of the two — a charger doing its own
scheduling at the wall leaves a genuinely-immediate car sitting exactly like a
well-behaved one — which is why the tile shows the behaviour it read rather
than the setting it inferred. "Plugged in and waiting for 23:00" is something
you can walk outside and check; "on schedule" would be the app's word for it
and nothing more.

With no reading available the switch shows this device's own last command, said
as such ("Set to charge now from this phone"), and with neither it says why it
has nothing — unplugged, mostly. Two rules keep that hint from hardening into a
claim, and both took a go to get right:

- **An observation is never written down.** It is true in the present tense
  only: a car charging outside its window says nothing about the car an hour
  after it stopped. Remembering one meant a car that had been on immediate went
  on being described that way long after a start hour had put it back — the
  first cut of this tile did exactly that, and reported a correctly-deferring
  car as ignoring its schedule.
- **A command outranks the reading it was sent against.** The car takes 30–90s
  to act, so the reading on screen when you press is necessarily from before you
  pressed. Until the car has reported something *since* — a comparison of what
  the car said, not of two clocks — the tile shows what was asked for. Without
  that, pressing Schedule on a charging car is answered by the tile insisting,
  from the stale reading, that it is still on immediate. Once the car has
  answered and disagrees, the hint is dropped rather than kept for the next time
  the car is unplugged and unreadable.

The hint lives in component state and dies with the session — one that outlives
the session it was made in is indistinguishable from a reading, which is the
mistake the paragraph above this one is about.

---

## The Android wrapper

`android/` is optional, and exists for one reason: **a PWA cannot put a widget
on an Android home screen.** Chrome doesn't implement the Badging API there
either, so neither the launcher icon nor a widget can carry the state of
charge. Only a real APK can.

It is a **Trusted Web Activity**, not a WebView wrapper, and the distinction is
the whole design. A TWA is Chrome rendering the site full-screen without
browser chrome, so the web app keeps Chrome's storage: the Cloudflare Access
cookie still authenticates it, the service worker still serves it offline, and
the existing Web Push subscription still delivers the charge notifications
(delegated so they arrive as *ë-C4* rather than as *Chrome*). A `WebView` would
have its own cookie jar, no Web Push at all, and would mean logging into Access
inside it.

**What wrapping does not buy.** The widget cannot see the web app. A widget is
`RemoteViews` drawn by the launcher's process; it cannot render a page, and
native code cannot read Chrome's cookies. So it is a sibling of the PWA in one
APK, not a view of it — it makes its own request, with its own credential:

- **A Cloudflare Access service token**, the machine-traffic case this README
  already distinguishes from browser traffic, scoped in Access to
  `/api/get_vehicleinfo` alone. It lives in an APK on a phone, and the bridge
  behind it has no authentication of its own — a token that could also reach
  `/preconditioning` is a car key on the lock screen.
- **`?from_cache=1`**, so the 15-minute refresh reads the bridge's stored state
  and never wakes the car. A widget on the live endpoint would quietly undo
  [Battery safety](#battery-safety).

Its readings are held to the same standard as the tiles': a failed refresh
keeps the last good number and says why it is old rather than blanking, the
ring uses the same three severity colours as the charge tile, and a reading
older than 45 minutes says its age instead of its range — the same threshold
`App.tsx` calls stale.

Nothing about the web app depends on any of this. `npm run build` neither knows
nor cares that `android/` exists; the only thing the two share is
`public/.well-known/assetlinks.json`, which ships in `dist/` and is what tells
Chrome the APK may act for the domain.

Building it needs no toolchain on your part — `.github/workflows/android.yml`
produces a signed APK as a run artifact. The signing key is deliberately not in
this repo: `deploy/make-signing-key.sh` mints it, writes the asset-links file
for it, and prints the base64 to paste into a GitHub secret. Full walkthrough,
including the two Access policies it needs, is
[step 9 of DEPLOYMENT.md](deploy/DEPLOYMENT.md#9-the-android-wrapper-and-its-home-screen-widget-optional).

---

## Shared settings across devices

Everyone in the household controls the same one car, so the settings that
describe *the car* — VIN, background poll interval, electricity tariff, and
dashboard layout — are shared across every phone, not stored per-browser.
(Charge start/stop/limit no longer live here at all — see [Things the bridge
does not report back](#things-the-bridge-does-not-report-back) — they're read
live from the car/bridge instead of cached in this blob.) Settings that
describe the *viewer* instead — theme, distance/temperature units, the app
lock's PIN or biometric enrolment — stay in that browser's own `localStorage`,
since there is no single correct answer for those across a household (and a
shared PIN would defeat the point of a *local* presence check).

Push subscriptions (see ["Charging notifications"](#what-it-does) above) are
the one field here that is per-device data living in a shared blob rather than
a household-wide preference: each phone's endpoint is unique to that phone,
and so is its choice of which of the two notifications it wants (stored as an
`events` object on its own entry), but *the list of who to notify* still has
to be shared so `deploy/charge_notify.py` — which has no browser of its own —
can read it.

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
  `noUncheckedIndexedAccess`. Output: 276 kB JS (87 kB gzipped), 32 kB CSS
  (7.3 kB gzipped).
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
- The offline path was driven end to end in a headless browser against the
  production build: with the network cut entirely, a reload is served the shell
  by the service worker and the dashboard comes up on the stored reading, under
  the banner that dates it. Restoring the connection clears the banner and
  repolls without a reload.
- Battery health was exercised against every shape the route might answer with —
  a bare figure, a dated history, a 404 from a bridge that predates it, and a
  value that cannot be a state of health — and the tile appears only in the two
  cases where the answer means something.
- The charge-type inference was driven from the rendered DOM rather than from
  the function: a car charging outside its window, one waiting outside it, one
  idle at its limit, one unplugged, one rapid-charging outside it, one charging
  inside it, and a window with no stop hour at 3 and at 14 hours past the start
  — the tile reads the type in exactly the two cases the car's behaviour
  separates them, and names what it read in the rest. `next_delayed_time` was
  checked at `PT23H`, `PT7H30M`, `PT30M`, `PT0S`, absent and malformed. The
  charge-type transitions were then run end to end against the mock, including
  the one that confuses: setting a start hour on a car charging outside the new
  window pauses the charge.
- The tile was then driven through the state changes in a real browser, not just
  rendered: a car seen ignoring its window and then waiting (the observation is
  not remembered, and the waiting car reads as scheduled), a command surviving
  both the reading it was sent against and a re-render of it, the same command
  overridden by the next reading that disagrees and kept by one that reads
  nothing, and Schedule pressed on a charging car not being argued with by the
  stale reading it was sent against.
- The tile was rasterised at 300, 340 and 420px to confirm the charge-type row
  drops to its own line rather than breaking "Charge now" across two.
- The charting was re-checked at 64 sessions, not just the six the mock ships:
  bar width, date-label thinning, and the free-charge mark were all confirmed by
  rasterising the tile, which is how the axis collision between a selected label
  and a scheduled one was found and fixed.

Not verified: real-device install and the WebAuthn lock (both need a real
browser on HTTPS), the nginx config against a live psa_car_controller, and the
exact JSON your car returns — `get_vehicleinfo` passes through the Stellantis
v4 status object, whose fields vary by trim and firmware. `normalise()` is
written to tolerate that, but check the real payload on first run.
