import type { Metadata } from "next";
import DesktopOverview from "../../components/desktop-overview";
import "./desktop.css";
import "./panels.css";
import "./responsive.css";

export const metadata: Metadata = { title: "Desktop overview · Care coordination" };

export default function DesktopPage() {
  return <DesktopOverview />;
}
