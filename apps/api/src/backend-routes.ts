import {
  authorityGrantInputSchema,
  authorityRequestInputSchema,
  authorityReviewInputSchema,
  callbackInputSchema,
  createTaskInputSchema,
  decisionInputSchema,
  proposeInputSchema,
  revisionInputSchema,
  stopInputSchema,
  textIntentInputSchema,
} from "@prc/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { interpretRequest, runAgentTool } from "./agent-tools.js";
import { BackendError } from "./domain.js";
import { BookingExecutor } from "./executor.js";
import {
  authenticate,
  getPrincipal,
  grantAuthority,
  listAuthorityRequests,
  requestAuthority,
  requirePatientAccess,
  requireStaff,
  reviewAuthorityRequest,
  revokeAuthority,
  type Principal,
} from "./identity.js";
import { MockScheduler, type Scheduler } from "./scheduler.js";
import { WorkflowService } from "./workflow.js";

type TaskRoute = { Params: { id: string } };

export function registerBackendRoutes(
  app: FastifyInstance,
  pool: Pool,
  options: { scheduler?: Scheduler; now?: () => Date; autoPropose?: boolean } = {},
): void {
  const now = options.now ?? (() => new Date());
  const scheduler = options.scheduler ?? new MockScheduler(pool, { now });
  const service = new WorkflowService(pool, { scheduler, now, autoPropose: options.autoPropose });
  const executor = new BookingExecutor(pool, { scheduler, now });

  // Encapsulation keeps authentication and safe errors local to backend routes.
  app.register(async (backend) => {
    const identities = new WeakMap<FastifyRequest, Principal>();
    const actor = (request: FastifyRequest) => {
      const identity = identities.get(request);
      if (!identity) throw new BackendError("unauthorized", 401);
      return identity;
    };
    backend.setErrorHandler((error, _request, reply) => {
      if (error instanceof BackendError)
        return reply.code(error.statusCode).send({ error: error.code });
      if (
        error instanceof Error &&
        (error.name === "ZodError" ||
          ("code" in error &&
            typeof error.code === "string" &&
            (error.code.startsWith("FST_ERR_CTP_") || error.code === "FST_ERR_VALIDATION")))
      ) {
        return reply.code(400).send({ error: "invalid_input" });
      }
      return reply.code(503).send({ error: "storage_unavailable" });
    });
    backend.addHook("onRequest", async (request) => {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? "");
      if (!match) throw new BackendError("unauthorized", 401);
      identities.set(request, await authenticate(pool, match[1]!, now()));
    });

    backend.get("/me", async (request) => actor(request));
    backend.get("/tasks", async (request) => ({ tasks: await service.list(actor(request)) }));
    backend.post("/tasks", async (request, reply) => {
      const task = await service.create(actor(request), createTaskInputSchema.parse(request.body));
      return reply.code(201).send(task);
    });
    backend.get<TaskRoute>("/tasks/:id", async (request) =>
      service.progress(actor(request), request.params.id),
    );
    backend.get<TaskRoute>("/tasks/:id/events", async (request) => {
      const progress = await service.progress(actor(request), request.params.id);
      return { taskId: progress.task.id, events: progress.events };
    });
    backend.get<TaskRoute>("/tasks/:id/proposals", async (request) => {
      const progress = await service.progress(actor(request), request.params.id);
      return { taskId: progress.task.id, proposals: progress.proposals };
    });
    backend.post<TaskRoute>("/tasks/:id/verify", async (request) =>
      service.verify(actor(request), request.params.id, revisionInputSchema.parse(request.body)),
    );
    backend.post<TaskRoute>("/tasks/:id/proposals", async (request) =>
      service.propose(actor(request), request.params.id, proposeInputSchema.parse(request.body)),
    );
    backend.post<TaskRoute>("/tasks/:id/staff-approval", async (request) =>
      service.decide(
        actor(request),
        request.params.id,
        "staff_approval",
        decisionInputSchema.parse(request.body),
      ),
    );
    backend.post<TaskRoute>("/tasks/:id/confirmation", async (request) =>
      service.decide(
        actor(request),
        request.params.id,
        "patient_confirmation",
        decisionInputSchema.parse(request.body),
      ),
    );
    backend.post<TaskRoute>("/tasks/:id/callback", async (request) =>
      service.callback(actor(request), request.params.id, callbackInputSchema.parse(request.body)),
    );
    backend.post<TaskRoute>("/tasks/:id/withdraw", async (request) =>
      service.withdraw(actor(request), request.params.id, stopInputSchema.parse(request.body)),
    );
    backend.post<TaskRoute>("/tasks/:id/takeover", async (request) =>
      service.takeover(actor(request), request.params.id, stopInputSchema.parse(request.body)),
    );
    backend.post<TaskRoute>("/tasks/:id/execute", async (request) => {
      const input = revisionInputSchema.parse(request.body);
      const current = await getPrincipal(pool, actor(request).id);
      const progress = await service.progress(current, request.params.id);
      await requireStaff(pool, current, progress.task.departmentId);
      // Executor applies this guard again under its task lock before preparing/replaying work.
      await executor.execute(request.params.id, {
        actor: current,
        expectedRevision: input.expectedRevision,
      });
      return service.progress(current, request.params.id);
    });

    backend.get("/slots", async (request) => {
      const input = authorityRequestInputSchema.parse(request.query);
      await requirePatientAccess(pool, actor(request), input.patientId, now());
      const patient = (
        await pool.query("SELECT department_id FROM patients WHERE id=$1", [input.patientId])
      ).rows[0];
      if (!patient) throw new BackendError("not_found", 404);
      return {
        patientId: input.patientId,
        slots: await scheduler.listSlots(patient.department_id),
      };
    });
    backend.get<TaskRoute>("/bookings/:id", async (request) => {
      const booking = await scheduler.getBooking(request.params.id);
      if (!booking) throw new BackendError("not_found", 404);
      await requirePatientAccess(pool, actor(request), booking.patientId, now());
      return booking;
    });

    backend.post("/authority-requests", async (request, reply) =>
      reply
        .code(201)
        .send(
          await requestAuthority(
            pool,
            actor(request),
            authorityRequestInputSchema.parse(request.body),
            now(),
          ),
        ),
    );
    backend.get("/authority-requests", async (request) => ({
      requests: await listAuthorityRequests(pool, actor(request)),
    }));
    backend.post<TaskRoute>("/authority-requests/:id/review", async (request) =>
      reviewAuthorityRequest(
        pool,
        actor(request),
        request.params.id,
        authorityReviewInputSchema.parse(request.body),
        now(),
      ),
    );
    backend.post("/authority-grants", async (request, reply) =>
      reply
        .code(201)
        .send(
          await grantAuthority(
            pool,
            actor(request),
            authorityGrantInputSchema.parse(request.body),
            now(),
          ),
        ),
    );
    backend.delete<{ Params: { patientId: string; requesterId: string } }>(
      "/patients/:patientId/authority/:requesterId",
      async (request, reply) => {
        await revokeAuthority(
          pool,
          actor(request),
          request.params.patientId,
          request.params.requesterId,
          now(),
        );
        return reply.code(204).send();
      },
    );

    backend.get("/operator/queue", async (request) => {
      const current = await getPrincipal(pool, actor(request).id);
      if (!current.active || !current.verified) throw new BackendError("unauthorized", 401);
      if (current.role !== "staff" && current.role !== "operator")
        throw new BackendError("forbidden", 403);
      const asOf = now();
      const tasks = (await service.list(current)).filter(
        (progress) => progress.task.departmentId === current.departmentId,
      );
      const counts = {
        tasks: tasks.length,
        overduePendingActions: 0,
        overdueJobs: 0,
        failedDeliveries: 0,
        reconciliation: 0,
      };
      for (const progress of tasks) {
        counts.overduePendingActions += progress.actions.filter(
          (action) =>
            action.status === "pending" && new Date(action.expiresAt).getTime() <= asOf.getTime(),
        ).length;
        counts.overdueJobs += progress.jobs.filter(
          (job) => job.status === "pending" && new Date(job.dueAt).getTime() <= asOf.getTime(),
        ).length;
        counts.failedDeliveries += progress.jobs.filter((job) => job.status === "failed").length;
        counts.reconciliation += progress.operations.filter(
          (operation) => operation.status === "dispatched" || operation.status === "reconciling",
        ).length;
      }
      return { departmentId: current.departmentId, asOf: asOf.toISOString(), counts, tasks };
    });
    backend.post("/agent/interpret", async (request) =>
      interpretRequest(textIntentInputSchema.parse(request.body).text),
    );
    backend.post("/agent/tools", async (request) =>
      runAgentTool(service, actor(request), request.body),
    );
  });
}
