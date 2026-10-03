-- Template field strategies for JSON columns (docs/template-anonymizer.md): a `bindings` list of
-- (JSON path → generator) pairs, overlaid onto each row's real value.
--
-- Two changes to `field_strategies`:
--   * `kind` gains 'template'
--   * a new `template_json` column holds the serialized bindings
--
-- **SQLite cannot ALTER a CHECK constraint**, so widening `kind` needs the full 12-step table
-- rebuild (create new → copy → drop old → rename) rather than the `ADD COLUMN` that migrations 003
-- and 004 could use. `template_json` is added in the same rebuild since we're paying for it anyway.
--
-- Safe under `foreign_keys = ON` (which `db.ts` sets): the only inbound reference is
-- `field_strategies.workspace_id → workspaces(id)`, and nothing references `field_strategies`, so
-- dropping and renaming can't orphan another table. The copy carries every existing row verbatim.
--
-- Numbering note: this plan originally called itself migration 004, but morph support
-- (docs/polymorphic-cascade.md) landed first and took that number — the two are independent
-- features and the plans agreed that whichever shipped first would claim 004.

CREATE TABLE field_strategies_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preserve', 'redact', 'fake', 'jitter', 'template')),
  generator TEXT,
  jitter_percent REAL,
  -- JSON array of { path, generator }. NULL for every non-template kind.
  template_json TEXT,
  UNIQUE (workspace_id, table_name, column_name)
);

INSERT INTO field_strategies_new
  (id, workspace_id, table_name, column_name, kind, generator, jitter_percent, template_json)
SELECT id, workspace_id, table_name, column_name, kind, generator, jitter_percent, NULL
  FROM field_strategies;

DROP TABLE field_strategies;

ALTER TABLE field_strategies_new RENAME TO field_strategies;
