-- Framework becomes a first-class concept: which one a workspace is, and where a classification
-- came from.
--
-- Until now "framework" existed only as a hardcoded Laravel name list and a button that seeded it.
-- That does not survive a second framework: nothing recorded which framework a workspace was, and
-- a preset-written classification was indistinguishable from a hand-set one — so re-applying could
-- only ever skip what was already there (migration 014 had to identify its own earlier writes by
-- matching table names, which works exactly once).
--
-- Two columns:
--
-- `workspaces.framework` — the framework this workspace's source belongs to, or NULL for none/not
-- yet known. Set by detection on discovery, overridable by hand.
--
-- `table_classifications.source` — 'manual' or 'preset:<frameworkId>'. This is what turns
-- re-applying a framework's presets into a *repair*: preset-written rows can be refreshed and
-- newly-listed tables added, while a hand-set classification is never touched. Existing rows
-- default to 'manual', which is the safe reading — it means "leave this alone".
--
-- **Neither column carries a CHECK constraint**, deliberately and unlike `class` beside it. The
-- framework catalogue lives in `src/shared/frameworks.ts` and grows by editing code; a CHECK would
-- make every new framework need a 12-step SQLite rebuild of this table. Validation belongs at the
-- repository boundary, which already rejects an unknown id.
--
-- Plain ADD COLUMNs, so SQLite widens both tables in place.

ALTER TABLE workspaces ADD COLUMN framework TEXT;

ALTER TABLE table_classifications ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

-- Adopt the rows the old Laravel preset button wrote, so the first re-apply on an existing
-- workspace repairs rather than skips.
--
-- Matched on **both** the table name and the class the preset would have given it. A row a user
-- moved somewhere else no longer matches and stays 'manual'; so does any table the presets never
-- named. The residual risk is a hand-set classification that happens to agree with the preset
-- exactly — and the cost of getting that one wrong is that a later re-apply resets it to the value
-- it already holds.
UPDATE table_classifications
   SET source = 'preset:laravel'
 WHERE class = 'structure'
   AND table_name IN (
     'sessions',
     'password_reset_tokens',
     'password_resets',
     'personal_access_tokens',
     'failed_jobs',
     'jobs',
     'job_batches',
     'cache',
     'cache_locks',
     'telescope_entries',
     'telescope_entries_tags'
   );

-- A workspace that carries those rows is a Laravel workspace; recording it saves re-detecting.
UPDATE workspaces
   SET framework = 'laravel'
 WHERE framework IS NULL
   AND id IN (SELECT workspace_id FROM table_classifications WHERE source = 'preset:laravel');
