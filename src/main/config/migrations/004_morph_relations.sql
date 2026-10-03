-- Polymorphic ("morph") relations — Laravel's `*_type` + `*_id` column pairs, where the *type*
-- column names the target model and the *id* column is that model's primary key. See
-- docs/polymorphic-cascade.md.
--
-- These carry NO foreign-key constraint (the target table varies per row), so they are invisible to
-- `getForeignKeys()` and therefore to both cascade and parent backfill. They also can't be
-- introspected *as relations* — only guessed at from column naming — so the user declares them here.
--
-- **Declaring a relation is the opt-in.** An undeclared morph behaves exactly as it does today:
-- ignored. That keeps this table inert until the engine reads it, and gives direct control over
-- which morphs affect a dump (you'd declare `documents`, but likely not `vector_embeddings`).
--
-- Two directions, each opt-in per relation, because they do different jobs:
--   cascade_down — keep an entity, pull the rows it owns (coverage; changes dump size, so OFF by
--                  default: declaring a relation shouldn't silently grow the subset)
--   backfill_up  — a kept row's morph reference must point at a row that's also kept (integrity;
--                  ON by default, matching the always-on plain-FK parent backfill)

CREATE TABLE morph_relations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  type_column TEXT NOT NULL,
  id_column TEXT NOT NULL,
  cascade_down INTEGER NOT NULL DEFAULT 0,
  backfill_up INTEGER NOT NULL DEFAULT 1,
  -- One declaration per type column. A table with two morphs (distinct `*_type` columns) gets two
  -- rows, which is why the key isn't just (workspace, table).
  UNIQUE (workspace_id, table_name, type_column)
);

-- The type→table map: one row per **canonical** type value seen in the data. Masq does not try to
-- reconcile two spellings of the same entity (`App\Models\User` vs a bare `user`) — that's a source
-- data-hygiene problem fixed upstream, either by a data cleanup or a consistent
-- `Relation::enforceMorphMap()`. Deliberate morph-map *aliases* (different real targets under short
-- names) are fully supported: they're just normal one-value-per-target entries.
--
-- A type value present in the data but absent here is logged and skipped by the engine, never
-- silently dropped, so the gap surfaces instead of quietly shrinking the dump.
CREATE TABLE morph_type_map (
  id TEXT PRIMARY KEY,
  morph_relation_id TEXT NOT NULL REFERENCES morph_relations(id) ON DELETE CASCADE,
  type_value TEXT NOT NULL,
  target_table TEXT NOT NULL,
  UNIQUE (morph_relation_id, type_value)
);
