# Prompt for Claude Code running on the server

Copy everything in the block below, fill in the four `<<< >>>` placeholders, and
paste it as your first message to Claude Code on the server.

---

````text
I want to deploy a Citroën ë-C4 control PWA and its API bridge behind the nginx
container and Cloudflare Tunnel I already run on this server.

The repo is https://github.com/WJStephenson/citroen — clone it somewhere sensible
and READ `deploy/DEPLOYMENT.md` FIRST. That file is the spec; it explains the
architecture, the exact nginx server block, and a compose file for the bridge.
`deploy/nginx-citroen.conf` and `deploy/docker-compose.psa.yml` are meant to be
adapted to what is actually on this machine, not copied blindly.

My details:
  domain / tunnel hostname : <<< citroen.example.com >>>
  cloudflare tunnel name   : <<< my-tunnel >>>
  where static sites live  : <<< /srv/www — or "you tell me, follow the existing convention" >>>
  my VIN                   : <<< VR3... — or "I'll set it in the app myself" >>>

## Work in two phases

PHASE 1 — discover, then propose. Change nothing yet.

Find out how this server is actually set up, because I don't want you assuming:
  - every running container, and which are nginx and cloudflared
  - the nginx container's name, where its config lives, and how that config is
    mounted (bind mount? named volume? baked into an image?)
  - which Docker network(s) nginx is on
  - how cloudflared is run (container or host service) and where its config.yml
    and ingress rules are
  - where existing static sites are served from, and the convention they follow
  - whether any VPN/egress container (Gluetun or similar) is in play
  - whether Node.js 20+ is available for building, or whether I need to build
    elsewhere and copy `dist/` over

Then show me a plan: exactly which files you will create or edit, which
containers you will touch, and what you will run. Wait for me to approve it.

PHASE 2 — execute, in this order, showing me diffs before applying each change:

  1. Put nginx and the bridge on a shared Docker network. This is the part
     everything else depends on: nginx resolves upstream hostnames at config
     load, so if they aren't on the same network, `nginx -t` fails with
     "host not found in upstream" and nothing works. Prefer adding the network
     to nginx's compose file over a one-off `docker network connect`, so it
     survives a recreate.
  2. Bring up psa_car_controller from `deploy/docker-compose.psa.yml`, adapted
     to the real network name. The container_name must stay
     `psa_car_controller` — that is the hostname the nginx config proxies to.
  3. Prove the wiring before going further:
     `docker exec <nginx> wget -qO- http://psa_car_controller:5000/get_vehicles`
  4. Build the PWA (`npm install && npm run build`) and place `dist/` where
     nginx serves it, following this server's existing convention. Prefer a
     bind mount so future updates are just an rsync.
  5. Install the server block from `deploy/nginx-citroen.conf`, editing
     `server_name` and `root` for this machine. Then `nginx -t`, and only on
     success, `nginx -s reload`.
  6. Add the tunnel ingress rule for my hostname and the DNS route.
  7. Verify end to end and report what you checked.

## Hard rules

  - STOP and hand back to me for the MyCitroën login and the SMS/OTP enrolment.
    Do not enter my credentials, request an OTP, or complete that wizard. Set
    the container up so I can reach it privately and finish that step myself.
  - Do NOT make the hostname publicly reachable before Cloudflare Access is
    protecting it. psa_car_controller has no authentication of its own — anyone
    with the URL could pre-condition and reconfigure charging on my car. Tell me
    what policy to create and I'll do it in the Cloudflare dashboard.
  - Do NOT publish port 5000 to anything but 127.0.0.1, and remind me to remove
    that mapping once setup is finished.
  - Do NOT route psa_car_controller through Gluetun or any VPN. Stellantis drops
    OAuth sessions and raises anti-bot challenges when the source IP hops
    between exit nodes. It needs the normal residential IP.
  - This nginx serves other things I care about. Reload it, never blindly
    recreate or restart it, and never apply a config that hasn't passed
    `nginx -t`.
  - Back up any existing file before you edit it, and tell me where the backup is.
  - If something is ambiguous, ask me instead of guessing.

## When you're done

Report against this checklist, with the command output for each:
  - [ ] nginx and psa_car_controller are on the same network; nginx can reach
        the bridge by name
  - [ ] `nginx -t` passes
  - [ ] https://<my hostname>/ serves the app shell
  - [ ] /api/ proxies to the bridge (a request returns JSON, or an auth
        redirect if Access is already on)
  - [ ] port 5000 is not reachable from the LAN
  - [ ] the bridge is not behind a VPN
  - [ ] the config volume that will hold the OAuth tokens is on persistent
        storage, and you've told me what to back up

Then tell me, as a numbered list, exactly what I still have to do by hand:
the MyCitroën login and OTP, enabling recording, setting up charge control,
creating the Cloudflare Access policy, and installing the PWA on my phone.
````
