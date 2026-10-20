import { verify, deviceKey, type Json } from './sign';
import { spendNonce } from './nonce';

/**
 * Validate a message a device POSTed to us. The wire form carries an unsigned
 * `device` hint used only to pick the HMAC key — it is not trusted: if it's
 * wrong, the signature fails, and we also require the *signed* body to name the
 * same device. On success the nonce is spent, so a captured message can't be
 * replayed.
 */
export type Inbound = { device: string; body: Record<string, Json> };
export type InboundResult = { ok: true; value: Inbound } | { ok: false; status: number; reason: string };

export async function readInbound(raw: unknown): Promise<InboundResult> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, status: 400, reason: 'bad-shape' };
  const device = (raw as Record<string, unknown>).device;
  if (typeof device !== 'string' || !device) return { ok: false, status: 400, reason: 'no-device' };

  let key: string;
  try {
    key = deviceKey(device);
  } catch {
    return { ok: false, status: 503, reason: 'no-key' };
  }

  const v = verify(key, raw);
  if (!v.ok) return { ok: false, status: 401, reason: v.reason };
  if (v.value.body.device !== device) return { ok: false, status: 401, reason: 'device-mismatch' };
  if (!(await spendNonce(v.value.nonce))) return { ok: false, status: 409, reason: 'replay' };

  return { ok: true, value: { device, body: v.value.body } };
}
