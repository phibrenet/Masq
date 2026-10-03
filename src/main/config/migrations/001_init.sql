-- Config store schema (spec §10). App-local settings DB — never the source/target DB.
-- These migration files are source and stay tracked in git.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dump_output_mode TEXT NOT NULL DEFAULT 'combined'
    CHECK (dump_output_mode IN ('combined', 'split')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  dialect TEXT NOT NULL CHECK (dialect IN ('mysql', 'postgres', 'sqlite', 'mssql')),
  role TEXT NOT NULL CHECK (role IN ('source', 'target')),
  host TEXT,
  port INTEGER,
  database TEXT,
  username TEXT,
  file_path TEXT
  -- NOTE: no password column — see the `credentials` table
);

CREATE TABLE credentials (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  encrypted_password BLOB NOT NULL -- via Electron safeStorage
);

CREATE TABLE table_classifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('reference', 'transactional', 'excluded')),
  UNIQUE (workspace_id, table_name)
);

CREATE TABLE selection_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('random', 'pattern', 'all', 'explicit')),
  anonymize INTEGER NOT NULL CHECK (anonymize IN (0, 1)),
  count INTEGER,
  column_name TEXT,
  pattern TEXT,
  explicit_values TEXT -- JSON
);

CREATE TABLE field_strategies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preserve', 'redact', 'fake', 'jitter')),
  generator TEXT,
  jitter_percent REAL,
  UNIQUE (workspace_id, table_name, column_name)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  row_counts TEXT,   -- JSON, e.g. {"users": 500, "orders": 1240}
  output_files TEXT, -- JSON: {"schema": path, "data": path} or {"combined": path}
  error_message TEXT
);
