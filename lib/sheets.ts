import { getGoogleAccessToken } from './googleAuth';
import { optionalEnv } from './config';

/**
 * Mirror each door event into a Google Sheet the board can read (PLAN.md
 * "Log"). The database (DoorEvent) is the source of truth; this is a convenience
 * copy, so a Sheets failure must never fail the unlock — callers swallow it.
 * No DOOR_LOG_SHEET_ID set → no-op.
 */

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export async function appendDoorLog(row: (string | number)[]): Promise<void> {
  const sheetId = optionalEnv('DOOR_LOG_SHEET_ID');
  const subject = optionalEnv('DOOR_LOG_SHEET_SUBJECT');
  if (!sheetId || !subject) return;

  const token = await getGoogleAccessToken([SCOPE], subject);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`Sheets append failed (${res.status})`);
}
