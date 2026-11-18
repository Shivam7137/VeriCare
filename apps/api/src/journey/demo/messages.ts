import type { createTwin, TwinPatient } from "../../twin/scenario.js";
import { hashSeed, type Act, type Plan } from "./flow.js";
import type { Row } from "./types.js";

// Turns one move of one visit into the HL7 messages a hospital feed would send for it.

type Twin = ReturnType<typeof createTwin>;
const UNITS = ["6.1", "6.2", "7.3", "4.4"] as const;

/** The patient as the twin builders expect, read back from the visit's record. */
export function patientOf(row: Row): TwinPatient {
  const [given = "Patient", ...rest] = row.name.split(" ");
  return {
    mrn: row.mrn,
    visit: row.visit,
    given: given.toUpperCase(),
    family: rest.join(" ").toUpperCase() || "UNKNOWN",
    dateOfBirth: row.dob ?? "1980-01-01",
  };
}

/**
 * Writes the move with the twin at `minute`. `nextRoom` hands out treatment rooms in turn.
 * The caller collects the messages the twin produced.
 */
export function writeMove(
  twin: Twin,
  minute: number,
  row: Row,
  act: Act,
  plan: Plan,
  nextRoom: () => string,
): void {
  const patient = patientOf(row);
  const room = row.facts.room || "WAITROOM";
  switch (act) {
    case "triage":
      twin.triage(minute, patient, plan.ctas, plan.raz ? "RAZ" : room);
      break;
    case "see": {
      const rapid = plan.raz || row.state.stream === "rapid_assessment";
      twin.see(minute, patient, rapid ? "RAZ" : nextRoom(), hashSeed(row.visit) % 3);
      break;
    }
    case "order":
      if (plan.labs) twin.order(minute, patient, room, `ORD-${row.visit}-L`, "LAB");
      if (plan.imaging) twin.order(minute, patient, room, `ORD-${row.visit}-I`, plan.imaging);
      if (plan.consult) twin.order(minute, patient, room, `ORD-${row.visit}-C`, "CON");
      break;
    case "result":
      if (plan.labs) twin.result(minute, patient, room, `ORD-${row.visit}-L`);
      if (plan.imaging) twin.result(minute, patient, room, `ORD-${row.visit}-I`);
      break;
    case "discharge":
      twin.discharge(minute, patient, room, "HOME");
      break;
    case "admit":
      twin.admit(minute, patient, room);
      break;
    case "bed":
      twin.requestBed(minute, patient, room);
      break;
    case "move":
      twin.moveToUnit(
        minute,
        patient,
        UNITS[hashSeed(row.visit) % UNITS.length]!,
        `B${(hashSeed(row.visit) % 24) + 1}`,
      );
      break;
  }
}
