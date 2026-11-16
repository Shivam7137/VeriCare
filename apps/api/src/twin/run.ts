import { setTimeout as sleep } from "node:timers/promises";
import { sendMllp } from "../opor/mllp.js";
import { buildDemoScenario } from "./scenario.js";

// Plays the demo scenario into the API's feed listener over MLLP.
// Usage: npm run twin -- [--speed 60] [--port 2575] [--until 180] [--phone +1...] [--core]
// Speed is simulated minutes per real minute: 60 plays three hours in three minutes.

const arg = (name: string, fallback: number) => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
};
const speed = arg("speed", 60);
const port = arg("port", Number(process.env.OPOR_MLLP_PORT ?? 2575));
const until = arg("until", 240);
const target = { host: "127.0.0.1", port };

// --phone +1902...: the number registration recorded for Maya, so her texts go to a real phone.
const phoneAt = process.argv.indexOf("--phone");
const phone = phoneAt >= 0 ? process.argv[phoneAt + 1] : process.env.TWIN_PATIENT_PHONE;
if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("--phone must be an E.164 number");

// --core plays only Maya's story and the background queue, without the eight featured visits.
const featured = !process.argv.includes("--core");

const start = new Date();
const scenario = buildDemoScenario(start, phone, { featured }).filter(
  (message) => message.atMinute <= until,
);
// Everything dated before "now" is history: send it at once to fill the department.
const history = scenario.filter((message) => message.atMinute < 0);
const live = scenario.filter((message) => message.atMinute >= 0);

console.log(`OPOR Twin: ${history.length} history messages, ${live.length} live, speed x${speed}`);
await sendMllp(
  target,
  history.map((message) => message.raw),
);
let clock = 0;
for (const message of live) {
  const wait = ((message.atMinute - clock) * 60_000) / speed;
  if (wait > 0) await sleep(wait);
  clock = message.atMinute;
  await sendMllp(target, [message.raw]);
  console.log(`+${String(message.atMinute).padStart(3)} min  ${message.note}`);
}
console.log("OPOR Twin: scenario complete.");
