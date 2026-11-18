import type { Metadata } from "next";
import PatientView from "../../../../../components/vc/patient-view";

export const metadata: Metadata = { title: "Visit" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PatientView id={id} />;
}
