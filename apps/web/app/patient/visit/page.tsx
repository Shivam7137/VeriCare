import type { Metadata, Viewport } from "next";
import DemoBar from "../../../components/demo-bar";
import VisitPage from "../../../components/visit-page";
import { journeyFonts } from "../../../lib/journey-fonts";
import "../../journey.css";
import "../../journey-extra.css";
import "../../visit-app.css";

export const metadata: Metadata = {
  title: "Your visit · VeriCare",
  applicationName: "VeriCare",
  appleWebApp: { capable: true, title: "VeriCare", statusBarStyle: "default" },
  icons: { apple: "/apple-touch-icon.png" },
};

// Installed as an app, the page fills the screen; the top and tab bars pad for the notch.
export const viewport: Viewport = {
  themeColor: "#ffffff",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export default function PatientVisit() {
  return (
    <div className={journeyFonts}>
      <VisitPage />
      <DemoBar />
    </div>
  );
}
