import type { Metadata } from "next";
import Dashboard from "../../components/dashboard";

export const metadata: Metadata = { title: "Professional portal · Care coordination" };

export default function ProfessionalPortal() {
  return <Dashboard key="professional" portal="professional" />;
}
