import { z } from "zod";

export const voiceMonitorEntrySchema = z.object({
  id: z.string().min(1).max(180),
  kind: z.enum(["transcript", "tool", "session", "speech", "response", "keypad", "error"]),
  label: z.string().max(160),
  at: z.iso.datetime(),
  status: z.enum([
    "streaming",
    "complete",
    "running",
    "failed",
    "interrupted",
    "incomplete",
    "info",
  ]),
  speaker: z.enum(["caller", "assistant"]).optional(),
  itemId: z.string().max(128).optional(),
  responseId: z.string().max(128).optional(),
  text: z.string().max(8200).optional(),
  elapsedMs: z.number().nonnegative().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type VoiceMonitorEntry = z.infer<typeof voiceMonitorEntrySchema>;
export type VoiceMonitorSnapshot = {
  entries: VoiceMonitorEntry[];
  captureWarning: string | null;
  persisted: true;
  streamConnected: boolean;
};
