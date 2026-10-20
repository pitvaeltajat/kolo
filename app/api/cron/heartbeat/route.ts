import { denyNonCron } from '@/lib/cron';
import prisma from '@/lib/prisma';
import { notifyAdmins } from '@/lib/notify';
import { DEVICE_SILENT_MS } from '@/lib/config';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Alert when a device goes quiet (HEATING.md "site silent > 30 min → email").
 * Only *newly* silent devices are reported — those whose last report fell into
 * the one-window band before the threshold — so a device that stays down emails
 * once, not every run.
 *
 * ponytail: time-band dedupe (no persisted alert state). If the cron interval
 * and the band drift out of sync you could miss or repeat an alert; add an
 * `alertedAt` per device if that ever bites.
 */
export async function GET(req: NextRequest) {
  const bad = denyNonCron(req);
  if (bad) return bad;

  const now = Date.now();
  const devices = await prisma.device.findMany();
  const newlySilent = devices.filter((d) => {
    const age = now - d.updatedAt.getTime();
    return age > DEVICE_SILENT_MS && age <= 2 * DEVICE_SILENT_MS;
  });

  if (newlySilent.length > 0) {
    const list = newlySilent.map((d) => `- ${d.id} (viimeksi ${d.updatedAt.toISOString()})`).join('\n');
    await notifyAdmins('Kolo: laite hiljentynyt', `Seuraavat laitteet eivät ole raportoineet yli 30 min:\n${list}`);
  }
  return NextResponse.json({ ok: true, alerted: newlySilent.map((d) => d.id) });
}
