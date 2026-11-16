import { readPlanner } from "./agents/llm.js";
import { createRetriever, readEmbedder } from "./agents/retrieval.js";
import { createVisitAgent } from "./agents/visit-agent.js";
import { buildApp } from "./app.js";
import { createPool } from "./db.js";
import { ingestHl7, tickFeed } from "./journey/ingest.js";
import { createJourneySmsSender, dispatchJourneySms } from "./journey/sms.js";
import { startMllpListener } from "./opor/mllp.js";
import { readVoiceConfig } from "./voice-config.js";

const pool = createPool();
const host = process.env.API_HOST ?? "127.0.0.1";
const demoEnabled = process.env.ENABLE_SYNTHETIC_DEMO === "true";
if (demoEnabled && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error("Synthetic demo endpoints must bind to loopback.");
}
const quiet = (label: string) => (error: unknown) =>
  console.error(`${label}: ${error instanceof Error ? error.message : "unknown error"}`);

// The Visit Agent. With VISIT_AGENT_ENABLED=true and a key, a language model plans each
// wake; otherwise the rules path does, and the pages behave the same.
const agent = createVisitAgent(pool, {
  planner: readPlanner(),
  retriever: createRetriever({ embed: readEmbedder() }),
  onError: quiet("Visit Agent"),
});
// Opt-in: the scheduling agent offers the earliest open slot when a request is verified.
const app = buildApp(pool, demoEnabled, process.env.AGENT_AUTO_PROPOSE === "true", agent);
await app.listen({ host, port: Number(process.env.API_PORT ?? 4100) });
console.log(`Synthetic backend API listening on ${host}:${process.env.API_PORT ?? 4100}`);
console.log(
  agent.defer
    ? `Visit Agent: language model ${agent.model}, knowledge base ${agent.retriever.hybrid ? "hybrid" : "lexical"} retrieval`
    : "Visit Agent: rules path (set VISIT_AGENT_ENABLED=true to plan with a language model)",
);

// The OPOR feed arrives as HL7 v2 over MLLP. Loopback only: the demo sender is the OPOR Twin.
const feedPort = Number(process.env.OPOR_MLLP_PORT ?? 2575);
const feed = await startMllpListener({
  host: "127.0.0.1",
  port: feedPort,
  onMessage: async (raw) => {
    const outcome = await ingestHl7(pool, raw, { defer: agent.defer });
    // The feed is acknowledged first; the model plans afterwards.
    void agent.drain();
    return outcome;
  },
});
console.log(`OPOR feed listener on 127.0.0.1:${feedPort}`);

// Background work: plan what is waiting, send queued texts, and keep timers moving when the
// feed is quiet (check-ins and overrun alerts must not wait for the next hospital message).
const sender = createJourneySmsSender(readVoiceConfig());
console.log(`Journey texts: ${sender ? "live" : "simulated on screen"}`);
let busy = false;
let lastTimers = 0;
const worker = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    if (Date.now() - lastTimers >= 30_000) {
      lastTimers = Date.now();
      await tickFeed(pool, { defer: agent.defer });
    }
    await agent.drain();
    await dispatchJourneySms(pool, sender, new Date());
  } catch (error) {
    quiet("Journey worker")(error);
  } finally {
    busy = false;
  }
}, 2000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    clearInterval(worker);
    feed.close();
    await app.close();
    await pool.end();
  });
}
