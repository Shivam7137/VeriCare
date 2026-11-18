import type { Metadata } from "next";
import Dashboard from "../../components/dashboard";

export const metadata: Metadata = { title: "Professional portal · VeriCare" };

export default function ProfessionalPortal() {
  return <Dashboard key="professional" portal="professional" />;
}
