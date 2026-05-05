"use client";

import azureCertLogo from "@/app/azure-cert-logo.png";
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
import { type FormEvent, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type {
  CoverageHealth,
  DashboardCoverage,
  DashboardItem,
  DashboardOwnerOverride,
  DashboardSummary,
  InventorySource,
  OwnerMatchType,
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

const SOURCE_LABELS: Record<InventorySource, string> = {
  entra_application: "Entra app",
  service_principal: "Service principal",
  key_vault_secret: "Key Vault secret",
  key_vault_certificate: "Key Vault cert",
  key_vault_key: "Key Vault key"
};

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

export function Dashboard({
  items,
  summary,
  coverage,
  ownerOverrides
}: {
  items: DashboardItem[];
  summary: DashboardSummary;
  coverage: DashboardCoverage[];
  ownerOverrides: DashboardOwnerOverride[];
}) {
  const dashboardRouter = useRouter();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<InventorySource | "all">("all");
  const [bucket, setBucket] = useState<RiskBucket | "all">("all");
  const [status, setStatus] = useState<WorkflowStatus | "all">("all");
  const [ownerMode, setOwnerMode] = useState<"all" | "unknown" | "low">("all");
  const [rotationScope, setRotationScope] = useState<RotationScope>("actionable");
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>("all");
  const [activeTab, setActiveTab] = useState<DashboardTab>("inventory");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectedDetailId, setSelectedDetailId] = useState<number | null>(null);
  const [copyPanel, setCopyPanel] = useState<{ title: string; text: string; copied: boolean } | null>(null);
  const [refreshStatus, setRefreshStatus] = useState<RefreshRunStatus | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshStatusRef = useRef<string | null>(null);
  const refreshStartedFromUi = useRef(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const stored = window.localStorage.getItem("gstack-theme");
    if (stored === "dark" || stored === "light") {
      setTheme(stored);
      document.documentElement.dataset.theme = stored;
    }
  }, []);

  useEffect(() => {
    void loadRefreshStatus(false);
  }, []);

  useEffect(() => {
    if (refreshStatus?.status !== "running") return;
    const timer = window.setInterval(() => {
      void loadRefreshStatus(true);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [refreshStatus?.status]);

  function toggleTheme() {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      window.localStorage.setItem("gstack-theme", next);
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

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (source !== "all" && item.source !== source) return false;
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

  function toggleSelection(id: number) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((selected) => selected !== id) : [...current, id]
    );
  }

  async function copyText(title: string, text: string) {
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
      <section className="table-wrap" aria-label={label}>
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
                  <td>{SOURCE_LABELS[item.source]}</td>
                  <td>
                    <strong>{item.parentName}</strong>
                    <span className="muted mono">{item.naturalKey.split(":").slice(0, 3).join(":")}</span>
                  </td>
                  <td>
                    <span className="credential">
                      <KeyRound size={15} />
                      {item.credentialName}
                    </span>
                    <span className="muted">{item.credentialType}</span>
                  </td>
                  <td>
                    <RotationBadge item={item} />
                  </td>
                  <td>
                    <strong>{formatDate(item.expiresAt)}</strong>
                    <span className="muted">
                      {item.daysUntilExpiry === null ? "No expiry metadata" : `${item.daysUntilExpiry} days`}
                    </span>
                  </td>
                  <td>
                    <OwnerCell item={item} />
                  </td>
                  <td>
                    <StatusForm item={item} />
                  </td>
                  <td>
                    <span>{formatDate(item.lastSeenAt)}</span>
                    {item.removedAt ? <span className="muted danger-text">Removed from source</span> : null}
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
                      <span className="muted">
                        {formatDate(item.expiresAt)}
                        {item.daysUntilExpiry === null ? "" : ` / ${item.daysUntilExpiry} days`}
                      </span>
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
            <h1>Azure Cert</h1>
            <span>Secret Expiration Dashboard</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="refresh-button"
            onClick={startDataRefresh}
            disabled={refreshStatus?.status === "running"}
            aria-live="polite"
          >
            <RefreshCw size={16} className={refreshStatus?.status === "running" ? "spin" : ""} />
            <span>{refreshStatus?.status === "running" ? "Refreshing" : "Refresh data"}</span>
          </button>
          <button type="button" className="theme-toggle" onClick={toggleTheme} aria-pressed={theme === "dark"}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            <span>{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
          <div className="sync-pill">
            <RefreshCw size={16} />
            <span>Last sync {summary.lastSuccessfulSyncAt ? formatDateTime(summary.lastSuccessfulSyncAt) : "never"}</span>
          </div>
        </div>
      </header>

      {refreshStatus && refreshStatus.status !== "idle" ? (
        <section className={`refresh-panel ${refreshStatus.status}`} aria-live="polite" aria-label="Data refresh status">
          <div className="refresh-panel-header">
            <div>
              <strong>{refreshStatus.message}</strong>
              <span>
                {refreshStatus.status === "running"
                  ? `Started ${formatDateTime(refreshStatus.startedAt ?? new Date().toISOString())}`
                  : `Finished ${formatDateTime(refreshStatus.finishedAt ?? new Date().toISOString())}`}
              </span>
            </div>
            <span className="refresh-percent">{refreshStatus.progress}%</span>
          </div>
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
        </section>
      ) : null}

      {refreshError ? (
        <section className="refresh-panel failed" aria-live="polite" aria-label="Data refresh error">
          <strong>Refresh status unavailable</strong>
          <span>{refreshError}</span>
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
            onClick={() => setActiveTab(tab)}
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
          {(Object.keys(QUEUE_LABELS) as WorkflowMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={workflowMode === mode ? "active" : ""}
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
          <Select label="Source" value={source} onChange={(value) => setSource(value as InventorySource | "all")}>
            <option value="all">All sources</option>
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
          <Select
            label="Workflow"
            value={workflowMode}
            onChange={(value) => setWorkflowMode(value as WorkflowMode)}
          >
            {Object.entries(QUEUE_LABELS).map(([value, label]) => (
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
          <form action={saveBulkOwnerOverride} className="owner-bulk-form">
            {selectedItems.map((item) => (
              <input key={item.id} type="hidden" name="parentId" value={item.parentId} />
            ))}
            <input name="ownerName" placeholder="Owner for selected" aria-label="Owner for selected" />
            <input name="ownerEmail" placeholder="email" aria-label="Owner email for selected" />
            <button type="submit" disabled={!selectedIds.length || isPending}>
              Assign owner
            </button>
          </form>
          <div className="action-buttons">
            <button type="button" onClick={() => bulkUpdate("owner_contacted")} disabled={!selectedIds.length || isPending}>
              Owner contacted
            </button>
            <button type="button" onClick={() => bulkUpdate("rotation_scheduled")} disabled={!selectedIds.length || isPending}>
              Rotation scheduled
            </button>
            <button type="button" onClick={() => copyUnknownOwners()}>
              <Download size={15} />
              Copy unknowns
            </button>
            <button type="button" onClick={copyRenewalRequest} disabled={!actionableRenewalItems.length}>
              <Download size={15} />
              Copy renewal request
            </button>
            <button type="button" onClick={copyOwnerPackets} disabled={!actionableRenewalItems.length}>
              <Download size={15} />
              Copy owner packets
            </button>
            <button type="button" onClick={copyOwnerSummary} disabled={!actionableRenewalItems.length}>
              <Download size={15} />
              Copy by owner
            </button>
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
        <OwnerDirectory ownerOverrides={ownerOverrides} onCopy={copyOwnerMappings} />
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

      {selectedDetail && (activeTab === "inventory" || activeTab === "renewals") ? (
        <CredentialDetailDrawer
          item={selectedDetail}
          coverage={detailCoverage}
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
      <img src={azureCertLogo.src} alt="" width={42} height={42} decoding="async" />
    </div>
  );
}

function CredentialDetailDrawer({
  item,
  coverage,
  onClose,
  onCopy
}: {
  item: DashboardItem;
  coverage: DashboardCoverage[];
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
        <h3>Expiration</h3>
        <dl className="detail-list">
          <DetailRow label="Risk" value={<RiskBadge item={item} />} />
          <DetailRow label="Expires" value={formatDate(item.expiresAt)} />
          <DetailRow
            label="Days remaining"
            value={item.daysUntilExpiry === null ? "No expiry metadata" : String(item.daysUntilExpiry)}
          />
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
              <label>
                <span>Owner</span>
                <input name="ownerName" defaultValue={item.renewalCase.ownerName ?? ""} />
              </label>
              <label>
                <span>Email</span>
                <input name="ownerEmail" defaultValue={item.renewalCase.ownerEmail ?? ""} />
              </label>
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
              <button type="submit" disabled={isRotating}>
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

function OwnerDirectory({
  ownerOverrides,
  onCopy
}: {
  ownerOverrides: DashboardOwnerOverride[];
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
        <label>
          <span>Owner</span>
          <input name="ownerName" placeholder="Owner name" />
        </label>
        <label>
          <span>Email</span>
          <input name="ownerEmail" placeholder="owner@example.com" />
        </label>
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

function OwnerCell({ item }: { item: DashboardItem }) {
  if (!item.ownerName) {
    return (
      <form action={saveOwnerOverride} className="owner-form">
        <input type="hidden" name="matchType" value="parent_id" />
        <input type="hidden" name="matchValue" value={item.parentId} />
        <input name="ownerName" placeholder="Owner name" aria-label="Owner name" />
        <input name="ownerEmail" placeholder="email" aria-label="Owner email" />
        <button type="submit">Save</button>
      </form>
    );
  }

  return (
    <div className="owner">
      <strong>{item.ownerName}</strong>
      <span className="muted">{item.ownerEmail ?? "No email"}</span>
      <span className={`confidence ${item.ownerConfidence}`}>{item.ownerConfidence}</span>
      <span className="muted">{item.ownerEvidence}</span>
    </div>
  );
}

function StatusForm({ item }: { item: DashboardItem }) {
  return (
    <div className="status-stack">
      <form action={updateCredentialStatus} className="status-form">
        <input type="hidden" name="id" value={item.id} />
        <select name="status" defaultValue={item.status} aria-label={`Status for ${item.credentialName}`}>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button type="submit">
          <CheckCircle2 size={14} />
        </button>
      </form>
      {item.statusHistory.length ? (
        <div className="status-history">
          {item.statusHistory.map((history) => (
            <span key={`${history.changedAt}-${history.toStatus}`}>
              {STATUS_LABELS[history.toStatus]} by {history.changedBy} {formatDateTime(history.changedAt)}
            </span>
          ))}
        </div>
      ) : (
        <span className="muted">No status updates</span>
      )}
      {item.renewalCase ? <span className="renewal-pill">{RENEWAL_CASE_LABELS[item.renewalCase.status]}</span> : null}
    </div>
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

function matchesRotationScope(item: DashboardItem, rotationScope: RotationScope): boolean {
  if (rotationScope === "all") return true;
  if (rotationScope === "actionable") return isRenewalActionable(item.rotationMode);
  return item.rotationMode === rotationScope;
}
