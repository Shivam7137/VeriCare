import type { Metadata } from "next";
import { IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import PitchDeck from "../../components/pitch-deck";

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--pitch-sans",
});
const serif = Source_Serif_4({ subsets: ["latin"], variable: "--pitch-serif" });

export const metadata: Metadata = { title: "CareBridge · Pitch" };

export default function PitchPage() {
  return <PitchDeck fonts={`${sans.variable} ${serif.variable}`} />;
}
