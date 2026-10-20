import prisma from './prisma';
import { COMMAND_SKEW_MS } from './config';

/**
 * Spend a nonce exactly once. Returns true the first time, false on a replay.
 * The unique insert is the race-free part — two concurrent copies of the same
 * replayed message can't both win. Nonces older than the skew window are pruned
 * opportunistically; outside that window `verify()` has already rejected on the
 * timestamp, so a pruned nonce can never be accepted again.
 */
export async function spendNonce(nonce: string): Promise<boolean> {
  try {
    await prisma.seenNonce.create({ data: { nonce } });
  } catch {
    return false; // unique violation = already spent
  }
  // Fire-and-forget prune; never block the request on it.
  prisma.seenNonce
    .deleteMany({ where: { at: { lt: new Date(Date.now() - COMMAND_SKEW_MS * 2) } } })
    .catch(() => {});
  return true;
}
