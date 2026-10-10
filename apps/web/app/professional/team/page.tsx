import type { Metadata } from "next";
import CareTeamDirectory from "../../../components/care-team-directory";
export const metadata: Metadata = { title: "Care team & phone · careBridge" };
export default function TeamPage() {
  return <CareTeamDirectory />;
}
