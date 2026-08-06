#!/bin/bash
# Exercises every branch of auto-deploy.sh against a throwaway repo, a fake
# origin and a stubbed npm. Nothing here touches the real repo, the real dist
# target or the live service — every path the script uses is overridden, which
# is why they are env-overridable in the first place.
#
#     deploy/auto-deploy.test.sh
#
# Case 4 is the regression that prompted all this: the build trigger used to
# compare origin/main against HEAD, so committing on the server and pushing —
# which leaves the two already equal — silently deployed nothing, and dist/
# drifted commits behind the source.
set -uo pipefail

SCRIPT=${SCRIPT:-"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/auto-deploy.sh"}
BASE=$(mktemp -d "${TMPDIR:-/tmp}/citroen-autodeploy-test.XXXXXX")
trap 'rm -rf "$BASE"' EXIT
mkdir -p "$BASE/bin"

# Stub npm: records each call, and `run build` writes a dist from the tree.
cat > "$BASE/bin/npm" <<'NPM'
#!/bin/bash
echo "npm $*" >> "$NPM_CALLS"
if [ "${1:-}" = "run" ] && [ "${2:-}" = "build" ]; then
  [ -f "$BASE_REPO/FAIL_BUILD" ] && { echo "build blew up"; exit 1; }
  mkdir -p "$BASE_REPO/dist"
  # Strictly growing payload. rsync -a quick-checks on size+mtime, so a fixture
  # whose builds happen to be the same size inside the same second would be
  # skipped as unchanged — an artifact of tiny fake files, not of the script
  # (real builds emit hash-named assets of differing sizes).
  COUNT=$(( $(cat "$BUILD_COUNT" 2>/dev/null || echo 0) + 1 ))
  echo "$COUNT" > "$BUILD_COUNT"
  { cat "$BASE_REPO/src.txt"; seq "$COUNT" | sed 's/^/pad/'; } > "$BASE_REPO/dist/index.html"
fi
exit 0
NPM
chmod +x "$BASE/bin/npm"
export PATH="$BASE/bin:$PATH"
export NPM_CALLS="$BASE/npm-calls.log" BASE_REPO="$BASE/repo" BUILD_COUNT="$BASE/buildcount"

git init -q --bare -b main "$BASE/origin.git"
git init -q -b main "$BASE/repo"
cd "$BASE/repo"
git config user.email t@t; git config user.name t
echo "v1" > src.txt; echo '{}' > package-lock.json
# Mirrors the real repo: build output is gitignored, so an existing dist/ must
# not make every run look like a dirty working tree.
printf 'dist/\nFAIL_BUILD\n' > .gitignore
git add -A; git commit -qm v1
git remote add origin "$BASE/origin.git"; git push -q -u origin main

# A second clone, standing in for a push from another machine.
git clone -q "$BASE/origin.git" "$BASE/other"
cd "$BASE/other"; git config user.email t@t; git config user.name t

export REPO="$BASE/repo" DIST_TARGET="$BASE/target" \
       DEPLOYED_STAMP="$BASE/stamp" LOG="$BASE/log" LOCK="$BASE/lock"
mkdir -p "$BASE/target"

PASS=0; FAIL=0
run() { : > "$NPM_CALLS"; : > "$LOG"; bash "$SCRIPT"; echo "exit=$?"; }
check() { # name expected_substring actual
  if [[ "$3" == *"$2"* ]]; then echo "  PASS  $1"; PASS=$((PASS+1))
  else echo "  FAIL  $1"; echo "        wanted: $2"; echo "        got:    ${3//$'\n'/ | }"; FAIL=$((FAIL+1)); fi
}
served() { head -1 "$BASE/target/index.html" 2>/dev/null || echo "(nothing)"; }
stamp() { cat "$BASE/stamp" 2>/dev/null || echo "(none)"; }

echo "1. first run, no stamp -> deploys"
out=$(run); check "deployed" "deployed" "$(cat "$BASE/log")"; check "served v1" "v1" "$(served)"

echo "2. nothing changed -> silent no-op"
out=$(run); check "log stays empty" "" "$(cat "$BASE/log")"
check "no npm calls" "" "$(cat "$NPM_CALLS")"

echo "3. someone else pushes -> pulls and deploys"
cd "$BASE/other"; echo "v2" > src.txt; git commit -qam v2; git push -q origin main; cd "$BASE/repo"
out=$(run); check "deployed" "deployed" "$(cat "$BASE/log")"; check "served v2" "v2" "$(served)"

echo "4. THE BUG: commit here + push, so HEAD == origin/main -> must still deploy"
echo "v3" > src.txt; git commit -qam v3; git push -q origin main
out=$(run); check "deployed" "deployed" "$(cat "$BASE/log")"; check "served v3" "v3" "$(served)"

echo "5. unpushed local commit -> silent no-op, deploys nothing"
echo "v4-unpushed" > src.txt; git commit -qam v4
out=$(run); check "log stays empty" "" "$(cat "$BASE/log")"; check "still serving v3" "v3" "$(served)"
git push -q origin main   # tidy up for later cases
out=$(run) >/dev/null

echo "6. diverged history -> refuses, exits 1"
cd "$BASE/other"; git fetch -q; git reset -q --hard origin/main
echo "theirs" > src.txt; git commit -qam theirs; git push -q -f origin main; cd "$BASE/repo"
echo "mine" > src.txt; git commit -qam mine
out=$(run); check "logs divergence" "diverged" "$(cat "$BASE/log")"; check "exit 1" "exit=1" "$out"
git reset -q --hard HEAD~1; git fetch -q origin main; git reset -q --hard origin/main
out=$(run) >/dev/null   # resync

echo "7. dirty tree -> deploys, stamped dirty"
echo "v5-dirty" > src.txt
out=$(run); check "deployed" "deployed" "$(cat "$BASE/log")"
check "stamp marked dirty" "+dirty." "$(stamp)"; check "served dirty content" "v5-dirty" "$(served)"

echo "8. same dirty tree again -> no rebuild every tick"
out=$(run); check "log stays empty" "" "$(cat "$BASE/log")"

echo "9. dirty tree changes again -> redeploys"
echo "v6-dirty" > src.txt
out=$(run); check "deployed" "deployed" "$(cat "$BASE/log")"; check "served v6" "v6-dirty" "$(served)"
git checkout -q -- src.txt; out=$(run) >/dev/null

echo "10. target emptied by hand -> redeploys despite matching stamp"
rm -rf "$BASE/target"; mkdir -p "$BASE/target"
# The dirty edit was reverted at the end of case 9, so the tree is back to the
# committed content ("theirs") — that is what a rebuild must put back.
out=$(run); check "deployed" "deployed" "$(cat "$BASE/log")"; check "restored" "theirs" "$(served)"

echo "11. package-lock.json changes -> npm ci runs"
echo '{"n":2}' > package-lock.json; echo "v7" > src.txt; git commit -qam v7; git push -q origin main
out=$(run); check "npm ci ran" "npm ci" "$(cat "$NPM_CALLS")"; check "deployed" "deployed" "$(cat "$BASE/log")"

echo "12. ordinary commit, no lock change -> no npm ci"
echo "v8" > src.txt; git commit -qam v8; git push -q origin main
out=$(run); check "no npm ci" "none" "$(grep -q 'npm ci' "$NPM_CALLS" && echo ran || echo none)"; check "deployed" "deployed" "$(cat "$BASE/log")"

echo "13. build fails -> nothing stamped, retries next tick"
before=$(stamp); touch "$BASE/repo/FAIL_BUILD"; echo "v9" > src.txt; git commit -qam v9; git push -q origin main
out=$(run); check "logs failure" "build failed" "$(cat "$BASE/log")"; check "exit 1" "exit=1" "$out"
check "stamp unchanged" "$before" "$(stamp)"
rm "$BASE/repo/FAIL_BUILD"
out=$(run); check "recovers on next run" "deployed" "$(cat "$BASE/log")"; check "serves v9" "v9" "$(served)"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
