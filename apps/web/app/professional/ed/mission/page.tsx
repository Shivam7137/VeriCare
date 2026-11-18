import type { Metadata } from "next";
import EdMission from "../../../../components/ed-mission";

export const metadata: Metadata = { title: "Live feed" };

export default function Page() {
  return <EdMission embedded />;
}
