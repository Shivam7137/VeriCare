import type { Metadata } from "next";
import "./globals.css";
import "./portals.css";
import "./workspace.css";

export const metadata: Metadata = {
  title: "careBridge",
  description:
    "Appointments, care-team requests, and phone assistance for a fictional outpatient clinic.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
