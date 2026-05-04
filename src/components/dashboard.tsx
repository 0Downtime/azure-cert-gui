"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  Download,
  Filter,
  KeyRound,
  PanelRightOpen,
  RefreshCw,
  Search,
  ShieldAlert,
  UserRound,
  X,
  XCircle
} from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import type {
  CoverageHealth,
  DashboardCoverage,
  DashboardItem,
  DashboardOwnerOverride,
  DashboardSummary,
  InventorySource,
  OwnerMatchType,
  RiskBucket,
  WorkflowStatus
} from "@/types";
import { deleteOwnerOverride, saveBulkOwnerOverride, saveOwnerOverride, updateCredentialStatus } from "@/app/actions";

const SOURCE_LABELS: Record<InventorySource, string> = {
  entra_application: "Entra app",
  service_principal: "Service principal",
  key_vault_secret: "Key Vault secret",
  key_vault_certificate: "Key Vault cert"
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
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<InventorySource | "all">("all");
  const [bucket, setBucket] = useState<RiskBucket | "all">("all");
  const [status, setStatus] = useState<WorkflowStatus | "all">("all");
  const [ownerMode, setOwnerMode] = useState<"all" | "unknown" | "low">("all");
  const [workflowMode, setWorkflowMode] = useState<"all" | "urgent" | "due60" | "unknown" | "contacted_pending">("all");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [selectedDetailId, setSelectedDetailId] = useState<number | null>(null);
  const [copyPanel, setCopyPanel] = useState<{ title: string; text: string; copied: boolean } | null>(null);
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (source !== "all" && item.source !== source) return false;
      if (bucket !== "all" && item.riskBucket !== bucket) return false;
      if (status !== "all" && item.status !== status) return false;
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
  }, [bucket, items, ownerMode, query, source, status, workflowMode]);

  const groupedByOwner = useMemo(() => {
    const groups = new Map<string, DashboardItem[]>();
    for (const item of filtered) {
      const key = item.ownerName ? `${item.ownerName}${item.ownerEmail ? ` <${item.ownerEmail}>` : ""}` : "Unknown owner";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [filtered]);

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.includes(item.id)),
    [items, selectedIds]
  );
  const selectedDetail = useMemo(
    () => items.find((item) => item.id === selectedDetailId) ?? null,
    [items, selectedDetailId]
  );
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
    const text = groupedByOwner
      .map(([owner, ownerItems]) => {
        const rows = ownerItems
          .map((item) => `- ${item.parentName}: ${item.credentialName} expires ${formatDate(item.expiresAt)} (${item.riskBucket})`)
          .join("\n");
        return `${owner}\n${rows}`;
      })
      .join("\n\n");
    void copyText("Owner grouped renewal worklist", text);
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

  function copyRenewalRequest() {
    const rows = selectedItems.length ? selectedItems : filtered;
    const text = rows
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
    void copyText("Renewal request draft", text);
  }

  function copyUnknownOwners() {
    const unknownRows = filtered.filter((item) => !item.ownerName);
    const text = [
      "source\tapp_or_vault\tcredential\texpires\trisk\tparent_id",
      ...unknownRows.map((item) =>
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

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Azure / Entra Inventory</p>
          <h1>Secret Expiration Dashboard</h1>
        </div>
        <div className="sync-pill">
          <RefreshCw size={16} />
          <span>Last sync {summary.lastSuccessfulSyncAt ? formatDateTime(summary.lastSuccessfulSyncAt) : "never"}</span>
        </div>
      </header>

      <section className="metrics" aria-label="Inventory summary">
        <Metric label="Total" value={summary.total} icon={<Database size={18} />} />
        <Metric label="Expired" value={summary.expired} tone="danger" icon={<XCircle size={18} />} />
        <Metric label="0-30 days" value={summary.next30} tone="warning" icon={<Clock size={18} />} />
        <Metric label="31-60 days" value={summary.next60} icon={<Clock size={18} />} />
        <Metric label="61-90 days" value={summary.next90} icon={<Clock size={18} />} />
        <Metric label="Unknown owners" value={summary.unknownOwners} tone="warning" icon={<UserRound size={18} />} />
        <Metric label="Coverage gaps" value={summary.coverageGaps} tone="danger" icon={<ShieldAlert size={18} />} />
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
        <Select
          label="Workflow"
          value={workflowMode}
          onChange={(value) => setWorkflowMode(value as "all" | "urgent" | "due60" | "unknown" | "contacted_pending")}
        >
          <option value="all">All work</option>
          <option value="urgent">Expired / 30</option>
          <option value="due60">Due in 60</option>
          <option value="unknown">Needs owner</option>
          <option value="contacted_pending">Contacted, unscheduled</option>
        </Select>
      </section>

      <section className="actionbar" aria-label="Bulk actions">
        <div>
          <Filter size={16} />
          <span>{filtered.length} visible</span>
          <span>{selectedIds.length} selected</span>
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
          <button type="button" onClick={copyUnknownOwners}>
            <Download size={15} />
            Copy unknowns
          </button>
          <button type="button" onClick={copyRenewalRequest} disabled={!filtered.length}>
            <Download size={15} />
            Copy renewal request
          </button>
          <button type="button" onClick={copyOwnerSummary}>
            <Download size={15} />
            Copy by owner
          </button>
        </div>
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

      <CoveragePanel coverage={coverage} />
      <OwnerDirectory ownerOverrides={ownerOverrides} onCopy={copyOwnerMappings} />

      <section className="table-wrap">
        {items.length === 0 ? (
          <EmptyState />
        ) : (
          <table>
            <thead>
              <tr>
                <th aria-label="Select rows" />
                <th>Risk</th>
                <th>Source</th>
                <th>App / vault</th>
                <th>Credential</th>
                <th>Expires</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Updated</th>
                <th aria-label="Credential details" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
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

      {selectedDetail ? (
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
  const metadata = Object.entries(item.metadata);
  return (
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
    </div>
  );
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
  return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", year: "numeric" }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
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
    `Identifier: ${item.credentialId}`,
    "",
    "Requested action: rotate or replace this credential before the expiration date, then reply with the completion date and the new rotation owner.",
    "If this credential is no longer needed, confirm it can be removed or marked ignored."
  ].join("\n");
}

function formatMetadataValue(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function matchesWorkflowMode(
  item: DashboardItem,
  workflowMode: "all" | "urgent" | "due60" | "unknown" | "contacted_pending"
): boolean {
  if (workflowMode === "all") return true;
  if (workflowMode === "urgent") return item.riskBucket === "expired" || item.riskBucket === "0-30";
  if (workflowMode === "due60") {
    return item.riskBucket === "expired" || item.riskBucket === "0-30" || item.riskBucket === "31-60";
  }
  if (workflowMode === "unknown") return !item.ownerName;
  return item.status === "owner_contacted";
}
