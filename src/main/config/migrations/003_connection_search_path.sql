-- Postgres schema/search path (spec §4). MySQL's `information_schema.table_schema` *is* the
-- database, so the MySQL adapter can scope introspection with `connection.database` alone. In
-- Postgres the database is chosen at connect time and `table_schema` names a *schema* within it —
-- and real apps often don't use `public` (Laravel exposes this as `DB_SEARCH_PATH`).
--
-- Stored as the raw, as-typed value so it round-trips whatever the app's own config holds,
-- including a comma-separated list (`tenant, public`). Parsing lives in
-- `src/main/adapters/search-path.ts`. NULL/blank means `public`.
--
-- Only meaningful for the postgres dialect; other dialects leave it NULL.

ALTER TABLE connections ADD COLUMN search_path TEXT;
