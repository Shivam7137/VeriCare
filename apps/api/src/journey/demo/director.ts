import type { Ctas, VisitState } from "@prc/contracts";
import type { Pool } from "pg";
import { BackendError } from "../../domain.js";
import { createTwin, mayaRecord, type TwinPatient } from "../../twin/scenario.js";
import { ingestHl7, refreshEstimates } from "../ingest.js";
import type { Agent } from "../intake.js";
import { feedStatus, journeyTransaction } from "../records.js";
import {
  ARRIVALS_PER_HOUR,
  MOVE_LABEL,
  arrivalsIn,
  birthDateFor,
  hashSeed,
  mulberry32,
  nameFor,
  nextMove,
  nextStartAfter,
  pickCtas,
  pickNextToSee,
  planFor,
  type Act,
  type Arrivals,
  type Plan,
  type Rng,
  type Staffing,
  type Stream,
} from "./flow.js";
import { addJudgeContact, askAsContact } from "./contact.js";
import { writeMove } from "./messages.js";
import { MAYA_VISIT, isMaya, isScripted, openingMessages, wipeDepartment } from "./seed.js";
import { SPEEDS, type DemoAction, type DemoState, type Row, type Speed } from "./types.js";
import { buildState, freshView, type ViewMemory } from "./view.js";

export { SPEEDS };
export type { DemoAction, DemoLive, DemoPatient, DemoState } from "./types.js";

// The demo director. It plays the emergency department forward on its own clock so a judge
// can add patients, speed time up, skip ahead or move one person along without waiting.
// Everything it does goes through the same HL7 feed path as the scripted OPOR Twin, so the
// wait model, the Visit Agent and the patient pages react exactly as they would to a hospital.

const MIN = 60_000;
const SEC = 1000;
const MAX_OPEN = 70;
const MAX_SKIP_MIN = 480;
const MAYA_PLAN: Partial<Plan> = {
  ctas: 4,
  raz: false,
  triageMin: 8,
  labs: true,
  imaging: "XR",
  consult: false,
  admit: false,
};

type Twin = ReturnType<typeof createTwin>;
type Out = { at: number; raw: string[] };

export type DemoDirector = ReturnType<typeof createDemoDirector>;

export function createDemoDirector(
  pool: Pool,
  options: {
    site?: string;
    departmentId?: string;
    now?: () => Date;
    agent?: Agent;
    seed?: number;
    /** Minutes without use before the demo starts over by itself. 0 turns it off. */
    idleResetMinutes?: number;
    onError?: (error: unknown) => void;
  } = {},
) {
  const site = options.site ?? "qeii-hi";
  const departmentId = options.departmentId ?? "demo-department";
  const clock = options.now ?? (() => new Date());
  const defer = options.agent?.defer ?? false;
  const onError = options.onError ?? (() => undefined);
  const idleMinutes = Math.max(0, options.idleResetMinutes ?? 30);
  const idleMs = idleMinutes * MIN;
  /** When the demo last started itself over, kept across resets so the bar can say so. */
  let autoResetAt: number | null = null;
  let lastResetAt = 0;

  type Mem = {
    active: boolean;
    checked: boolean;
    running: boolean;
    /** Whether the clock has run since the last reset, so the bar can say "Resume". */
    started: boolean;
    speed: Speed;
    arrivals: Arrivals;
    staffing: Staffing;
    simNow: number;
    skipLeft: number;
    sinceSettle: number;
    lastTick: number;
    twin: Twin;
    twinStart: number;
    tag: string;
    counter: number;
    rooms: number;
    rng: Rng;
    nextStart: Record<Stream, number>;
    scheduled: Out[];
    attempts: Map<string, { key: string; n: number }>;
    fault: string | null;
    view: ViewMemory;
    /** Last time anyone used a control, or null while the demo is untouched. */
    lastUse: number | null;
  };
  const fresh = (simNow: number, seed: number): Mem => {
    // A new twin needs its own start, or its message ids would repeat the scenario's.
    const twinStart = clock().getTime() + 1;
    return {
      active: false,
      checked: false,
      running: false,
      started: false,
      // Slow by default: a judge must still find Maya waiting when they reach step 2.
      speed: 10,
      arrivals: "normal",
      staffing: "normal",
      simNow,
      skipLeft: 0,
      sinceSettle: 0,
      lastTick: Date.now(),
      twin: createTwin(new Date(twinStart)),
      twinStart,
      tag: Math.floor(twinStart).toString(36),
      counter: 0,
      rooms: 0,
      rng: mulberry32(seed),
      nextStart: { main: simNow, rapid_assessment: simNow },
      scheduled: [],
      attempts: new Map(),
      fault: null,
      view: freshView(),
      lastUse: null,
    };
  };
  let m = fresh(clock().getTime(), options.seed ?? hashSeed(site));

  // One thing at a time: ticks, button presses and a reset never overlap.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  };

  const floorSecond = (at: number) => Math.floor(at / SEC) * SEC;
  const planOf = (row: Row) =>
    planFor(row.visit, {
      ...(isMaya(row.visit) ? MAYA_PLAN : {}),
      ...(row.state.ctas ? { ctas: row.state.ctas } : {}),
    });

  // ---- reading the department -------------------------------------------------------------

  async function openRows(): Promise<Row[]> {
    const result = await pool.query<Row>(
      `SELECT id, visit_number AS visit, mrn, display_name AS name, date_of_birth::text AS dob,
              patient_id AS "patientId", state, facts, published, created_at AS "createdAt"
       FROM ed_encounters WHERE site = $1 AND NOT (state->>'ended')::boolean ORDER BY created_at`,
      [site],
    );
    return result.rows;
  }

  /** Adopts a department that already exists, so a restarted API picks up where it was. */
  async function ensure() {
    if (m.active || m.checked) return;
    const feed = await feedStatus(pool, site);
    // Marked only after the read succeeds, so a failed first read is tried again.
    m.checked = true;
    if (!feed) return;
    m.active = true;
    m.simNow = feed.feedTime.getTime();
    m.nextStart = { main: m.simNow, rapid_assessment: m.simNow };
    // The featured visits' later steps lived in memory. Rebuild them from the shift's start
    // (Maya's arrival); steps already sent come back as duplicates and change nothing.
    const opened = await pool.query<{ at: Date }>(
      `SELECT e.occurred_at AS at FROM ed_events e JOIN ed_encounters c ON c.id = e.encounter_id
       WHERE c.site = $1 AND c.visit_number = $2 AND e.kind = 'arrived' ORDER BY e.seq LIMIT 1`,
      [site, MAYA_VISIT],
    );
    if (opened.rows[0]) m.scheduled = openingMessages(opened.rows[0].at.getTime()).later;
  }

  // ---- building and sending feed messages ---------------------------------------------------

  /** Runs one twin builder at an absolute time and returns the HL7 it produced. */
  function emit(at: number, build: (twin: Twin, minute: number) => void): string[] {
    // The small offset keeps floating-point error from dropping a whole second.
    build(m.twin, (at - m.twinStart) / MIN + 1e-7);
    return m.twin.messages.splice(0).map((item) => item.raw);
  }

  function build(row: Row, act: Act, at: number, plan: Plan): string[] {
    return emit(at, (twin, minute) =>
      writeMove(twin, minute, row, act, plan, () => {
        m.rooms += 1;
        return `ROOM${((m.rooms - 1) % 12) + 1}`;
      }),
    );
  }

  const signature = (state: VisitState) =>
    `${state.step}|${+state.testsInProgress}|${+state.resultsReady}|${+state.consultRequested}|${+state.bedRequested}`;

  /** A move that changes nothing, because the feed ids no longer match, must not repeat forever. */
  function mayTry(row: Row, act: Act): boolean {
    const key = `${act}|${signature(row.state)}`;
    const seen = m.attempts.get(row.visit);
    const n = seen?.key === key ? seen.n + 1 : 1;
    m.attempts.set(row.visit, { key, n });
    return n <= 3;
  }

  const ingest = (raw: string) =>
    ingestHl7(pool, raw, {
      now: clock,
      siteId: site,
      departmentId,
      defer,
      // Estimates are recomputed once per batch, not once per message.
      deferEstimates: true,
    });

  async function send(batch: Out[]) {
    const ordered = [...batch].sort((a, b) => a.at - b.at);
    let sent = 0;
    for (const item of ordered)
      for (const raw of item.raw) {
        await ingest(raw);
        sent += 1;
      }
    return sent;
  }

  /** Brings the feed's clock to the department clock and refreshes every estimate. */
  async function settle() {
    const now = clock();
    await journeyTransaction(pool, async (db) => {
      await db.query(
        `UPDATE opor_feed SET feed_time = $2, last_message_at = $3, ticked_at = $3 WHERE site = $1`,
        [site, new Date(m.simNow), now],
      );
      await refreshEstimates(db, site, now, defer);
    });
    m.sinceSettle = 0;
    m.view.watch = null;
  }

  /** Keeps the feed from looking stale while the department clock is paused. */
  async function heartbeat() {
    await pool.query(
      `UPDATE opor_feed SET feed_time = $2, last_message_at = $3, ticked_at = $3 WHERE site = $1`,
      [site, new Date(m.simNow), clock()],
    );
  }

  // ---- one simulated minute -----------------------------------------------------------------

  function newVisit() {
    m.counter += 1;
    const index = m.counter;
    return {
      visit: `FIN58${m.tag}${String(index).padStart(4, "0")}`,
      mrn: `73${m.tag}${String(index).padStart(4, "0")}`,
      name: nameFor(hashSeed(m.tag) + index),
    };
  }

  function arrivalMessages(
    at: number,
    ctas?: Ctas,
  ): { out: Out; visit: string; person: TwinPatient; plan: Plan } {
    const { visit, mrn, name } = newVisit();
    const plan = planFor(visit, ctas ? { ctas } : {});
    const person: TwinPatient = {
      mrn,
      visit,
      given: name.given.toUpperCase(),
      family: name.family.toUpperCase(),
      dateOfBirth: birthDateFor(m.rng, at),
    };
    const where = plan.ctas <= 2 ? "TRIAGE" : "WAITROOM";
    return {
      visit,
      person,
      plan,
      out: { at, raw: emit(at, (twin, minute) => twin.arrive(minute, person, where)) },
    };
  }

  async function step(from: number, end: number): Promise<number> {
    const batch: Out[] = [];
    let due = 0;
    while (m.scheduled[due] && m.scheduled[due]!.at <= end) batch.push(m.scheduled[due++]!);

    const all = (await openRows()).filter((row) => !isScripted(row.visit));
    // Maya is the guided demo's patient: she is triaged on her own, then waits until a judge
    // moves her on, so she is never sent home before anyone has met her.
    const open = all.filter((row) => !isMaya(row.visit) || row.state.step === "arrived");
    // Walk-ins.
    const walkIns = arrivalsIn(m.rng, ARRIVALS_PER_HOUR[m.arrivals], end - from);
    for (let index = 0; index < walkIns && all.length + index < MAX_OPEN; index += 1)
      batch.push(arrivalMessages(floorSecond(from + m.rng() * (end - from))).out);

    // Timed moves: triage, tests, results, decisions, beds.
    for (const row of open) {
      const plan = planOf(row);
      const move = nextMove(row.state, plan, from);
      if (!move || move.at === null || move.at > end) continue;
      const last = row.state.lastEventAt ? Date.parse(row.state.lastEventAt) : 0;
      const at = floorSecond(Math.min(end, Math.max(move.at, from, last + SEC)));
      if (!mayTry(row, move.act)) continue;
      batch.push({ at, raw: build(row, move.act, at, plan) });
    }

    // The queue: the sickest first, and the longest-waiting among equals. Level 1 never waits.
    for (const stream of ["main", "rapid_assessment"] as const) {
      const queue = open
        .filter(
          (row) =>
            row.state.step === "waiting" &&
            row.state.ctas !== null &&
            row.state.triagedAt !== null &&
            row.state.stream === stream,
        )
        .map((row) => ({
          row,
          ctas: row.state.ctas!,
          triagedAt: Date.parse(row.state.triagedAt!),
        }));
      for (const urgent of queue.filter((item) => item.ctas === 1)) {
        const at = floorSecond(Math.max(from, urgent.triagedAt + MIN));
        if (at <= end && mayTry(urgent.row, "see"))
          batch.push({ at, raw: build(urgent.row, "see", at, planOf(urgent.row)) });
      }
      const next = pickNextToSee(queue.filter((item) => item.ctas > 1));
      if (!next || m.nextStart[stream] > end) continue;
      const at = floorSecond(Math.max(m.nextStart[stream], from, next.triagedAt + MIN));
      if (at > end || !mayTry(next.row, "see")) continue;
      batch.push({ at, raw: build(next.row, "see", at, planOf(next.row)) });
      m.nextStart[stream] = nextStartAfter(at, stream, m.staffing, m.rng);
    }
    const sent = await send(batch);
    m.scheduled.splice(0, due);
    return sent;
  }

  /** Runs the department forward to `to`, a minute at a time. */
  async function advance(to: number): Promise<number> {
    let sent = 0;
    while (m.simNow < to) {
      const end = Math.min(m.simNow + MIN, to);
      sent += await step(m.simNow, end);
      m.sinceSettle += end - m.simNow;
      m.simNow = end;
    }
    return sent;
  }

  // ---- what the control bar can do ----------------------------------------------------------

  async function reset(reason: "manual" | "idle" = "manual") {
    // Several people pressing Reset together get one reset, not a queue of them.
    if (reason === "manual" && m.active && m.lastUse === null && m.fault === null)
      if (clock().getTime() - lastResetAt < 5 * SEC) return "Already a fresh demo.";
    try {
      return await resetNow(reason);
    } catch (error) {
      // Half-finished: say so, and let the idle check try again within a minute.
      Object.assign(m, { active: true, checked: true });
      m.lastUse = clock().getTime() - Math.max(0, idleMs - MIN);
      m.fault = "The reset did not finish. Press Reset to try again.";
      throw error;
    }
  }

  async function resetNow(reason: "manual" | "idle") {
    const epoch = Math.floor(clock().getTime() / MIN) * MIN;
    await wipeDepartment(pool);
    // Back to the original demo: default speed, walk-ins and staffing, nothing used yet.
    m = fresh(epoch, (options.seed ?? hashSeed(site)) + epoch);
    Object.assign(m, { active: true, checked: true });
    if (reason === "idle") autoResetAt = clock().getTime();

    // The opening shift fills the department; the featured visits play their own parts later.
    const opening = openingMessages(epoch);
    for (const raw of opening.now) await ingest(raw);
    m.scheduled.push(...opening.later);
    await settle();
    lastResetAt = clock().getTime();
    return reason === "idle"
      ? `Started over after ${idleMinutes} minutes without use.`
      : "Fresh emergency department, paused. Press play.";
  }

  async function addPatients(
    count: number,
    options: { levels?: readonly Ctas[]; pick?: Ctas; verb?: string } = {},
  ) {
    const open = await openRows();
    if (open.length >= MAX_OPEN) throw new BackendError("department_full", 409);
    const room = Math.min(count, MAX_OPEN - open.length);
    const batch: Out[] = [];
    for (let index = 0; index < room; index += 1) {
      const ctas = options.levels?.[index] ?? options.pick ?? pickCtas(m.rng);
      // Backdated a little, so they are already triaged and waiting when the button returns.
      const arriveAt = floorSecond(m.simNow - 3 * MIN + (index * 2.5 * MIN) / room);
      const made = arrivalMessages(arriveAt, ctas);
      const triageAt = floorSecond(Math.min(m.simNow, arriveAt + (ctas <= 2 ? MIN : 1.5 * MIN)));
      const triaged = emit(triageAt, (twin, minute) =>
        twin.triage(
          minute,
          made.person,
          ctas,
          made.plan.raz ? "RAZ" : ctas <= 2 ? "TRIAGE" : "WAITROOM",
        ),
      );
      batch.push(made.out, { at: triageAt, raw: triaged });
    }
    await send(batch);
    await settle();
    return `${room} ${room === 1 ? "patient" : "patients"} ${options.verb ?? "arrived"}`;
  }

  async function advancePatient(id: string) {
    const row = (await openRows()).find((item) => item.id === id);
    if (!row) throw new BackendError("not_found", 404);
    if (isScripted(row.visit)) throw new BackendError("scripted_visit", 409);
    const plan = planOf(row);
    const move = nextMove(row.state, plan, m.simNow);
    if (!move) throw new BackendError("nothing_next", 409);
    const last = row.state.lastEventAt ? Date.parse(row.state.lastEventAt) : 0;
    const at = floorSecond(Math.max(m.simNow, last + SEC));
    // The department clock never trails an event it just recorded.
    if (at > m.simNow) m.simNow = at;
    if (!mayTry(row, move.act)) throw new BackendError("nothing_next", 409);
    await send([{ at, raw: build(row, move.act, at, plan) }]);
    await settle();
    return `${row.name.split(" ")[0]}: ${MOVE_LABEL[move.act].toLowerCase()}`;
  }

  /**
   * Brings Maya back to the waiting room without touching anyone else: her current visit (if
   * any) ends, her contacts stop following it, and a new visit for the same person arrives and
   * is triaged. Her app follows, because the new visit links to the same patient.
   */
  async function reseatMaya() {
    const current = (await openRows()).filter((row) => isMaya(row.visit));
    const at = floorSecond(m.simNow);
    const batch: Out[] = current.map((row) => ({
      at,
      raw: build(row, "discharge", at, planOf(row)),
    }));
    const past = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ed_encounters WHERE site = $1 AND visit_number LIKE $2",
      [site, `${MAYA_VISIT}%`],
    );
    const person: TwinPatient = { ...mayaRecord, visit: `${MAYA_VISIT}${past.rows[0]?.n ?? 1}` };
    const plan = planFor(person.visit, MAYA_PLAN);
    const arriveAt = floorSecond(m.simNow - 3 * MIN);
    const triageAt = floorSecond(m.simNow - 1.5 * MIN);
    batch.push(
      {
        at: arriveAt,
        raw: emit(arriveAt, (twin, minute) => twin.arrive(minute, person, "WAITROOM")),
      },
      {
        at: triageAt,
        raw: emit(triageAt, (twin, minute) => twin.triage(minute, person, plan.ctas, "WAITROOM")),
      },
    );
    // Contacts belonged to the visit that ended; a judge adds themselves again to the new one.
    await pool.query(
      `UPDATE ed_contacts SET withdrawn_at = $3 WHERE withdrawn_at IS NULL AND encounter_id IN
       (SELECT id FROM ed_encounters WHERE site = $1 AND visit_number LIKE $2)`,
      [site, `${MAYA_VISIT}%`, clock()],
    );
    // The discharge goes first (send() orders by time, and the arrival is backdated), so the
    // old visit has ended before the new one arrives.
    await send(batch.slice(0, current.length));
    await send(batch.slice(current.length));
    await settle();
    return "Maya is back in the waiting room.";
  }

  // ---- state for the bar --------------------------------------------------------------------

  async function state(focus: { patientId?: string | null; encounterId?: string | null } = {}) {
    await ensure();
    if (!m.active) return { active: false } as const satisfies DemoState;
    return buildState({
      pool,
      site,
      simNow: m.simNow,
      settings: {
        running: m.running,
        started: m.started,
        speed: m.speed,
        arrivals: m.arrivals,
        staffing: m.staffing,
        skipLeft: m.skipLeft,
        fault: m.fault,
        idleReset: {
          minutes: idleMinutes,
          inMinutes:
            idleMs > 0 && m.lastUse !== null
              ? Math.max(0, Math.ceil((m.lastUse + idleMs - clock().getTime()) / MIN))
              : null,
          lastAutoReset: autoResetAt === null ? null : new Date(autoResetAt).toISOString(),
        },
      },
      memory: m.view,
      open: await openRows(),
      focus,
      planOf,
      isScripted,
    });
  }

  // ---- the clock ----------------------------------------------------------------------------

  async function tick() {
    // Nothing runs until the bar asks for the department (see ensure) or a reset creates one.
    if (!m.active) return;
    // Used, then left alone: start over so the next person gets a fresh demo.
    if (idleMs > 0 && m.lastUse !== null && clock().getTime() - m.lastUse >= idleMs) {
      try {
        await reset("idle");
      } catch (error) {
        onError(error);
      }
      return;
    }
    const real = Date.now();
    // After a stall the clock catches up by at most three real seconds.
    const elapsed = Math.min(real - m.lastTick, 3 * SEC);
    m.lastTick = real;
    try {
      let sent = 0;
      if (m.skipLeft > 0) {
        const stopAt = Date.now() + 1500;
        while (m.skipLeft > 0 && Date.now() < stopAt) {
          const chunk = Math.min(m.skipLeft, 10 * MIN);
          sent += await advance(m.simNow + chunk);
          m.skipLeft -= chunk;
          await settle();
        }
      } else if (m.running) sent = await advance(m.simNow + elapsed * m.speed);
      if (sent > 0 || m.sinceSettle >= 30 * SEC) await settle();
      else await heartbeat();
      // A failed reset's message stays until a reset succeeds.
      if (m.fault !== null && !m.fault.startsWith("The reset")) m.fault = null;
    } catch (error) {
      m.fault = "The simulation hit a snag and will retry.";
      // Moves that failed to send must not count against a visit's retry limit.
      m.attempts.clear();
      onError(error);
    }
  }

  async function act(
    action: DemoAction,
    focus: { patientId?: string | null; encounterId?: string | null } = {},
  ) {
    return exclusive(async () => {
      await ensure();
      let note = "";
      let contact: { id: string; phone: string } | undefined;
      if (action.type === "reset") note = await reset();
      else if (!m.active) throw new BackendError("demo_not_started", 409);
      else {
        m.lastUse = clock().getTime();
        switch (action.type) {
          case "play":
            note = m.started ? `Resumed at ×${m.speed}` : `Time is moving at ×${m.speed}`;
            m.running = true;
            m.started = true;
            m.lastTick = Date.now();
            break;
          case "pause":
            m.running = false;
            note = "Paused";
            break;
          case "speed":
            // Choosing a speed also plays; say so, so a paused ER never starts silently.
            note = m.running
              ? `Speed ×${action.value}`
              : m.started
                ? `Resumed at ×${action.value}`
                : `Time is moving at ×${action.value}`;
            m.speed = action.value;
            m.running = true;
            m.started = true;
            m.lastTick = Date.now();
            break;
          case "skip":
            m.skipLeft = Math.min(m.skipLeft + action.minutes * MIN, MAX_SKIP_MIN * MIN);
            note = `Skipping ${action.minutes} minutes`;
            break;
          case "add":
            note = await addPatients(action.count, { pick: action.ctas });
            break;
          case "surge":
            note = await addPatients(5, { levels: [1, 2, 2, 2, 2], verb: "arrived at once" });
            break;
          case "next":
            note = await advancePatient(action.patientId);
            break;
          case "reseat":
            note = await reseatMaya();
            break;
          case "arrivals":
            m.arrivals = action.value;
            note = `Walk-ins: ${{ off: "none", normal: "normal", busy: "busy" }[action.value]}`;
            break;
          case "staffing":
            m.staffing = action.value;
            note = `Staff on shift: ${{ low: "few", normal: "normal", high: "many" }[action.value]}`;
            break;
          case "keep":
            note = "Keeping this demo. It will not start over yet.";
            break;
          case "contact":
            // Real time, like the apps' own messages: the Guardian compares it with when the
            // feed last spoke, and the department clock runs ahead of that.
            ({ note, contact } = await addJudgeContact(pool, action, clock()));
            break;
          case "ask":
            note = await askAsContact(pool, action, clock(), options.agent ?? null);
            break;
        }
      }
      return { note, state: await state(focus), ...(contact ? { contact } : {}) };
    });
  }

  // The loop is self-scheduling so a slow tick never stacks up behind itself.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let generation = 0;
  function loop(run = generation) {
    timer = setTimeout(
      async () => {
        try {
          await exclusive(tick);
        } catch (error) {
          onError(error);
        }
        if (!stopped && run === generation) loop(run);
      },
      m.skipLeft > 0 ? 50 : 1000,
    );
    timer.unref?.();
  }

  return {
    /** Starts the clock. Nothing moves until the bar is used or the department already exists. */
    start() {
      if (!stopped) return;
      stopped = false;
      generation += 1;
      loop();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    state: (focus?: { patientId?: string | null; encounterId?: string | null }) =>
      exclusive(() => state(focus)),
    act,
    /** For tests: one tick, and a direct way to run the department forward. */
    tick: () => exclusive(tick),
    runTo: (to: number) =>
      exclusive(async () => {
        await ensure();
        const sent = await advance(to);
        await settle();
        return sent;
      }),
    clock: () => m.simNow,
  };
}
