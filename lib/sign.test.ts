import { describe, it, expect } from 'vitest';
import { sign, verify } from './sign';

const KEY = 'test-secret';

describe('sign/verify', () => {
  it('round-trips a valid envelope', () => {
    const now = 1_000_000;
    const env = sign(KEY, { device: 'door', action: 'unlock' }, now);
    const r = verify(KEY, env, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.body.action).toBe('unlock');
      expect(r.value.nonce).toBe(env.nonce);
    }
  });

  it('rejects a tampered payload', () => {
    const env = sign(KEY, { action: 'unlock' });
    const tampered = { ...env, payload: env.payload.replace('unlock', 'lock') };
    expect(verify(KEY, tampered)).toMatchObject({ ok: false, reason: 'bad-sig' });
  });

  it('rejects the wrong key', () => {
    const env = sign(KEY, { action: 'unlock' });
    expect(verify('other-key', env)).toMatchObject({ ok: false, reason: 'bad-sig' });
  });

  it('rejects a stale timestamp (replay outside skew)', () => {
    const env = sign(KEY, { action: 'unlock' }, 1_000_000);
    expect(verify(KEY, env, 1_000_000 + 60_000)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rejects a malformed envelope', () => {
    expect(verify(KEY, { nope: true })).toMatchObject({ ok: false, reason: 'bad-shape' });
    expect(verify(KEY, null)).toMatchObject({ ok: false, reason: 'bad-shape' });
  });
});
