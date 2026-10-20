import mqtt from 'mqtt';
import { sign, verify, deviceKey, type Json } from './sign';
import { ACK_TIMEOUT_MS } from './config';

/**
 * The link to the on-site devices. The broker only relays (it is untrusted),
 * so every command is signed on the way out and every ack verified on the way
 * back — see lib/sign.ts. Vercel functions are short-lived, so we connect per
 * call and tear down after; nothing here keeps a long-lived connection.
 *
 * Topics:
 *   kolo/<device>/cmd         commands  (Vercel → device)
 *   kolo/<device>/ack         acks      (device → Vercel), `reply` = command nonce
 *   kolo/<device>/setpoint    heating setpoint (fire-and-forget)
 *   kolo/<device>/schedule    7-day heating periods (fire-and-forget)
 *   kolo/door/allowlist       signed tag allowlist (fire-and-forget)
 */

function brokerUrl(): string {
  const url = process.env.MQTT_URL?.trim();
  if (!url) throw new Error('MQTT_URL is not set — device transport not configured');
  return url;
}

/**
 * CA for the broker's TLS cert. The troop's Mosquitto on Lightsail uses a
 * private CA (not a public one), so Node must be told to trust it — otherwise
 * `mqtts://` fails verification. Accepts the PEM directly or base64 of it
 * (base64 survives the Vercel env editor). Unset → public CAs only.
 */
function brokerCa(): Buffer | undefined {
  const raw = process.env.MQTT_CA?.trim();
  if (!raw) return undefined;
  return Buffer.from(raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
}

function connect(): Promise<mqtt.MqttClient> {
  const client = mqtt.connect(brokerUrl(), {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    ca: brokerCa(),
    connectTimeout: 4000,
    reconnectPeriod: 0, // one shot: a serverless invocation shouldn't retry forever
  });
  return new Promise((resolve, reject) => {
    client.once('connect', () => resolve(client));
    client.once('error', (err) => reject(err));
  });
}

function envelope(e: { payload: string; sig: string }): string {
  return JSON.stringify({ payload: e.payload, sig: e.sig });
}

/** Fire-and-forget: sign and publish one message, QoS 1, then disconnect. */
export async function publishSigned(device: string, topic: string, body: Record<string, Json>): Promise<void> {
  const client = await connect();
  try {
    await client.publishAsync(topic, envelope(sign(deviceKey(device), { device, ...body })), { qos: 1 });
  } finally {
    await client.endAsync();
  }
}

export type CommandResult = { ok: true; detail?: string } | { ok: false; reason: string };

/**
 * Publish a command and wait for the device's signed ack (≤ ACK_TIMEOUT_MS).
 * Used for the door, where the caller must know whether it actually opened.
 */
export async function command(device: string, action: string, args: Record<string, Json> = {}): Promise<CommandResult> {
  const key = deviceKey(device);
  const signed = sign(key, { device, action, ...args });
  const client = await connect();

  try {
    return await new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: 'ei vastausta laitteelta' }), ACK_TIMEOUT_MS);

      client.on('message', (_t, buf) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(buf.toString());
        } catch {
          return;
        }
        const v = verify(key, parsed);
        if (!v.ok) return; // only a correctly-signed, in-window ack counts
        const b = v.value.body;
        if (b.reply !== signed.nonce) return; // ...and only the one for THIS command
        clearTimeout(timer);
        resolve(
          b.result === 'ok'
            ? { ok: true, detail: typeof b.detail === 'string' ? b.detail : undefined }
            : { ok: false, reason: typeof b.detail === 'string' ? b.detail : 'laite hylkäsi' },
        );
      });

      client
        .subscribeAsync(`kolo/${device}/ack`, { qos: 1 })
        .then(() => client.publishAsync(`kolo/${device}/cmd`, envelope(signed), { qos: 1 }))
        .catch((err) => {
          clearTimeout(timer);
          resolve({ ok: false, reason: err instanceof Error ? err.message : 'julkaisu epäonnistui' });
        });
    });
  } finally {
    await client.endAsync();
  }
}
