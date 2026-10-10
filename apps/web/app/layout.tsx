import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Patient Request Coordination",
  description: "Synthetic prototype development workspace",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
