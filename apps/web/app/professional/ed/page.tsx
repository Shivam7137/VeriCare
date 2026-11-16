import type { Metadata } from "next";
import EdDesk from "../../../components/ed-desk";
import { journeyFonts } from "../../../lib/journey-fonts";
import "../../journey.css";
import "../../journey-extra.css";

export const metadata: Metadata = { title: "Emergency Desk · VeriCare" };

export default function EmergencyDesk() {
  return (
    <div className={journeyFonts}>
      <EdDesk />
    </div>
  );
}
