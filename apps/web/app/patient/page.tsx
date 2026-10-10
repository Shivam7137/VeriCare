import type { Metadata } from "next";
import Dashboard from "../../components/dashboard";

export const metadata: Metadata = { title: "Patient portal · Health Coordinator" };

export default function PatientPortal() {
  return <Dashboard key="patient" portal="patient" />;
}
