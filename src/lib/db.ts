import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB_PATH = "./data/gstack.sqlite";

export function dbPath(): string {
  return resolve(process.env.GSTACK_DB_PATH ?? DEFAULT_DB_PATH);
}

export function openDatabase(): DatabaseSync {
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  return new DatabaseSync(path);
}

export function migrate(db = openDatabase()): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS credential_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      natural_key TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      source_tenant_id TEXT,
      subscription_id TEXT,
      resource_group TEXT,
      parent_id TEXT NOT NULL,
      parent_name TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      credential_name TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      expires_at TEXT,
      owner_hint TEXT,
      owner_override_id INTEGER,
      status TEXT NOT NULL DEFAULT 'not_started',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      source_updated_at TEXT,
      removed_at TEXT,
      removal_reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(owner_override_id) REFERENCES owner_overrides(id)
    );

    CREATE TABLE IF NOT EXISTS owner_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_type TEXT NOT NULL,
      match_value TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      owner_email TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(match_type, match_value)
    );

    CREATE TABLE IF NOT EXISTS owner_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_item_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      owner_name TEXT,
      owner_email TEXT,
      confidence TEXT NOT NULL,
      evidence TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      FOREIGN KEY(credential_item_id) REFERENCES credential_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS owner_directory (
      directory_key TEXT PRIMARY KEY,
      owner_name TEXT NOT NULL,
      owner_email TEXT,
      source TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      items_seen INTEGER NOT NULL DEFAULT 0,
      items_changed INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS source_coverage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      tenant_id TEXT,
      subscription_id TEXT,
      resource_id TEXT,
      resource_name TEXT NOT NULL,
      configured INTEGER NOT NULL,
      reachable INTEGER NOT NULL,
      last_successful_sync_at TEXT,
      last_attempt_at TEXT NOT NULL,
      items_seen INTEGER NOT NULL DEFAULT 0,
      items_skipped INTEGER NOT NULL DEFAULT 0,
      skip_reason TEXT,
      error_code TEXT,
      UNIQUE(source, resource_id)
    );

    CREATE TABLE IF NOT EXISTS status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_item_id INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      note TEXT,
      changed_at TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      FOREIGN KEY(credential_item_id) REFERENCES credential_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS renewal_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_item_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      due_at TEXT,
      owner_name TEXT,
      owner_email TEXT,
      notes TEXT,
      reminder_at TEXT,
      last_contacted_at TEXT,
      escalation_owner TEXT,
      handoff_status TEXT NOT NULL DEFAULT 'not_contacted',
      replacement_credential_id TEXT,
      replacement_expires_at TEXT,
      key_vault_copy_vault_name TEXT,
      key_vault_copy_secret_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      FOREIGN KEY(credential_item_id) REFERENCES credential_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS renewal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      renewal_case_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      note TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      FOREIGN KEY(renewal_case_id) REFERENCES renewal_cases(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS refresh_schedule (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL,
      interval_minutes INTEGER NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      updated_at TEXT,
      updated_by TEXT,
      message TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refresh_schedule_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      interval_minutes INTEGER NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_credential_items_expires_at ON credential_items(expires_at);
    CREATE INDEX IF NOT EXISTS idx_credential_items_source ON credential_items(source);
    CREATE INDEX IF NOT EXISTS idx_credential_items_status ON credential_items(status);
    CREATE INDEX IF NOT EXISTS idx_credential_items_parent_name ON credential_items(parent_name);
    CREATE INDEX IF NOT EXISTS idx_owner_overrides_match ON owner_overrides(match_type, match_value);
    CREATE INDEX IF NOT EXISTS idx_owner_directory_name ON owner_directory(owner_name);
    CREATE INDEX IF NOT EXISTS idx_owner_directory_email ON owner_directory(owner_email);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_renewal_cases_active_credential
      ON renewal_cases(credential_item_id)
      WHERE closed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_renewal_events_case ON renewal_events(renewal_case_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_refresh_schedule_events_created ON refresh_schedule_events(created_at DESC);
  `);
  ensureColumn(db, "renewal_cases", "reminder_at", "TEXT");
  ensureColumn(db, "renewal_cases", "last_contacted_at", "TEXT");
  ensureColumn(db, "renewal_cases", "escalation_owner", "TEXT");
  ensureColumn(db, "renewal_cases", "handoff_status", "TEXT NOT NULL DEFAULT 'not_contacted'");
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
