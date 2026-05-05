import {
  dashboardSummary,
  listCoverage,
  listDashboardItems,
  listOwnerOverrides,
  listOwnerSuggestions
} from "@/lib/repository";
import { Dashboard } from "@/components/dashboard";

export const dynamic = "force-dynamic";

export default function Home() {
  const items = listDashboardItems();
  const summary = dashboardSummary();
  const coverage = listCoverage();
  const ownerOverrides = listOwnerOverrides();
  const ownerSuggestions = listOwnerSuggestions();
  return (
    <Dashboard
      items={items}
      summary={summary}
      coverage={coverage}
      ownerOverrides={ownerOverrides}
      ownerSuggestions={ownerSuggestions}
    />
  );
}
