import type {
  Ctas,
  EdEvent,
  EdEventKind,
  EdImagingModality,
  EdOrderType,
  SensitivityFlag,
} from "@prc/contracts";
import {
  component,
  field,
  hl7Time,
  parseHl7,
  repetitions,
  segment,
  segments,
  type Hl7Message,
} from "./hl7.js";

/**
 * Per-site settings. Oracle Health's outbound interface is built per customer,
 * and triage level and privacy markers have no standard HL7 field, so every
 * site-specific code lives here instead of in the mapping logic.
 */
export type SiteConfig = {
  utcOffset: string;
  /** PV1-3.1 values that mean the patient is in the emergency department. */
  edPointsOfCare: readonly string[];
  /** PV1-3.2 rooms that belong to the rapid assessment stream. */
  rapidAssessmentRooms: readonly string[];
  /** OBX-3.1 code that carries the triage level. */
  ctasObservationCode: string;
  /** OBX-3.1 code for a security or violence alert (value Y). */
  securityObservationCode: string;
  /** PV1-36 values for patients who left before being seen. */
  walkoutDispositions: readonly string[];
  deceasedDispositions: readonly string[];
};

export const halifaxTwinSite: SiteConfig = {
  utcOffset: "-0400",
  edPointsOfCare: ["ED"],
  rapidAssessmentRooms: ["RAZ"],
  ctasObservationCode: "CTAS",
  securityObservationCode: "SECALERT",
  walkoutDispositions: ["LWBS"],
  deceasedDispositions: ["EXP"],
};

/** What the last message told us about the visit, kept so the next one can be compared. */
export type VisitFacts = {
  pointOfCare: string;
  room: string;
  hasProvider: boolean;
  ctas: Ctas | null;
  inpatient: boolean;
  flags: SensitivityFlag[];
};

export type MappedMessage =
  | { kind: "ignored"; controlId: string; why: "not_emergency" | "pre_arrival" }
  | {
      kind: "visit";
      controlId: string;
      visitNumber: string;
      mrn: string;
      patient: { name: string; dateOfBirth: string | null; phone: string | null };
      occurredAt: string;
      events: EdEvent[];
      facts: VisitFacts;
    };

const imaging = new Set(["RAD", "CT", "US", "XR", "MR", "NM"]);
const lab = new Set(["LAB", "HM", "CH", "BG", "MB", "SR"]);

/** Turns one HL7 v2 message into normalised events, given what was known before it. */
export function mapHl7(raw: string, site: SiteConfig, prior: VisitFacts | null): MappedMessage {
  const message = parseHl7(raw);
  const msh = segment(message, "MSH");
  const pid = segment(message, "PID");
  const pv1 = segment(message, "PV1");
  const controlId = field(msh, 10);
  const type = component(field(msh, 9), 1);
  const trigger = component(field(msh, 9), 2);
  const visitNumber = component(field(pv1, 19), 1);
  if (!controlId || !visitNumber) throw new Error("hl7_missing_identifiers");

  const location = field(pv1, 3);
  const pointOfCare = component(location, 1) || prior?.pointOfCare || "";
  const room = component(location, 2) || (component(location, 1) ? "" : (prior?.room ?? ""));
  const inEd = site.edPointsOfCare.includes(pointOfCare);
  if (!prior && !inEd) return { kind: "ignored", controlId, why: "not_emergency" };
  if (!prior && trigger === "A05") return { kind: "ignored", controlId, why: "pre_arrival" };

  const evn = segment(message, "EVN");
  const occurredAt =
    hl7Time(field(evn, 6), site.utcOffset) ??
    hl7Time(field(evn, 2), site.utcOffset) ??
    hl7Time(field(msh, 7), site.utcOffset);
  if (!occurredAt) throw new Error("hl7_missing_time");

  const events: EdEvent[] = [];
  const add = (kind: EdEventKind, detail: EdEvent["detail"] = {}) =>
    events.push({
      kind,
      occurredAt,
      source: "hl7v2",
      sourceEventId: `${controlId}#${events.length}`,
      detail,
    });
  const stream = site.rapidAssessmentRooms.includes(room) ? "rapid_assessment" : "main";
  const facts: VisitFacts = {
    pointOfCare,
    room,
    hasProvider: prior?.hasProvider ?? false,
    ctas: prior?.ctas ?? null,
    inpatient: prior?.inpatient ?? false,
    flags: [...(prior?.flags ?? [])],
  };

  if (type === "ADT") mapAdt({ message, trigger, site, prior, facts, inEd, stream, add });
  else if (type === "ORM") mapOrder(message, add);
  else if (type === "ORU") mapResult(message, add);
  else add("unmapped", { trigger: `${type}^${trigger}`.slice(0, 20) });

  return {
    kind: "visit",
    controlId,
    visitNumber,
    mrn: medicalRecordNumber(repetitions(pid, 3)),
    patient: {
      name: [component(field(pid, 5), 2), component(field(pid, 5), 1)].filter(Boolean).join(" "),
      dateOfBirth: birthDate(field(pid, 7)),
      phone: phoneNumber(field(pid, 13)),
    },
    occurredAt,
    events,
    facts,
  };
}

function mapAdt(input: {
  message: Hl7Message;
  trigger: string;
  site: SiteConfig;
  prior: VisitFacts | null;
  facts: VisitFacts;
  inEd: boolean;
  stream: "main" | "rapid_assessment";
  add: (kind: EdEventKind, detail?: EdEvent["detail"]) => void;
}) {
  const { message, trigger, site, prior, facts, inEd, stream, add } = input;
  const pid = segment(message, "PID");
  const pv1 = segment(message, "PV1");
  const pv2 = segment(message, "PV2");
  const pd1 = segment(message, "PD1");
  const observation = (code: string) =>
    segments(message, "OBX").find((obx) => component(field(obx, 3), 1) === code);

  // Privacy and safety markers first, so a flagged visit is silenced before anything else.
  const setFlag = (flag: SensitivityFlag) => {
    if (facts.flags.includes(flag)) return;
    facts.flags.push(flag);
    add("flag_set", { flag });
  };
  // The feed can only clear a flag with an explicit negative. Absence proves nothing.
  const clearFlag = (flag: SensitivityFlag) => {
    if (!facts.flags.includes(flag)) return;
    facts.flags = facts.flags.filter((item) => item !== flag);
    add("flag_cleared", { flag });
  };
  const disposition = component(field(pv1, 36), 1);
  if (field(pid, 30) === "Y" || field(pid, 29) || site.deceasedDispositions.includes(disposition))
    setFlag("deceased");
  else if (field(pid, 30) === "N") clearFlag("deceased");
  if (field(pv1, 16)) setFlag("vip");
  const protection = [field(pd1, 12), field(pv2, 22)];
  if (protection.includes("Y")) setFlag("confidential");
  else if (protection.includes("N")) clearFlag("confidential");
  const security = field(observation(site.securityObservationCode), 5);
  if (component(security, 1) === "Y") setFlag("security");
  else if (component(security, 1) === "N") clearFlag("security");

  if (trigger === "A11") return add("cancelled", { trigger });
  if (trigger === "A03")
    return add(
      site.walkoutDispositions.includes(disposition) ? "left_without_being_seen" : "discharged",
      { trigger },
    );
  // Cancelled discharges and merges change history. Fail closed until staff review.
  if (["A12", "A13", "A40", "A41", "A42", "A44", "A45"].includes(trigger))
    return add("unmapped", { trigger });

  const area = facts.room || facts.pointOfCare;
  if (!prior) add("arrived", { area, stream, trigger });
  else if (!inEd) return add("moved_to_unit", { area: facts.pointOfCare, trigger });
  else if (prior.room !== facts.room || prior.pointOfCare !== facts.pointOfCare)
    add("location_changed", { area, stream });

  const level = Number(component(field(observation(site.ctasObservationCode), 5), 1));
  if (level >= 1 && level <= 5 && level !== facts.ctas) {
    facts.ctas = level as Ctas;
    add("triaged", { ctas: facts.ctas });
  }
  if (field(pv1, 7) && !facts.hasProvider) {
    facts.hasProvider = true;
    add("provider_assigned");
  }
  const inpatient = field(pv1, 2) === "I" || trigger === "A01" || trigger === "A06";
  if (prior && inpatient && !facts.inpatient) {
    facts.inpatient = true;
    add("admit_decision", { trigger });
  }
  if (trigger === "A14" || trigger === "A15") add("bed_requested", { trigger });
}

function mapOrder(
  message: Hl7Message,
  add: (kind: EdEventKind, detail?: EdEvent["detail"]) => void,
) {
  const orc = segment(message, "ORC");
  const obr = segment(message, "OBR");
  const orderId = component(field(obr, 2), 1) || component(field(orc, 2), 1);
  const control = field(orc, 1);
  const section = field(obr, 24);
  if (!orderId) return add("unmapped", { trigger: "ORM" });
  if (control === "CA" || control === "OC" || control === "DC")
    return add("order_cancelled", { orderId });
  if (control !== "NW") return;
  if (section === "CON") return add("consult_requested");
  const type = orderType(section);
  add("order_placed", {
    orderId,
    orderType: type,
    ...(type === "imaging" ? { modality: modality(section) } : {}),
  });
}

function mapResult(
  message: Hl7Message,
  add: (kind: EdEventKind, detail?: EdEvent["detail"]) => void,
) {
  const obr = segment(message, "OBR");
  const orderId = component(field(obr, 2), 1);
  if (!orderId) return add("unmapped", { trigger: "ORU" });
  // Only the status is read. Result values (OBX) are never looked at or stored as events.
  const status = field(obr, 25);
  if (status === "F" || status === "C") add("result_available", { orderId });
}

const orderType = (section: string): EdOrderType =>
  imaging.has(section) ? "imaging" : lab.has(section) ? "lab" : "other";

const modalities: Record<string, EdImagingModality> = {
  RAD: "xray",
  XR: "xray",
  CT: "ct",
  US: "ultrasound",
  MR: "mri",
};
const modality = (section: string): EdImagingModality => modalities[section] ?? "other";

function medicalRecordNumber(ids: string[]): string {
  const record = ids.find((id) => component(id, 5) === "MR") ?? ids[0] ?? "";
  return component(record, 1);
}

function birthDate(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function phoneNumber(value: string): string | null {
  const direct = component(value, 1).replace(/[^\d+]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(direct)) return direct;
  const built = `+1${component(value, 6)}${component(value, 7)}`;
  return /^\+1\d{10}$/.test(built) ? built : null;
}
