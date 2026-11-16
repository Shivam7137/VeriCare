import assert from "node:assert/strict";
import test from "node:test";
import { deriveVisitState } from "../src/journey/visit-state.js";
import { buildAck, field, hl7Time, parseHl7, segment } from "../src/opor/hl7.js";
import { halifaxTwinSite, mapHl7, type VisitFacts } from "../src/opor/hl7v2-mapper.js";

// Synthetic messages in standard HL7 v2.5.1 layout. All people and codes are invented.
const msh = (type: string, id: string, time: string) =>
  `MSH|^~\\&|MILLENNIUM|QEII|VERICARE|VC|${time}||${type}|${id}|P|2.5.1`;
const pid =
  "PID|1||7000123^^^QEII^MR~7000123^^^NSHA^PI||TESTPATIENT^ALEX^^^^^L||19840312|F|||1 SAMPLE ST^^HALIFAX^NS^B3H0A0^CAN||^PRN^PH^^^902^5550101";
const pv1 = (
  location: string,
  extra: { prior?: string; doctor?: string; cls?: string; vip?: string } = {},
) => {
  const fields = Array.from({ length: 20 }, () => "");
  fields[0] = "PV1";
  fields[1] = "1";
  fields[2] = extra.cls ?? "E";
  fields[3] = location;
  fields[6] = extra.prior ?? "";
  fields[7] = extra.doctor ?? "";
  fields[16] = extra.vip ?? "";
  fields[19] = "FIN4410023^^^QEII^VN";
  return fields.join("|");
};
const pv2Protection = (value: string) => `PV2${"|".repeat(22)}${value}`;

const arrival = [
  msh("ADT^A04^ADT_A01", "MSG000001", "20261114083212"),
  "EVN|A04|20261114083200",
  pid,
  pv1("ED^WAITROOM^^QEII"),
  "PV2|||CHEST PAIN^^L",
].join("\r");
const triage = [
  msh("ADT^A08^ADT_A01", "MSG000002", "20261114084505"),
  "EVN|A08|20261114084455",
  pid,
  pv1("ED^TRIAGE^1^QEII", { prior: "ED^WAITROOM^^QEII" }),
  "OBX|1|CWE|CTAS^Canadian Triage and Acuity Scale^L||3^Urgent^L||||||F",
].join("\r");
const order = [
  msh("ORM^O01^ORM_O01", "MSG000005", "20261114090010"),
  "PID|1||7000123^^^QEII^MR",
  pv1("ED^TRIAGE^1^QEII"),
  "ORC|NW|ORD778899^MILLENNIUM",
  "OBR|1|ORD778899^MILLENNIUM||TROP^Troponin^L|||20261114090000|||||||||||||||||LAB",
].join("\r");
const result = [
  msh("ORU^R01^ORU_R01", "MSG000006", "20261114094550"),
  "PID|1||7000123^^^QEII^MR",
  pv1("ED^ROOM5^A^QEII"),
  "ORC|RE|ORD778899^MILLENNIUM",
  "OBR|1|ORD778899^MILLENNIUM||TROP^Troponin^L|||20261114090000||||||||||||||||||F",
  "OBX|1|NM|TROP^Troponin^L||31337|ng/L|||||F",
].join("\r");
const room = [
  msh("ADT^A02^ADT_A02", "MSG000003", "20261114101530"),
  "EVN|A02|20261114101520",
  pid,
  pv1("ED^ROOM5^A^QEII", { prior: "ED^TRIAGE^1^QEII", doctor: "1234567^SAMPLEDOC^PAT" }),
].join("\r");
const discharge = (disposition: string) =>
  [
    msh("ADT^A03^ADT_A03", "MSG000004", "20261114133040"),
    "EVN|A03|20261114133020",
    pid,
    `${pv1("ED^ROOM5^A^QEII")}|||||||||||||||||${disposition}`,
  ].join("\r");

function replay(messages: string[]) {
  let facts: VisitFacts | null = null;
  const events = [];
  for (const raw of messages) {
    const mapped = mapHl7(raw, halifaxTwinSite, facts);
    assert.equal(mapped.kind, "visit");
    if (mapped.kind !== "visit") continue;
    facts = mapped.facts;
    events.push(...mapped.events);
  }
  return { events, facts };
}

test("the reader handles MSH offsets, repetitions and timestamps", () => {
  const message = parseHl7(arrival);
  assert.equal(field(segment(message, "MSH"), 9), "ADT^A04^ADT_A01");
  assert.equal(field(segment(message, "MSH"), 10), "MSG000001");
  assert.equal(field(segment(message, "PID"), 3), "7000123^^^QEII^MR");
  assert.equal(hl7Time("20261114083200", "-0400"), "2026-11-14T12:32:00.000Z");
  assert.equal(hl7Time("20261114083200+0000", "-0400"), "2026-11-14T08:32:00.000Z");
  assert.equal(hl7Time("not a time", "-0400"), null);
  assert.throws(() => parseHl7("PID|1"), /hl7_missing_msh/);
});

test("an arrival message opens the visit with patient details", () => {
  const mapped = mapHl7(arrival, halifaxTwinSite, null);
  assert.equal(mapped.kind, "visit");
  if (mapped.kind !== "visit") return;
  assert.equal(mapped.visitNumber, "FIN4410023");
  assert.equal(mapped.mrn, "7000123");
  assert.deepEqual(mapped.patient, {
    name: "ALEX TESTPATIENT",
    dateOfBirth: "1984-03-12",
    phone: "+19025550101",
  });
  assert.equal(mapped.occurredAt, "2026-11-14T12:32:00.000Z");
  assert.deepEqual(
    mapped.events.map((event) => event.kind),
    ["arrived"],
  );
  assert.equal(mapped.events[0]!.sourceEventId, "MSG000001#0");
  // The reason for visit is never copied into an event.
  assert.equal(JSON.stringify(mapped.events).includes("CHEST"), false);
});

test("a full visit replays into the right journey", () => {
  const { events } = replay([arrival, triage, order, room, result, discharge("01")]);
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "arrived",
      "location_changed",
      "triaged",
      "order_placed",
      "location_changed",
      "provider_assigned",
      "result_available",
      "discharged",
    ],
  );
  assert.equal(events.find((event) => event.kind === "triaged")!.detail.ctas, 3);
  assert.equal(events.find((event) => event.kind === "order_placed")!.detail.orderType, "lab");
  // Result values never reach the event log.
  assert.equal(JSON.stringify(events).includes("31337"), false);
  const state = deriveVisitState(events);
  assert.equal(state.step, "discharged");
  assert.equal(state.providerAt, "2026-11-14T14:15:20.000Z");
});

test("an imaging order keeps its kind, because a CT takes far longer than an X-ray", () => {
  const { facts } = replay([arrival, triage]);
  const imaging = (section: string, id: string) => {
    const mapped = mapHl7(
      order.replace("MSG000005", id).replaceAll("ORD778899", `ORD${id}`).replace(/LAB$/, section),
      halifaxTwinSite,
      facts,
    );
    return mapped.kind === "visit" ? mapped.events[0]!.detail : null;
  };
  assert.deepEqual(imaging("CT", "MSG000041"), {
    orderId: "ORDMSG000041",
    orderType: "imaging",
    modality: "ct",
  });
  assert.equal(imaging("RAD", "MSG000042")!.modality, "xray");
  assert.equal(imaging("US", "MSG000043")!.modality, "ultrasound");
  assert.equal(imaging("NM", "MSG000044")!.modality, "other");
  assert.equal(imaging("LAB", "MSG000045")!.modality, undefined);
});

test("repeated facts do not produce repeated events", () => {
  const { facts } = replay([arrival, triage, room]);
  const again = mapHl7(room.replace("MSG000003", "MSG000009"), halifaxTwinSite, facts);
  assert.equal(again.kind === "visit" && again.events.length, 0);
});

test("privacy and safety markers set flags, and only an explicit negative clears them", () => {
  const { facts } = replay([arrival]);
  const vip = [
    msh("ADT^A08^ADT_A01", "MSG000030", "20261114084505"),
    pid,
    pv1("ED^TRIAGE^1^QEII", { vip: "VIP" }),
  ].join("\r");
  const flagged = mapHl7(vip, halifaxTwinSite, facts);
  assert.equal(flagged.kind, "visit");
  if (flagged.kind !== "visit") return;
  assert.equal(flagged.events[0]!.kind, "flag_set");
  assert.equal(flagged.events[0]!.detail.flag, "vip");

  const confidential = mapHl7(`${triage}\r${pv2Protection("Y")}`, halifaxTwinSite, facts);
  assert.equal(
    confidential.kind === "visit" && confidential.facts.flags.includes("confidential"),
    true,
  );
  if (confidential.kind !== "visit") return;
  // A later message that simply omits the marker leaves the flag in place.
  const silent = mapHl7(room, halifaxTwinSite, confidential.facts);
  assert.equal(silent.kind === "visit" && silent.facts.flags.includes("confidential"), true);
  const cleared = mapHl7(`${room}\r${pv2Protection("N")}`, halifaxTwinSite, confidential.facts);
  assert.equal(cleared.kind === "visit" && cleared.facts.flags.length, 0);

  const deceased = mapHl7(
    triage.replace(pid, `${pid}||||||||||||||||20261114090000|Y`),
    halifaxTwinSite,
    facts,
  );
  assert.equal(deceased.kind === "visit" && deceased.events[0]!.detail.flag, "deceased");
  const security = mapHl7(
    `${triage}\rOBX|2|CWE|SECALERT^Security alert^L||Y`,
    halifaxTwinSite,
    facts,
  );
  assert.equal(security.kind === "visit" && security.facts.flags.includes("security"), true);
});

test("walkouts, admissions, moves and corrections map to the right events", () => {
  const { facts } = replay([arrival, triage]);
  const kinds = (raw: string) => {
    const mapped = mapHl7(raw, halifaxTwinSite, facts);
    return mapped.kind === "visit" ? mapped.events.map((event) => event.kind) : [mapped.why];
  };
  assert.deepEqual(kinds(discharge("LWBS")), ["left_without_being_seen"]);
  assert.deepEqual(kinds(discharge("EXP")), ["flag_set", "discharged"]);
  const admit = [
    msh("ADT^A06^ADT_A06", "MSG000010", "20261114150000"),
    pid,
    pv1("ED^ROOM5^A^QEII", { cls: "I" }),
  ].join("\r");
  assert.deepEqual(kinds(admit), ["location_changed", "admit_decision"]);
  const transfer = [
    msh("ADT^A02^ADT_A02", "MSG000011", "20261114190000"),
    pid,
    pv1("4B^412^A^QEII"),
  ].join("\r");
  assert.deepEqual(kinds(transfer), ["moved_to_unit"]);
  const cancel = [
    msh("ADT^A11^ADT_A09", "MSG000012", "20261114084000"),
    pid,
    pv1("ED^TRIAGE^1^QEII"),
  ].join("\r");
  assert.deepEqual(kinds(cancel), ["cancelled"]);
  const cancelDischarge = [
    msh("ADT^A13^ADT_A01", "MSG000013", "20261114140000"),
    pid,
    pv1("ED^TRIAGE^1^QEII"),
  ].join("\r");
  assert.deepEqual(kinds(cancelDischarge), ["unmapped"]);
  const cancelOrder = order.replace("ORC|NW", "ORC|CA");
  assert.deepEqual(kinds(cancelOrder), ["order_cancelled"]);
  const consult = order.replace("|LAB", "|CON");
  assert.deepEqual(kinds(consult), ["consult_requested"]);
});

test("messages for other departments and pre-arrivals are ignored", () => {
  const ward = [
    msh("ADT^A04^ADT_A01", "MSG000020", "20261114083212"),
    pid,
    pv1("4B^412^A^QEII"),
  ].join("\r");
  assert.deepEqual(mapHl7(ward, halifaxTwinSite, null), {
    kind: "ignored",
    controlId: "MSG000020",
    why: "not_emergency",
  });
  const preArrival = arrival.replace("ADT^A04^ADT_A01", "ADT^A05^ADT_A05");
  assert.equal(mapHl7(preArrival, halifaxTwinSite, null).kind, "ignored");
  assert.throws(() =>
    mapHl7(`${msh("ADT^A04", "X1", "20261114083212")}\r${pid}`, halifaxTwinSite, null),
  );
});

test("acknowledgements echo the control id", () => {
  const ack = buildAck(arrival, "AA", new Date("2026-11-14T12:32:13Z"));
  assert.equal(field(segment(parseHl7(ack), "MSA"), 1), "AA");
  assert.equal(field(segment(parseHl7(ack), "MSA"), 2), "MSG000001");
  assert.equal(field(segment(parseHl7(buildAck("garbage", "AR", new Date())), "MSA"), 1), "AR");
});
