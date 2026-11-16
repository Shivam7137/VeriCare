import type { Metadata } from "next";
import EdMission from "../../../../components/ed-mission";
import { journeyFonts } from "../../../../lib/journey-fonts";
import "../../../journey.css";
import "../../../journey-extra.css";

export const metadata: Metadata = { title: "Mission control · VeriCare" };

export default function Page() {
  return (
    <div className={journeyFonts}>
      <EdMission />
    </div>
  );
}
