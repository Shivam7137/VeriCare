import type { ConsentScope } from "@prc/contracts";
import type { Pool } from "pg";
import { z } from "zod";
import { BackendError } from "../domain.js";
import type { EmergencyLookup } from "../emergency-lookup.js";
import { decideDisclosure } from "./guardian.js";
import { visitMessage, type Agent } from "./intake.js";
import {
  CONTACT_WORSE_REPLY,
  HANDOFF_REPLY,
  QUESTION_REPLY,
  rangeSentence,
  statusSentence,
} from "./messages.js";
import {
  activeContacts,
  audit,
  feedStatus,
  latestEncounterForPatient,
  recordMessage,
  journeyTransaction,
} from "./records.js";
import { openTask, triageText, waitedText, worseWords } from "./tasks.js";

// Alex's journey tools on the phone line. Both unlock only after the caller has passed the
// one-time code for this patient, and both go through the Guardian like every other channel.
// Alex receives a finished sentence to say; it never sees the visit record.

const questionSchema = z.strictObject({ question: z.string().trim().min(3).max(500) });
const SAY =
  "Say what 'say' says, in the caller's language. Do not add reasons, guesses or numbers.";

export class JourneyVoice {
  readonly now: () => Date;
  constructor(
    readonly pool: Pool,
    readonly emergency: EmergencyLookup,
    readonly options: { now?: () => Date; agent?: Agent } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** The verified caller, the patient's open visit, and what the patient lets this caller hear. */
  private async caller(callId: string) {
    const verified = await this.emergency.verifiedContact(callId);
    if ("gate" in verified) return { gate: verified.gate };
    const encounter = await latestEncounterForPatient(this.pool, verified.patientId);
    if (!encounter || encounter.state.ended) return { verified, encounter: null, contact: null };
    // Consent on the visit page decides what this number hears. The contact registered with
    // the hospital, with no entry on the visit page, hears the step and nothing more.
    const contact =
      (await activeContacts(this.pool, encounter.id)).find(
        (item) => item.phone === verified.contactNumber,
      ) ?? null;
    return { verified, encounter, contact };
  }

  async status(callId: string) {
    const caller = await this.caller(callId);
    if ("gate" in caller) return caller.gate;
    const { encounter, contact } = caller;
    const now = this.now();
    const handoff = { status: "handoff", say: HANDOFF_REPLY, message: SAY };
    if (!encounter) return handoff;
    const scopes: ConsentScope[] = contact?.scopes ?? ["status"];
    const feed = await feedStatus(this.pool, encounter.site);
    const decision = decideDisclosure({
      audience: "contact",
      verified: true,
      consentScopes: scopes,
      state: encounter.state,
      feedLastMessageAt: feed?.lastMessageAt ?? null,
      now,
      request: "estimate",
    });
    const firstName = encounter.displayName.split(" ")[0] ?? "";
    const range =
      decision.outcome === "allow" && decision.estimate && encounter.published
        ? ` ${rangeSentence(encounter.published.lowMinutes, encounter.published.highMinutes, "contact")}`
        : "";
    const say =
      decision.outcome === "allow"
        ? `${statusSentence(encounter.state, "contact", firstName)}${range}`
        : HANDOFF_REPLY;
    await journeyTransaction(this.pool, async (db) => {
      await audit(db, {
        at: now,
        actor: "guardian",
        action: `voice_status_${decision.outcome}`,
        encounterId: encounter.id,
        detail: { callId, estimate: range !== "" },
      });
      if (contact)
        await recordMessage(db, {
          encounterId: encounter.id,
          audience: "contact",
          contactId: contact.id,
          direction: "out",
          kind: "voice_status",
          body: say,
          at: now,
          channel: "voice",
        });
    });
    // A silenced visit and a transfer sound the same: the caller is never told why.
    if (decision.outcome !== "allow") return handoff;
    return { status: "journey_status", say, estimateShared: range !== "", message: SAY };
  }

  async relay(callId: string, raw: unknown) {
    const { question } = questionSchema.parse(raw);
    const caller = await this.caller(callId);
    if ("gate" in caller) return caller.gate;
    const { encounter, contact, verified } = caller;
    const now = this.now();
    if (!encounter) return { status: "handoff", say: HANDOFF_REPLY, message: SAY };
    let reply: string;
    if (contact) {
      // Same path as a text or the family page: floors first, then the Visit Agent.
      try {
        reply = (
          await visitMessage(
            this.pool,
            { encounterId: encounter.id, contactId: contact.id },
            question,
            "voice",
            now,
            this.options.agent ?? null,
          )
        ).reply;
      } catch (error) {
        if (!(error instanceof BackendError)) throw error;
        reply = HANDOFF_REPLY;
      }
    } else {
      const worse = worseWords.test(question);
      reply = worse ? CONTACT_WORSE_REPLY : QUESTION_REPLY;
      await journeyTransaction(this.pool, async (db) => {
        const feed = await feedStatus(db, encounter.site);
        if (encounter.state.sensitivity.length > 0 || encounter.state.unmapped) {
          reply = HANDOFF_REPLY;
          return;
        }
        await openTask(
          db,
          encounter,
          worse ? "recheck" : "question",
          worse ? 1 : 3,
          worse
            ? `${verified.relationship} reports by phone that the patient may be getting worse: "${question}".${triageText(encounter)}${waitedText(encounter, feed?.feedTime)}`
            : `Question by phone from ${verified.relationship}: "${question}".`,
          now,
        );
      });
    }
    return {
      status: reply === HANDOFF_REPLY ? "handoff" : "relayed",
      say: reply,
      message: `${SAY} Do not answer the question yourself.`,
    };
  }
}
