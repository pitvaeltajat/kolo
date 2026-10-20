import { denyNonCron } from '@/lib/cron';
import prisma from '@/lib/prisma';
import { notifyAdmins } from '@/lib/notify';
import { DEVICE_SILENT_MS } from '@/lib/config';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Alert when a device goes quiet (HEATING.md "site silent > 30 min → email").
 * On Vercel Hobby this cron runs daily, so every silent device is reported and
 * the once-per-day cadence is its own de-dupe. Move the cron to a few minutes
 * and add per-device `alertedAt` if you upgrade to Pro and want faster, quieter
 * alerts (ponytail: daily cadence, no persisted alert state).
 */
export async function GET(req: NextRequest) {
  const bad = denyNonCron(req);
  if (bad) return bad;

  const now = Date.now();
  const devices = await prisma.device.findMany();
  const silent = devices.filter((d) => now - d.updatedAt.getTime() > DEVICE_SILENT_MS);

  if (silent.length > 0) {
    const list = silent.map((d) => `- ${d.id} (viimeksi ${d.updatedAt.toISOString()})`).join('\n');
    await notifyAdmins('Kolo: laite hiljentynyt', `Seuraavat laitteet eivät ole raportoineet yli 30 min:\n${list}`);
  }
  return NextResponse.json({ ok: true, alerted: silent.map((d) => d.id) });
}
