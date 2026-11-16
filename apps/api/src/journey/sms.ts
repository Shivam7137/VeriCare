import twilio from "twilio";
import type { Pool } from "pg";
import { BackendError } from "../domain.js";
import { webhookUrl } from "../twilio-provider.js";
import { SMS_SID, smsProviderStatus, type TwilioSmsClient } from "../twilio-sms.js";
import { voiceNumberAllowed, voiceReadiness, type VoiceConfig } from "../voice-config.js";
import { checkInByText, visitMessage, type Agent } from "./intake.js";
import { SMS_STOPPED, SMS_WELCOME } from "./messages.js";

// Text messages for the journey: the sender that empties the queue, and what an inbound
// text does. Without a live provider every queued text is marked "simulated" and shown on
// screen, so the demo runs the same with or without a phone company behind it.

export type SmsSender = {
  send(input: { id: string; to: string; body: string }): Promise<{ sid: string; status: string }>;
};

/**
 * A real sender only when the phone line is fully configured AND journey texts are switched
 * on. Texts go only to numbers on the allow-list, never to the line's own number.
 */
export function createJourneySmsSender(
  config: VoiceConfig,
  env: NodeJS.ProcessEnv = process.env,
  client?: TwilioSmsClient,
): SmsSender | null {
  if (env.JOURNEY_SMS_ENABLED !== "true" || !voiceReadiness(config).liveReady) return null;
  return {
    async send(input) {
      if (!voiceNumberAllowed(config, input.to) || input.to === config.phoneNumber)
        throw new BackendError("sms_blocked", 403);
      const active =
        client ??
        twilio(config.accountSid!, config.authToken!, {
          autoRetry: false,
          timeout: 10_000,
          logLevel: "error",
        });
      const ack = await active.messages.create({
        to: input.to,
        from: config.phoneNumber!,
        body: input.body,
        statusCallback: webhookUrl(config, `/journey/sms/${input.id}/status`),
      });
      if (!ack || !SMS_SID.test(ack.sid) || !Object.hasOwn(smsProviderStatus, ack.status))
        throw new BackendError("sms_uncertain", 502);
      return { sid: ack.sid, status: smsProviderStatus[ack.status]! };
    },
  };
}

/**
 * Sends what is queued. A text is claimed before it is sent, so a crash can lose one text
 * but can never send the same one twice.
 */
export async function dispatchJourneySms(pool: Pool, sender: SmsSender | null, now: Date) {
  const claimed = await pool.query<{ id: string; to: string; body: string }>(
    `UPDATE ed_sms SET status = $1, updated_at = $2
     WHERE id IN (SELECT id FROM ed_sms WHERE status = 'queued' ORDER BY seq LIMIT 20
                  FOR UPDATE SKIP LOCKED)
     RETURNING id, to_number AS "to", body`,
    [sender ? "accepted" : "simulated", now],
  );
  if (!sender) return claimed.rowCount ?? 0;
  for (const row of claimed.rows) {
    try {
      const ack = await sender.send(row);
      await pool.query(
        "UPDATE ed_sms SET status = $2, provider_sid = $3, updated_at = $4 WHERE id = $1",
        [row.id, ack.status, ack.sid, now],
      );
    } catch (error) {
      const blocked = error instanceof BackendError && error.code === "sms_blocked";
      await pool.query(
        "UPDATE ed_sms SET status = $2, last_error = $3, updated_at = $4 WHERE id = $1",
        [row.id, blocked ? "blocked" : "failed", blocked ? "not_allowed" : "provider_error", now],
      );
    }
  }
  return claimed.rowCount ?? 0;
}

/** The provider's delivery report for one text. */
export async function smsStatus(
  pool: Pool,
  id: string,
  report: { sid: string; status: string },
  now: Date,
) {
  const status = smsProviderStatus[report.status];
  if (!status || !SMS_SID.test(report.sid)) throw new BackendError("invalid_input", 400);
  // A late "sent" must not overwrite "delivered".
  await pool.query(
    `UPDATE ed_sms SET status = $3, updated_at = $4
     WHERE id = $1 AND provider_sid = $2 AND status NOT IN ('delivered', 'failed')`,
    [id, report.sid, status, now],
  );
}

const yes = /^\s*(yes|y|start|oui)\s*[.!]?\s*$/i;
const stop = /^\s*(stop|stopall|unsubscribe|end|quit|cancel|arret)\s*[.!]?\s*$/i;
const feeling = /^\s*(same|better|worse)\s*[.!]?\s*$/i;

/**
 * One inbound text. Returns the reply to send back, or null to stay silent: an unknown
 * number learns nothing, not even that this line belongs to a hospital service.
 */
export async function inboundSms(
  pool: Pool,
  message: { from: string; body: string; sid: string },
  now: Date,
  agent: Agent = null,
): Promise<string | null> {
  const fresh = await pool.query(
    `INSERT INTO ed_sms_inbound (provider_sid, from_number, received_at) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING RETURNING provider_sid`,
    [message.sid, message.from, now],
  );
  if (fresh.rowCount === 0) return null;
  const text = message.body.trim().slice(0, 500);
  if (!text) return null;
  const patient = await pool.query<{ id: string }>(
    `SELECT id FROM ed_encounters WHERE phone = $1 AND NOT (state->>'ended')::boolean
     ORDER BY created_at DESC LIMIT 1`,
    [message.from],
  );
  const contact = patient.rows[0]
    ? null
    : (
        await pool.query<{ id: string; encounterId: string }>(
          `SELECT c.id, c.encounter_id AS "encounterId" FROM ed_contacts c
           JOIN ed_encounters e ON e.id = c.encounter_id
           WHERE c.phone = $1 AND c.withdrawn_at IS NULL AND NOT (e.state->>'ended')::boolean
           ORDER BY c.created_at DESC LIMIT 1`,
          [message.from],
        )
      ).rows[0];
  if (!patient.rows[0] && !contact) return null;
  const encounterId = patient.rows[0]?.id ?? contact!.encounterId;

  if (yes.test(text) || stop.test(text)) {
    const optIn = yes.test(text) ? now : null;
    if (contact)
      await pool.query("UPDATE ed_contacts SET sms_opt_in_at = $2 WHERE id = $1", [
        contact.id,
        optIn,
      ]);
    else
      await pool.query("UPDATE ed_encounters SET sms_opt_in_at = $2 WHERE id = $1", [
        encounterId,
        optIn,
      ]);
    return optIn ? SMS_WELCOME : SMS_STOPPED;
  }
  try {
    const answer = feeling.exec(text)?.[1]?.toLowerCase();
    if (!contact && answer)
      return (await checkInByText(pool, encounterId, answer as "same" | "better" | "worse", now))
        .reply;
    return (
      await visitMessage(pool, { encounterId, contactId: contact?.id }, text, "sms", now, agent)
    ).reply;
  } catch (error) {
    if (error instanceof BackendError) return null;
    throw error;
  }
}

export function twiml(reply: string | null) {
  const escaped = (reply ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${reply ? `<Message>${escaped}</Message>` : ""}</Response>`;
}
