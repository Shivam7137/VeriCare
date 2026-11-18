import type { Metadata } from "next";
import EdAccuracy from "../../../../components/ed-accuracy";

export const metadata: Metadata = { title: "Accuracy" };

export default function Page() {
  return <EdAccuracy embedded />;
}
