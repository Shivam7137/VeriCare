import type { Metadata } from "next";
import AgentView from "../../../../components/vc/agent-view";

export const metadata: Metadata = { title: "Agent & audit" };

export default function Page() {
  return <AgentView />;
}
