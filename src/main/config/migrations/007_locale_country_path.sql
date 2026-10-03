-- Locale from a JSON path, not just a column (spec §8).
--
-- `table_locale_sources.country_column` names a *column*, which is not where the country actually
-- lives in every schema. Measured on the real workspace: `users.country_code` is populated on only
-- **3 of 18** rows, so 15 users fall back to `en` and get US-shaped postcodes and phone numbers —
-- while the same rows carry a perfectly good country inside `users.address`, a JSON blob with a
-- `country` key. Naming a column could not reach it, which made this a genuine feature gap rather
-- than a configuration mistake.
--
-- So a source is now (column, optional path): with `country_path` NULL the column's own value is the
-- country, exactly as before; set it and the column is read as JSON and the dot path walked
-- (`address` + `country`). The path convention is the same one template field strategies already use
-- for their bindings, so there is one definition of what a path means (see `readPath`).
--
-- A plain ADD COLUMN — no CHECK constraint to widen, so no table rebuild. Existing rows read back
-- with `country_path` NULL, which is the pre-existing behaviour unchanged.

ALTER TABLE table_locale_sources ADD COLUMN country_path TEXT; -- dot path within the column's JSON
