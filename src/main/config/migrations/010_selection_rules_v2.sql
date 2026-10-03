-- Selection rules v2 (docs/selection-rules-v2.md): split `strategy` into a filter and a take.
--
-- v1's `SelectionStrategy` fused two orthogonal questions — "which rows qualify" and "how many of
-- them to keep" — and each of its four values pinned one axis: `random` couldn't be filtered,
-- `pattern` couldn't be limited, and `pattern` filtered one column by one regex, so an AND of two
-- conditions had nowhere to go. The whole filtered-AND-limited half of that grid was unreachable,
-- which is why "users with no work email, created in the last 90 days, take 20" could not be
-- written at all. v2 stores the two axes separately: `conditions_json` + `match_mode` say which
-- rows qualify, `take_json` says how many to keep.
--
-- **A full 12-step rebuild, not ALTER TABLE.** SQLite cannot ALTER a CHECK constraint and `strategy`
-- carries one, so the table has to be recreated — the same tax migration 005 paid. The upside is
-- that the v1 → v2 rewrite rides along free, inside the INSERT … SELECT below.
--
-- Safe under `foreign_keys = ON` (which db.ts sets): the only inbound reference is
-- `selection_rules.workspace_id → workspaces(id)`, and nothing references `selection_rules`, so
-- dropping and renaming can't orphan another table.
--
-- **Why JSON columns rather than a `selection_conditions` child table.** A condition is never
-- addressed on its own, never queried across rules, and has no life outside the rule that owns it —
-- it fails the store's "one table per concept" grain (see migration 008's note) and matches the
-- `explicit_values` / `field_strategies.template_json` precedent already here. The cost is that
-- CHECK can't validate the payload, so shape validation lives at the repository boundary, where
-- `parseValues` already handled a malformed `explicit_values`.
--
-- **The `explicit` sentinel.** A v1 `explicit` rule is a list of PRIMARY KEY values, but the config
-- store doesn't hold any table's PK column name — that's a source-schema fact, and migrations run
-- at app start with no source connection to introspect. So the rewritten condition stores
-- `"column": null`, which the extract layer reads as "this table's primary key" and resolves live.
-- It also means an `explicit` rule keeps working if the table's PK is ever renamed.

CREATE TABLE selection_rules_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  -- How `conditions_json` combines: AND or OR. Flat — nested groups are `raw_where`'s job.
  match_mode TEXT NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all', 'any')),
  -- JSON array of { column, op, value?, includeNulls? }. '[]' = every row qualifies.
  conditions_json TEXT NOT NULL DEFAULT '[]',
  -- JSON: {"kind":"all"} | {"kind":"sample","count":n} | {"kind":"top","count":n,"orderBy":c,"dir":d}
  take_json TEXT NOT NULL DEFAULT '{"kind":"all"}',
  -- Verbatim SQL predicate, used INSTEAD OF conditions_json. NULL for builder-authored rules.
  raw_where TEXT,
  anonymize INTEGER NOT NULL CHECK (anonymize IN (0, 1))
);

-- The v1 → v2 rewrite. Lossless and behaviour-preserving in all four cases:
--
--   random N       →  where []                        · take {sample, N}
--   pattern col/re →  where [{col, matches, re}]      · take {all}
--   all            →  where []                        · take {all}
--   explicit vals  →  where [{null(pk), in, vals}]    · take {all}
--
-- `json_array`/`json_object` come from SQLite's JSON1 extension, which better-sqlite3 bundles.
-- `json(explicit_values)` re-parses the stored text so the values land as a real JSON array rather
-- than as a quoted string.
INSERT INTO selection_rules_new
  (id, workspace_id, table_name, match_mode, conditions_json, take_json, raw_where, anonymize)
SELECT
  id,
  workspace_id,
  table_name,
  'all',
  CASE strategy
    WHEN 'pattern' THEN json_array(json_object('column', column_name, 'op', 'matches', 'value', pattern))
    WHEN 'explicit' THEN json_array(json_object('column', NULL, 'op', 'in', 'value', json(COALESCE(explicit_values, '[]'))))
    ELSE json_array()
  END,
  CASE strategy
    -- "count" is quoted so it reads as the column, not as the aggregate function's name.
    WHEN 'random' THEN json_object('kind', 'sample', 'count', COALESCE("count", 0))
    ELSE json_object('kind', 'all')
  END,
  NULL,
  anonymize
FROM selection_rules;

DROP TABLE selection_rules;

ALTER TABLE selection_rules_new RENAME TO selection_rules;
