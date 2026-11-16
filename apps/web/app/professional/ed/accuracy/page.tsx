import type { Metadata } from "next";
import EdAccuracy from "../../../../components/ed-accuracy";
import { journeyFonts } from "../../../../lib/journey-fonts";
import "../../../journey.css";
import "../../../journey-extra.css";

export const metadata: Metadata = { title: "Estimate accuracy · VeriCare" };

export default function Page() {
  return (
    <div className={journeyFonts}>
      <EdAccuracy />
    </div>
  );
}
