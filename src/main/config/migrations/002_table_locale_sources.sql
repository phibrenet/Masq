-- Data-driven faker locale (spec §8). Names the column whose value gives a row's country,
-- so `fake` field strategies (postcode/phone/address/…) produce country-appropriate output.
-- One locale source per (workspace, table); the value→locale mapping is resolved by the
-- anonymization engine at dump time. See the 2026-07-24 decision entry.

CREATE TABLE table_locale_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  country_column TEXT NOT NULL,
  UNIQUE (workspace_id, table_name)
);
