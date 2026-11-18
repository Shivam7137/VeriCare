import type { Metadata } from "next";
import NowView from "../../../components/vc/now-view";

export const metadata: Metadata = { title: "Now" };

export default function Page() {
  return <NowView />;
}
