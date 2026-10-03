-- Per-edge backfill policy: what parent backfill does with one foreign-key column.
--
-- `backfillSelection` makes every kept row's FK point at a row that is also kept, by pulling the
-- missing parent in. That is the right answer for an *ownership* edge (`submissions.user_id` — the
-- submission belongs to that user) and the wrong one for an *incidental* edge (`submissions
-- .welded_by_user_id` — which member of staff happened to touch it). Following both is why a
-- "20 random users" rule produces a dump with 74 users: measured on a real Laravel schema, 26 FK
-- columns point at `users` and half of them are staff/actor references that drag in whole
-- populations nobody asked for.
--
-- A `null` policy says: don't pull the parent in — emit NULL for that column instead, on any row
-- whose reference points outside the subset. The dump stays referentially clean (a NULL references
-- nothing), it just stops growing.
--
-- **Only nullable columns can carry `null`.** A NOT NULL column has no safe answer here: nulling it
-- makes the dump fail to load. That can't be a CHECK — nullability lives in the *source* schema, not
-- this store — so it's enforced in the UI (which introspects) and re-checked at extract time, where
-- an unsafe policy is downgraded to `follow` with a warning rather than producing an unloadable dump.
--
-- Keyed on (table, column) rather than on the constraint: the decision is about the *column* ("is
-- this reference worth pulling a record in for"), and keying it this way stays stable if a constraint
-- is renamed. A column may legally carry more than one foreign key, so a policy governs all of them
-- together — which is the only coherent reading, since a single stored value cannot be followed for
-- one constraint and nulled for another. The engine treats them as a set: backfill skips every
-- constraint on the column, and a value is kept only if it satisfies every one of them.
--
-- Polymorphic edges deliberately aren't covered — `morph_relations.backfill_up` already says
-- "don't follow this upward" for a declared morph, so a second mechanism would be two switches for
-- one behaviour.
--
-- Absence means `follow`, which is the behaviour every existing workspace already has. Storing
-- `follow` explicitly is allowed and means the same thing; the UI deletes the row to reset instead,
-- so the table stays a list of deliberate exceptions.

CREATE TABLE fk_backfill_policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The CHILD table the foreign key leaves from (the table holding the column).
  table_name TEXT NOT NULL,
  -- The foreign-key column on `table_name`.
  column_name TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('follow', 'null')),
  UNIQUE (workspace_id, table_name, column_name)
);
