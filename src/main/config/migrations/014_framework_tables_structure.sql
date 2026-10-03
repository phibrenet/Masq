-- The framework-table presets mean "none of this data", not "none of this table".
--
-- Migration 013 added the `structure` class; this corrects what the presets have been writing.
-- `sessions`, `cache`, `jobs` and the rest carry no useful developer data, which is why they were
-- preset to `excluded` — but they are still **expected to exist**. A dump meant to stand up a fresh
-- database has to contain every table the app writes to, and `excluded` drops the CREATE as well as
-- the rows: the app then fails on its first request that touches one, and the failure looks like a
-- bug in the app rather than a gap in the dump. `structure` is what was always meant — schema in,
-- rows out.
--
-- Scoped to exactly the preset names, and only where the class is still `excluded`. A table someone
-- excluded deliberately keeps that choice; the only rows rewritten are ones this app's own preset
-- button wrote. Kept in step with `LARAVEL_STRUCTURE_PRESETS` in `src/shared/presets.ts` — if a
-- name is added there, it does not need adding here (new workspaces get `structure` directly);
-- this list is only the historical repair.
--
-- `excluded` remains a class and remains the right answer for a table that genuinely should not be
-- in the dump at all — another app's tables sharing the database, or an audit log too large to be
-- worth the DDL.

UPDATE table_classifications
   SET class = 'structure'
 WHERE class = 'excluded'
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
