import { dashboardSummary, listCoverage, listDashboardItems } from "@/lib/repository";
import { Dashboard } from "@/components/dashboard";

export const dynamic = "force-dynamic";

export default function Home() {
  const items = listDashboardItems();
  const summary = dashboardSummary();
  const coverage = listCoverage();
  return <Dashboard items={items} summary={summary} coverage={coverage} />;
}
