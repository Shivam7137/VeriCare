import type { Metadata } from "next";
import DesktopOverview from "../../components/desktop-overview";
import "./desktop.css";
import "./panels.css";
import "./responsive.css";
import "./polish.css";
import "../phone.css";

export const metadata: Metadata = { title: "Desktop overview · VeriCare" };

export default function DesktopPage() {
  return <DesktopOverview />;
}
