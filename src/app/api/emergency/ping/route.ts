import { NextRequest, NextResponse } from "next/server";
import { isEmergencyRequestAuthorized } from "@/lib/emergency-auth";

/**
 * Secured no-op used to verify the Twilio -> MPNext channel end-to-end WITHOUT
 * touching Ministry Platform. Returns 401 unless the shared secret is present
 * and correct, 200 otherwise. Safe to call repeatedly; performs no reads or
 * writes. Once this returns ok from the Twilio side, the secure connection is
 * proven and the real /incident and /acknowledge routes can be built on the
 * same guard.
 */
export async function POST(req: NextRequest) {
  if (!isEmergencyRequestAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, service: "emergency", route: "ping" });
}
