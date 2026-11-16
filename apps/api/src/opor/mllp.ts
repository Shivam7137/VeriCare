import { createConnection, createServer, type Server } from "node:net";
import { buildAck, field, parseHl7, segment } from "./hl7.js";

// MLLP is how HL7 v2 travels over TCP: each message is wrapped in a start byte
// and two end bytes, and the receiver answers each one with an acknowledgement.
const START = 0x0b;
const END = 0x1c;
const CR = 0x0d;

const frame = (message: string) =>
  Buffer.concat([Buffer.from([START]), Buffer.from(message, "utf8"), Buffer.from([END, CR])]);

function reader(onMessage: (message: string) => void) {
  let buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const start = buffer.indexOf(START);
      const end = buffer.indexOf(Buffer.from([END, CR]), start + 1);
      if (start < 0 || end < 0) break;
      onMessage(buffer.subarray(start + 1, end).toString("utf8"));
      buffer = buffer.subarray(end + 2);
    }
    // A sender that never completes a frame must not grow the buffer without bound.
    if (buffer.length > 1_000_000) buffer = Buffer.alloc(0);
  };
}

/** Listens for the OPOR feed. Messages are handled one at a time, in arrival order. */
export function startMllpListener(options: {
  host: string;
  port: number;
  onMessage: (raw: string) => Promise<unknown>;
  /** Told why a message was refused. Receives the error, never the message itself. */
  onError?: (error: unknown) => void;
  now?: () => Date;
}): Promise<Server> {
  const now = options.now ?? (() => new Date());
  const server = createServer((socket) => {
    let queue = Promise.resolve();
    socket.on(
      "data",
      reader((raw) => {
        queue = queue.then(async () => {
          let code: "AA" | "AE" = "AA";
          try {
            await options.onMessage(raw);
          } catch (error) {
            // AE asks the sender to hold and resend; nothing was applied.
            code = "AE";
            options.onError?.(error);
          }
          if (!socket.destroyed) socket.write(frame(buildAck(raw, code, now())));
        });
      }),
    );
    socket.on("error", () => socket.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}

/** Sends messages over one connection, waiting for each acknowledgement before the next. */
export async function sendMllp(
  target: { host: string; port: number },
  messages: readonly string[],
  timeoutMs = 10_000,
): Promise<string[]> {
  const socket = createConnection(target);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const acks: string[] = [];
  try {
    for (const message of messages) {
      const ack = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("mllp_ack_timeout")), timeoutMs);
        const onData = reader((raw) => {
          clearTimeout(timer);
          socket.off("data", onData);
          resolve(raw);
        });
        socket.on("data", onData);
        socket.once("error", reject);
        socket.write(frame(message));
      });
      const code = field(segment(parseHl7(ack), "MSA"), 1);
      if (code !== "AA") throw new Error(`mllp_not_accepted:${code}`);
      acks.push(code);
    }
  } finally {
    socket.destroy();
  }
  return acks;
}
