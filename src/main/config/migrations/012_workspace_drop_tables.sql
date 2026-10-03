-- Whether a dump drops each table before recreating it.
--
-- Without this, a combined dump can only ever be loaded into an empty database: the second load
-- fails on `table ... already exists` and nothing after that point runs. That makes the everyday
-- case Masq exists for -- "refresh my local copy from the latest dump" -- a manual drop-database
-- step the developer has to remember. Split dumps already TRUNCATE in the data file, so this
-- mainly repairs combined mode, but the schema file has the same re-runnability problem.
--
-- DEFAULT 1, and backfilled onto existing rows, rather than defaulting off: a dump that cannot be
-- re-applied is a bug in every workspace that has one, not a preference some workspaces hold. This
-- does change the output of existing workspaces on upgrade, which is the intent -- a per-workspace
-- checkbox turns it back off for anyone loading into a database they share with other data.
--
-- Stored as INTEGER because SQLite has no boolean type; the repository maps 0/1 at the row
-- boundary like the rest of the config store.
--
-- A plain ADD COLUMN with a constant default, like migration 011: no CHECK constraint, so SQLite
-- widens the table in place and every existing row picks up the default without a rebuild.

ALTER TABLE workspaces ADD COLUMN drop_existing_tables INTEGER NOT NULL DEFAULT 1;
