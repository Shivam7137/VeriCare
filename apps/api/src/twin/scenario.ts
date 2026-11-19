import { buildHl7, toHl7Time } from "../opor/hl7.js";
import { addFeaturedVisits } from "./featured.js";

// The OPOR Twin: a scripted emergency department that speaks HL7 v2.5.1 the
// way a hospital interface engine does. Every person here is fictional.

export type TwinPatient = {
  mrn: string;
  visit: string;
  family: string;
  given: string;
  dateOfBirth: string;
  phone?: string;
};
export type TwinMessage = { atMinute: number; note: string; raw: string };

const facility = "QEII";
const doctors = ["1001^RAO^ANIKA", "1002^MORRIS^DANIEL", "1003^OKOYE^SAM"];

export function createTwin(start: Date) {
  const messages: TwinMessage[] = [];
  let serial = 0;
  const at = (minute: number) => toHl7Time(new Date(start.getTime() + minute * 60_000));
  const header = (type: string, minute: number) => [
    "MSH",
    "^~\\&",
    "MILLENNIUM",
    facility,
    "VERICARE",
    "VC",
    at(minute),
    "",
    type,
    `TW${start.getTime().toString(36)}${String(++serial).padStart(5, "0")}`,
    "P",
    "2.5.1",
  ];
  const pid = (patient: TwinPatient) => [
    "PID",
    "1",
    "",
    `${patient.mrn}^^^${facility}^MR`,
    "",
    `${patient.family}^${patient.given}`,
    "",
    patient.dateOfBirth.replaceAll("-", ""),
    "",
    "",
    "",
    "",
    "",
    patient.phone ?? "",
  ];
  const pv1 = (
    patient: TwinPatient,
    room: string,
    options: {
      doctor?: string;
      cls?: string;
      vip?: boolean;
      disposition?: string;
      unit?: string;
    } = {},
  ) => {
    const fields = Array.from({ length: 37 }, () => "");
    fields[0] = "PV1";
    fields[1] = "1";
    fields[2] = options.cls ?? "E";
    fields[3] = options.unit ? `${options.unit}^${room}^^${facility}` : `ED^${room}^^${facility}`;
    fields[7] = options.doctor ?? "";
    fields[16] = options.vip ? "VIP" : "";
    fields[19] = `${patient.visit}^^^${facility}^VN`;
    fields[36] = options.disposition ?? "";
    return fields;
  };
  const push = (minute: number, note: string, rows: string[][]) =>
    messages.push({ atMinute: minute, note, raw: buildHl7(rows) });
  const adt = (
    trigger: string,
    minute: number,
    note: string,
    patient: TwinPatient,
    room: string,
    options: Parameters<typeof pv1>[2] & {
      ctas?: number;
      confidential?: boolean;
      security?: boolean;
    } = {},
  ) => {
    const rows = [
      header(`ADT^${trigger}`, minute),
      ["EVN", trigger, at(minute)],
      pid(patient),
      pv1(patient, room, options),
    ];
    if (options.confidential !== undefined)
      rows.push(["PV2", ...Array.from({ length: 21 }, () => ""), options.confidential ? "Y" : "N"]);
    if (options.ctas)
      rows.push([
        "OBX",
        "1",
        "CWE",
        "CTAS^Canadian Triage and Acuity Scale^L",
        "",
        `${options.ctas}`,
      ]);
    if (options.security !== undefined)
      rows.push(["OBX", "2", "CWE", "SECALERT^Security alert^L", "", options.security ? "Y" : "N"]);
    push(minute, note, rows);
  };
  const orderMessage = (
    minute: number,
    note: string,
    patient: TwinPatient,
    room: string,
    control: string,
    orderId: string,
    section: string,
  ) => {
    const obr = Array.from({ length: 25 }, () => "");
    obr[0] = "OBR";
    obr[1] = "1";
    obr[2] = orderId;
    obr[4] = section === "LAB" ? "CBC^Blood count^L" : `${section}^Order^L`;
    obr[24] = section;
    push(minute, note, [
      header("ORM^O01", minute),
      pid(patient),
      pv1(patient, room),
      ["ORC", control, orderId],
      obr,
    ]);
  };

  return {
    messages,
    arrive: (minute: number, patient: TwinPatient, room = "WAITROOM") =>
      adt("A04", minute, `${patient.given} arrives`, patient, room),
    triage: (minute: number, patient: TwinPatient, ctas: number, room = "WAITROOM") =>
      adt("A08", minute, `${patient.given} triaged CTAS ${ctas}`, patient, room, { ctas }),
    see: (minute: number, patient: TwinPatient, room: string, doctor = 0) =>
      adt("A02", minute, `${patient.given} seen in ${room}`, patient, room, {
        doctor: doctors[doctor % doctors.length],
      }),
    discharge: (minute: number, patient: TwinPatient, room: string, disposition = "HOME") =>
      adt("A03", minute, `${patient.given} leaves (${disposition})`, patient, room, {
        disposition,
      }),
    admit: (minute: number, patient: TwinPatient, room: string) =>
      adt("A06", minute, `${patient.given} admitted, waiting for a bed`, patient, room, {
        cls: "I",
      }),
    moveToUnit: (minute: number, patient: TwinPatient, unit: string, room: string) =>
      adt("A02", minute, `${patient.given} moves to ${unit}`, patient, room, { cls: "I", unit }),
    confidential: (minute: number, patient: TwinPatient, room: string, value: boolean) =>
      adt("A08", minute, `${patient.given} confidential=${value}`, patient, room, {
        confidential: value,
      }),
    security: (minute: number, patient: TwinPatient, room: string, value: boolean) =>
      adt("A08", minute, `${patient.given} security alert=${value}`, patient, room, {
        security: value,
      }),
    requestBed: (minute: number, patient: TwinPatient, room: string) =>
      adt("A14", minute, `${patient.given}: inpatient bed requested`, patient, room, { cls: "I" }),
    cancelVisit: (minute: number, patient: TwinPatient, room: string) =>
      adt("A11", minute, `${patient.given}: registration cancelled`, patient, room),
    // Sections: LAB, RAD/XR (X-ray), CT, US, MR, and CON for a specialist consult.
    order: (minute: number, patient: TwinPatient, room: string, orderId: string, section: string) =>
      orderMessage(
        minute,
        `${patient.given}: ${section} ordered`,
        patient,
        room,
        "NW",
        orderId,
        section,
      ),
    cancelOrder: (
      minute: number,
      patient: TwinPatient,
      room: string,
      orderId: string,
      section: string,
    ) =>
      orderMessage(
        minute,
        `${patient.given}: ${section} cancelled`,
        patient,
        room,
        "CA",
        orderId,
        section,
      ),
    result: (minute: number, patient: TwinPatient, room: string, orderId: string) => {
      const obr = Array.from({ length: 26 }, () => "");
      obr[0] = "OBR";
      obr[1] = "1";
      obr[2] = orderId;
      obr[25] = "F";
      push(minute, `${patient.given}: result back`, [
        header("ORU^R01", minute),
        pid(patient),
        pv1(patient, room),
        ["ORC", "RE", orderId],
        obr,
      ]);
    },
    sorted: () => [...messages].sort((a, b) => a.atMinute - b.atMinute),
  };
}

const background: [string, string, string][] = [
  ["LEBLANC", "CLAIRE", "1958-03-02"],
  ["MACDONALD", "IAN", "1971-07-19"],
  ["NGUYEN", "LINH", "1989-11-30"],
  ["BOUDREAU", "MARC", "1946-01-12"],
  ["SINGH", "HARPREET", "1995-05-08"],
  ["FRASER", "ELLEN", "1963-09-27"],
  ["PAUL", "DARCY", "2001-02-14"],
  ["COMEAU", "RENEE", "1980-12-05"],
  ["ADEYEMI", "TOBI", "1992-06-21"],
  ["MACNEIL", "RUTH", "1939-04-17"],
  ["GALLANT", "PIERRE", "1976-10-03"],
  ["HASSAN", "OMAR", "1968-08-11"],
  ["DOUCET", "ANNIE", "1999-01-29"],
  ["CAMERON", "SCOTT", "1955-11-09"],
  ["BERNARD", "LUCIE", "1984-07-07"],
  ["WHITE", "GEORGE", "1949-05-25"],
  ["ROY", "JULIEN", "1990-03-18"],
  ["STEWART", "MEGAN", "1987-09-01"],
  ["ARSENAULT", "DENIS", "1961-02-22"],
  ["KEEPING", "NORA", "1974-06-13"],
  ["OLIVER", "JUNE", "1952-08-30"],
  ["THERIAULT", "LUC", "1983-03-09"],
];

export const mayaRecord: TwinPatient = {
  mrn: "7000001",
  visit: "FIN5500001",
  family: "CHEN",
  given: "MAYA",
  dateOfBirth: "1990-04-12",
};

/**
 * A visit of just over three hours for Maya Chen inside a working department: a queue ahead
 * of her, steady assessments, a surge of urgent arrivals, tests, and discharge.
 */
export function buildDemoScenario(
  start: Date,
  mayaPhone?: string,
  options: { featured?: boolean } = {},
): TwinMessage[] {
  const twin = createTwin(start);
  // Eight extra visits, each taking a different path. Off by default so the core story stays fixed.
  if (options.featured) addFeaturedVisits(twin);
  const maya: TwinPatient = { ...mayaRecord, phone: mayaPhone };
  const people: TwinPatient[] = background.map(([family, given, dateOfBirth], index) => ({
    mrn: `71${String(index).padStart(5, "0")}`,
    visit: `FIN56${String(index).padStart(5, "0")}`,
    family,
    given,
    dateOfBirth,
  }));
  let room = 1;
  const nextRoom = () => `ROOM${((room++ - 1) % 12) + 1}`;

  // Seen in the hour before Maya arrives, one about every seven minutes: the department's pace.
  people.slice(0, 8).forEach((patient, index) => {
    const seen = -56 + index * 7;
    twin.arrive(seen - 95, patient);
    twin.triage(seen - 87, patient, index % 2 ? 4 : 3);
    const where = nextRoom();
    twin.see(seen, patient, where, index);
    twin.discharge(seen + 70, patient, where);
  });
  // Still waiting when Maya arrives: two more urgent, three at her level.
  const queue = people.slice(8, 13);
  queue.forEach((patient, index) => {
    const arrived = -60 + index * 9;
    twin.arrive(arrived, patient);
    twin.triage(arrived + 7, patient, index < 2 ? 3 : 4);
  });

  twin.arrive(0, maya);
  twin.triage(8, maya, 4);
  // Bloodwork starts in the waiting room, before a doctor sees her.
  twin.order(20, maya, "WAITROOM", "ORD-MAYA-1", "LAB");
  twin.result(48, maya, "WAITROOM", "ORD-MAYA-1");

  // Five very sick patients arrive together and are seen ahead of everyone waiting. The
  // trained wait model already allows for two or three such arrivals in its first range,
  // so a surge has to be this large before the patient's estimate honestly gets worse.
  const surge = people.slice(13, 18);
  surge.forEach((patient, index) => {
    twin.arrive(30 + index, patient, "TRIAGE");
    twin.triage(32 + index, patient, 2, "TRIAGE");
  });
  // Later, lower-urgency arrivals join behind Maya.
  const later = people.slice(18, 22);
  later.forEach((patient, index) => {
    const arrived = 25 + index * 20;
    twin.arrive(arrived, patient);
    twin.triage(arrived + 9, patient, index % 2 ? 5 : 4);
  });

  // The team works through the queue. The surge slows everyone behind it.
  const schedule: [TwinPatient, number][] = [
    [queue[0]!, 2],
    [queue[1]!, 10],
    [queue[2]!, 18],
    [queue[3]!, 26],
    [surge[0]!, 38],
    [surge[1]!, 50],
    [surge[2]!, 62],
    [surge[3]!, 74],
    [surge[4]!, 86],
    [queue[4]!, 98],
    [later[0]!, 122],
    [later[1]!, 136],
    [later[2]!, 150],
    [later[3]!, 164],
  ];
  schedule.forEach(([patient, seen], index) => {
    const where = nextRoom();
    twin.see(seen, patient, where, index);
    if (surge.includes(patient)) twin.admit(seen + 60, patient, where);
    else twin.discharge(seen + 70, patient, where);
  });

  twin.see(112, maya, "EXAM5", 1);
  twin.order(119, maya, "EXAM5", "ORD-MAYA-2", "RAD");
  twin.result(159, maya, "EXAM5", "ORD-MAYA-2");
  twin.discharge(189, maya, "EXAM5");
  return twin.sorted();
}
