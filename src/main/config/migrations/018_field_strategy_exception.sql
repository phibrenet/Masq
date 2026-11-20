-- A field strategy may carry one exception: a different rule for the rows of the column that match a
-- set of conditions — `users.email` on an ID-keyed example.com address, except staff rows, which keep
-- their domain because the app decides who is staff from it.
--
-- Stored as JSON (`{ match, conditions, rule }`), NULL when there is none. The conditions are the
-- selection-rule `Condition` shape and the rule is any non-template rule, so both already have
-- validators. The repository reads it leniently and flags anything it can't read as `invalid`, which
-- the run refuses, as with selection rules. Plain ADD COLUMN: existing rows have no exception.

ALTER TABLE field_strategies ADD COLUMN exception_json TEXT;
