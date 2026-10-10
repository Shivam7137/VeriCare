import type { Metadata } from "next";
import CallMonitor from "../../../components/call-monitor";
export const metadata: Metadata = { title: "Call monitor · Health Coordinator" };
export default function MonitorPage() {
  return <CallMonitor />;
}
