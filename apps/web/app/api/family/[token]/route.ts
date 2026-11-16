import { NextRequest } from "next/server";
import { guardDemo, json } from "../../../../lib/demo-server";

// The family page has no session: the link in the contact's text message is the key.
// This handler only forwards a well-formed link to the API, which decides what it may show.
const link = /^[A-Za-z0-9_-]{32}$/;

async function forward(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const denied = guardDemo(request);
  if (denied) return denied;
  const { token } = await context.params;
  if (!link.test(token)) return json({ mode: "handoff", message: "" }, 404);
  try {
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && body.length > 4096) return json({ error: "invalid_input" }, 400);
    const response = await fetch(
      `${process.env.API_URL ?? "http://127.0.0.1:4100"}/journey/family/${token}${body === undefined ? "" : "/messages"}`,
      {
        method: request.method,
        headers: { "Content-Type": "application/json" },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      },
    );
    return json(await response.json(), response.status);
  } catch {
    return json({ error: "service_unavailable" }, 503);
  }
}
export const GET = forward;
export const POST = forward;
