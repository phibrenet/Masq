-- Run warnings on the Runs screen (spec §10). The extract already produces warnings that matter
-- more than anything else it prints — the references it could NOT repair, the FK constraints it had
-- to strip from the DDL, the polymorphic type values it couldn't map, the tables it couldn't address
-- by a single-column PK. Every one of those describes a way the dump is quietly less complete than
-- the rules imply, and until now they went to `console.warn` only: invisible to anyone running the
-- app normally, which is everyone.
--
-- Stored as a JSON array of already-formatted, stage-prefixed strings ("backfill: …", "morph: …").
-- Deliberately not a structured shape: the renderer only lists them, so parsing them into
-- code/table/column fields would be a schema to maintain for no reader. If a future UI wants to
-- filter or link them, that's the migration to write then, against a known requirement.
--
-- A plain ADD COLUMN like migrations 003 and 004 — no CHECK constraint changes, so none of the
-- table-rebuild dance migration 005 needed. Existing rows read back as NULL, which the repository
-- maps to `undefined`, so historical runs simply show no warnings rather than an empty list.

ALTER TABLE runs ADD COLUMN warnings TEXT; -- JSON array of strings, e.g. ["backfill: …"]
