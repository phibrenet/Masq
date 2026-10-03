-- Declared identity source (spec §7–§8): which entity a table's rows belong to.
--
-- Cross-table anonymization identity (2026-08-20) makes a cascaded row's fake values come from the
-- entity that pulled it in, so `payments.cardholder_name` matches `users.name`. It derives that from
-- the **cascade graph**, which cannot tell an *ownership* edge (`users → orders`) from an *incidental*
-- one (`posts → comments`, where the commenter is not the post's author). On an incidental edge every
-- descendant of one root shares that root's fake values — right for the former, wrong for the latter.
--
-- This table lets the answer be declared instead of inferred: for one table, the column holding the
-- owning entity's id, and the table that entity lives in. `comments.user_id → users` makes each
-- comment take its *own* commenter's identity, overriding whatever the cascade would have propagated.
--
-- **The entity table is stored, not derived from the foreign-key graph.** Deriving it would fail
-- exactly where this feature is most needed: Laravel schemas frequently carry no FK constraints at
-- all (the same reason `morph_relations` has to be declared rather than introspected), and a table can
-- legitimately hold two FKs to the same parent, which no graph lookup can disambiguate.
--
-- One source per (workspace, table): a row belongs to one entity. If a schema ever needs
-- per-generator identity (name from one entity, address from another), that is a different feature
-- and a different table — not a nullable column bolted onto this one.
--
-- Deliberately a table of its own rather than more columns on `table_locale_sources`: the config
-- store's grain is one table per concept (`table_classifications`, `selection_rules`,
-- `field_strategies`, `table_locale_sources`, `morph_relations`), the two have different consumers
-- (locale feeds `fakerFor`, identity feeds `anonymizeRow`'s `identityKey`), and merging them would
-- produce rows whose meaning depends on which columns happen to be non-NULL.

CREATE TABLE table_identity_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  -- The column on `table_name` holding the owning entity's id (e.g. `user_id`).
  identity_column TEXT NOT NULL,
  -- The table that entity lives in (e.g. `users`). Combined with the column's value this yields the
  -- same `table:pk` identity string a kept row of that table uses for itself, so the fake values agree.
  identity_table TEXT NOT NULL,
  UNIQUE (workspace_id, table_name)
);
