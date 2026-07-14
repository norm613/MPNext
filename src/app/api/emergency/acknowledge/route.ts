import { NextRequest, NextResponse } from "next/server";
import { isEmergencyRequestAuthorized } from "@/lib/emergency-auth";
import { ContactLogService } from "@/services/contactLogService";

export const runtime = "nodejs";

interface AckBody {
  contactLogId?: number;
  ackBy?: string;
  ackAt?: string; // ISO datetime
}

/**
 * Marks an emergency incident acknowledged: flips the Contact_Log's
 * Contact_Successful to true and appends an "Acknowledged by ... at ..." line.
 * Called when the primary presses `#` on the notify call or texts an ack
 * keyword. Guarded by the shared secret.
 */
export async function POST(req: NextRequest) {
  if (!isEmergencyRequestAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: AckBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { contactLogId, ackBy, ackAt } = body;
  if (!contactLogId) {
    return NextResponse.json({ error: "missing 'contactLogId'" }, { status: 400 });
  }

  const logs = await ContactLogService.getInstance();
  const existing = await logs.getContactLogById(contactLogId);
  const stamp = `Acknowledged by ${ackBy || "on-call responder"} at ${ackAt || new Date().toISOString()}`;
  const newNotes = (
    (existing?.Notes ?? "").replace("Status: UNACKNOWLEDGED", "Status: ACKNOWLEDGED") +
    "\n" +
    stamp
  ).slice(0, 2000);

  await logs.updateContactLog(contactLogId, {
    Contact_Successful: true,
    Notes: newNotes,
  });

  return NextResponse.json({ ok: true, contactLogId });
}
