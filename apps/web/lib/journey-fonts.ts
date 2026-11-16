import { Figtree, Noto_Sans } from "next/font/google";

// Self-hosted at build time, so the pages make no font requests at runtime.
const display = Figtree({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const body = Noto_Sans({ subsets: ["latin"], variable: "--font-body", display: "swap" });

export const journeyFonts = `${display.variable} ${body.variable}`;
