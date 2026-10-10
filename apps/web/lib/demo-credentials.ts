import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const demoAccounts = {
  patient: "synthetic-patient-001",
  staff: "synthetic-staff-001",
  operator: "synthetic-operator-001",
} as const;
export type DemoPersona = keyof typeof demoAccounts;

// Server env supports hosted Next; the local file remains ignored and outside public assets.
export async function demoCredential(persona: DemoPersona) {
  const saved = JSON.parse(
    process.env.DEMO_SESSIONS_JSON ||
      (await readFile(resolve(process.cwd(), "../../.env.sessions.json"), "utf8")),
  );
  const credential = saved?.[demoAccounts[persona]];
  if (
    !credential ||
    typeof credential.token !== "string" ||
    !credential.token ||
    typeof credential.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(credential.expiresAt))
  )
    throw new Error("demo_setup_required");
  if (Date.parse(credential.expiresAt) <= Date.now()) throw new Error("demo_session_expired");
  return credential as { token: string; expiresAt: string };
}
