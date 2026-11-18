import { z } from "zod";

// VeriCare Journey: one emergency visit as a stream of normalised events.
// These schemas validate shape only. Disclosure is decided by the API's Guardian.

export const ctasSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export type Ctas = z.infer<typeof ctasSchema>;

export const edEventKindSchema = z.enum([
  "arrived",
  "triaged",
  "location_changed",
  "provider_assigned",
  "order_placed",
  "result_available",
  "order_cancelled",
  "consult_requested",
  "admit_decision",
  "bed_requested",
  "moved_to_unit",
  "discharged",
  "left_without_being_seen",
  "cancelled",
  "flag_set",
  "flag_cleared",
  // A message we could not interpret. The visit fails closed until staff clear it.
  "unmapped",
]);
export type EdEventKind = z.infer<typeof edEventKindSchema>;

export const sensitivityFlagSchema = z.enum([
  "deceased",
  "confidential",
  "vip",
  "security",
  "critical",
]);
export type SensitivityFlag = z.infer<typeof sensitivityFlagSchema>;

export const edStreamSchema = z.enum(["main", "rapid_assessment"]);
export type EdStream = z.infer<typeof edStreamSchema>;

export const edOrderTypeSchema = z.enum(["lab", "imaging", "other"]);
export type EdOrderType = z.infer<typeof edOrderTypeSchema>;

// Imaging turnaround differs several-fold by kind, so the kind is kept. Never the result.
export const edImagingModalitySchema = z.enum(["xray", "ct", "ultrasound", "mri", "other"]);
export type EdImagingModality = z.infer<typeof edImagingModalitySchema>;

export const edEventDetailSchema = z.strictObject({
  ctas: ctasSchema.optional(),
  area: z.string().max(80).optional(),
  room: z.string().max(80).optional(),
  stream: edStreamSchema.optional(),
  orderId: z.string().max(80).optional(),
  orderType: edOrderTypeSchema.optional(),
  modality: edImagingModalitySchema.optional(),
  flag: sensitivityFlagSchema.optional(),
  trigger: z.string().max(20).optional(),
});
export type EdEventDetail = z.infer<typeof edEventDetailSchema>;

export const edEventSourceSchema = z.enum(["hl7v2", "fhir", "staff"]);

export const edEventSchema = z.strictObject({
  kind: edEventKindSchema,
  occurredAt: z.iso.datetime(),
  source: edEventSourceSchema,
  sourceEventId: z.string().min(1).max(200),
  detail: edEventDetailSchema,
});
export type EdEvent = z.infer<typeof edEventSchema>;

export const visitStepSchema = z.enum([
  "arrived",
  "waiting",
  "being_seen",
  "deciding",
  "admitted_waiting_bed",
  "moved_to_unit",
  "discharged",
  "left",
  "cancelled",
]);
export type VisitStep = z.infer<typeof visitStepSchema>;

export const visitStateSchema = z.strictObject({
  step: visitStepSchema,
  // The five steps people see: checked in, waiting, being seen, tests and results, next steps.
  friendlyStep: z.number().int().min(1).max(5),
  ctas: ctasSchema.nullable(),
  stream: edStreamSchema,
  area: z.string().nullable(),
  testsInProgress: z.boolean(),
  resultsReady: z.boolean(),
  consultRequested: z.boolean(),
  bedRequested: z.boolean(),
  sensitivity: z.array(sensitivityFlagSchema),
  unmapped: z.boolean(),
  ended: z.boolean(),
  arrivedAt: z.iso.datetime().nullable(),
  triagedAt: z.iso.datetime().nullable(),
  providerAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  lastEventAt: z.iso.datetime().nullable(),
});
export type VisitState = z.infer<typeof visitStateSchema>;

export const consentScopeSchema = z.enum(["status", "alerts", "estimates"]);
export type ConsentScope = z.infer<typeof consentScopeSchema>;

export const waitRangeSchema = z.strictObject({
  lowMinutes: z.number().int().nonnegative(),
  highMinutes: z.number().int().positive(),
  computedAt: z.iso.datetime(),
  reason: z.enum(["first", "more_urgent_arrivals", "pace_slower", "pace_faster", "steady"]),
});
export type WaitRange = z.infer<typeof waitRangeSchema>;

export const staffTaskKindSchema = z.enum([
  "recheck",
  "leaving",
  "question",
  "interpreter",
  "comfort",
]);
export type StaffTaskKind = z.infer<typeof staffTaskKindSchema>;

export const contactInputSchema = z.strictObject({
  name: z.string().trim().min(2).max(150),
  relationship: z.string().trim().min(2).max(80),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
  scopes: z.array(consentScopeSchema).min(1).max(3),
});

export const patientMessageInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(500),
});

export const checkInAnswerSchema = z.strictObject({
  answer: z.enum(["same", "better", "worse"]),
});

export const staffFlagInputSchema = z.strictObject({
  flag: sensitivityFlagSchema,
  active: z.boolean(),
});

export const staffTaskCloseSchema = z.strictObject({
  outcome: z.enum(["done", "not_needed"]),
});

/** A knowledge-base article as staff write it. `publish` is the approval to send it. */
export const kbArticleInputSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9_]{2,48}$/)
    .optional(),
  title: z.string().trim().min(3).max(80),
  body: z.string().trim().min(20).max(600),
  gapId: z.uuid().optional(),
  publish: z.boolean(),
});

export const kbQuestionInputSchema = z.strictObject({
  question: z.string().trim().min(2).max(500),
});
