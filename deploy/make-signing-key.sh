#!/usr/bin/env bash
#
# Creates the signing key for the Android wrapper, and writes the asset-links
# file that vouches for it.
#
#   ./deploy/make-signing-key.sh
#
# Run this once, on a machine you keep. The key is the app's identity: Android
# will only install an update signed with the same one, and
# citroen.knotworking.dev/.well-known/assetlinks.json names its fingerprint as
# the app allowed to act for the domain. Lose it and the fix is a new package
# name, a new asset-links entry, and uninstalling the old app by hand.
#
# It is deliberately not in the repo and never passes through CI logs. What CI
# gets is a base64 copy in a GitHub secret, printed at the end of this script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYSTORE="${KEYSTORE:-$REPO_ROOT/citroen-release.jks}"
ALIAS="${ALIAS:-citroen}"
PACKAGE="${PACKAGE:-dev.knotworking.citroen}"
ASSETLINKS="$REPO_ROOT/public/.well-known/assetlinks.json"

if [[ -e "$KEYSTORE" ]]; then
  echo "refusing to overwrite an existing keystore: $KEYSTORE" >&2
  echo "delete it deliberately if you really mean to mint a new identity." >&2
  exit 1
fi

command -v keytool >/dev/null || { echo "keytool not found — install a JDK" >&2; exit 1; }

echo "Creating $KEYSTORE"
echo "You will be asked for a password. Keep it: CI needs it too."
echo

# RSA 4096 and a 10000-day validity: an app signing key should outlive the car.
keytool -genkeypair \
  -keystore "$KEYSTORE" \
  -storetype PKCS12 \
  -alias "$ALIAS" \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -dname "CN=$PACKAGE, OU=citroen, O=knotworking, C=GB"

FINGERPRINT="$(keytool -list -v -keystore "$KEYSTORE" -alias "$ALIAS" 2>/dev/null \
  | awk '/SHA256:/ { print $2; exit }')"

if [[ -z "$FINGERPRINT" ]]; then
  echo "could not read the SHA-256 fingerprint back out of the keystore" >&2
  exit 1
fi

cat > "$ASSETLINKS" <<JSON
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "$PACKAGE",
      "sha256_cert_fingerprints": ["$FINGERPRINT"]
    }
  }
]
JSON

echo
echo "Fingerprint: $FINGERPRINT"
echo "Wrote        $ASSETLINKS"
echo
echo "Next:"
echo "  1. npm run build && redeploy dist/ — assetlinks.json ships inside it."
echo "  2. Add a Cloudflare Access BYPASS policy for"
echo "       /.well-known/assetlinks.json"
echo "     Chrome fetches it with no cookies; behind Access it gets the login"
echo "     page instead and verification fails silently."
echo "  3. Check it is really public, from somewhere with no Access session:"
echo "       curl -sS https://citroen.knotworking.dev/.well-known/assetlinks.json"
echo "  4. Put these in the repo's GitHub secrets, for the APK build:"
echo "       KEYSTORE_BASE64    (printed below)"
echo "       KEYSTORE_PASSWORD  (what you just typed)"
echo "       KEY_ALIAS          $ALIAS"
echo
echo "--- KEYSTORE_BASE64 ---"
base64 -w0 "$KEYSTORE" 2>/dev/null || base64 "$KEYSTORE"
echo
echo "--- end ---"
