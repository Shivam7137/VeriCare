import { z } from "zod";

export const emergencyPatientInputSchema = z.strictObject({
  patientName: z.string().trim().min(2).max(150),
  dateOfBirth: z.iso.date(),
});
export const emergencyContactInputSchema = z.strictObject({
  contactName: z.string().trim().min(2).max(150),
  relationship: z.string().trim().min(2).max(80),
  resend: z.boolean(),
});
