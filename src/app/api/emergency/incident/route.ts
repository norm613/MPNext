import { NextRequest, NextResponse } from "next/server";
import { isEmergencyRequestAuthorized } from "@/lib/emergency-auth";
import { ContactService } from "@/services/contactService";
import { ContactLogService } from "@/services/contactLogService";
import { MPHelper } from "@/lib/providers/ministry-platform";
import { downloadRecordingMp3 } from "@/lib/twilio-recording";

// Needs the Node.js runtime (File / server-side fetch to Twilio).
export const runtime = "nodejs";

const EMERGENCY_LOG_TYPE_ID = 7; // "Emergency Line"
const MADE_BY_USER_ID = 318; // "MPNext User"
const UNASSIGNED_CONTACT_ID = 10;

interface IncidentBody {
  from?: string;
  recordingSid?: string;
  transcription?: string;
  callSid?: string;
  receivedAt?: string; // ISO datetime
}

function buildNotes(p: {
  from: string;
  matchedName: string | null;
  callSid?: string;
  transcription?: string;
  recordingUrl: string | null;
}): string {
  const lines = [
    "[Emergency Line] Incoming message.",
    `From: ${p.from}${p.matchedName ? ` (matched: ${p.matchedName})` : " (no MP match)"}`,
  ];
  if (p.callSid) lines.push(`Call SID: ${p.callSid}`);
  lines.push(`Transcription: ${p.transcription?.trim() || "(pending)"}`);
  lines.push(`Recording: ${p.recordingUrl ?? "(attached to this record)"}`);
  lines.push("Status: UNACKNOWLEDGED");
  return lines.join("\n").slice(0, 2000); // Notes column caps at 2000 chars
}

/**
 * Creates an emergency-line incident: resolves the caller to an MP Contact,
 * writes a Type-7 Contact_Log, and (best-effort) downloads + attaches the
 * Twilio recording, linking it via MP's no-auth file URL.
 *
 * Called server-to-server by the Twilio recording-status function; guarded by
 * the shared secret. The recording attach is best-effort and never fails the
 * incident. Any other failure returns 500 with the message (the caller is our
 * own authenticated function, so surfacing the detail aids debugging).
 */
export async function POST(req: NextRequest) {
  if (!isEmergencyRequestAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: IncidentBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { from, recordingSid, transcription, callSid, receivedAt } = body;
  if (!from) {
    return NextResponse.json({ error: "missing 'from'" }, { status: 400 });
  }

  try {
    // Resolve caller -> Contact. EMERGENCY_TEST_CONTACT_ID pins every incident
    // to one contact during development (e.g. 3575) so no real parishioner is
    // touched; unset it in production for the real lookup.
    const testContactId = process.env.EMERGENCY_TEST_CONTACT_ID;
    let contactId: number;
    let matchedName: string | null = null;
    if (testContactId) {
      contactId = parseInt(testContactId, 10);
    } else {
      const contacts = await ContactService.getInstance();
      const c = await contacts.getContactByPhone(from);
      contactId = c?.Contact_ID ?? UNASSIGNED_CONTACT_ID;
      matchedName = c ? `${c.First_Name ?? ""} ${c.Last_Name ?? ""}`.trim() : null;
    }

    const logs = await ContactLogService.getInstance();
    const created = await logs.createContactLog({
      Contact_ID: contactId,
      Contact_Log_Type_ID: EMERGENCY_LOG_TYPE_ID,
      Contact_Date: receivedAt || new Date().toISOString(),
      Made_By: MADE_BY_USER_ID,
      Notes: buildNotes({ from, matchedName, callSid, transcription, recordingUrl: null }),
      Contact_Successful: false,
      Planned_Contact_ID: null,
      Original_Contact_Log_Entry: null,
      Feedback_Entry_ID: null,
    });
    const contactLogId = created.Contact_Log_ID;

    // Best-effort: download the Twilio recording, attach to the record, link it.
    let recordingUrl: string | null = null;
    if (recordingSid) {
      try {
        const mp3 = await downloadRecordingMp3(recordingSid);
        const file = new File([mp3], `emergency-${recordingSid}.mp3`, { type: "audio/mpeg" });
        const mp = new MPHelper();
        const [uploaded] = await mp.uploadFiles({
          table: "Contact_Log",
          recordId: contactLogId,
          files: [file],
        });
        if (uploaded?.UniqueFileId) {
          recordingUrl = `${process.env.MINISTRY_PLATFORM_BASE_URL}/files/${uploaded.UniqueFileId}`;
          await logs.updateContactLog(contactLogId, {
            Notes: buildNotes({ from, matchedName, callSid, transcription, recordingUrl }),
          });
        }
      } catch (err) {
        console.error("[emergency/incident] recording attach failed (non-fatal):", err);
      }
    }

    return NextResponse.json({ ok: true, contactLogId, contactId, matchedName, recordingUrl });
  } catch (err) {
    console.error("[emergency/incident] error:", err);
    return NextResponse.json(
      { error: "incident_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
