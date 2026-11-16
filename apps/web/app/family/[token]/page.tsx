import type { Metadata } from "next";
import FamilyPage from "../../../components/family-page";
import { journeyFonts } from "../../../lib/journey-fonts";
import "../../journey.css";
import "../../journey-extra.css";

// The link is private to one contact, so search engines and link previews are told to stay out.
export const metadata: Metadata = {
  title: "ER visit updates · VeriCare",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function Family({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className={journeyFonts}>
      <FamilyPage token={token} />
    </div>
  );
}
