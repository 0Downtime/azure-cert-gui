"use client";

import azureCertLogoDark from "@/app/azure-cert-logo-dark.png";
import azureCertLogoLight from "@/app/azure-cert-logo-light.png";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  Download,
  Filter,
  KeyRound,
  Moon,
  PanelRightOpen,
  RefreshCw,
  Search,
  ShieldAlert,
  Sun,
  UserRound,
  X,
  XCircle
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import type {
  CoverageHealth,
  DashboardAuthState,
  DashboardCoverage,
  DashboardItem,
  DashboardOwnerOverride,
  DashboardOwnerSuggestion,
  DashboardSummary,
  InventorySource,
  OwnerMatchType,
  RefreshScheduleStatus,
  RefreshRunStatus,
  RenewalHandoffStatus,
  RenewalCaseStatus,
  RiskBucket,
  RotationMode,
  WorkflowStatus
} from "@/types";
import {
  closeRenewalCase,
  createRenewalCase,
  deleteOwnerOverride,
  executeRenewalRotation,
  markRenewalValidated,
  saveBulkOwnerOverride,
  saveOwnerOverride,
  updateCredentialStatus,
  updateRenewalCase
} from "@/app/actions";
import { isRenewalActionable } from "@/lib/rotation";

type WorkflowMode = "all" | "urgent" | "due60" | "unknown" | "contacted_pending";
type RotationScope = "actionable" | "all" | RotationMode;
type DashboardTab = "inventory" | "renewals" | "owners" | "coverage";
type SourceFilter = InventorySource | "all" | "key_vault";

const SOURCE_LABELS: Record<InventorySource, string> = {
  entra_application: "Entra app",
  service_principal: "Service principal",
  key_vault_secret: "Key Vault secret",
  key_vault_certificate: "Key Vault cert",
  key_vault_key: "Key Vault key"
};

const KEY_VAULT_SOURCES = new Set<InventorySource>(["key_vault_secret", "key_vault_certificate", "key_vault_key"]);

const STATUS_LABELS: Record<WorkflowStatus, string> = {
  not_started: "Not started",
  owner_contacted: "Owner contacted",
  rotation_scheduled: "Rotation scheduled",
  rotated: "Rotated",
  ignored: "Ignored"
};

const BUCKET_LABELS: Record<RiskBucket, string> = {
  expired: "Expired",
  "0-30": "0-30",
  "31-60": "31-60",
  "61-90": "61-90",
  "90+": "90+",
  "no-expiry": "No expiry"
};

const HEALTH_LABELS: Record<CoverageHealth, string> = {
  ok: "Healthy",
  warning: "Skipped items",
  failed: "Failed",
  stale: "Stale"
};

const MATCH_LABELS: Record<OwnerMatchType, string> = {
  credential_id: "Credential ID",
  parent_id: "App / principal ID",
  parent_name: "App / vault name",
  vault_name: "Vault name"
};

const QUEUE_LABELS: Record<WorkflowMode, string> = {
  all: "All work",
  urgent: "Expired / 30",
  due60: "Due in 60",
  unknown: "Needs owner",
  contacted_pending: "Contacted"
};

const ROTATION_LABELS: Record<RotationMode, string> = {
  owner_rotates: "Owner rotates",
  platform_managed: "Platform managed",
  rotate_in_source_system: "Source system",
  coordinated_high_risk: "Coordinated",
  federated_no_secret: "Federated"
};

const RENEWAL_CASE_LABELS: Record<RenewalCaseStatus, string> = {
  open: "Open",
  rotation_created: "Pending validation",
  validated: "Validated",
  closed: "Closed",
  blocked: "Blocked"
};

const HANDOFF_LABELS: Record<RenewalHandoffStatus, string> = {
  not_contacted: "Not contacted",
  contacted: "Contacted",
  waiting_on_owner: "Waiting on owner",
  escalated: "Escalated",
  ready_to_validate: "Ready to validate"
};

const TAB_LABELS: Record<DashboardTab, string> = {
  inventory: "Inventory",
  renewals: "Renewals",
  owners: "Owners",
  coverage: "Coverage & Audit"
};

const REFRESH_INTERVAL_OPTIONS = [
  { value: "5", label: "5m" },
  { value: "15", label: "15m" },
  { value: "30", label: "30m" },
  { value: "60", label: "1h" },
  { value: "120", label: "2h" },
  { value: "240", label: "4h" },
  { value: "720", label: "12h" },
  { value: "1440", label: "24h" }
];

function authDisplayName(auth: DashboardAuthState): string {
  const displayName = auth.displayName?.trim();
  if (displayName) return displayName;
  return auth.username || "Signed-in user";
}

export function Dashboard({
  items,
  summary,
  coverage,
  ownerOverrides,
  ownerSuggestions,
  auth
}: {
  items: DashboardItem[];
  summary: DashboardSummary;
  coverage: DashboardCoverage[];
  ownerOverrides: DashboardOwnerOverride[];
  ownerSuggestions: DashboardOwnerSuggestion[];
  auth: DashboardAuthState;
}) {
  const dashboardRouter = useRouter();
  const signedInName = authDisplayName(auth);
  const authTitle =
    auth.username && auth.username !== signedInName ? `${signedInName} (${auth.username})` : signedInName;
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [bucket, setBucket] = useState<RiskBucket | "all">("all");
  const [status, setStatus] = useState<WorkflowStatus | "all">("all");
  const [ownerMode, setOwnerMode] = useState<"all" | "unknown" | "low">("all");
  const [rotationScope, setRotationScope] = useState<RotationScope>("actionable");
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>(() => (summary.unknownOwners > 0 ? "unknown" : "all"));
  const [activeTab, setActiveTab] = useState<DashboardTab>("inventory");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectedDetailId, setSelectedDetailId] = useState<number | null>(null);
  const [copyPanel, setCopyPanel] = useState<{ title: string; text: string; copied: boolean } | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<RefreshRunStatus | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [scheduleStatus, setScheduleStatus] = useState<RefreshScheduleStatus | null>(null);
  const [scheduleInterval, setScheduleInterval] = useState("60");
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const refreshStatusRef = useRef<string | null>(null);
  const refreshStartedFromUi = useRef(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const stored = window.localStorage.getItem("azure-cert-gui-theme");
    if (stored === "dark" || stored === "light") {
      setTheme(stored);
      document.documentElement.dataset.theme = stored;
    }
  }, []);

  useEffect(() => {
    void loadRefreshStatus(false);
    void loadScheduleStatus(true);
  }, []);

  useEffect(() => {
    if (refreshStatus?.status !== "running") return;
    const timer = window.setInterval(() => {
      void loadRefreshStatus(true);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [refreshStatus?.status]);

  useEffect(() => {
    if (!scheduleStatus?.enabled) return;
    const timer = window.setInterval(() => {
      void loadScheduleStatus(false);
      void loadRefreshStatus(true);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [scheduleStatus?.enabled]);

  function toggleTheme() {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      window.localStorage.setItem("azure-cert-gui-theme", next);
      return next;
    });
  }

  async function loadRefreshStatus(refreshWhenFinished: boolean) {
    try {
      const response = await fetch("/api/refresh", { cache: "no-store" });
      if (!response.ok) throw new Error(`Refresh status failed with HTTP ${response.status}`);
      const next = (await response.json()) as RefreshRunStatus;
      applyRefreshStatus(next, refreshWhenFinished);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadScheduleStatus(syncInput: boolean) {
    try {
      const response = await fetch("/api/refresh/schedule", { cache: "no-store" });
      if (!response.ok) throw new Error(`Schedule status failed with HTTP ${response.status}`);
      const next = (await response.json()) as RefreshScheduleStatus;
      setScheduleStatus(next);
      if (syncInput) setScheduleInterval(String(next.intervalMinutes));
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error));
    }
  }

  function applyRefreshStatus(next: RefreshRunStatus, refreshWhenFinished: boolean) {
    const previousStatus = refreshStatusRef.current;
    refreshStatusRef.current = next.status;
    setRefreshStatus(next);
    if (refreshWhenFinished && refreshStartedFromUi.current && previousStatus === "running" && next.status !== "running") {
      refreshStartedFromUi.current = false;
      dashboardRouter.refresh();
    }
  }

  async function startDataRefresh() {
    if (!auth.canOperate) {
      setRefreshError("Operator access is required to refresh Azure metadata.");
      return;
    }
    setRefreshError(null);
    refreshStartedFromUi.current = true;
    try {
      const response = await fetch("/api/refresh", { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error(`Refresh start failed with HTTP ${response.status}`);
      const next = (await response.json()) as RefreshRunStatus;
      applyRefreshStatus(next, false);
    } catch (error) {
      refreshStartedFromUi.current = false;
      setRefreshError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveRefreshSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.canOperate) {
      setScheduleError("Operator access is required to change the refresh schedule.");
      return;
    }
    setScheduleError(null);
    const form = new FormData(event.currentTarget);
    const intervalMinutes = Number.parseInt(String(form.get("intervalMinutes") ?? ""), 10);
    try {
      const response = await fetch("/api/refresh/schedule", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, intervalMinutes })
      });
      if (!response.ok) throw new Error(`Schedule update failed with HTTP ${response.status}`);
      const next = (await response.json()) as RefreshScheduleStatus;
      setScheduleStatus(next);
      setScheduleInterval(String(next.intervalMinutes));
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error));
    }
  }

  async function stopRefreshSchedule() {
    if (!auth.canOperate) {
      setScheduleError("Operator access is required to change the refresh schedule.");
      return;
    }
    setScheduleError(null);
    try {
      const response = await fetch("/api/refresh/schedule", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false, intervalMinutes: scheduleInterval })
      });
      if (!response.ok) throw new Error(`Schedule update failed with HTTP ${response.status}`);
      const next = (await response.json()) as RefreshScheduleStatus;
      setScheduleStatus(next);
      setScheduleInterval(String(next.intervalMinutes));
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error));
    }
  }

  function showAllSyncedItems(nextSource: SourceFilter = "all") {
    setQuery("");
    setSource(nextSource);
    setBucket("all");
    setStatus("all");
    setOwnerMode("all");
    setRotationScope("all");
    setWorkflowMode("all");
    setSelectedIds([]);
    setSelectedDetailId(null);
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (!matchesSourceFilter(item, source)) return false;
      if (bucket !== "all" && item.riskBucket !== bucket) return false;
      if (status !== "all" && item.status !== status) return false;
      if (!matchesRotationScope(item, rotationScope)) return false;
      if (ownerMode === "unknown" && item.ownerName) return false;
      if (ownerMode === "low" && item.ownerConfidence !== "low" && item.ownerConfidence !== "unknown") {
        return false;
      }
      if (!matchesWorkflowMode(item, workflowMode)) return false;
      if (!needle) return true;
      return [item.parentName, item.credentialName, item.ownerName, item.ownerEmail, item.naturalKey]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [bucket, items, ownerMode, query, rotationScope, source, status, workflowMode]);

  const queueCounts = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(QUEUE_LABELS) as WorkflowMode[]).map((mode) => [
          mode,
          items.filter((item) => isRenewalActionable(item.rotationMode) && matchesWorkflowMode(item, mode)).length
        ])
      ) as Record<WorkflowMode, number>,
    [items]
  );
  const broadInventoryFiltersActive =
    bucket === "all" &&
    status === "all" &&
    ownerMode === "all" &&
    rotationScope === "all" &&
    workflowMode === "all" &&
    query.trim() === "";
  const allSyncedViewActive = broadInventoryFiltersActive && source === "all";
  const vaultItemsViewActive = broadInventoryFiltersActive && source === "key_vault";
  const vaultItemCount = useMemo(() => items.filter((item) => KEY_VAULT_SOURCES.has(item.source)).length, [items]);

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.includes(item.id)),
    [items, selectedIds]
  );
  const renewalBaseItems = selectedItems.length ? selectedItems : filtered;
  const actionableRenewalItems = renewalBaseItems.filter((item) => isRenewalActionable(item.rotationMode));
  const excludedRenewalItems = renewalBaseItems.length - actionableRenewalItems.length;
  const selectedDetail = useMemo(
    () => items.find((item) => item.id === selectedDetailId) ?? null,
    [items, selectedDetailId]
  );
  const renewalWorkItems = useMemo(
    () =>
      items.filter(
        (item) =>
          Boolean(item.renewalCase) ||
          (isRenewalActionable(item.rotationMode) &&
            (item.riskBucket === "expired" ||
              item.riskBucket === "0-30" ||
              item.riskBucket === "31-60" ||
              item.riskBucket === "61-90"))
      ),
    [items]
  );
  const ownerGapItems = useMemo(() => items.filter((item) => !item.ownerName), [items]);
  const detailCoverage = useMemo(
    () => (selectedDetail ? coverage.filter((row) => coverageMatchesItem(row, selectedDetail)) : []),
    [coverage, selectedDetail]
  );
  const refreshIntervalOptions = useMemo(
    () =>
      REFRESH_INTERVAL_OPTIONS.some((option) => option.value === scheduleInterval)
        ? REFRESH_INTERVAL_OPTIONS
        : [{ value: scheduleInterval, label: `${scheduleInterval}m` }, ...REFRESH_INTERVAL_OPTIONS],
    [scheduleInterval]
  );

  function toggleSelection(id: number) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((selected) => selected !== id) : [...current, id]
    );
  }

  async function copyText(title: string, text: string) {
    setExportMenuOpen(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopyPanel({ title, text, copied: true });
    } catch {
      setCopyPanel({ title, text, copied: false });
    }
  }

  function copyOwnerSummary() {
    const groups = new Map<string, DashboardItem[]>();
    for (const item of actionableRenewalItems) {
      const key = item.ownerName ? `${item.ownerName}${item.ownerEmail ? ` <${item.ownerEmail}>` : ""}` : "Unknown owner";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const text = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([owner, ownerItems]) => {
        const rows = ownerItems
          .map((item) => `- ${item.parentName}: ${item.credentialName} expires ${formatDate(item.expiresAt)} (${item.riskBucket})`)
          .join("\n");
        return `${owner}\n${rows}`;
      })
      .join("\n\n");
    void copyText("Owner grouped renewal worklist", withExclusionNote(text, excludedRenewalItems));
  }

  function copyOwnerMappings() {
    const text = [
      "match_type\tmatch_value\towner_name\towner_email\tactive_credentials\tnotes\tupdated_at",
      ...ownerOverrides.map((override) =>
        [
          MATCH_LABELS[override.matchType],
          override.matchValue,
          override.ownerName,
          override.ownerEmail ?? "",
          override.activeCredentialCount,
          override.notes ?? "",
          override.updatedAt
        ].join("\t")
      )
    ].join("\n");
    void copyText("Owner mapping directory", text);
  }

  function copyInventoryExport() {
    const rows = selectedItems.length ? selectedItems : filtered;
    const text = [
      "source\tparent_name\tcredential_name\tcredential_type\texpires_at\tdays_until_expiry\trisk\trotation_mode\trotation_reason\towner_name\towner_email\towner_confidence\tstatus\ttenant_id\tsubscription_id\tresource_group\tparent_id\tcredential_id\tnatural_key\tlast_seen_at",
      ...rows.map((item) =>
        [
          SOURCE_LABELS[item.source],
          item.parentName,
          item.credentialName,
          item.credentialType,
          item.expiresAt ?? "",
          item.daysUntilExpiry ?? "",
          item.riskBucket,
          ROTATION_LABELS[item.rotationMode],
          item.rotationModeReason,
          item.ownerName ?? "",
          item.ownerEmail ?? "",
          item.ownerConfidence,
          STATUS_LABELS[item.status],
          item.sourceTenantId ?? "",
          item.subscriptionId ?? "",
          item.resourceGroup ?? "",
          item.parentId,
          item.credentialId,
          item.naturalKey,
          item.lastSeenAt
        ].join("\t")
      )
    ].join("\n");
    void copyText("Inventory export", text);
  }

  function copyStatusAudit() {
    const rows = items.flatMap((item) =>
      item.statusHistory.map((history) => ({
        item,
        history
      }))
    );
    const text = [
      "changed_at\tchanged_by\tfrom_status\tto_status\tnote\tsource\tparent_name\tcredential_name\tcredential_id",
      ...rows.map(({ item, history }) =>
        [
          history.changedAt,
          history.changedBy,
          history.fromStatus ? STATUS_LABELS[history.fromStatus] : "",
          STATUS_LABELS[history.toStatus],
          history.note ?? "",
          SOURCE_LABELS[item.source],
          item.parentName,
          item.credentialName,
          item.credentialId
        ].join("\t")
      )
    ].join("\n");
    void copyText("Status audit export", text);
  }

  function copyCoverageExport() {
    void copyText("Coverage export", JSON.stringify(coverage, null, 2));
  }

  function copyRenewalRequest() {
    const text = actionableRenewalItems
      .map((item) =>
        [
          `Owner: ${item.ownerName ?? "Unassigned"}${item.ownerEmail ? ` <${item.ownerEmail}>` : ""}`,
          `Application/resource: ${item.parentName}`,
          `Credential: ${item.credentialName} (${item.credentialType})`,
          `Source: ${SOURCE_LABELS[item.source]}`,
          `Expiration: ${formatDate(item.expiresAt)}${
            item.daysUntilExpiry === null ? "" : ` (${item.daysUntilExpiry} days)`
          }`,
          `Current status: ${STATUS_LABELS[item.status]}`,
          "",
          "Requested action: rotate or replace this credential before the expiration date, then reply with the completion date and the new rotation owner.",
          "If this credential is no longer needed, confirm it can be removed or marked ignored.",
          ""
        ].join("\n")
      )
      .join("\n---\n\n");
    void copyText("Renewal request draft", withExclusionNote(text, excludedRenewalItems));
  }

  function copyOwnerPackets() {
    const groups = new Map<string, DashboardItem[]>();
    for (const item of actionableRenewalItems) {
      const key = item.ownerName ? `${item.ownerName}${item.ownerEmail ? ` <${item.ownerEmail}>` : ""}` : "Unassigned owner";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }

    const text = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([owner, ownerItems]) => renewalPacket(owner, ownerItems))
      .join("\n\n---\n\n");
    void copyText("Owner renewal packets", withExclusionNote(text, excludedRenewalItems));
  }

  function copyUnknownOwners(rows = filtered.filter((item) => !item.ownerName)) {
    const text = [
      "source\tapp_or_vault\tcredential\texpires\trisk\tparent_id",
      ...rows.map((item) =>
        [
          SOURCE_LABELS[item.source],
          item.parentName,
          item.credentialName,
          formatDate(item.expiresAt),
          item.riskBucket,
          item.parentId
        ].join("\t")
      )
    ].join("\n");
    void copyText("Unknown owner worklist", text);
  }

  function bulkUpdate(statusValue: WorkflowStatus) {
    if (!auth.canOperate) return;
    startTransition(() => {
      for (const id of selectedIds) {
        const form = new FormData();
        form.set("id", String(id));
        form.set("status", statusValue);
        void updateCredentialStatus(form);
      }
      setSelectedIds([]);
    });
  }

  function credentialTable(rows: DashboardItem[], label: string) {
    return (
      <section className="table-wrap inventory-table" aria-label={label}>
        {items.length === 0 ? (
          <EmptyState />
        ) : rows.length === 0 ? (
          <div className="empty compact">
            <Database size={24} />
            <h2>No matching credentials</h2>
            <p>Adjust the queue or filter controls to show more rows.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th aria-label="Select rows" />
                <th>Risk</th>
                <th>Source</th>
                <th>App / vault</th>
                <th>Credential</th>
                <th>Rotation</th>
                <th>Expires</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Updated</th>
                <th aria-label="Credential details" />
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id} className={`${item.removedAt ? "removed" : ""} ${selectedDetailId === item.id ? "selected-row" : ""}`}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(item.id)}
                      onChange={() => toggleSelection(item.id)}
                      aria-label={`Select ${item.credentialName}`}
                    />
                  </td>
                  <td>
                    <RiskBadge item={item} />
                  </td>
                  <td title={SOURCE_LABELS[item.source]}>{SOURCE_LABELS[item.source]}</td>
                  <td title={`${item.parentName}\n${item.naturalKey}`}>
                    <strong>{item.parentName}</strong>
                  </td>
                  <td title={`${item.credentialName}\n${item.credentialType}\n${item.credentialId}`}>
                    <span className="credential">
                      <KeyRound size={15} />
                      {item.credentialName}
                    </span>
                  </td>
                  <td>
                    <RotationBadge item={item} />
                  </td>
                  <td>
                    <strong>{formatDate(item.expiresAt)}</strong>
                    <DaysOut days={item.daysUntilExpiry} />
                  </td>
                  <td>
                    <OwnerSummary item={item} />
                  </td>
                  <td>
                    <StatusSummary item={item} />
                  </td>
                  <td title={item.removedAt ? `Removed from source ${formatDateTime(item.removedAt)}` : formatDate(item.lastSeenAt)}>
                    <span>{formatDate(item.lastSeenAt)}</span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => setSelectedDetailId(item.id)}
                      aria-label={`Open details for ${item.credentialName}`}
                      title="Open details"
                    >
                      <PanelRightOpen size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    );
  }

  function renewalTable(rows: DashboardItem[]) {
    return (
      <section className="table-wrap renewal-table" aria-label="Renewal credential queue">
        {items.length === 0 ? (
          <EmptyState />
        ) : rows.length === 0 ? (
          <div className="empty compact">
            <Clock size={24} />
            <h2>No renewal work</h2>
            <p>Active cases and near-term actionable expirations will appear here.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Credential</th>
                <th>Owner / handoff</th>
                <th>Due</th>
                <th>Expiration</th>
                <th>Replacement</th>
                <th>Last event</th>
                <th aria-label="Renewal details" />
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const renewalCase = item.renewalCase;
                const lastEvent = renewalCase?.events[0] ?? null;
                const ownerName = renewalCase?.ownerName ?? item.ownerName;
                const ownerEmail = renewalCase?.ownerEmail ?? item.ownerEmail;
                return (
                  <tr key={item.id} className={selectedDetailId === item.id ? "selected-row" : ""}>
                    <td>
                      <span className={`renewal-case-chip ${renewalCase?.status ?? "none"}`}>
                        {renewalCase ? RENEWAL_CASE_LABELS[renewalCase.status] : "Needs case"}
                      </span>
                      <span className="muted">{renewalCase ? `Case #${renewalCase.id}` : "Open detail drawer"}</span>
                    </td>
                    <td>
                      <strong>{item.parentName}</strong>
                      <span className="credential">
                        <KeyRound size={15} />
                        {item.credentialName}
                      </span>
                      <span className="muted">
                        {SOURCE_LABELS[item.source]} / {item.credentialType}
                      </span>
                    </td>
                    <td>
                      <strong>{ownerName ?? "Unassigned"}</strong>
                      <span className="muted">{ownerEmail ?? "No email"}</span>
                      <span className="muted">
                        {renewalCase ? HANDOFF_LABELS[renewalCase.handoffStatus] : "No handoff started"}
                      </span>
                    </td>
                    <td>
                      <strong>{renewalCase?.dueAt ? formatDate(renewalCase.dueAt) : formatDate(item.expiresAt)}</strong>
                      <span className="muted">
                        {renewalCase?.reminderAt ? `Reminder ${formatDate(renewalCase.reminderAt)}` : "No reminder set"}
                      </span>
                    </td>
                    <td>
                      <RiskBadge item={item} />
                      <span className="muted">{formatDate(item.expiresAt)}</span>
                      <DaysOut days={item.daysUntilExpiry} />
                    </td>
                    <td>
                      <strong>{renewalCase?.replacementCredentialId ?? "Not created"}</strong>
                      <span className="muted">{formatDate(renewalCase?.replacementExpiresAt ?? null)}</span>
                    </td>
                    <td>
                      <strong>{lastEvent ? lastEvent.eventType.replaceAll("_", " ") : "No case event"}</strong>
                      <span className="muted">
                        {lastEvent ? `${lastEvent.createdBy} ${formatDateTime(lastEvent.createdAt)}` : "Open case to start audit history"}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => setSelectedDetailId(item.id)}
                        aria-label={`${renewalCase ? "Review renewal case" : "Open renewal case"} for ${item.credentialName}`}
                        title={renewalCase ? "Review renewal case" : "Open renewal case"}
                      >
                        <PanelRightOpen size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-lockup">
          <AzureCertLogo />
          <div>
            <p className="eyebrow">Azure / Entra Inventory</p>
            <h1>Azure Cert GUI</h1>
            <span>Credential Expiration Dashboard</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="refresh-button"
            onClick={startDataRefresh}
            disabled={refreshStatus?.status === "running" || !auth.canOperate}
            aria-disabled={!auth.canOperate}
            aria-label={refreshStatus?.status === "running" ? "Refreshing" : "Refresh data"}
            aria-live="polite"
            title={auth.canOperate ? "Refresh data" : "Operator access required"}
          >
            <RefreshCw size={16} className={refreshStatus?.status === "running" ? "spin" : ""} />
            <span className="refresh-label-full" aria-hidden="true">
              {refreshStatus?.status === "running" ? "Refreshing" : "Refresh data"}
            </span>
            <span className="refresh-label-short" aria-hidden="true">
              {refreshStatus?.status === "running" ? "Refreshing" : "Refresh"}
            </span>
          </button>
          <form className="scheduler-form" onSubmit={saveRefreshSchedule}>
            <label>
              <Clock size={14} aria-hidden="true" />
              <select
                name="intervalMinutes"
                value={scheduleInterval}
                onChange={(event) => setScheduleInterval(event.currentTarget.value)}
                disabled={!auth.canOperate}
                aria-label="Automatic refresh interval"
              >
                {refreshIntervalOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={!auth.canOperate}
              title={scheduleStatus?.enabled ? "Update automatic refresh" : "Enable automatic refresh"}
            >
              <RefreshCw size={14} aria-hidden="true" />
              <span>{scheduleStatus?.enabled ? "Update" : "Auto"}</span>
            </button>
            <button
              type="button"
              className="icon-button scheduler-stop"
              onClick={stopRefreshSchedule}
              disabled={!auth.canOperate || !scheduleStatus?.enabled}
              aria-label="Stop automatic refresh"
              title="Stop automatic refresh"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </form>
          <button type="button" className="theme-toggle" onClick={toggleTheme} aria-pressed={theme === "dark"}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            <span>{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
          <div className="auth-pill" title={authTitle}>
            <UserRound size={16} />
            <span className="auth-name">{signedInName}</span>
            <span className="auth-role">{auth.accessLevel}</span>
            {auth.source === "oidc" ? <a href={auth.signOutPath}>Sign out</a> : null}
          </div>
        </div>
      </header>

      <section className="operations-strip" aria-label="Refresh operations">
        <div className={`sync-pill ${refreshStatus?.status === "running" ? "running" : refreshStatus?.status ?? ""}`}>
          {refreshStatus?.status === "running" ? (
            <span className="sync-loader" aria-hidden="true" />
          ) : (
            <RefreshCw size={16} />
          )}
          <span>
            {refreshStatus?.status === "running"
              ? `Refreshing ${refreshStatus.progress}%`
              : `Last sync ${summary.lastSuccessfulSyncAt ? formatDateTime(summary.lastSuccessfulSyncAt) : "never"}`}
          </span>
        </div>
        <span className={`scheduler-state ${scheduleStatus?.enabled ? "enabled" : ""}`}>
          {scheduleStatus?.enabled && scheduleStatus.nextRunAt
            ? `Auto ${scheduleStatus.intervalMinutes}m / next ${formatDateTime(scheduleStatus.nextRunAt)}`
            : "Auto refresh off"}
        </span>
      </section>

      {refreshStatus && refreshStatus.status !== "idle" ? (
        <details className={`refresh-panel ${refreshStatus.status}`} aria-live="polite">
          <summary>
            <span>{refreshStatus.message}</span>
            <strong>{refreshStatus.progress}%</strong>
          </summary>
          <div className="refresh-panel-body">
            <span>
              {refreshStatus.status === "running"
                ? `Started ${formatDateTime(refreshStatus.startedAt ?? new Date().toISOString())}`
                : `Finished ${formatDateTime(refreshStatus.finishedAt ?? new Date().toISOString())}`}
            </span>
            <div className="refresh-progress" aria-hidden="true">
              <span style={{ width: `${Math.max(5, refreshStatus.progress)}%` }} />
            </div>
            {refreshStatus.status !== "running" ? (
              <span className="refresh-complete">
                {refreshStatus.status === "succeeded"
                  ? "Done refreshing. Dashboard data has been reloaded."
                  : "Refresh did not complete. Check the latest sync output below."}
              </span>
            ) : null}
            {refreshStatus.logs.length ? (
              <ol className="refresh-log">
                {refreshStatus.logs.slice(-5).map((line, index) => (
                  <li key={`${refreshStatus.runId ?? "refresh"}-${index}-${line}`}>{line}</li>
                ))}
              </ol>
            ) : null}
          </div>
        </details>
      ) : null}

      {refreshError ? (
        <section className="refresh-panel failed" aria-live="polite" aria-label="Data refresh error">
          <strong>Refresh status unavailable</strong>
          <span>{refreshError}</span>
        </section>
      ) : null}

      {(scheduleStatus?.lastRunAt || scheduleError) ? (
        <section className={`scheduler-note ${scheduleError ? "failed" : ""}`} aria-live="polite">
          <span>
            {scheduleError
              ? scheduleError
              : scheduleStatus?.lastRunAt
                ? `Last scheduled run ${formatDateTime(scheduleStatus.lastRunAt)}`
                : ""}
          </span>
        </section>
      ) : null}

      <section className="metrics" aria-label="Inventory summary">
        <Metric label="Total" value={summary.total} icon={<Database size={18} />} />
        <Metric label="Expired" value={summary.expired} tone="danger" icon={<XCircle size={18} />} />
        <Metric label="0-30 days" value={summary.next30} tone="warning" icon={<Clock size={18} />} />
        <Metric label="31-60 days" value={summary.next60} icon={<Clock size={18} />} />
        <Metric label="61-90 days" value={summary.next90} icon={<Clock size={18} />} />
        <Metric label="Unknown owners" value={summary.unknownOwners} tone="warning" icon={<UserRound size={18} />} />
        <Metric label="Excluded" value={summary.excludedFromRenewal} icon={<Ban size={18} />} />
        <Metric label="Coverage gaps" value={summary.coverageGaps} tone="danger" icon={<ShieldAlert size={18} />} />
      </section>

      <nav className="tabs" role="tablist" aria-label="Dashboard views">
        {(Object.keys(TAB_LABELS) as DashboardTab[]).map((tab) => (
          <button
            key={tab}
            id={`tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`panel-${tab}`}
            className={activeTab === tab ? "active" : ""}
            onClick={() => {
              if (activeTab !== tab) {
                setSelectedDetailId(null);
              }
              setExportMenuOpen(false);
              setActiveTab(tab);
            }}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </nav>

      <section
        id="panel-inventory"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="tab-inventory"
        hidden={activeTab !== "inventory"}
      >
        <section className="queuebar" aria-label="Quick queues">
          <button
            type="button"
            className={allSyncedViewActive ? "active" : ""}
            onClick={() => showAllSyncedItems("all")}
          >
            <span>All synced</span>
            <strong>{items.length}</strong>
          </button>
          <button
            type="button"
            className={vaultItemsViewActive ? "active" : ""}
            onClick={() => showAllSyncedItems("key_vault")}
          >
            <span>Vault items</span>
            <strong>{vaultItemCount}</strong>
          </button>
          {(Object.keys(QUEUE_LABELS) as WorkflowMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={workflowMode === mode && !(mode === "all" && broadInventoryFiltersActive) ? "active" : ""}
              onClick={() => setWorkflowMode(mode)}
            >
              <span>{QUEUE_LABELS[mode]}</span>
              <strong>{queueCounts[mode]}</strong>
            </button>
          ))}
        </section>

        <section className="toolbar" aria-label="Filters">
          <label className="search">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search app, vault, owner, credential" />
          </label>
          <Select label="Source" value={source} onChange={(value) => setSource(value as SourceFilter)}>
            <option value="all">All sources</option>
            <option value="key_vault">Key Vault certs, secrets, keys</option>
            {Object.entries(SOURCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Select label="Risk" value={bucket} onChange={(value) => setBucket(value as RiskBucket | "all")}>
            <option value="all">All risk</option>
            {Object.entries(BUCKET_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Select label="Status" value={status} onChange={(value) => setStatus(value as WorkflowStatus | "all")}>
            <option value="all">All status</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Select label="Owner" value={ownerMode} onChange={(value) => setOwnerMode(value as "all" | "unknown" | "low")}>
            <option value="all">All owners</option>
            <option value="unknown">Unknown only</option>
            <option value="low">Low confidence</option>
          </Select>
          <Select label="Rotation" value={rotationScope} onChange={(value) => setRotationScope(value as RotationScope)}>
            <option value="actionable">Actionable only</option>
            <option value="all">All rotation modes</option>
            {Object.entries(ROTATION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </section>

        <section className="actionbar" aria-label="Bulk actions">
          <div>
            <Filter size={16} />
            <span>{filtered.length} visible</span>
            <span>{selectedIds.length} selected</span>
            {excludedRenewalItems ? <span>{excludedRenewalItems} excluded from renewal exports</span> : null}
          </div>
          {selectedIds.length ? (
            <div className="selection-actions">
              <form action={saveBulkOwnerOverride} className="owner-bulk-form">
                {selectedItems.map((item) => (
                  <input key={item.id} type="hidden" name="parentId" value={item.parentId} />
                ))}
                <OwnerAutocompleteInputs
                  suggestions={ownerSuggestions}
                  ownerPlaceholder="Owner for selected"
                  ownerAriaLabel="Owner for selected"
                />
                <button type="submit" disabled={isPending}>
                  Assign owner
                </button>
              </form>
              <div className="action-buttons">
                <button type="button" onClick={() => bulkUpdate("owner_contacted")} disabled={isPending}>
                  Owner contacted
                </button>
                <button type="button" onClick={() => bulkUpdate("rotation_scheduled")} disabled={isPending}>
                  Rotation scheduled
                </button>
              </div>
            </div>
          ) : (
            <span className="selection-hint">Select rows to assign owners or update status.</span>
          )}
          <div className="export-menu">
            <button type="button" onClick={() => setExportMenuOpen((current) => !current)} aria-expanded={exportMenuOpen}>
              <Download size={15} />
              Copy / export
            </button>
            {exportMenuOpen ? (
              <div className="export-menu-panel" role="menu">
                <button type="button" role="menuitem" onClick={() => copyUnknownOwners()}>
                  Copy unknowns
                </button>
                <button type="button" role="menuitem" onClick={copyRenewalRequest} disabled={!actionableRenewalItems.length}>
                  Copy renewal request
                </button>
                <button type="button" role="menuitem" onClick={copyOwnerPackets} disabled={!actionableRenewalItems.length}>
                  Copy owner packets
                </button>
                <button type="button" role="menuitem" onClick={copyOwnerSummary} disabled={!actionableRenewalItems.length}>
                  Copy by owner
                </button>
              </div>
            ) : null}
          </div>
        </section>

        {credentialTable(filtered, "Credential inventory")}
      </section>

      <section
        id="panel-renewals"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="tab-renewals"
        hidden={activeTab !== "renewals"}
      >
        <section className="section-heading tab-heading" aria-label="Renewal queue summary">
          <div>
            <h2>Renewal queue</h2>
            <span>Active cases and actionable credentials due within 90 days</span>
          </div>
          <div className="tab-counts">
            <strong>{renewalWorkItems.length}</strong>
            <span>items</span>
          </div>
        </section>
        {renewalTable(renewalWorkItems)}
      </section>

      <section
        id="panel-owners"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="tab-owners"
        hidden={activeTab !== "owners"}
      >
        <section className="actionbar" aria-label="Owner gaps">
          <div>
            <UserRound size={16} />
            <span>{ownerGapItems.length} credentials need owner mapping</span>
          </div>
          <button type="button" onClick={() => copyUnknownOwners(ownerGapItems)} disabled={!ownerGapItems.length}>
            <Download size={15} />
            Copy owner gaps
          </button>
        </section>
        <OwnerGapList items={ownerGapItems} onOpen={(id) => setSelectedDetailId(id)} />
        <OwnerDirectory ownerOverrides={ownerOverrides} ownerSuggestions={ownerSuggestions} onCopy={copyOwnerMappings} />
      </section>

      <section
        id="panel-coverage"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="tab-coverage"
        hidden={activeTab !== "coverage"}
      >
        <CoveragePanel coverage={coverage} />
        <section className="exportbar" aria-label="Audit exports">
          <span>Audit exports</span>
          <button type="button" onClick={copyInventoryExport} disabled={!filtered.length}>
            <Download size={15} />
            Copy inventory TSV
          </button>
          <button type="button" onClick={copyStatusAudit} disabled={!items.some((item) => item.statusHistory.length)}>
            <Download size={15} />
            Copy status audit
          </button>
          <button type="button" onClick={copyCoverageExport} disabled={!coverage.length}>
            <Download size={15} />
            Copy coverage JSON
          </button>
          <button type="button" onClick={copyOwnerMappings} disabled={!ownerOverrides.length}>
            <Download size={15} />
            Copy owner mappings
          </button>
        </section>
      </section>

      {copyPanel ? (
        <section className="copy-panel" aria-label="Copy output">
          <div>
            <strong>{copyPanel.title}</strong>
            <span>{copyPanel.copied ? "Copied to clipboard" : "Clipboard blocked; select and copy from here"}</span>
          </div>
          <textarea readOnly value={copyPanel.text} aria-label={copyPanel.title} />
          <button type="button" onClick={() => setCopyPanel(null)}>
            Close
          </button>
        </section>
      ) : null}

      {selectedDetail && (activeTab === "inventory" || activeTab === "renewals" || activeTab === "owners") ? (
        <CredentialDetailDrawer
          item={selectedDetail}
          coverage={detailCoverage}
          ownerSuggestions={ownerSuggestions}
          canOperate={auth.canOperate}
          onClose={() => setSelectedDetailId(null)}
          onCopy={copyText}
        />
      ) : null}
    </main>
  );
}

function AzureCertLogo() {
  return (
    <div className="azure-cert-logo" aria-hidden="true">
      <img className="logo-light" src={azureCertLogoLight.src} alt="" width={72} height={72} decoding="async" />
      <img className="logo-dark" src={azureCertLogoDark.src} alt="" width={72} height={72} decoding="async" />
    </div>
  );
}

function CredentialDetailDrawer({
  item,
  coverage,
  ownerSuggestions,
  canOperate,
  onClose,
  onCopy
}: {
  item: DashboardItem;
  coverage: DashboardCoverage[];
  ownerSuggestions: DashboardOwnerSuggestion[];
  canOperate: boolean;
  onClose: () => void;
  onCopy: (title: string, text: string) => Promise<void>;
}) {
  const router = useRouter();
  const metadata = Object.entries(item.metadata);
  const inAppRotationSupported = supportsInAppRotation(item);
  const checklist = item.renewalCase ? renewalChecklist(item) : [];
  const [rotationResult, setRotationResult] = useState<{
    ok: boolean;
    message: string;
    oneTimeSecretValue: string | null;
    dryRun: boolean;
  } | null>(null);
  const [pendingRotation, setPendingRotation] = useState<FormData | null>(null);
  const [oneTimeSecret, setOneTimeSecret] = useState<{ message: string; value: string } | null>(null);
  const [isRotating, startRotation] = useTransition();

  function prepareRotation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canOperate) {
      setRotationResult({
        ok: false,
        message: "Operator access is required to run renewal rotations.",
        oneTimeSecretValue: null,
        dryRun: false
      });
      return;
    }
    setRotationResult(null);
    setPendingRotation(new FormData(event.currentTarget));
  }

  function runRotation(formData: FormData) {
    setRotationResult(null);
    setPendingRotation(null);
    startRotation(async () => {
      const result = await executeRenewalRotation(formData);
      const sanitized = { ...result, oneTimeSecretValue: null };
      setRotationResult(sanitized);
      if (result.oneTimeSecretValue) {
        setOneTimeSecret({ message: result.message, value: result.oneTimeSecretValue });
      }
      router.refresh();
    });
  }

  return (
    <>
    <aside className="detail-drawer" aria-label="Credential detail">
      <div className="detail-header">
        <div>
          <p className="eyebrow">{SOURCE_LABELS[item.source]}</p>
          <h2>{item.parentName}</h2>
          <span className="muted">{item.credentialName}</span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close details" title="Close details">
          <X size={16} />
        </button>
      </div>

      <div className="detail-actions">
        <button type="button" onClick={() => void onCopy("Credential identifiers", detailCopyText(item))}>
          <Copy size={15} />
          Copy identifiers
        </button>
        <button type="button" onClick={() => void onCopy("Renewal request draft", renewalCopyText(item))}>
          <Download size={15} />
          Copy renewal request
        </button>
      </div>

      <section className="detail-section">
        <h3>Quick edit</h3>
        <form action={saveOwnerOverride} className="owner-detail-form">
          <input type="hidden" name="matchType" value="parent_id" />
          <input type="hidden" name="matchValue" value={item.parentId} />
          <OwnerAutocompleteFields
            suggestions={ownerSuggestions}
            defaultOwnerName={item.ownerName ?? ""}
            defaultOwnerEmail={item.ownerEmail ?? ""}
          />
          <button type="submit">Save owner</button>
        </form>
        <form action={updateCredentialStatus} className="status-detail-form">
          <input type="hidden" name="id" value={item.id} />
          <label>
            <span>Status</span>
            <select name="status" defaultValue={item.status} aria-label={`Status for ${item.credentialName}`}>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Save status</button>
        </form>
      </section>

      <section className="detail-section">
        <h3>Expiration</h3>
        <dl className="detail-list">
          <DetailRow label="Risk" value={<RiskBadge item={item} />} />
          <DetailRow label="Expires" value={formatDate(item.expiresAt)} />
          <DetailRow label="Days remaining" value={<DaysOut days={item.daysUntilExpiry} />} />
          <DetailRow label="Status" value={STATUS_LABELS[item.status]} />
          <DetailRow label="Rotation" value={<RotationBadge item={item} />} />
          <DetailRow label="Rotation reason" value={item.rotationModeReason} />
        </dl>
      </section>

      <section className="detail-section">
        <h3>Owner</h3>
        <dl className="detail-list">
          <DetailRow label="Name" value={item.ownerName ?? "Unassigned"} />
          <DetailRow label="Email" value={item.ownerEmail ?? "No email"} />
          <DetailRow label="Confidence" value={item.ownerConfidence} />
          <DetailRow label="Evidence" value={item.ownerEvidence ?? "No owner evidence"} />
        </dl>
      </section>

      <section className="detail-section">
        <h3>Renewal case</h3>
        {item.renewalCase ? (
          <div className="renewal-case">
            <dl className="detail-list">
              <DetailRow label="Case status" value={RENEWAL_CASE_LABELS[item.renewalCase.status]} />
              <DetailRow label="Due" value={item.renewalCase.dueAt ? formatDate(item.renewalCase.dueAt) : "No due date"} />
              <DetailRow label="Replacement" value={item.renewalCase.replacementCredentialId ?? "Not created"} />
              <DetailRow label="Replacement expiry" value={formatDate(item.renewalCase.replacementExpiresAt)} />
              <DetailRow
                label="Key Vault copy"
                value={
                  item.renewalCase.keyVaultCopyVaultName && item.renewalCase.keyVaultCopySecretName
                    ? `${item.renewalCase.keyVaultCopyVaultName}/${item.renewalCase.keyVaultCopySecretName}`
                    : "None"
                }
              />
              <DetailRow label="Handoff" value={HANDOFF_LABELS[item.renewalCase.handoffStatus]} />
              <DetailRow label="Last contacted" value={formatOptionalDate(item.renewalCase.lastContactedAt)} />
              <DetailRow label="Reminder" value={formatOptionalDate(item.renewalCase.reminderAt)} />
              <DetailRow label="Escalation" value={item.renewalCase.escalationOwner ?? "None"} />
            </dl>

            <ol className="renewal-checklist" aria-label="Renewal checklist">
              {checklist.map((step) => (
                <li key={step.label} className={step.complete ? "complete" : ""}>
                  {step.complete ? <CheckCircle2 size={15} /> : <Clock size={15} />}
                  <div>
                    <strong>{step.label}</strong>
                    <span>{step.detail}</span>
                  </div>
                </li>
              ))}
            </ol>

            <form action={updateRenewalCase} className="renewal-form">
              <input type="hidden" name="caseId" value={item.renewalCase.id} />
              <label>
                <span>Due</span>
                <input type="date" name="dueAt" defaultValue={dateInputValue(item.renewalCase.dueAt)} />
              </label>
              <OwnerAutocompleteFields
                suggestions={ownerSuggestions}
                defaultOwnerName={item.renewalCase.ownerName ?? ""}
                defaultOwnerEmail={item.renewalCase.ownerEmail ?? ""}
              />
              <label>
                <span>Notes</span>
                <input name="notes" defaultValue={item.renewalCase.notes ?? ""} />
              </label>
              <label>
                <span>Handoff</span>
                <select name="handoffStatus" defaultValue={item.renewalCase.handoffStatus}>
                  {Object.entries(HANDOFF_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Last contacted</span>
                <input type="date" name="lastContactedAt" defaultValue={dateInputValue(item.renewalCase.lastContactedAt)} />
              </label>
              <label>
                <span>Reminder</span>
                <input type="date" name="reminderAt" defaultValue={dateInputValue(item.renewalCase.reminderAt)} />
              </label>
              <label>
                <span>Escalation</span>
                <input name="escalationOwner" defaultValue={item.renewalCase.escalationOwner ?? ""} />
              </label>
              <label>
                <span>KV copy vault</span>
                <input name="keyVaultCopyVaultName" defaultValue={item.renewalCase.keyVaultCopyVaultName ?? ""} />
              </label>
              <label>
                <span>KV copy secret</span>
                <input name="keyVaultCopySecretName" defaultValue={item.renewalCase.keyVaultCopySecretName ?? ""} />
              </label>
              <button type="submit">Save case</button>
            </form>

            {inAppRotationSupported ? (
            <form onSubmit={prepareRotation} className="renewal-form">
              <input type="hidden" name="caseId" value={item.renewalCase.id} />
              <div className="renewal-safety-note">
                <ShieldAlert size={15} />
                <span>Replacement is created first. Old credential stays active in v1.</span>
              </div>
              <label className="checkbox-row">
                <input type="checkbox" name="dryRun" />
                <span>Dry run only</span>
              </label>
              <label>
                <span>Type credential name</span>
                <input name="confirmation" placeholder={item.credentialName} autoComplete="off" />
              </label>
              <label>
                <span>New display name</span>
                <input name="newCredentialDisplayName" placeholder={`${item.credentialName} renewal`} />
              </label>
              <label>
                <span>New expiry</span>
                <input type="datetime-local" name="replacementExpiresAt" />
              </label>
              {item.source === "key_vault_secret" ? (
                <>
                  <label>
                    <span>Secret mode</span>
                    <select name="secretMode" defaultValue="generated">
                      <option value="generated">Generate value</option>
                      <option value="provided">Use provided value</option>
                    </select>
                  </label>
                  <label>
                    <span>Provided value</span>
                    <input type="password" name="providedSecretValue" autoComplete="new-password" />
                  </label>
                </>
              ) : null}
              {(item.source === "entra_application" || item.source === "service_principal") && item.credentialType === "client_secret" ? (
                <>
                  <label>
                    <span>Copy vault</span>
                    <input name="keyVaultCopyVaultName" defaultValue={item.renewalCase.keyVaultCopyVaultName ?? ""} />
                  </label>
                  <label>
                    <span>Copy secret</span>
                    <input name="keyVaultCopySecretName" defaultValue={item.renewalCase.keyVaultCopySecretName ?? ""} />
                  </label>
                </>
              ) : null}
              <button type="submit" disabled={isRotating || !canOperate}>
                {isRotating ? "Rotating" : "Run confirmed rotation"}
              </button>
            </form>
            ) : (
              <div className="renewal-safety-note blocked">
                <Ban size={15} />
                <span>Workflow-only case. This credential is excluded from in-app rotation.</span>
              </div>
            )}

            {rotationResult ? (
              <div className={`renewal-result ${rotationResult.ok ? "ok" : "failed"}`}>
                <strong>
                  {rotationResult.ok
                    ? rotationResult.dryRun
                      ? "Dry run complete"
                      : "Rotation action complete"
                    : "Rotation action failed"}
                </strong>
                <span>{rotationResult.message}</span>
              </div>
            ) : null}

            <div className="renewal-actions">
              <form action={markRenewalValidated}>
                <input type="hidden" name="caseId" value={item.renewalCase.id} />
                <button type="submit">Mark validated</button>
              </form>
              <form action={closeRenewalCase}>
                <input type="hidden" name="caseId" value={item.renewalCase.id} />
                <button type="submit">Close case</button>
              </form>
            </div>

            {item.renewalCase.events.length ? (
              <ol className="detail-history">
                {item.renewalCase.events.map((event) => (
                  <li key={event.id}>
                    <strong>{event.eventType.replaceAll("_", " ")}</strong>
                    <span className="muted">
                      {event.createdBy} {formatDateTime(event.createdAt)}
                      {event.note ? ` - ${event.note}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : (
          <form action={createRenewalCase} className="renewal-form">
            <input type="hidden" name="credentialItemId" value={item.id} />
            <input type="hidden" name="ownerName" value={item.ownerName ?? ""} />
            <input type="hidden" name="ownerEmail" value={item.ownerEmail ?? ""} />
            <label>
              <span>Due</span>
              <input type="date" name="dueAt" defaultValue={dateInputValue(item.expiresAt)} />
            </label>
            <label>
              <span>Notes</span>
              <input name="notes" placeholder="Renewal context, dependency, or rollout note" />
            </label>
            <button type="submit">Open renewal case</button>
          </form>
        )}
      </section>

      <section className="detail-section">
        <h3>Identifiers</h3>
        <dl className="detail-list">
          <DetailRow label="Natural key" value={<CodeValue value={item.naturalKey} />} />
          <DetailRow label="Parent ID" value={<CodeValue value={item.parentId} />} />
          <DetailRow label="Credential ID" value={<CodeValue value={item.credentialId} />} />
          <DetailRow label="Tenant" value={item.sourceTenantId ? <CodeValue value={item.sourceTenantId} /> : "Unknown"} />
          <DetailRow label="Subscription" value={item.subscriptionId ? <CodeValue value={item.subscriptionId} /> : "Unknown"} />
          <DetailRow label="Resource group" value={item.resourceGroup ?? "Not applicable"} />
          <DetailRow label="Type" value={item.credentialType} />
        </dl>
      </section>

      <section className="detail-section">
        <h3>Source state</h3>
        <dl className="detail-list">
          <DetailRow label="Last seen" value={formatDateTime(item.lastSeenAt)} />
          <DetailRow label="Source updated" value={item.sourceUpdatedAt ? formatDateTime(item.sourceUpdatedAt) : "Unknown"} />
          <DetailRow label="Removed" value={item.removedAt ? formatDateTime(item.removedAt) : "No"} />
        </dl>
        <div className="detail-coverage-list">
          {coverage.length ? (
            coverage.map((row) => (
              <div key={`${row.source}:${row.resourceId ?? row.resourceName}`} className="detail-coverage-row">
                <span className={`health ${row.health}`}>{HEALTH_LABELS[row.health]}</span>
                <strong>{row.resourceName}</strong>
                <span className="muted">
                  {row.itemsSeen} seen, {row.itemsSkipped} skipped
                </span>
              </div>
            ))
          ) : (
            <span className="muted">No matching source coverage row</span>
          )}
        </div>
      </section>

      <section className="detail-section">
        <h3>Status history</h3>
        {item.statusHistory.length ? (
          <ol className="detail-history">
            {item.statusHistory.map((history) => (
              <li key={`${history.changedAt}-${history.toStatus}`}>
                <strong>{STATUS_LABELS[history.toStatus]}</strong>
                <span className="muted">
                  {history.changedBy} {formatDateTime(history.changedAt)}
                  {history.note ? ` - ${history.note}` : ""}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <span className="muted">No status updates</span>
        )}
      </section>

      {metadata.length ? (
        <section className="detail-section">
          <h3>Metadata</h3>
          <dl className="detail-list">
            {metadata.map(([key, value]) => (
              <DetailRow key={key} label={key} value={formatMetadataValue(value)} />
            ))}
          </dl>
        </section>
      ) : null}
    </aside>
    {pendingRotation ? (
      <div className="modal-backdrop" role="presentation">
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rotation-confirm-title">
          <h2 id="rotation-confirm-title">Confirm rotation</h2>
          <p>
            Type-confirmed action for <strong>{item.credentialName}</strong>.{" "}
            {pendingRotation.get("dryRun") === "on"
              ? "This is a dry run and will not change Azure or update the renewal case."
              : "This will create replacement material in Azure and leave the old credential active."}
          </p>
          <div className="modal-actions">
            <button type="button" onClick={() => runRotation(pendingRotation)} disabled={isRotating}>
              {pendingRotation.get("dryRun") === "on" ? "Run dry run" : "Create replacement"}
            </button>
            <button type="button" onClick={() => setPendingRotation(null)} disabled={isRotating}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    ) : null}
    {oneTimeSecret ? (
      <div className="modal-backdrop" role="presentation">
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="one-time-secret-title">
          <h2 id="one-time-secret-title">One-time secret value</h2>
          <p>{oneTimeSecret.message}</p>
          <textarea readOnly value={oneTimeSecret.value} />
          <div className="modal-actions">
            <button type="button" onClick={() => navigator.clipboard.writeText(oneTimeSecret.value)}>
              <Copy size={15} />
              Copy value
            </button>
            <button type="button" onClick={() => setOneTimeSecret(null)}>
              Close
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function CodeValue({ value }: { value: string }) {
  return <code className="detail-code">{value}</code>;
}

function OwnerAutocompleteFields({
  suggestions,
  defaultOwnerName = "",
  defaultOwnerEmail = "",
  ownerPlaceholder = "Owner name or email"
}: {
  suggestions: DashboardOwnerSuggestion[];
  defaultOwnerName?: string;
  defaultOwnerEmail?: string;
  ownerPlaceholder?: string;
}) {
  return (
    <OwnerAutocompleteInputs
      suggestions={suggestions}
      defaultOwnerName={defaultOwnerName}
      defaultOwnerEmail={defaultOwnerEmail}
      ownerPlaceholder={ownerPlaceholder}
      withLabels
    />
  );
}

function OwnerAutocompleteInputs({
  suggestions,
  defaultOwnerName = "",
  defaultOwnerEmail = "",
  ownerPlaceholder = "Owner name or email",
  ownerAriaLabel,
  withLabels = false
}: {
  suggestions: DashboardOwnerSuggestion[];
  defaultOwnerName?: string;
  defaultOwnerEmail?: string;
  ownerPlaceholder?: string;
  ownerAriaLabel?: string;
  withLabels?: boolean;
}) {
  const datalistId = useId().replaceAll(":", "");
  const defaultOwnerValue = defaultOwnerName || defaultOwnerEmail;
  const [ownerLookup, setOwnerLookup] = useState(defaultOwnerValue);

  useEffect(() => {
    setOwnerLookup(defaultOwnerName || defaultOwnerEmail);
  }, [defaultOwnerName, defaultOwnerEmail]);

  const listId = `owner-identities-${datalistId}`;
  const identityOptions = ownerIdentityOptions(suggestions);

  const ownerInput = (
    <input
        name="ownerLookup"
        value={ownerLookup}
        onChange={(event) => setOwnerLookup(event.target.value)}
        list={listId}
        placeholder={ownerPlaceholder}
        aria-label={ownerAriaLabel}
        autoComplete="off"
      />
  );
  const lists = (
    <datalist id={listId}>
        {identityOptions.map((option) => (
          <option
            key={`${option.value}:${option.label}`}
            value={option.value}
            label={option.label}
          />
        ))}
      </datalist>
  );

  if (withLabels) {
    return (
      <>
        <label>
          <span>Owner</span>
          {ownerInput}
        </label>
        {lists}
      </>
    );
  }

  return (
    <>
      {ownerInput}
      {lists}
    </>
  );
}

function ownerIdentityOptions(suggestions: DashboardOwnerSuggestion[]): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string }> = [];
  for (const suggestion of suggestions) {
    const entries = [
      { value: suggestion.ownerName, label: suggestion.ownerEmail ?? suggestion.source },
      ...(suggestion.ownerEmail ? [{ value: suggestion.ownerEmail, label: suggestion.ownerName }] : [])
    ];
    for (const entry of entries) {
      const key = entry.value.toLowerCase();
      if (!entry.value || seen.has(key)) continue;
      seen.add(key);
      options.push(entry);
    }
  }
  return options;
}

function OwnerDirectory({
  ownerOverrides,
  ownerSuggestions,
  onCopy
}: {
  ownerOverrides: DashboardOwnerOverride[];
  ownerSuggestions: DashboardOwnerSuggestion[];
  onCopy: () => void;
}) {
  return (
    <section className="owner-directory" aria-label="Owner mapping directory">
      <div className="section-heading">
        <h2>Owner directory</h2>
        <span>{ownerOverrides.length} saved mapping{ownerOverrides.length === 1 ? "" : "s"}</span>
      </div>

      <form action={saveOwnerOverride} className="mapping-form">
        <label>
          <span>Match</span>
          <select name="matchType" defaultValue="parent_id" aria-label="Owner mapping match type">
            {Object.entries(MATCH_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Value</span>
          <input name="matchValue" placeholder="Application ID, credential ID, app name, or vault name" />
        </label>
        <OwnerAutocompleteFields suggestions={ownerSuggestions} />
        <label>
          <span>Notes</span>
          <input name="notes" placeholder="Team, escalation, or renewal context" />
        </label>
        <button type="submit">Save mapping</button>
      </form>

      <div className="owner-directory-actions">
        <button type="button" onClick={onCopy} disabled={!ownerOverrides.length}>
          <Download size={15} />
          Copy mappings
        </button>
      </div>

      {ownerOverrides.length ? (
        <div className="owner-mapping-list">
          {ownerOverrides.map((override) => (
            <div key={override.id} className="owner-mapping-row">
              <div>
                <span className="match-pill">{MATCH_LABELS[override.matchType]}</span>
                <strong>{override.ownerName}</strong>
                <span className="muted">{override.ownerEmail ?? "No email"}</span>
              </div>
              <div>
                <code className="mapping-value">{override.matchValue}</code>
                <span className="muted">
                  {override.activeCredentialCount} active credential{override.activeCredentialCount === 1 ? "" : "s"}
                </span>
              </div>
              <div>
                <span>{override.notes ?? "No notes"}</span>
                <span className="muted">Updated {formatDateTime(override.updatedAt)}</span>
              </div>
              <form action={deleteOwnerOverride}>
                <input type="hidden" name="id" value={override.id} />
                <button type="submit">Remove</button>
              </form>
            </div>
          ))}
        </div>
      ) : (
        <span className="muted">No owner mappings saved yet</span>
      )}
    </section>
  );
}

function CoveragePanel({ coverage }: { coverage: DashboardCoverage[] }) {
  if (!coverage.length) {
    return (
      <section className="coverage-panel" aria-label="Source coverage">
        <div className="section-heading">
          <h2>Source coverage</h2>
          <span>No sync coverage recorded</span>
        </div>
      </section>
    );
  }

  return (
    <section className="coverage-panel" aria-label="Source coverage">
      <div className="section-heading">
        <h2>Source coverage</h2>
        <span>{coverage.length} monitored source{coverage.length === 1 ? "" : "s"}</span>
      </div>
      <div className="coverage-grid">
        {coverage.map((row) => (
          <div key={`${row.source}:${row.resourceId ?? row.resourceName}`} className={`coverage-row ${row.health}`}>
            <div>
              <span className={`health ${row.health}`}>{HEALTH_LABELS[row.health]}</span>
              <strong>{row.resourceName}</strong>
              <span className="muted">{SOURCE_LABELS[row.source]}</span>
            </div>
            <div>
              <strong>{row.itemsSeen}</strong>
              <span className="muted">seen</span>
            </div>
            <div>
              <strong>{row.itemsSkipped}</strong>
              <span className="muted">skipped</span>
            </div>
            <div>
              <strong>{formatDateTime(row.lastAttemptAt)}</strong>
              <span className="muted">last attempt</span>
            </div>
            <div>
              <strong>{row.lastSuccessfulSyncAt ? formatDateTime(row.lastSuccessfulSyncAt) : "Never"}</strong>
              <span className="muted">last success</span>
            </div>
            {row.errorCode || row.skipReason ? (
              <div className="coverage-note">
                {row.errorCode ? <strong>{row.errorCode}</strong> : null}
                <span className="muted">{row.skipReason}</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  icon,
  tone = "neutral"
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: "neutral" | "warning" | "danger";
}) {
  return (
    <div className={`metric ${tone}`}>
      <div>{icon}</div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  children
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  );
}

function RiskBadge({ item }: { item: DashboardItem }) {
  const label = BUCKET_LABELS[item.riskBucket];
  const className = `risk bucket-${item.riskBucket.replace("+", "plus").replace("no-expiry", "no-expiry")}`;
  return (
    <span className={className}>
      {item.riskBucket === "expired" ? <AlertTriangle size={14} /> : <Clock size={14} />}
      {label}
    </span>
  );
}

function DaysOut({ days }: { days: number | null }) {
  return <span className={`days-out ${daysOutTone(days)}`}>{daysOutLabel(days)}</span>;
}

function daysOutTone(days: number | null): "unknown" | "danger" | "warning" | "attention" | "steady" {
  if (days === null) return "unknown";
  if (days < 7) return "danger";
  if (days < 14) return "warning";
  if (days < 30) return "attention";
  return "steady";
}

function daysOutLabel(days: number | null): string {
  if (days === null) return "No expiry metadata";
  if (days < 0) return `${Math.abs(days)} ${pluralizeDay(Math.abs(days))} overdue`;
  if (days === 0) return "Expires today";
  return `${days} ${pluralizeDay(days)} out`;
}

function pluralizeDay(days: number): string {
  return days === 1 ? "day" : "days";
}

function RotationBadge({ item }: { item: DashboardItem }) {
  const actionable = isRenewalActionable(item.rotationMode);
  return (
    <span
      className={`rotation-mode ${actionable ? "actionable" : "excluded"}`}
      title={item.rotationModeReason}
    >
      {actionable ? <CheckCircle2 size={14} /> : <Ban size={14} />}
      {ROTATION_LABELS[item.rotationMode]}
    </span>
  );
}

function OwnerSummary({ item }: { item: DashboardItem }) {
  if (!item.ownerName) {
    return (
      <div className="owner-summary missing" title="Open details to assign">
        <strong>Unassigned</strong>
      </div>
    );
  }

  return (
    <div className="owner-summary" title={[item.ownerName, item.ownerEmail ?? "No email", `${item.ownerConfidence} confidence`].join("\n")}>
      <strong>{item.ownerName}</strong>
      <span className={`confidence ${item.ownerConfidence}`}>{item.ownerConfidence}</span>
    </div>
  );
}

function StatusSummary({ item }: { item: DashboardItem }) {
  const lastStatus = item.statusHistory[0];
  const title = lastStatus ? `${lastStatus.changedBy} ${formatDateTime(lastStatus.changedAt)}` : "No status updates";
  return (
    <div className="status-summary" title={title}>
      <strong>{STATUS_LABELS[item.status]}</strong>
      {item.renewalCase ? <span className="renewal-pill">{RENEWAL_CASE_LABELS[item.renewalCase.status]}</span> : null}
    </div>
  );
}

function OwnerGapList({ items, onOpen }: { items: DashboardItem[]; onOpen: (id: number) => void }) {
  return (
    <section className="owner-gap-panel" aria-label="Owner gap worklist">
      <div className="section-heading">
        <div>
          <h2>Owner gaps</h2>
          <span>Credentials with no mapped owner</span>
        </div>
        <span>{items.length} gaps</span>
      </div>
      {items.length ? (
        <div className="owner-gap-list">
          {items.map((item) => (
            <div key={item.id} className="owner-gap-row">
              <div>
                <RiskBadge item={item} />
                <strong>{item.parentName}</strong>
                <span className="muted">
                  {SOURCE_LABELS[item.source]} / {item.credentialName}
                </span>
              </div>
              <div>
                <strong>{formatDate(item.expiresAt)}</strong>
                <DaysOut days={item.daysUntilExpiry} />
              </div>
              <button type="button" onClick={() => onOpen(item.id)}>
                Assign owner
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty compact">
          <CheckCircle2 size={24} />
          <h2>No owner gaps</h2>
          <p>All visible credentials have an owner mapping.</p>
        </div>
      )}
    </section>
  );
}

function supportsInAppRotation(item: DashboardItem): boolean {
  if (!isRenewalActionable(item.rotationMode)) return false;
  if ((item.source === "entra_application" || item.source === "service_principal") && item.credentialType === "client_secret") {
    return true;
  }
  if (item.source === "key_vault_secret" || item.source === "key_vault_key") return true;
  if (item.source !== "key_vault_certificate") return false;
  const lifetimeAction = String(item.metadata.certificateLifetimeAction ?? "").toLowerCase();
  const issuerName = String(item.metadata.certificateIssuerName ?? "").toLowerCase();
  return lifetimeAction === "autorenew" || Boolean(issuerName && issuerName !== "self");
}

function renewalChecklist(item: DashboardItem): { label: string; detail: string; complete: boolean }[] {
  const renewalCase = item.renewalCase;
  if (!renewalCase) return [];
  const replacementCreated = Boolean(
    renewalCase.replacementCredentialId ||
      renewalCase.status === "rotation_created" ||
      renewalCase.status === "validated" ||
      renewalCase.status === "closed"
  );
  const validated = renewalCase.status === "validated" || renewalCase.status === "closed";
  return [
    {
      label: "Owner assigned",
      detail: renewalCase.ownerName || item.ownerName || "Owner needed",
      complete: Boolean(renewalCase.ownerName || item.ownerName)
    },
    {
      label: "Due date set",
      detail: renewalCase.dueAt ? formatDate(renewalCase.dueAt) : "No due date",
      complete: Boolean(renewalCase.dueAt)
    },
    {
      label: "Owner handoff",
      detail: `${HANDOFF_LABELS[renewalCase.handoffStatus]}${
        renewalCase.lastContactedAt ? ` on ${formatDate(renewalCase.lastContactedAt)}` : ""
      }`,
      complete: renewalCase.handoffStatus !== "not_contacted" || Boolean(renewalCase.lastContactedAt)
    },
    {
      label: "Replacement created",
      detail: renewalCase.replacementCredentialId ?? "No replacement recorded",
      complete: replacementCreated
    },
    {
      label: "Old credential retained",
      detail: replacementCreated ? "Pending owner validation" : "Awaiting replacement",
      complete: replacementCreated
    },
    {
      label: "Validated",
      detail: validated ? RENEWAL_CASE_LABELS[renewalCase.status] : "Validation pending",
      complete: validated
    }
  ];
}

function EmptyState() {
  return (
    <div className="empty">
      <Database size={28} />
      <h2>No inventory loaded</h2>
      <p>Run npm run db:migrate and npm run fixtures:sync, then refresh this dashboard.</p>
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return "No expiry";
  const dateOnly = dateOnlyParts(value);
  const date = dateOnly ? new Date(dateOnly.year, dateOnly.month - 1, dateOnly.day) : new Date(value);
  return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", year: "numeric" }).format(date);
}

function formatOptionalDate(value: string | null): string {
  return value ? formatDate(value) : "Not set";
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function dateInputValue(value: string | null): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function dateOnlyParts(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function coverageMatchesItem(row: DashboardCoverage, item: DashboardItem): boolean {
  if (row.source !== item.source) return false;
  if (row.resourceId?.startsWith("graph-")) return true;
  if (!row.resourceId) return true;
  return row.resourceId === item.parentId || row.resourceName === item.parentName;
}

function detailCopyText(item: DashboardItem): string {
  return [
    `Source: ${SOURCE_LABELS[item.source]}`,
    `Application/resource: ${item.parentName}`,
    `Credential: ${item.credentialName}`,
    `Credential type: ${item.credentialType}`,
    `Natural key: ${item.naturalKey}`,
    `Parent ID: ${item.parentId}`,
    `Credential ID: ${item.credentialId}`,
    `Tenant ID: ${item.sourceTenantId ?? "unknown"}`,
    `Subscription ID: ${item.subscriptionId ?? "unknown"}`,
    `Resource group: ${item.resourceGroup ?? "not applicable"}`,
    `Expires: ${formatDate(item.expiresAt)}`,
    `Rotation mode: ${ROTATION_LABELS[item.rotationMode]}`,
    `Rotation reason: ${item.rotationModeReason}`,
    `Owner: ${item.ownerName ?? "Unassigned"}${item.ownerEmail ? ` <${item.ownerEmail}>` : ""}`,
    `Owner evidence: ${item.ownerEvidence ?? "none"}`,
    `Status: ${STATUS_LABELS[item.status]}`
  ].join("\n");
}

function renewalCopyText(item: DashboardItem): string {
  return [
    `Owner: ${item.ownerName ?? "Unassigned"}${item.ownerEmail ? ` <${item.ownerEmail}>` : ""}`,
    `Application/resource: ${item.parentName}`,
    `Credential: ${item.credentialName} (${item.credentialType})`,
    `Source: ${SOURCE_LABELS[item.source]}`,
    `Expiration: ${formatDate(item.expiresAt)}${
      item.daysUntilExpiry === null ? "" : ` (${item.daysUntilExpiry} days)`
    }`,
    `Current status: ${STATUS_LABELS[item.status]}`,
    `Rotation mode: ${ROTATION_LABELS[item.rotationMode]}`,
    `Identifier: ${item.credentialId}`,
    "",
    "Requested action: rotate or replace this credential before the expiration date, then reply with the completion date and the new rotation owner.",
    "If this credential is no longer needed, confirm it can be removed or marked ignored."
  ].join("\n");
}

function renewalPacket(owner: string, items: DashboardItem[]): string {
  const sorted = [...items].sort((a, b) => riskRank(a.riskBucket) - riskRank(b.riskBucket));
  const urgentCount = sorted.filter((item) => item.riskBucket === "expired" || item.riskBucket === "0-30").length;
  const dueSoonCount = sorted.filter((item) => item.riskBucket === "31-60" || item.riskBucket === "61-90").length;
  const subject = `Credential rotation request: ${urgentCount} urgent, ${dueSoonCount} upcoming`;
  const rows = sorted
    .map((item) =>
      [
        SOURCE_LABELS[item.source],
        item.parentName,
        item.credentialName,
        item.credentialType,
        formatDate(item.expiresAt),
        item.daysUntilExpiry === null ? "No expiry metadata" : `${item.daysUntilExpiry} days`,
        STATUS_LABELS[item.status],
        item.credentialId
      ].join("\t")
    )
    .join("\n");

  return [
    `To: ${owner}`,
    `Subject: ${subject}`,
    "",
    "Please review and rotate the credentials below. Reply with the completion date, the new rotation owner, and whether any listed credential should be removed instead of rotated.",
    "",
    `Total credentials: ${sorted.length}`,
    `Urgent credentials: ${urgentCount}`,
    `Upcoming credentials: ${dueSoonCount}`,
    "",
    "source\tapplication_or_resource\tcredential\ttype\texpires\tremaining\tstatus\tcredential_id",
    rows
  ].join("\n");
}

function withExclusionNote(text: string, excludedCount: number): string {
  if (!excludedCount) return text;
  return [
    text,
    "",
    `Note: ${excludedCount} selected or visible credential${excludedCount === 1 ? " was" : "s were"} excluded because the dashboard classified them as not owner-rotatable. Use the Rotation filter and inventory export for audit details.`
  ].join("\n");
}

function riskRank(bucket: RiskBucket): number {
  return ["expired", "0-30", "31-60", "61-90", "90+", "no-expiry"].indexOf(bucket);
}

function formatMetadataValue(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function matchesWorkflowMode(
  item: DashboardItem,
  workflowMode: WorkflowMode
): boolean {
  if (workflowMode === "all") return true;
  if (!isRenewalActionable(item.rotationMode)) return false;
  if (workflowMode === "urgent") return item.riskBucket === "expired" || item.riskBucket === "0-30";
  if (workflowMode === "due60") {
    return item.riskBucket === "expired" || item.riskBucket === "0-30" || item.riskBucket === "31-60";
  }
  if (workflowMode === "unknown") return !item.ownerName;
  return item.status === "owner_contacted";
}

function matchesSourceFilter(item: DashboardItem, source: SourceFilter): boolean {
  if (source === "all") return true;
  if (source === "key_vault") return KEY_VAULT_SOURCES.has(item.source);
  return item.source === source;
}

function matchesRotationScope(item: DashboardItem, rotationScope: RotationScope): boolean {
  if (rotationScope === "all") return true;
  if (rotationScope === "actionable") return isRenewalActionable(item.rotationMode);
  return item.rotationMode === rotationScope;
}
