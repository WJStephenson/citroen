/**
 * Local app lock (design doc §3.3: "Local Biometric Lock").
 *
 * SCOPE, PLAINLY: this is a *local presence check* on the handset. There is no
 * server verifying the WebAuthn assertion and no secret gating the API calls,
 * so anyone who can reach the tunnel URL can still reach the bridge. The real
 * security boundary is Cloudflare Access / nginx auth at the edge (§3.2). This
 * lock stops a borrowed or unlocked phone from pre-conditioning the car; it is
 * not authentication.
 */

const LS_CREDENTIAL = 'ec4.lock.credentialId'
const LS_PIN = 'ec4.lock.pin'
const PBKDF2_ITERATIONS = 250_000

export type LockMethod = 'biometric' | 'pin' | 'none'

const encoder = new TextEncoder()

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export async function isBiometricAvailable(): Promise<boolean> {
  if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) return false
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

export function configuredMethod(): LockMethod {
  if (localStorage.getItem(LS_CREDENTIAL)) return 'biometric'
  if (localStorage.getItem(LS_PIN)) return 'pin'
  return 'none'
}

export async function enrolBiometric(): Promise<boolean> {
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const userId = crypto.getRandomValues(new Uint8Array(16))

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'Citroën ë-C4', id: window.location.hostname },
      user: { id: userId, name: 'owner', displayName: 'Owner' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60_000,
      attestation: 'none',
    },
  })) as PublicKeyCredential | null

  if (!credential) return false
  localStorage.setItem(LS_CREDENTIAL, toBase64(credential.rawId))
  return true
}

export async function verifyBiometric(): Promise<boolean> {
  const stored = localStorage.getItem(LS_CREDENTIAL)
  if (!stored) return false

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: fromBase64(stored) }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })
  // The platform authenticator only returns an assertion after a successful
  // fingerprint / face / device-PIN check, which is the signal we want.
  return assertion !== null
}

export function clearLock(): void {
  localStorage.removeItem(LS_CREDENTIAL)
  localStorage.removeItem(LS_PIN)
}

async function derive(pin: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )
  return toBase64(bits)
}

export async function setPin(pin: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(pin, salt)
  localStorage.setItem(LS_PIN, JSON.stringify({ salt: toBase64(salt), hash }))
}

export async function verifyPin(pin: string): Promise<boolean> {
  const stored = localStorage.getItem(LS_PIN)
  if (!stored) return false
  try {
    const { salt, hash } = JSON.parse(stored) as { salt: string; hash: string }
    return (await derive(pin, fromBase64(salt))) === hash
  } catch {
    return false
  }
}
