import { z } from "zod";

export const taskStateSchema = z.enum([
  "awaiting_verification",
  "awaiting_proposal",
  "awaiting_staff_approval",
  "awaiting_patient_confirmation",
  "ready_to_execute",
  "executing",
  "reconciling",
  "completed",
  "withdrawn",
  "staff_takeover",
]);

// This validates record shape. It is not an authorization or transition engine.
export const taskSchema = z.object({
  id: z.string().min(1),
  patientId: z.string().min(1),
  requesterId: z.string().min(1),
  departmentId: z.string().min(1),
  owner: z.string().min(1),
  state: taskStateSchema,
  revision: z.number().int().nonnegative(),
  summary: z.string().min(1),
  nextAction: z.string().min(1),
  synthetic: z.literal(true),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Task = z.infer<typeof taskSchema>;

export const taskEventSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  actorId: z.string().min(1),
  action: z.string().min(1),
  occurredAt: z.iso.datetime(),
  evidenceRef: z.string().min(1),
});

export type TaskEvent = z.infer<typeof taskEventSchema>;

export const seededTask = taskSchema.parse({
  id: "T001",
  patientId: "synthetic-patient-001",
  requesterId: "synthetic-patient-001",
  departmentId: "demo-department",
  owner: "demo-staff-queue",
  state: "awaiting_verification",
  revision: 0,
  summary: "Move a fictional Tuesday appointment to Thursday afternoon.",
  nextAction: "Verify access and ask for a specific callback window and time zone.",
  synthetic: true,
  createdAt: "2030-01-07T12:00:00.000Z",
  updatedAt: "2030-01-07T12:00:00.000Z",
});

// Drafts describe a candidate change; they are not approval or booking evidence.
export const proposalDraftSchema = z
  .strictObject({
    id: z.string().min(1),
    taskId: z.string().min(1),
    version: z.number().int().positive(),
    status: z.literal("draft"),
    appointmentId: z.string().min(1),
    slotId: z.string().min(1),
    expectedBookingVersion: z.string().min(1),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    createdBy: z.string().min(1),
  })
  .refine((draft) => Date.parse(draft.endsAt) > Date.parse(draft.startsAt), {
    message: "The slot must end after it starts.",
    path: ["endsAt"],
  })
  .refine((draft) => Date.parse(draft.expiresAt) > Date.parse(draft.createdAt), {
    message: "The draft must expire after it is created.",
    path: ["expiresAt"],
  })
  .refine((draft) => Date.parse(draft.expiresAt) <= Date.parse(draft.startsAt), {
    message: "The draft must expire no later than the slot starts.",
    path: ["expiresAt"],
  });

export type ProposalDraft = z.infer<typeof proposalDraftSchema>;

export const saveProposalDraftInputSchema = z.strictObject({
  taskId: proposalDraftSchema.shape.taskId,
  expectedRevision: z.number().int().nonnegative(),
  actorId: proposalDraftSchema.shape.createdBy,
  appointmentId: proposalDraftSchema.shape.appointmentId,
  slotId: proposalDraftSchema.shape.slotId,
  expectedBookingVersion: proposalDraftSchema.shape.expectedBookingVersion,
  startsAt: proposalDraftSchema.shape.startsAt,
  endsAt: proposalDraftSchema.shape.endsAt,
  expiresAt: proposalDraftSchema.shape.expiresAt,
});

export type SaveProposalDraftInput = z.infer<typeof saveProposalDraftInputSchema>;
