#!/usr/bin/env python3
"""
One-off: generates a VAPID keypair for "notify when charging finishes".

Run once per deployment (not per phone — every subscribed device shares the
same keypair, it's how the push service verifies the notification came from
this server rather than anyone who found the endpoint URL). Needs the
`cryptography` package, which charge_notify.py's own container already
carries as a pywebpush dependency — easiest to run it in one:

    docker run --rm -v "$PWD":/w -w /w python:3.13-slim sh -c \
        "pip install --quiet cryptography && python generate_vapid_keys.py"

Prints both halves. Put VAPID_PRIVATE_KEY and a VAPID_SUBJECT (a mailto: or
https: URL identifying you, required by the push protocol so a provider can
contact you about a misbehaving sender) in charge_notify's .env — never
commit that file. Put VAPID_PUBLIC_KEY in the PWA's .env.local/.env
production build as VITE_VAPID_PUBLIC_KEY — it's public, safe to commit,
and has to match the private key exactly or every subscribe() will fail.

Rotating the keys after the fact invalidates every existing subscription
(the browser signs against the public key at subscribe time) — everyone
would need to flip the Settings sheet toggle off and on again.
"""

import base64

from cryptography.hazmat.primitives.asymmetric import ec


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def main() -> None:
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    private_raw = private_key.private_numbers().private_value.to_bytes(32, "big")
    numbers = public_key.public_numbers()
    public_raw = b"\x04" + numbers.x.to_bytes(32, "big") + numbers.y.to_bytes(32, "big")

    print(f"VAPID_PUBLIC_KEY={b64url(public_raw)}")
    print(f"VAPID_PRIVATE_KEY={b64url(private_raw)}")


if __name__ == "__main__":
    main()
