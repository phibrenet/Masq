-- Where a workspace's dumps are written.
--
-- Until now the destination was hardcoded to `<userData>/dumps` — a path inside the app's own
-- support directory, which is somewhere most people never look and nowhere anyone wants a dump they
-- intend to hand to a developer. A workspace can now point at a real folder: a shared drive, a
-- project directory, wherever the dump is actually consumed from.
--
-- NULL (and empty) means "use the default", which is what every existing workspace gets. The
-- default is resolved at run time rather than written in here on purpose: `app.getPath('userData')`
-- differs per OS and per dev-vs-packaged build, so baking one machine's answer into the config store
-- would follow the file somewhere it is wrong.
--
-- A plain ADD COLUMN, unlike migrations 005 and 010: no CHECK constraint is involved, so SQLite can
-- widen the table in place rather than needing the 12-step rebuild.

ALTER TABLE workspaces ADD COLUMN dump_output_dir TEXT;
