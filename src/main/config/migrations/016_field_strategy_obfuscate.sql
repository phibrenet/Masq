-- A fifth field-strategy kind: `obfuscate` — scramble the first or last N characters of a value.
--
-- The gap it fills. `fake` replaces a value outright, which loses every property of the original;
-- `redact` nulls it. Neither suits a value that has to stay *recognisably itself* while stopping
-- being identifying — a customer reference, an account number, a licence key. Keeping the stable
-- part and scrambling a fixed run of characters does, and it is what people reach for when a value
-- is looked up or quoted in support tickets.
--
-- Two columns: which end to scramble, and how many characters. **A minimum of 6 is enforced at the
-- repository boundary, not here.** A CHECK could express `>= 6`, but the count is also validated in
-- the form and in the workspace-transfer reader, and putting the rule in three places invites them
-- to disagree; the repository is the one every write passes through. The column is left permissive
-- so an existing row can never become unreadable if that minimum is ever revised.
--
-- **A 12-step rebuild, not ALTER TABLE.** `kind` carries a CHECK constraint and SQLite cannot alter
-- one, so the table is recreated — the same tax migration 005 paid to add `template`. Existing rows
-- carry through unchanged; `obfuscate` is only ever reached by an explicit choice.
--
-- Safe under `foreign_keys = ON` (which db.ts sets): the only inbound reference is
-- `field_strategies.workspace_id → workspaces(id)`, and nothing references this table.

CREATE TABLE field_strategies_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('preserve', 'redact', 'fake', 'jitter', 'template', 'obfuscate')),
  generator TEXT,
  jitter_percent REAL,
  -- JSON array of { path, generator }. NULL for every non-template kind.
  template_json TEXT,
  -- 'first' | 'last', and how many characters. NULL for every non-obfuscate kind.
  obfuscate_side TEXT,
  obfuscate_count INTEGER,
  UNIQUE (workspace_id, table_name, column_name)
);

INSERT INTO field_strategies_new
  (id, workspace_id, table_name, column_name, kind, generator, jitter_percent, template_json,
   obfuscate_side, obfuscate_count)
SELECT id, workspace_id, table_name, column_name, kind, generator, jitter_percent, template_json,
       NULL, NULL
  FROM field_strategies;

DROP TABLE field_strategies;

ALTER TABLE field_strategies_new RENAME TO field_strategies;
