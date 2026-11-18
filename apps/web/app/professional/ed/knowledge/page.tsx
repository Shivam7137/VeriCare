import type { Metadata } from "next";
import KnowledgeView from "../../../../components/vc/knowledge-view";

export const metadata: Metadata = { title: "Knowledge base" };

export default function Page() {
  return <KnowledgeView />;
}
