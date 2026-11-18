import type { MetadataRoute } from "next";

// Lets a patient add VeriCare to their home screen: it opens straight to their
// visit, full screen, without the browser's address bar.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/patient/visit",
    name: "VeriCare",
    short_name: "VeriCare",
    description: "Your hospital visit: where you are, your time estimate, updates and help.",
    start_url: "/patient/visit",
    scope: "/patient/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f1f7f7",
    theme_color: "#ffffff",
    categories: ["health", "medical"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
