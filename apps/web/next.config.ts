import type { NextConfig } from "next";
// devIndicators: false hides the dev-only badge so demo captures stay clean; real errors still show.
const config: NextConfig = { transpilePackages: ["@prc/contracts"], devIndicators: false };
export default config;
