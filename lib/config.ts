/**
 * Every environment knob kolo reads, in one place. Values that are policy
 * (temperatures, timings) are constants; values that are secrets or per-deploy
 * (domain, keys, broker URL) come from the environment.
 */

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

// --- Access policy ---------------------------------------------------------

/** Google Workspace domain members sign in with. Used as the `hd` hint and the server-side gate. */
export const WORKSPACE_DOMAIN = optionalEnv('GOOGLE_WORKSPACE_DOMAIN');

/** The one Google Group whose members may open the door and set the heating. */
export const ACCESS_GROUP = optionalEnv('ACCESS_GROUP');

/**
 * Comma-separated emails allowed to administer tags/devices. Empty = every
 * member may (the troop runs one shared access group — see HEATING.md open
 * questions). Narrow this the day tag admin needs to be restricted.
 */
export const ADMIN_EMAILS = (optionalEnv('ADMIN_EMAILS') ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/** The address directory reads impersonate (domain-wide delegation needs a real admin). */
export const DIRECTORY_SUBJECT = optionalEnv('GOOGLE_DIRECTORY_SUBJECT');

// --- Heating policy (HEATING.md "Control rules") ---------------------------

export const SETPOINT_MIN_C = 5;
export const SETPOINT_MAX_C = 24;
export const FROST_C = 8; // sensor silent > 30 min → frost protection, not "on"
export const COMFORT_C = 20; // during/before an event
export const IDLE_C = 12; // otherwise
export const PREHEAT_HOURS = 2; // start heating this long before an event
export const SCHEDULE_DAYS = 7; // how far ahead to push periods to the Shellys

// --- Timings ---------------------------------------------------------------

export const COMMAND_SKEW_MS = 30_000; // ESP32 accepts commands within ±30 s
export const ACK_TIMEOUT_MS = 5_000; // wait this long for the lock's ack
export const DEVICE_SILENT_MS = 30 * 60_000; // no report in 30 min → heartbeat alert

export function clampSetpoint(c: number): number {
  return Math.min(SETPOINT_MAX_C, Math.max(SETPOINT_MIN_C, c));
}
