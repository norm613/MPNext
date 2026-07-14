/**
 * Downloads a Twilio call recording as MP3 bytes, server-side, using the
 * restricted read-only Recordings API key. Never runs in the browser.
 * Returns a Uint8Array (plain ArrayBuffer-backed) so it is directly usable as a
 * File/Blob part — a Node Buffer is NOT assignable to DOM BlobPart under strict
 * TS.
 *
 * Env (set in Vercel + .env.local):
 *   TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET
 */
export async function downloadRecordingMp3(recordingSid: string): Promise<Uint8Array> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySecret = process.env.TWILIO_API_KEY_SECRET;
  if (!accountSid || !keySid || !keySecret) {
    throw new Error(
      "Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET)"
    );
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.mp3`;
  const auth = Buffer.from(`${keySid}:${keySecret}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    throw new Error(`Twilio recording download failed: HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
