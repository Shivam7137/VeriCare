// Minimal HL7 v2 reader and writer for the segments VeriCare needs.
// Dependency-free on purpose: the format is line- and pipe-delimited text.

export type Hl7Segment = { name: string; fields: string[] };
export type Hl7Message = { segments: Hl7Segment[] };

export function parseHl7(raw: string): Hl7Message {
  const lines = raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines[0]?.startsWith("MSH|")) throw new Error("hl7_missing_msh");
  return {
    segments: lines.map((line) => {
      const parts = line.split("|");
      const name = parts[0]!;
      // MSH-1 is the separator itself, so its fields are offset by one.
      return { name, fields: name === "MSH" ? ["MSH", "|", ...parts.slice(1)] : parts };
    }),
  };
}

export const segment = (message: Hl7Message, name: string) =>
  message.segments.find((item) => item.name === name);
export const segments = (message: Hl7Message, name: string) =>
  message.segments.filter((item) => item.name === name);

/** Field `index` (1-based, as HL7 numbers them), first repetition. */
export function field(item: Hl7Segment | undefined, index: number): string {
  return (item?.fields[index] ?? "").split("~")[0] ?? "";
}
export function repetitions(item: Hl7Segment | undefined, index: number): string[] {
  const value = item?.fields[index] ?? "";
  return value ? value.split("~") : [];
}
/** Component `part` (1-based) of a field or of one repetition. */
export function component(value: string, part: number): string {
  return value.split("^")[part - 1] ?? "";
}

/** HL7 timestamp (YYYYMMDDHHMM[SS][+/-ZZZZ]) to ISO. Without an offset, the site's is used. */
export function hl7Time(value: string, defaultOffset: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?([+-]\d{4})?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00", offset = defaultOffset] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${offset.slice(0, 3)}:${offset.slice(3)}`;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function toHl7Time(date: Date): string {
  return `${date.toISOString().replace(/[-:T]/g, "").slice(0, 14)}+0000`;
}

export function buildHl7(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.join("|").replace(/\|+$/, "")).join("\r");
}

/** Acknowledgement for a received message: AA accepted, AE error, AR rejected. */
export function buildAck(raw: string, code: "AA" | "AE" | "AR", now: Date): string {
  let controlId = "";
  let sender = ["", ""];
  try {
    const msh = segment(parseHl7(raw), "MSH");
    controlId = field(msh, 10);
    sender = [field(msh, 3), field(msh, 4)];
  } catch {
    // An unreadable message is still acknowledged, as rejected.
  }
  return buildHl7([
    [
      "MSH",
      "^~\\&",
      "VERICARE",
      "VC",
      ...sender,
      toHl7Time(now),
      "",
      "ACK",
      `ACK${controlId}`,
      "P",
      "2.5.1",
    ],
    ["MSA", code, controlId],
  ]);
}
