import type { Pool } from "pg";
import { seedBackend } from "./backend-fixtures.js";
import { demoPatients, demoScenarios, demoStaff, type DemoScenario } from "./demo-catalog.js";
import { demoTransaction } from "./demo-transaction.js";
import { dispatchDueJobs } from "./delivery.js";
import { BookingExecutor } from "./executor.js";
import { getPrincipal } from "./identity.js";
import { MockScheduler } from "./scheduler.js";
import { VoiceAgent } from "./voice-agent.js";
import { WorkflowService } from "./workflow.js";
import { seedCareTeam } from "./care-team-directory.js";

const minute = 60_000;
const day = 86_400_000;
const department = "demo-department";

function appointmentTime(anchor: Date, businessDays: number, hour: number) {
  const date = new Date(anchor);
  date.setUTCHours(hour, 0, 0, 0);
  for (let remaining = businessDays; remaining > 0;) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (![0, 6].includes(date.getUTCDay())) remaining--;
  }
  return date;
}

async function profiles(pool: Pool) {
  for (const patient of demoPatients) {
    await pool.query(
      `INSERT INTO patients (id,department_id,display_name) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET display_name=COALESCE(patients.display_name,EXCLUDED.display_name)`,
      [patient.id, department, patient.name],
    );
    await pool.query(
      `INSERT INTO principals (id,role,patient_id,verified,display_name) VALUES ($1,'patient',$1,true,$2)
       ON CONFLICT (id) DO UPDATE SET display_name=COALESCE(principals.display_name,EXCLUDED.display_name)`,
      [patient.id, patient.name],
    );
  }
  for (const staff of demoStaff) {
    await pool.query(
      `INSERT INTO principals (id,role,department_id,verified,display_name) VALUES ($1,'staff',$2,true,$3)
       ON CONFLICT (id) DO UPDATE SET display_name=COALESCE(principals.display_name,EXCLUDED.display_name)`,
      [staff.id, department, staff.name],
    );
  }
  await seedCareTeam(pool);
}

async function insertSlot(pool: Pool, id: string, start: Date) {
  await pool.query(
    `INSERT INTO scheduler_slots (id,department_id,starts_at,ends_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO NOTHING`,
    [id, department, start, new Date(start.getTime() + 30 * minute)],
  );
}

async function populateScenario(
  pool: Pool,
  anchor: Date,
  prefix: string,
  scenario: DemoScenario,
  index: number,
) {
  const id = `${prefix}-${scenario.key}`;
  const appointmentId = `${id}-appointment`;
  const existing = await pool.query(
    "SELECT task_id FROM workflow_tasks WHERE payload->>'appointmentId'=$1",
    [appointmentId],
  );
  // Never replay decisions or overwrite edits to an already populated scenario.
  if (existing.rows[0]) return { taskId: existing.rows[0].task_id as string, created: false };

  const patient = await getPrincipal(pool, demoPatients[scenario.patient]!.id);
  const staff = await getPrincipal(pool, demoStaff[index % demoStaff.length]!.id);
  const original = appointmentTime(anchor, 5 + Math.floor(index / 8), 9 + (index % 8));
  const target = appointmentTime(anchor, 10 + Math.floor(index / 8), 9 + (index % 8));
  const alternate = new Date(target.getTime() + 30 * minute);
  for (const [name, time] of [
    ["original", original],
    ["target", target],
    ["alternate", alternate],
  ] as const)
    await insertSlot(pool, `${id}-${name}`, time);
  await pool.query(
    `INSERT INTO scheduler_bookings (id,patient_id,department_id,slot_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO NOTHING`,
    [appointmentId, patient.patientId, department, `${id}-original`],
  );

  let clock = new Date(anchor.getTime() - (index + 1) * 12 * minute);
  const now = () => clock;
  const tick = (seconds = 15) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };
  const scheduler = new MockScheduler(pool, { now });
  const workflow = new WorkflowService(pool, { scheduler, now });
  const agent = new VoiceAgent(pool, { now });
  const callbackWindow = {
    startsAt: clock.toISOString(),
    endsAt: new Date(anchor.getTime() + 2 * day).toISOString(),
    timeZone: "UTC",
  };
  let task = await workflow.create(patient, {
    patientId: patient.patientId!,
    appointmentId,
    summary: scenario.summary,
    availability: {
      startsAt: target.toISOString(),
      endsAt: new Date(alternate.getTime() + 30 * minute).toISOString(),
      timeZone: "UTC",
    },
    callbackWindow,
  });
  tick();
  const access = await agent.store.issueCode(patient, task.id);
  const call = await agent.store.simulate(patient, access.code);
  await agent.run(call.id, `${id}-status`, "get_request_status", {});

  if (scenario.stage !== "verify") {
    task = await workflow.verify(patient, task.id, { expectedRevision: task.revision });
    tick();
  }
  if (scenario.callbackChanged) {
    const changed = {
      ...callbackWindow,
      startsAt: new Date(anchor.getTime() + 20 * minute).toISOString(),
    };
    await agent.run(call.id, `${id}-callback`, "prepare_callback", { callbackWindow: changed });
    await agent.confirm(call.id, (await agent.store.getInternal(call.id)).pendingAction!.id);
    task = (await workflow.progress(patient, task.id)).task;
    tick();
  }
  const propose = async (slot: string) => {
    task = await workflow.propose(staff, task.id, {
      expectedRevision: task.revision,
      slotId: `${id}-${slot}`,
      expiresAt: new Date(anchor.getTime() + 2 * day).toISOString(),
    });
    tick();
  };
  let version = 1;
  if (!["verify", "propose", "handoff"].includes(scenario.stage) || scenario.rejected) {
    await propose("target");
    if (scenario.revised) {
      await propose("alternate");
      version = 2;
    }
    if (scenario.rejected) {
      task = await workflow.decide(staff, task.id, "staff_approval", {
        expectedRevision: task.revision,
        proposalVersion: version,
        response: "reject",
        evidenceRef: `demo:${id}:review-rejected`,
      });
      tick();
    } else if (["confirm", "complete"].includes(scenario.stage)) {
      task = await workflow.decide(staff, task.id, "staff_approval", {
        expectedRevision: task.revision,
        proposalVersion: version,
        response: "approve",
        evidenceRef: `demo:${id}:staff-approved`,
      });
      tick();
      for (let attempt = 0; attempt < (scenario.failedDelivery ? 3 : 1); attempt++) {
        await dispatchDueJobs(pool, {
          now,
          taskId: task.id,
          ...(scenario.failedDelivery
            ? {
                beforeDelivery: async () => {
                  throw new Error("Synthetic transport failure");
                },
              }
            : {}),
        });
        tick();
      }
      task = (await workflow.progress(patient, task.id)).task;
    }
  }

  if (scenario.voice === "pending") {
    clock = new Date(anchor);
    // Settle due reminders before preparing the exact-revision action, so the
    // running worker cannot immediately invalidate the example on commit.
    await dispatchDueJobs(pool, { now, taskId: task.id });
  }
  if (scenario.voice === "pending" || scenario.voice === "approved") {
    await agent.run(call.id, `${id}-confirm`, "prepare_confirmation", { response: "approve" });
    if (scenario.voice === "approved") {
      await agent.confirm(call.id, (await agent.store.getInternal(call.id)).pendingAction!.id);
      task = (await workflow.progress(patient, task.id)).task;
      tick();
    }
  }
  if (scenario.stage === "complete") {
    if (scenario.voice !== "approved") {
      task = await workflow.decide(patient, task.id, "patient_confirmation", {
        expectedRevision: task.revision,
        proposalVersion: version,
        response: "approve",
        evidenceRef: `demo:${id}:patient-approved`,
      });
      tick();
    }
    await new BookingExecutor(pool, { scheduler, now }).execute(task.id);
  } else if (scenario.stage === "withdraw") {
    await agent.run(call.id, `${id}-withdraw`, "prepare_withdrawal", {});
    await agent.confirm(call.id, (await agent.store.getInternal(call.id)).pendingAction!.id);
  } else if (scenario.stage === "handoff") {
    await agent.run(call.id, `${id}-handoff`, "request_human", {});
    task = await workflow.takeover(staff, task.id, {
      expectedRevision: task.revision,
      evidenceRef: `voice:${call.id}:coordinator-review`,
    });
  }
  if (scenario.voice !== "pending" && scenario.voice !== "handoff") {
    tick();
    await agent.store.end(call.id, "demo_conversation_finished");
    await workflow.callEnded(patient, task.id, `voice:${call.id}`);
  }
  if (scenario.callback) {
    clock = new Date(anchor);
    await agent.store.scheduleCallback(patient, {
      taskId: task.id,
      // The North American 555-0100–0199 range is reserved for fictional use.
      to: `+1202555${String(100 + index).padStart(4, "0")}`,
      dueAt: new Date(anchor.getTime() + (30 + index * 10) * minute).toISOString(),
      mode: "simulated",
    });
  }
  return { taskId: task.id, created: true };
}

export async function populateDemo(pool: Pool, options: { now?: Date; batch?: string } = {}) {
  const anchor = new Date(options.now ?? new Date());
  if (!Number.isFinite(anchor.getTime())) throw new Error("Invalid population date");
  const batch = options.batch ?? anchor.toISOString().slice(0, 10);
  if (!/^[a-zA-Z0-9-]{1,40}$/.test(batch))
    throw new Error("Use a batch name of 1–40 letters, digits or hyphens");
  const prefix = `demo-v1-${batch}`;
  return demoTransaction(pool, async (scoped) => {
    await seedBackend(scoped, anchor);
    await profiles(scoped);
    const unusedCodes = (
      await scoped.query(
        "SELECT id FROM voice_access_codes WHERE actor_id=ANY($1::text[]) AND revoked_at IS NULL AND consumed_call_id IS NULL",
        [demoPatients.map((patient) => patient.id)],
      )
    ).rows.map((row) => row.id);
    const tasks: { taskId: string; created: boolean }[] = [];
    for (const [index, scenario] of demoScenarios.entries())
      tasks.push(await populateScenario(scoped, anchor, prefix, scenario, index));
    for (let index = 0; index < 12; index++)
      await insertSlot(
        scoped,
        `${prefix}-open-${index + 1}`,
        appointmentTime(anchor, 15 + Math.floor(index / 4), 9 + (index % 4)),
      );
    // Simulated sign-ins rotate codes inside this transaction. Restore any pre-existing
    // unused codes before commit; every new fixture code has already been consumed.
    await scoped.query("UPDATE voice_access_codes SET revoked_at=NULL WHERE id=ANY($1::text[])", [
      unusedCodes,
    ]);
    return {
      batch,
      created: tasks.filter((task) => task.created).length,
      preserved: tasks.filter((task) => !task.created).length,
      taskIds: tasks.map((task) => task.taskId),
    };
  });
}
