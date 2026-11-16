import type { Metadata } from "next";
import VisitPage from "../../../components/visit-page";
import { journeyFonts } from "../../../lib/journey-fonts";
import "../../journey.css";
import "../../journey-extra.css";

export const metadata: Metadata = { title: "Your ER visit · VeriCare" };

export default function PatientVisit() {
  return (
    <div className={journeyFonts}>
      <VisitPage />
    </div>
  );
}
