export interface BridgeSocket {
  readyState: number;
  bufferedAmount: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export interface RealtimeFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}
export interface RealtimeBridgeOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  instructions: string;
  tools: readonly RealtimeFunctionTool[];
  verifyStart(input: {
    callSid: string;
    streamSid: string;
    customParameters: Record<string, string>;
  }): Promise<{ callId: string }>;
  onTool(
    name: string,
    args: Record<string, unknown>,
    callId: string,
    toolCallId: string,
  ): Promise<unknown>;
  onDigit(digit: string, callId: string, readbackActionId?: string): Promise<unknown>;
  onClose(callId: string, reason: string): Promise<void>;
  onMonitor?(callId: string, entry: VoiceMonitorEntry): void;
  socketFactory?: (
    url: string,
    options: { headers: { Authorization: string }; maxPayload: number },
  ) => BridgeSocket;
  sessionTimeoutMs?: number;
  startTimeoutMs?: number;
}

export function parseFrame(data: unknown, maxBytes: number): Record<string, unknown> {
  if (Buffer.isBuffer(data) && data.length > maxBytes) throw new Error("invalid_frame");
  const raw =
    typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : undefined;
  if (raw === undefined || Buffer.byteLength(raw) > maxBytes) throw new Error("invalid_frame");
  const value: unknown = JSON.parse(raw);
  if (!record(value)) throw new Error("invalid_frame");
  return value;
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

export function validAudio(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 24 * 1024 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value) &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}

export function safeOutput(value: unknown): string {
  try {
    const output = JSON.stringify(value ?? null);
    if (output && Buffer.byteLength(output) <= 32 * 1024) return output;
  } catch {
    /* Provider output never includes internal errors or stack traces. */
  }
  return '{"ok":false,"error":"invalid_backend_result"}';
}
import type { VoiceMonitorEntry } from "@prc/contracts";
