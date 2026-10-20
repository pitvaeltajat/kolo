import { optionalEnv } from './config';

/**
 * Email the admins — used by the heartbeat cron when the site goes silent
 * (HEATING.md). Sent through Resend's HTTP API (no SDK, one fetch). Unconfigured
 * → logs a warning instead of throwing, so a missing key never breaks a cron.
 */
export async function notifyAdmins(subject: string, text: string): Promise<void> {
  const apiKey = optionalEnv('RESEND_API_KEY');
  const from = optionalEnv('NOTIFY_FROM');
  const to = optionalEnv('NOTIFY_TO');
  if (!apiKey || !from || !to) {
    console.warn(`[kolo] notifyAdmins (ei sähköpostia määritetty): ${subject} — ${text}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: to.split(',').map((s) => s.trim()), subject, text }),
  });
  if (!res.ok) throw new Error(`Resend failed (${res.status})`);
}
