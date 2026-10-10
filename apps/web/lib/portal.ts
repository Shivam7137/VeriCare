export type Portal = "patient" | "professional";

export const portalCookies: Record<Portal, string> = {
  patient: "prc_patient_session",
  professional: "prc_professional_session",
};

export function isPortal(value: unknown): value is Portal {
  return value === "patient" || value === "professional";
}

export function permitsRole(portal: Portal, role: unknown) {
  return portal === "patient" ? role === "patient" : role === "staff" || role === "operator";
}
