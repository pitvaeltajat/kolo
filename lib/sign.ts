import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { COMMAND_SKEW_MS } from './config';

/**
 * Message signing between the Vercel app and the on-site devices (ESP32 door
 * controller, heating Shellys). The MQTT broker is treated as untrusted — it
 * only relays — so every command Vercel publishes is HMAC-SHA256 signed with a
 * key shared only with the device, and every report a device sends back is
 * verified the same way (PLAN.md "MQTT broker").
 *
 * The wire form is an envelope: `{ "payload": "<json>", "sig": "<hex>" }` where
 * `sig = HMAC(key, payload-bytes)`. Signing over the exact bytes — not a
 * re-canonicalised object — means the device hashes the string it received and
 * never has to agree with us on key ordering or whitespace. That is what keeps
 * a from-scratch firmware/Shelly-script verifier simple and correct.
 *
 * Pure functions, no DB and no clock other than the one passed in, so the
 * replay/skew rules are unit-testable. Nonce bookkeeping (a nonce may be spent
 * once) lives in lib/nonce.ts because it needs the database.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type Envelope = { payload: string; sig: string };

function hmac(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Wrap a payload in a signed envelope, stamping it with the time and a fresh nonce. */
export function sign(
  key: string,
  body: Record<string, Json>,
  now: number = Date.now(),
): Envelope & { nonce: string } {
  const nonce = randomBytes(16).toString('hex');
  const payload = JSON.stringify({ ...body, ts: now, nonce });
  return { payload, sig: hmac(key, payload), nonce };
}

export type Verified = { ts: number; nonce: string; body: Record<string, Json> };
export type VerifyResult =
  | { ok: true; value: Verified }
  | { ok: false; reason: 'bad-shape' | 'bad-sig' | 'expired' };

/**
 * Verify a signed envelope: HMAC (constant time) then timestamp skew. The
 * caller must still reject a nonce it has already seen — that is the replay
 * guard and this function can't do it without state.
 */
export function verify(
  key: string,
  envelope: unknown,
  now: number = Date.now(),
  skewMs: number = COMMAND_SKEW_MS,
): VerifyResult {
  if (typeof envelope !== 'object' || envelope === null) return { ok: false, reason: 'bad-shape' };
  const { payload, sig } = envelope as Record<string, unknown>;
  if (typeof payload !== 'string' || typeof sig !== 'string') return { ok: false, reason: 'bad-shape' };

  const expected = hmac(key, payload);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad-sig' };

  let body: Record<string, Json>;
  try {
    body = JSON.parse(payload);
  } catch {
    return { ok: false, reason: 'bad-shape' };
  }
  const { ts, nonce } = body;
  if (typeof ts !== 'number' || typeof nonce !== 'string') return { ok: false, reason: 'bad-shape' };
  if (Math.abs(now - ts) > skewMs) return { ok: false, reason: 'expired' };

  return { ok: true, value: { ts, nonce, body } };
}

/** The HMAC key for a device: per-device override, else the shared key. */
export function deviceKey(deviceId: string): string {
  const slug = deviceId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const key = process.env[`DEVICE_HMAC_KEY_${slug}`]?.trim() || process.env.DEVICE_HMAC_KEY?.trim();
  if (!key) throw new Error('DEVICE_HMAC_KEY is not set');
  return key;
}
