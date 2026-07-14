import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared-secret guard for the server-to-server emergency API routes
 * (`/api/emergency/*`). These are called by the Twilio Serverless functions,
 * NOT by browser users — the app's proxy (src/proxy.ts) treats all `/api` paths
 * as public, so this check is the ENTIRE security boundary for these routes.
 *
 * Security properties:
 *  - Requires `Authorization: Bearer <EMERGENCY_API_SECRET>`.
 *  - Compares in CONSTANT TIME (timingSafeEqual over SHA-256 digests, so the
 *    comparison is fixed-length and does not leak the secret's length or a
 *    prefix match via timing).
 *  - FAILS CLOSED: if the server has no EMERGENCY_API_SECRET configured, every
 *    request is rejected (the opposite of the blocklist's fail-open — here we
 *    are protecting writes to real church data, so we deny by default).
 *
 * Set EMERGENCY_API_SECRET in the Vercel project env; set the SAME value in the
 * Twilio service env. Never commit it.
 */
export function isEmergencyRequestAuthorized(req: NextRequest): boolean {
  const expected = process.env.EMERGENCY_API_SECRET;
  if (!expected) return false; // fail closed — not configured

  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!provided) return false;

  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}
