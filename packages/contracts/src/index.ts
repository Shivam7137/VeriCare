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
