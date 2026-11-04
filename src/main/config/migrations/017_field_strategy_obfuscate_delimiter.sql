-- `obfuscate` gains a third side, `before`: scramble everything before the last occurrence of a
-- delimiter and keep the rest — `jane.doe@acme.com` before `@` keeps `@acme.com`.
--
-- One nullable column holds the delimiter. It is NULL for every rule except an `obfuscate` with
-- side `before`, which stores `obfuscate_count` as NULL instead; the repository writes exactly one
-- of the two. `obfuscate_side` has no CHECK constraint (migration 016 left it as plain TEXT), so
-- `before` needs no table rebuild — a plain ADD COLUMN is enough, and existing rows are untouched.

ALTER TABLE field_strategies ADD COLUMN obfuscate_delimiter TEXT;
