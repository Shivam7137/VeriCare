import type { Metadata } from "next";
import ForecastView from "../../../../components/vc/forecast-view";
import { loadModelCard } from "../../../../lib/model-card";

export const metadata: Metadata = { title: "Forecasts" };
export const dynamic = "force-dynamic";

export default async function Page() {
  return <ForecastView card={await loadModelCard()} />;
}
