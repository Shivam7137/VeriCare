import type { Metadata } from "next";
import type { ReactNode } from "react";
import DemoBar from "../../../components/demo-bar";
import Shell from "../../../components/vc/shell";
import { journeyFonts } from "../../../lib/journey-fonts";
import "../../journey.css";
import "../../journey-extra.css";
import "../../vc-app.css";

export const metadata: Metadata = {
  title: { default: "VeriCare", template: "%s · VeriCare" },
};

// Every staff view shares one sidebar, one session and one Desk poll.
export default function VeriCareLayout({ children }: { children: ReactNode }) {
  return (
    <div className={journeyFonts}>
      <Shell>{children}</Shell>
      <DemoBar />
    </div>
  );
}
