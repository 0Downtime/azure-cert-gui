import { dashboardSummary, listDashboardItems } from "@/lib/repository";
import { Dashboard } from "@/components/dashboard";

export const dynamic = "force-dynamic";

export default function Home() {
  const items = listDashboardItems();
  const summary = dashboardSummary();
  return <Dashboard items={items} summary={summary} />;
}
