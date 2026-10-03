-- A fourth table class: `structure` — dump the table's DDL, never any of its rows.
--
-- The gap this closes. "Transactional with no selection rule" *looked* like schema-only and is what
-- the Tables screen steered you towards, but it is only empty by accident: FK cascade pulls a child
-- row in for every kept parent, and a rule-less table is still a cascade target. Laravel's
-- `sessions` has a `user_id`, so the moment any rule seeds `users`, live session payloads land in
-- the dump — silently, with no rule anywhere in the workspace saying so. The alternatives were both
-- wrong: `excluded` drops the CREATE too, so the app fails on its first write to the table, and
-- `reference` means "copy 100%", which is the opposite of what is wanted.
--
-- `structure` states the intent instead of relying on the absence of configuration: the DDL is
-- dumped, cascade and backfill never reach it, and no rule can add to it.
--
-- **A 12-step rebuild, not ALTER TABLE.** `class` carries a CHECK constraint and SQLite cannot
-- alter one, so the table is recreated — the same tax migrations 005 and 010 paid. Nothing is
-- rewritten on the way through: every existing row keeps the class it had, and `structure` is only
-- ever reached by an explicit choice on the Tables screen.
--
-- Safe under `foreign_keys = ON` (which db.ts sets): the only inbound reference is
-- `table_classifications.workspace_id → workspaces(id)`, and nothing references this table, so
-- dropping and renaming cannot orphan anything.

CREATE TABLE table_classifications_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('reference', 'transactional', 'structure', 'excluded')),
  UNIQUE (workspace_id, table_name)
);

INSERT INTO table_classifications_new (id, workspace_id, table_name, class)
SELECT id, workspace_id, table_name, class FROM table_classifications;

DROP TABLE table_classifications;

ALTER TABLE table_classifications_new RENAME TO table_classifications;
