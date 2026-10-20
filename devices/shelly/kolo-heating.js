// kolo heating thermostat — Shelly 1 Gen4 script (mJS).
//
// One of these runs on each upstairs heater's Shelly. It:
//   - subscribes to kolo/heating/setpoint + kolo/heating/schedule over MQTT,
//     verifying the HMAC envelope (see devices/README.md "signing contract");
//   - reads its room's Shelly BLU H&T temperature over BLE (BTHome);
//   - runs a hysteresis thermostat with a minimum on/off time, clamps the
//     setpoint, and falls back to frost protection if the sensor goes quiet;
//   - keeps the last setpoint + the next-7-days schedule, so it keeps heating
//     correctly with no internet (HEATING.md "Everything must keep working").
//   - POSTs its state back to kolo so the web app can show room temp + on/off.
//
// Everything except the CONFIG block is generic. Flash the same file to every
// heater; change only CONFIG.
//
// ⚠ Hardware calibration (can't be verified off-device):
//   - SENSOR_MAC must be your BLU H&T's address (lower-case, no colons OK too).
//   - Confirm the HMAC self-test logs "crypto self-test OK" on boot.
//   - Confirm BLE temperature decodes sensibly before trusting the thermostat.

// ======================= CONFIG (edit per heater) ==========================
let CONFIG = {
  KOLO_URL: 'https://kolo.pitva.fi', // where to POST state
  HMAC_KEY: 'CHANGE-ME-same-as-DEVICE_HMAC_KEY', // shared secret with kolo
  DEVICE_ID: 'heater-eteinen', // unique per Shelly; shown in the web app
  ROOM: 'eteinen', // room label
  CONTROL_GROUP: 'upstairs', // both upstairs heaters are shown as one group
  SENSOR_MAC: 'aa:bb:cc:dd:ee:ff', // this room's BLU H&T
  RELAY_ID: 0, // Switch component controlling the heater

  HYSTERESIS_C: 0.5, // ±0.5 °C around the setpoint
  MIN_TOGGLE_MS: 10 * 60 * 1000, // don't switch faster than every 10 min
  FROST_C: 8, // sensor silent > SENSOR_TIMEOUT → this, never "on"
  IDLE_C: 12, // no setpoint and no active schedule period
  MIN_C: 5,
  MAX_C: 24,
  SENSOR_TIMEOUT_MS: 30 * 60 * 1000,
  SKEW_MS: 30 * 1000, // accept signed messages within ±30 s
  TICK_MS: 30 * 1000, // thermostat + state-report cadence
};

// ======================= HMAC-SHA256 (pure mJS) ============================
// Standard SHA-256; operates on byte arrays, returns lower-case hex.
let K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function sha256(bytes) {
  let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  let l = bytes.length;
  let withOne = bytes.slice(0);
  withOne.push(0x80);
  while (withOne.length % 64 !== 56) withOne.push(0);
  // 64-bit big-endian bit length. High 32 bits are always 0 for our tiny
  // payloads; write the low 32 in the last 4 bytes. (Don't use `bits >>> 32` —
  // JS takes the shift mod 32, which would corrupt the length.)
  let bits = l * 8;
  withOne.push(0); withOne.push(0); withOne.push(0); withOne.push(0);
  withOne.push((bits >>> 24) & 0xff);
  withOne.push((bits >>> 16) & 0xff);
  withOne.push((bits >>> 8) & 0xff);
  withOne.push(bits & 0xff);
  for (let off = 0; off < withOne.length; off += 64) {
    let w = [];
    for (let i = 0; i < 16; i++) {
      w[i] =
        ((withOne[off + i * 4] << 24) |
          (withOne[off + i * 4 + 1] << 16) |
          (withOne[off + i * 4 + 2] << 8) |
          withOne[off + i * 4 + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      let s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      let s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (((w[i - 16] + s0) >>> 0) + ((w[i - 7] + s1) >>> 0)) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      let S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      let ch = ((e & f) ^ (~e & g)) >>> 0;
      let t1 = (((hh + S1) >>> 0) + (((ch + K[i]) >>> 0) + w[i])) >>> 0;
      let S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      let maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      let t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  let hex = '';
  for (let i = 0; i < 8; i++) {
    let v = h[i];
    for (let j = 7; j >= 0; j--) hex += '0123456789abcdef'[(v >>> (j * 4)) & 0xf];
  }
  return hex;
}

function strBytes(s) {
  // UTF-8 encode. kolo payloads are ASCII JSON, but encode properly anyway.
  let out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6)); out.push(0x80 | (c & 0x3f)); }
    else { out.push(0xe0 | (c >> 12)); out.push(0x80 | ((c >> 6) & 0x3f)); out.push(0x80 | (c & 0x3f)); }
  }
  return out;
}

function hexBytes(hex) {
  let out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}

function hmacSha256(keyStr, msgStr) {
  let key = strBytes(keyStr);
  if (key.length > 64) key = hexBytes(sha256(key));
  while (key.length < 64) key.push(0);
  let ok = [], ik = [];
  for (let i = 0; i < 64; i++) { ok.push(key[i] ^ 0x5c); ik.push(key[i] ^ 0x36); }
  let inner = sha256(ik.concat(strBytes(msgStr)));
  return sha256(ok.concat(hexBytes(inner)));
}

function cryptoSelfTest() {
  // RFC-style vector: HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog")
  let got = hmacSha256('key', 'The quick brown fox jumps over the lazy dog');
  let want = 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8';
  if (got === want) print('kolo: crypto self-test OK');
  else print('kolo: CRYPTO SELF-TEST FAILED got=' + got);
}

// ======================= envelope sign / verify ===========================
function makeNonce() {
  let s = '';
  for (let i = 0; i < 16; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return s;
}

function sign(bodyObj) {
  bodyObj.device = CONFIG.DEVICE_ID;
  bodyObj.ts = Date.now();
  bodyObj.nonce = makeNonce();
  let payload = JSON.stringify(bodyObj);
  return JSON.stringify({ device: CONFIG.DEVICE_ID, payload: payload, sig: hmacSha256(CONFIG.HMAC_KEY, payload) });
}

// Returns the decoded body object or null. Nonce replay is not tracked here —
// setpoint/schedule are idempotent, so the ±skew check is enough for them.
function verify(raw) {
  let env;
  try { env = JSON.parse(raw); } catch (e) { return null; }
  if (!env || typeof env.payload !== 'string' || typeof env.sig !== 'string') return null;
  if (hmacSha256(CONFIG.HMAC_KEY, env.payload) !== env.sig) return null;
  let body;
  try { body = JSON.parse(env.payload); } catch (e) { return null; }
  if (typeof body.ts !== 'number' || Math.abs(Date.now() - body.ts) > CONFIG.SKEW_MS) return null;
  return body;
}

// ======================= state ============================================
let state = {
  setpointC: CONFIG.IDLE_C, // last setpoint from MQTT
  source: 'DEFAULT',
  schedule: [], // [{startMs,endMs,setpointC}]
  tempC: null,
  tempAt: 0,
  relayOn: false,
  lastToggle: 0,
};

function clamp(c) {
  return Math.max(CONFIG.MIN_C, Math.min(CONFIG.MAX_C, c));
}

// The setpoint in force now: live MQTT setpoint wins; else an active schedule
// period; else idle. (kolo already resolves manual-vs-calendar and sends the
// result as `setpoint`; the schedule is the offline fallback.)
function effectiveSetpoint() {
  if (state.source === 'MANUAL' || state.source === 'CALENDAR') return clamp(state.setpointC);
  let now = Date.now();
  for (let i = 0; i < state.schedule.length; i++) {
    let p = state.schedule[i];
    if (now >= p.startMs && now < p.endMs) return clamp(p.setpointC);
  }
  return CONFIG.IDLE_C;
}

// ======================= BLE temperature (BTHome v2) =======================
// Shelly BLU H&T advertises BTHome service data (UUID 0xFCD2). We only need the
// temperature object (id 0x02, int16 LE, ×0.01 °C). Filtered to our sensor.
function onBle(ev, res) {
  if (ev !== BLE.Scanner.SCAN_RESULT) return;
  if (!res || !res.addr) return;
  if (res.addr.toLowerCase() !== CONFIG.SENSOR_MAC.toLowerCase()) return;
  let sd = res.service_data && res.service_data['fcd2'];
  if (!sd) return;
  // sd is a byte string: [device-info][obj-id obj-data...]. Walk objects.
  for (let i = 1; i < sd.length - 2; ) {
    let id = sd.charCodeAt(i);
    if (id === 0x02) {
      let lo = sd.charCodeAt(i + 1), hi = sd.charCodeAt(i + 2);
      let v = (hi << 8) | lo;
      if (v & 0x8000) v -= 0x10000; // signed
      state.tempC = v * 0.01;
      state.tempAt = Date.now();
      return;
    }
    // ponytail: only the temp object is parsed. Other ids have varied lengths;
    // if a sensor packs temp after another object, add that id's length here.
    i += 3;
  }
}

// ======================= thermostat =======================================
function applyRelay(on) {
  if (on === state.relayOn) return;
  if (Date.now() - state.lastToggle < CONFIG.MIN_TOGGLE_MS) return; // anti-cycle
  state.relayOn = on;
  state.lastToggle = Date.now();
  Shelly.call('Switch.Set', { id: CONFIG.RELAY_ID, on: on });
}

function tick() {
  // Sensor silent > timeout → aim for the frost line (8 °C), never comfort.
  let sensorFresh = state.tempC !== null && Date.now() - state.tempAt < CONFIG.SENSOR_TIMEOUT_MS;
  let target = sensorFresh ? effectiveSetpoint() : CONFIG.FROST_C;

  // Run hysteresis against the target. When the sensor is stale we deliberately
  // keep using the LAST reading (temperature moves slowly), so a Bluetooth
  // glitch at −30 °C maintains ~8 °C instead of cutting the heat entirely. Only
  // a sensor that has never reported (tempC === null) leaves the relay as-is.
  if (state.tempC !== null) {
    if (state.tempC < target - CONFIG.HYSTERESIS_C) applyRelay(true);
    else if (state.tempC > target + CONFIG.HYSTERESIS_C) applyRelay(false);
  }
  reportState(target);
}

function reportState(target) {
  let st = Shelly.getComponentStatus('switch:' + JSON.stringify(CONFIG.RELAY_ID));
  let powerW = st && typeof st.apower === 'number' ? st.apower : null;
  let body = {
    kind: 'HEATER',
    room: CONFIG.ROOM,
    controlGroup: CONFIG.CONTROL_GROUP,
    relay: state.relayOn,
    tempC: state.tempC,
    powerW: powerW,
    target: target,
  };
  Shelly.call('HTTP.POST', {
    url: CONFIG.KOLO_URL + '/api/state',
    body: sign(body),
    content_type: 'application/json',
    timeout: 10,
  });
}

// ======================= MQTT wiring =======================================
function onSetpoint(topic, msg) {
  let b = verify(msg);
  if (!b) { print('kolo: bad setpoint msg'); return; }
  if (typeof b.setpointC === 'number') {
    state.setpointC = b.setpointC;
    state.source = typeof b.source === 'string' ? b.source : 'MANUAL';
  }
}

function onSchedule(topic, msg) {
  let b = verify(msg);
  if (!b || !b.periods) { print('kolo: bad schedule msg'); return; }
  state.schedule = b.periods;
}

// ======================= boot ==============================================
cryptoSelfTest();
MQTT.subscribe('kolo/heating/setpoint', onSetpoint);
MQTT.subscribe('kolo/heating/schedule', onSchedule);
BLE.Scanner.Subscribe(onBle);
if (!BLE.Scanner.isRunning()) BLE.Scanner.Start({ duration_ms: -1, active: false });
Timer.set(CONFIG.TICK_MS, true, tick);
print('kolo heating ready: ' + CONFIG.DEVICE_ID + ' (' + CONFIG.ROOM + ')');
