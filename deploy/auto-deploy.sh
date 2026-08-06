#!/bin/bash
# Keeps the nginx bind mount in sync with the citroen PWA's source. Run on a
# timer rather than by hand — see DEPLOYMENT.md §4b for the systemd units and
# for where this gets installed.
#
# This file is the canonical copy; the server runs its own copy outside the
# repo, on purpose. It must not be run straight out of the checkout it deploys,
# because it pulls: bash reads a script incrementally, so a pull that rewrote
# this file mid-run could leave it executing a spliced mixture of both versions.
# Copy it into place after changing it, the same way charge_notify.py is copied.
#
# Exercised by auto-deploy.test.sh — run that after any change here.
#
# The build trigger is "is what's deployed what a build would produce right
# now", recorded in DEPLOYED_STAMP — deliberately not "did the fetch bring
# anything new". The fetch-based version never fired in the ordinary case:
# committing on this machine and pushing leaves HEAD already equal to
# origin/main, so the "$LOCAL" = "$REMOTE" early exit hit and dist/ quietly
# drifted commits behind the source (it was four behind when this was found).
# Comparing against what is actually on disk cannot miss that, whether the
# commit arrived by pull or was made here.
#
# Paths are overridable so the branches can be exercised against a throwaway
# repo and target instead of the live ones.
set -euo pipefail

REPO=${REPO:-/home/deck/src/citroen}
DIST_TARGET=${DIST_TARGET:-/home/deck/docker/citroen/dist}
DEPLOYED_STAMP=${DEPLOYED_STAMP:-/home/deck/docker/citroen/.deployed-commit}
LOG=${LOG:-/home/deck/docker/citroen/auto-deploy.log}
LOCK=${LOCK:-/tmp/citroen-autodeploy.lock}

exec 9>"$LOCK"
flock -n 9 || exit 0

log() { echo "$(date -Iseconds) $*" >> "$LOG"; }

cd "$REPO"
git fetch --quiet origin main

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" != "$REMOTE" ]; then
  if git merge-base --is-ancestor "$REMOTE" "$LOCAL"; then
    # Unpushed local commits. Only what is on origin/main gets deployed, and
    # the working tree is at HEAD rather than at origin/main, so there is
    # nothing here to deploy safely. Silent on purpose: this is the normal
    # state between committing and pushing, and the timer runs every 3 minutes.
    exit 0
  fi
  if ! git merge-base --is-ancestor "$LOCAL" "$REMOTE"; then
    log "local HEAD and origin/main have diverged ($LOCAL vs $REMOTE) - refusing to pull, needs a human"
    exit 1
  fi
  if ! git pull --ff-only origin main >> "$LOG" 2>&1; then
    log "git pull failed"
    exit 1
  fi
fi

# What a build would produce, identified by commit plus the state of the working
# tree. The tree matters and not just HEAD: this machine is both the dev box and
# the server, so an uncommitted edit is a real difference in what gets served
# and must not be stamped as though it were the plain commit. Hashing the
# difference means a tree that keeps changing redeploys, while one left dirty
# and untouched does not rebuild every three minutes.
DESIRED=$(git rev-parse HEAD)
DIRT=$({ git status --porcelain; git diff HEAD; } | sha1sum | cut -c1-8)
if [ -n "$(git status --porcelain)" ]; then
  DESIRED="$DESIRED+dirty.$DIRT"
fi

DEPLOYED=$(cat "$DEPLOYED_STAMP" 2>/dev/null || true)

# The index.html check covers a target that was emptied by hand: the stamp would
# still claim a deploy that is no longer on disk.
if [ "$DESIRED" = "$DEPLOYED" ] && [ -e "$DIST_TARGET/index.html" ]; then
  exit 0
fi

# npm ci only when the lockfile actually moved between what is deployed and what
# is about to be. Keyed off the deployed commit rather than off the pull, so it
# is still caught for a commit made here and never pulled. An unrecognisable
# stamp (rebased or force-pushed away) leaves node_modules alone unless it is
# missing outright — the build will fail loudly if that turns out to be wrong.
LOCK_CHANGED=no
DEPLOYED_COMMIT=${DEPLOYED%%+*}
if [ -n "$DEPLOYED_COMMIT" ] && git rev-parse --verify --quiet "${DEPLOYED_COMMIT}^{commit}" >/dev/null; then
  if ! git diff --quiet "$DEPLOYED_COMMIT" HEAD -- package-lock.json; then
    LOCK_CHANGED=yes
  fi
elif [ ! -d node_modules ]; then
  LOCK_CHANGED=yes
fi

log "deploying $DESIRED (on disk: ${DEPLOYED:-none})"

if [ "$LOCK_CHANGED" = yes ]; then
  log "package-lock.json changed, running npm ci"
  if ! npm ci >> "$LOG" 2>&1; then
    log "npm ci failed"
    exit 1
  fi
fi

if ! npm run build >> "$LOG" 2>&1; then
  log "build failed at $DESIRED"
  exit 1
fi

if ! rsync -a --delete "$REPO/dist/" "$DIST_TARGET/" >> "$LOG" 2>&1; then
  log "rsync to $DIST_TARGET failed"
  exit 1
fi

# Stamped only once the bytes are in place, so any failure above retries on the
# next tick rather than being recorded as deployed.
printf '%s\n' "$DESIRED" > "$DEPLOYED_STAMP"
log "deployed $DESIRED"
