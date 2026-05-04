"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  Download,
  Filter,
  KeyRound,
  RefreshCw,
  Search,
  ShieldAlert,
  UserRound,
  XCircle
} from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import type { DashboardItem, DashboardSummary, InventorySource, RiskBucket, WorkflowStatus } from "@/types";
import { saveBulkOwnerOverride, saveOwnerOverride, updateCredentialStatus } from "@/app/actions";

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

export function Dashboard({ items, summary }: { items: DashboardItem[]; summary: DashboardSummary }) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<InventorySource | "all">("all");
  const [bucket, setBucket] = useState<RiskBucket | "all">("all");
  const [status, setStatus] = useState<WorkflowStatus | "all">("all");
  const [ownerMode, setOwnerMode] = useState<"all" | "unknown" | "low">("all");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
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
      if (!needle) return true;
      return [item.parentName, item.credentialName, item.ownerName, item.ownerEmail, item.naturalKey]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [bucket, items, ownerMode, query, source, status]);

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

  function toggleSelection(id: number) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((selected) => selected !== id) : [...current, id]
    );
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
    void navigator.clipboard.writeText(text);
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
    void navigator.clipboard.writeText(text);
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
          <button type="button" onClick={copyOwnerSummary}>
            <Download size={15} />
            Copy by owner
          </button>
        </div>
      </section>

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
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id} className={item.removedAt ? "removed" : ""}>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
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
