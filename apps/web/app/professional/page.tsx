import type { Metadata } from "next";
import Dashboard from "../../components/dashboard";

export const metadata: Metadata = { title: "Professional portal · careBridge" };

export default function ProfessionalPortal() {
  return <Dashboard key="professional" portal="professional" />;
}
