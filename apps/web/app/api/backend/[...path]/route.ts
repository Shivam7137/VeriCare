import { NextRequest } from "next/server";
import { backend, guardDemo, json, SESSION_COOKIE } from "../../../../lib/demo-server";

const readPaths = /^(tasks(?:\/[A-Za-z0-9-]+)?|slots|bookings\/[A-Za-z0-9-]+|operator\/queue)$/;
const writePaths =
  /^tasks(?:\/[A-Za-z0-9-]+\/(verify|proposals|staff-approval|confirmation|callback|withdraw|takeover))?$/;

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const denied = guardDemo(request);
  if (denied) return denied;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return json({ error: "unauthorized" }, 401);
  const path = (await context.params).path.join("/");
  if (!(request.method === "GET" ? readPaths : writePaths).test(path))
    return json({ error: "not_found" }, 404);
  try {
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && body.length > 16_384) return json({ error: "invalid_input" }, 400);
    const response = await backend(`/${path}${request.nextUrl.search}`, token, body);
    return json(await response.json(), response.status);
  } catch {
    return json({ error: "service_unavailable" }, 503);
  }
}
export const GET = proxy;
export const POST = proxy;
