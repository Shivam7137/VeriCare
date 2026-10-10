import type { Metadata } from "next";
import CareTeamDirectory from "../../../components/care-team-directory";
export const metadata: Metadata = { title: "Care team & phone · Health Coordinator" };
export default function TeamPage() {
  return <CareTeamDirectory />;
}
