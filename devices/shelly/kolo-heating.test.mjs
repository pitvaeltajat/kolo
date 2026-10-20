// Tests the ACTUAL Shelly script (kolo-heating.js) by running it in a Node vm
// with stubbed Shelly/MQTT/BLE globals and a controllable clock. No emulator
// exists for Shelly's mJS, but the script is plain JS, so this exercises the
// real crypto, envelope verify, schedule/hysteresis logic and the BTHome parse
// against the file that gets flashed — not a copy.
//
//   node --test devices/shelly/kolo-heating.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE = readFileSync(join(HERE, 'kolo-heating.js'), 'utf8');
const KEY = 'CHANGE-ME-same-as-DEVICE_HMAC_KEY'; // CONFIG.HMAC_KEY in the script

/** Fresh sandbox + loaded script per test, so `state` never leaks between them. */
function load() {
  const clock = { t: 1_700_000_000_000 };
  const printed = [];
  const calls = [];
  const sandbox = {
    print: (s) => printed.push(String(s)),
    Math,
    JSON,
    parseInt,
    Date: { now: () => clock.t },
    Timer: { set() {} },
    MQTT: { subscribe() {} },
    BLE: { Scanner: { Subscribe() {}, isRunning: () => true, Start() {}, SCAN_RESULT: 1 } },
    Shelly: {
      call: (method, params) => calls.push({ method, params }),
      getComponentStatus: () => ({ apower: 1234 }),
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(CODE, ctx, { filename: 'kolo-heating.js' });
  return { ctx, clock, printed, calls };
}

/** Build a kolo-style signed envelope exactly as lib/sign.ts does. */
function koloEnvelope(body, ts) {
  const payload = JSON.stringify({ ...body, ts, nonce: 'deadbeefdeadbeefdeadbeefdeadbeef' });
  const sig = createHmac('sha256', KEY).update(payload).digest('hex');
  return JSON.stringify({ payload, sig });
}

function bthome(tempC) {
  const raw = Math.round(tempC * 100) & 0xffff;
  // device-info byte, then object 0x02 = temperature int16 LE.
  return String.fromCharCode(0x40, 0x02, raw & 0xff, (raw >> 8) & 0xff);
}

test('crypto self-test passes on boot', () => {
  const { printed } = load();
  assert.ok(printed.some((l) => l.includes('crypto self-test OK')), printed.join('\n'));
});

test('embedded HMAC matches node crypto (interop with kolo)', () => {
  const { ctx } = load();
  const msg = 'The quick brown fox jumps over the lazy dog';
  const want = createHmac('sha256', KEY).update(msg).digest('hex');
  assert.equal(ctx.hmacSha256(KEY, msg), want);
});

test('accepts a kolo-signed setpoint and applies it', () => {
  const { ctx, clock } = load();
  ctx.onSetpoint('kolo/heating/setpoint', koloEnvelope({ device: 'heating', setpointC: 20, source: 'MANUAL' }, clock.t));
  assert.equal(ctx.effectiveSetpoint(), 20);
});

test('clamps an out-of-range setpoint to 24', () => {
  const { ctx, clock } = load();
  ctx.onSetpoint('t', koloEnvelope({ setpointC: 99, source: 'MANUAL' }, clock.t));
  assert.equal(ctx.effectiveSetpoint(), 24);
});

test('idle (no setpoint, no schedule) is 12', () => {
  const { ctx } = load();
  assert.equal(ctx.effectiveSetpoint(), 12);
});

test('uses the schedule when there is no live setpoint', () => {
  const { ctx, clock } = load();
  const periods = [{ startMs: clock.t - 3_600_000, endMs: clock.t + 3_600_000, setpointC: 19 }];
  ctx.onSchedule('t', koloEnvelope({ periods }, clock.t));
  assert.equal(ctx.effectiveSetpoint(), 19);
});

test('rejects a stale message (replay outside ±30 s)', () => {
  const { ctx, clock } = load();
  ctx.onSetpoint('t', koloEnvelope({ setpointC: 22, source: 'MANUAL' }, clock.t - 60_000));
  assert.equal(ctx.effectiveSetpoint(), 12); // unchanged
});

test('rejects a tampered signature', () => {
  const { ctx, clock } = load();
  let env = koloEnvelope({ setpointC: 22, source: 'MANUAL' }, clock.t);
  env = env.replace(/"sig":"./, '"sig":"0'); // corrupt first sig hex digit
  ctx.onSetpoint('t', env);
  assert.equal(ctx.effectiveSetpoint(), 12);
});

test('thermostat: heats when cold, stops when warm (respecting min on/off)', () => {
  const { ctx, clock, calls } = load();
  ctx.onSetpoint('t', koloEnvelope({ setpointC: 20, source: 'MANUAL' }, clock.t));

  ctx.onBle(1, { addr: 'aa:bb:cc:dd:ee:ff', service_data: { fcd2: bthome(18) } });
  ctx.tick();
  const on = calls.filter((c) => c.method === 'Switch.Set');
  assert.equal(on.at(-1).params.on, true, 'should switch on at 18 °C vs 20 °C target');

  // Immediately warm: min-toggle (10 min) must block the switch-off.
  clock.t += 60_000;
  ctx.onBle(1, { addr: 'aa:bb:cc:dd:ee:ff', service_data: { fcd2: bthome(22) } });
  ctx.tick();
  assert.equal(calls.filter((c) => c.method === 'Switch.Set').length, 1, 'min on/off blocks fast cycling');

  // After the min-toggle window, it switches off.
  clock.t += 11 * 60_000;
  ctx.onBle(1, { addr: 'aa:bb:cc:dd:ee:ff', service_data: { fcd2: bthome(22) } });
  ctx.tick();
  const sw = calls.filter((c) => c.method === 'Switch.Set');
  assert.equal(sw.at(-1).params.on, false, 'should switch off at 22 °C vs 20 °C target');
});

test('frost fallback: a stale sensor maintains ~8 °C off the last reading', () => {
  const { ctx, clock, calls } = load();
  ctx.onSetpoint('t', koloEnvelope({ setpointC: 20, source: 'MANUAL' }, clock.t));
  // Last reading 5 °C, then the sensor goes silent well past the 30-min timeout.
  ctx.onBle(1, { addr: 'aa:bb:cc:dd:ee:ff', service_data: { fcd2: bthome(5) } });
  clock.t += 31 * 60_000;
  ctx.tick();
  const sw = calls.filter((c) => c.method === 'Switch.Set');
  assert.equal(sw.at(-1).params.on, true, '5 °C < 8 °C frost line → heat, not comfort, not off');
});
