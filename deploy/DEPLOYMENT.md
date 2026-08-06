# Deploying to your domain

You already have a domain, a Cloudflare Tunnel, and nginx in Docker. This adds
three things behind that nginx: the `psa_car_controller` bridge, the shared
settings store, and the built PWA as static files.

```
phone ──HTTPS──▶ Cloudflare edge ──tunnel──▶ cloudflared ──▶ nginx ──┬─▶ /           dist/  (static PWA)
                       │                                              ├─▶ /api/*     psa_car_controller:5000
                  Access policy                                      │                   │
                (this is your only                                   │                   └──▶ Stellantis
                 real access control)                                │                        (direct, no VPN)
                                                                      └─▶ /settings/  settings_store:8090
```

The whole thing hinges on one fact: **nginx, psa_car_controller and
settings_store must all be on the same Docker network**, so that
`proxy_pass http://psa_car_controller:5000/` and
`proxy_pass http://settings_store:8090/` resolve by container name.

---

## 1. Find the network your nginx is on

```bash
docker ps --format '{{.Names}}'
docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' <nginx-container>
```

Note that network name. If nginx is only on its compose project's default
network, create a shared one and attach nginx to it:

```bash
docker network create proxy
docker network connect proxy <nginx-container>
```

(Better: add `networks: [proxy]` to nginx's own compose file so it survives a
recreate.)

## 2. Start the bridge

Copy `docker-compose.psa.yml` to your server, set the `name:` under `networks:`
to the network from step 1, then:

```bash
docker compose -f docker-compose.psa.yml up -d
docker logs -f psa_car_controller
```

Check nginx can see it:

```bash
docker exec <nginx-container> wget -qO- http://psa_car_controller:5000/get_vehicles
```

If that resolves, the networking is right. If it fails with a DNS error, the two
containers are not on the same network.

## 2b. Start the shared settings store

This is what lets every phone controlling the car see the same VIN, tariff,
dashboard layout and charge hints, instead of each browser keeping its own —
see the README's [Shared settings across devices](../README.md#shared-settings-across-devices).

Copy `docker-compose.settings.yml` **and** `settings_store.py` to your server
(the compose file bind-mounts the script — there's no image to build), set the
`name:` under `networks:` to the same network as step 1, then:

```bash
docker compose -f docker-compose.settings.yml up -d
docker logs -f settings_store
```

Check nginx can see it the same way as the bridge:

```bash
docker exec <nginx-container> wget -qO- http://settings_store:8090/
```

An empty `{}` is a healthy answer — it just means nothing has been saved yet.

## 2c. Start the charging notifications (optional)

Push notifications for a charge starting, and for one reaching its setpoint,
delivered even with the phone asleep and no tab open — see charge_notify.py
for why this has to be a separate always-running process rather than
something the PWA's own poll loop can catch, and why "the setpoint" means
whatever PSACC's charge control is configured to (percentage_threshold), not
a value configured twice. Each phone picks which of the two it wants, in
Settings; this one service covers both.

Generate a keypair (`generate_vapid_keys.py` explains the one-liner), then on
the server:

```bash
mkdir -p notify_data
cp .env.example .env
$EDITOR .env   # paste VAPID_PRIVATE_KEY and set VAPID_SUBJECT
docker compose -f docker-compose.notify.yml up -d
docker logs -f charge_notify
```

Put the *public* half in the PWA's own `.env` as `VITE_VAPID_PUBLIC_KEY`
before step 4's build — a build without it makes push notifications quietly
unavailable (Settings shows the toggle disabled) rather than broken, so
this step is easy to skip by accident and not notice until someone asks
where their notification went.

Skippable entirely: the rest of the app works the same without it, the
Settings toggle just won't do anything (`isPushSupported()` returns false
without a public key baked into the build).

## 3. Do the first-time setup on the LAN, before exposing anything

The bridge has **no authentication of its own**. Finish setup privately first.

Open `http://<server-ip>:5000` (or tunnel over SSH:
`ssh -L 5000:127.0.0.1:5000 you@server`) and work through the wizard:

1. Enter your MyCitroën account and pick the correct country/brand.
2. Complete the SMS/OTP challenge — this registers the container as a trusted
   device. This is the step that writes the credentials you must not lose.
3. Confirm your VIN appears, and that `/get_vehicleinfo/<VIN>` returns JSON.
4. **Enable recording** and **set up charge control** while you are here:
   - Recording populates the trips/charges database. The app's charging history
     chart reads it via `/vehicles/chargings`; without recording it stays empty.
   - Charge control is what enforces the charge limit and the charging stop
     time. Without it, both return `{"error": "VIN not in list"}` and the app
     will (correctly) show an error.

Back up `./psa_config` once this works. Losing it means redoing the OTP
enrolment.

## 4. Build the PWA and put it where nginx can serve it

On your workstation:

```bash
npm install
npm run build          # -> dist/
```

If you set up step 2c, make sure `VITE_VAPID_PUBLIC_KEY` (the *public* half
of that keypair) is in whatever `.env`/`.env.local` this build reads before
running it — baked in at build time, not runtime, so a rebuild is needed
after changing it.

Copy `dist/` to the server, e.g. `/srv/citroen/`, and mount it into nginx. In
nginx's compose file:

```yaml
    volumes:
      - /srv/citroen:/usr/share/nginx/html/citroen:ro
```

A bind mount means future updates are `rsync` + a browser refresh, with no
container rebuild:

```bash
rsync -av --delete dist/ you@server:/srv/citroen/
```

## 5. Add the nginx server block

Copy `nginx-citroen.conf` into nginx's `conf.d/`, and edit two lines:

- `server_name` → your tunnel hostname
- `root` → `/usr/share/nginx/html/citroen` (wherever you mounted `dist/`)

```bash
docker cp deploy/nginx-citroen.conf <nginx-container>:/etc/nginx/conf.d/citroen.conf
docker exec <nginx-container> nginx -t
docker exec <nginx-container> nginx -s reload
```

`nginx -t` failing with `host not found in upstream "psa_car_controller"` means
step 1 isn't done — nginx resolves upstreams at config load.

## 6. Point the tunnel at nginx

**If cloudflared runs in Docker** on the same network, use the container name:

```yaml
ingress:
  - hostname: citroen.yourdomain.com
    service: http://nginx:80
  - service: http_status:404
```

**If cloudflared runs on the host**, use whatever port nginx publishes:

```yaml
ingress:
  - hostname: citroen.yourdomain.com
    service: http://localhost:8080
  - service: http_status:404
```

Then add the DNS route (once):

```bash
cloudflared tunnel route dns <tunnel-name> citroen.yourdomain.com
```

Restart cloudflared and load `https://citroen.yourdomain.com`. You should get
the app shell.

## 7. Lock it down — before you install it on your phone

Until you do this, **anyone with the URL can pre-condition and reconfigure
charging on your car.** The in-app PIN/biometric lock does not help; it is a
local check with no server-side verification.

In Cloudflare Zero Trust → Access → Applications:

- Add a self-hosted application for `citroen.yourdomain.com`.
- Policy: Allow → Emails → your address (one-time PIN is fine).
- **Set the session duration to a month or more.** Short sessions bounce the PWA
  to a login page, which is exactly the annoyance this project exists to escape.

Don't use a service token here — those suit `curl` and CI, not a browser. The
Access cookie is what the PWA relies on; the API client sends
`credentials: 'same-origin'` so it rides along automatically.

Finally, remove the `ports:` block from `docker-compose.psa.yml` and recreate
the container, so port 5000 isn't reachable even from the LAN.

## 8. Install on the phone

Open the hostname in Chrome on Android → menu → **Install app**. It launches
standalone, no browser chrome.

In the app: **⚙ → set your VIN → Save**. That VIN, and the tariff and layout
you set up from here, apply to every phone that opens the app — see the
README's [Shared settings across devices](../README.md#shared-settings-across-devices).
Units and the app lock are per-device, so set those separately on each phone.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `nginx -t`: *host not found in upstream* | Containers not on the same Docker network (step 1) |
| App loads, every value is `—`, "Cannot reach the bridge" | `/api/` proxy wrong, or the bridge is down. Test `curl https://host/api/get_vehicleinfo/<VIN>` |
| "Session expired. Reload to sign in again." | Cloudflare Access returned its login HTML. Re-authenticate, and raise the session duration |
| "No VIN configured" | Set it in ⚙ |
| VIN/tariff/layout differ between phones, or a phone reverts to defaults after being offline | `settings_store` unreachable or not started (step 2b). Test `curl https://host/settings/` — an empty `{}` means it's up but nothing's been saved from that request yet |
| Charge limit / stop time error `VIN not in list` | Charge control not set up in the bridge (step 3) |
| Charging history empty | Recording not enabled, or no completed sessions yet (step 3) |
| Commands time out after ~2 min | Normal if the car is in deep sleep and unreachable; otherwise check the bridge logs |
| Frequent OAuth logouts | The bridge is behind a VPN. Take it off Gluetun — Stellantis drops sessions on IP hops |
| App updates don't appear | `sw.js` or `index.html` being cached upstream. The provided config sets `no-cache`; also purge the Cloudflare cache |
| Home-screen icon is a generic globe / screenshot | See below — the manifest is failing to load behind Access |

## The icon doesn't appear on the home screen

Browsers fetch the web app manifest with credentials mode **omit** by default,
*even same-origin*. Behind Cloudflare Access that unauthenticated request gets
redirected to the login page, the manifest never parses, and Android falls back
to a generic icon.

`index.html` therefore carries:

```html
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />
```

If the icon is still wrong after deploying a build that includes it:

1. **Reinstall the app.** The manifest is read at install time, so an app
   installed before the fix keeps the old icon forever. On Android: long-press
   the icon → Uninstall, then in Chrome → ⋮ → Settings → Site settings → All
   sites → your hostname → *Clear & reset*, then reinstall.
2. **Check the files are actually served**, authenticated:
   ```bash
   curl -I https://<your-host>/manifest.webmanifest
   curl -I https://<your-host>/icons/icon-192.png
   ```
   Both should be `200`. A `302` to a Cloudflare login URL means Access is
   intercepting them.
3. **If they still 302**, add a Cloudflare Access *Bypass* policy for the paths
   `/manifest.webmanifest` and `/icons/*`. Neither contains anything sensitive —
   they are a name, some colours, and a picture of a battery — so exempting them
   costs nothing and leaves every `/api/*` route protected.
