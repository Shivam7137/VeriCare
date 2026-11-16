import type { TwinPatient, createTwin } from "./scenario.js";

// Featured visits for the demo department. Each one takes a different path through the
// emergency department, so every kind of step and edge case appears at least once.
// Every person here is fictional. Minutes are relative to Maya Chen's arrival.

type Twin = ReturnType<typeof createTwin>;

export type FeaturedVisit = {
  patient: TwinPatient;
  /** One line for the demo guide: what this visit shows. */
  shows: string;
  play: (twin: Twin, patient: TwinPatient) => void;
};

const person = (
  index: number,
  family: string,
  given: string,
  dateOfBirth: string,
  phone?: string,
): TwinPatient => ({
  mrn: `72${String(index).padStart(5, "0")}`,
  visit: `FIN57${String(index).padStart(5, "0")}`,
  family,
  given,
  dateOfBirth,
  phone,
});

export const featuredVisits: FeaturedVisit[] = [
  {
    patient: person(1, "NATARAJAN", "PRIYA", "1992-02-11", "+19025550141"),
    shows: "Rapid assessment stream with an X-ray, home in about an hour and a half",
    play: (twin, p) => {
      twin.arrive(4, p);
      twin.triage(11, p, 4, "RAZ");
      twin.see(38, p, "RAZ", 2);
      twin.order(42, p, "RAZ", "ORD-PRIYA-1", "XR");
      twin.result(71, p, "RAZ", "ORD-PRIYA-1");
      twin.discharge(92, p, "RAZ");
    },
  },
  {
    patient: person(2, "HUGHES", "WALTER", "1947-06-03"),
    shows:
      "Older patient: bloodwork from the waiting room, CT, specialist consult, admitted, boards, moves to a ward",
    play: (twin, p) => {
      twin.arrive(-40, p);
      twin.triage(-33, p, 3);
      twin.order(-25, p, "WAITROOM", "ORD-WALTER-1", "LAB");
      twin.result(5, p, "WAITROOM", "ORD-WALTER-1");
      twin.see(20, p, "MAJ3", 0);
      twin.order(28, p, "MAJ3", "ORD-WALTER-2", "CT");
      twin.order(70, p, "MAJ3", "ORD-WALTER-3", "CON");
      twin.result(95, p, "MAJ3", "ORD-WALTER-2");
      twin.admit(125, p, "MAJ3");
      twin.requestBed(130, p, "MAJ3");
      twin.moveToUnit(205, p, "6.1", "B12");
    },
  },
  {
    patient: person(3, "PIKE", "JORDAN", "2003-09-14"),
    shows: "Low-acuity wait that ends with leaving before being seen",
    play: (twin, p) => {
      twin.arrive(15, p);
      twin.triage(22, p, 5);
      twin.discharge(150, p, "WAITROOM", "LWBS");
    },
  },
  {
    patient: person(4, "AZIZ", "FATIMA", "1984-12-02"),
    shows: "Marked confidential by the hospital record mid-visit: every update goes quiet",
    play: (twin, p) => {
      twin.arrive(50, p);
      twin.triage(57, p, 3);
      twin.see(75, p, "MAJ5", 1);
      twin.confidential(80, p, "MAJ5", true);
      twin.order(82, p, "MAJ5", "ORD-FATIMA-1", "LAB");
      twin.result(120, p, "MAJ5", "ORD-FATIMA-1");
      twin.discharge(170, p, "MAJ5");
    },
  },
  {
    patient: person(5, "LEGER", "ROBERT", "1970-03-27"),
    shows: "CT ordered then cancelled and replaced by an ultrasound",
    play: (twin, p) => {
      twin.arrive(60, p);
      twin.triage(66, p, 4);
      twin.see(128, p, "EXAM2", 2);
      twin.order(133, p, "EXAM2", "ORD-ROBERT-1", "CT");
      twin.cancelOrder(140, p, "EXAM2", "ORD-ROBERT-1", "CT");
      twin.order(141, p, "EXAM2", "ORD-ROBERT-2", "US");
      twin.result(180, p, "EXAM2", "ORD-ROBERT-2");
      twin.discharge(205, p, "EXAM2");
    },
  },
  {
    patient: person(6, "LIU", "GRACE", "2018-05-20"),
    shows: "Child, seen in the paediatric area with bloodwork",
    play: (twin, p) => {
      twin.arrive(70, p);
      twin.triage(76, p, 3);
      twin.see(96, p, "PEDS1", 1);
      twin.order(100, p, "PEDS1", "ORD-GRACE-1", "LAB");
      twin.result(132, p, "PEDS1", "ORD-GRACE-1");
      twin.discharge(160, p, "PEDS1");
    },
  },
  {
    patient: person(7, "KARIM", "AHMED", "1995-10-08"),
    shows: "Registered in error and cancelled: the visit closes without a word to anyone",
    play: (twin, p) => {
      twin.arrive(85, p);
      twin.cancelVisit(92, p, "WAITROOM");
    },
  },
  {
    patient: person(8, "ORTIZ", "SAM", "1988-01-30"),
    shows: "Security alert on the record: silenced like a confidential visit",
    play: (twin, p) => {
      twin.arrive(100, p);
      twin.triage(107, p, 3);
      twin.security(110, p, "WAITROOM", true);
      twin.see(140, p, "MAJ2", 0);
      twin.discharge(200, p, "MAJ2");
    },
  },
];

export function addFeaturedVisits(twin: Twin) {
  for (const visit of featuredVisits) visit.play(twin, visit.patient);
}
