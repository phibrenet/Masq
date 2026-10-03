# Glossary

Domain terms used across the code and spec. Add a term the first time it appears and
isn't self-explanatory. One or two sentences each.

- **Workspace** — a project the tool is being used against (any codebase/database — the
  app is general-purpose, not tied to one). All config (connections, rules,
  classifications, field strategies) is partitioned by `workspace_id` in one shared
  config SQLite file. Switching projects is just switching workspace.

- **Connection** — a stored source (or target) DB definition: dialect, host/port/db/user
  or file path. The password is *not* here — it lives encrypted in `credentials`.

- **Config store** — the app's *own* SQLite database in `userData`
  (`config.sqlite3`). Holds workspaces/rules/runs. Never the source or target DB, and
  never secrets.

- **Table classification** — every in-scope table is one of:
  - **excluded** — skipped entirely; not introspected, dumped, or cascaded through. For a table
    that genuinely shouldn't be in the dump (another app's tables in the same database, an oversized
    audit log) — *not* for "this data isn't worth copying", which is `structure`'s job.
  - **reference** — copied 100%, untouched, never anonymized (lookup/config tables).
  - **transactional** — goes through selection rules → cascade → field anonymization.
  - **structure** — the table's DDL is dumped, its rows never are (migration 013). Distinct from
    an unconfigured transactional table, which is still a cascade target and so fills up from its
    kept parents; `structure` is a guarantee, not an absence of configuration.

- **Framework** — which framework a workspace's source database belongs to (`laravel`, `rails`,
  `django`), stored on the workspace and detected from the discovered table names. Selects which
  table presets the Tables screen offers. The catalogue is code, in `src/shared/frameworks.ts`.

- **Classification source** — whether a table classification was set by hand (`manual`) or written
  by a framework's presets (`preset:<framework>`). What lets re-applying presets refresh their own
  rows without ever overwriting a deliberate choice.

- **Obfuscate** — a field strategy that scrambles the first or last N characters of a value while
  preserving each character's class (letter→letter, digit→digit, punctuation untouched), so the
  result keeps the original's shape. Minimum 6 characters; seeded on the value, so identical inputs
  scramble identically and joins on the column survive.

- **Selection rule** — how rows are chosen from a transactional table: a *filter* (`where` +
  `match`, or a `rawWhere` SQL escape hatch) plus a *take*, carrying an `anonymize` flag. Migration
  010 replaced v1's four strategies (`random`/`pattern`/`all`/`explicit`), which are now just presets
  over the same model. See [docs/selection-rules-v2.md](../docs/selection-rules-v2.md).

- **Condition** — one `column · operator · value` clause in a rule's `where` list, ANDed or ORed by
  the rule's `match` mode. Every operator but `matches` (regex) compiles to portable SQL and is
  pushed into the query; `matches` is evaluated in Node over whatever the pushed half returned —
  except in an `any` rule, where one regex forces the whole filter client-side (OR can't be narrowed
  in stages). `column: null` means "this table's primary key".

- **Take** — the second half of a rule: how many qualifying rows to keep. `all`, `sample N` (random,
  `ORDER BY RAND()`), `top N` (ordered by a column — deterministic, so a re-run reproduces the same
  dump), or `none` (see *Flag-only rule*). Withheld from SQL whenever a client-side condition still
  has to run, or the limit would cap rows before the regex filtered them.

- **Flag-only rule** — a selection rule with `take: { kind: 'none' }`: it adds no rows and only sets
  `anonymize` on rows the subset already contains, applied by `applyFlagRules` *after* cascade and
  backfill. Exists because "don't anonymize staff" is not "include all staff" — seeding a
  well-connected table drags in everything it touches. It can only ever *lower* the flag, so an
  anonymizing flag rule is a no-op.

- **Cooperative cancellation** — how a run is stopped: a `Proxy` around the `DbAdapter` throws
  `CancelledError` before each call once the run's `AbortSignal` fires, plus a per-row check in the
  dump writer. It stops at the *next* query or row and never kills in-flight SQL.

- **Push-down / client-side split** — which half of a rule the database answers and which half Node
  does. Decided by `partitionConditions`; the same `planRule` drives both the extract and the Rules
  screen's preview, so the preview counts what a run will actually keep.

- **Seed rows** — the rows a selection rule matches directly, before cascade and backfill. Not the
  row count in the dump: `users: random 20` produced 74 users once backfill followed staff FKs. The
  UI names the field this way deliberately, because "limit" is a lie.

- **Cohort** — _(designed, deferred)_ a label a selection rule attaches to the rows it matches, so a
  field strategy can be scoped to it (`users.email → preserve for staff, fake otherwise`). The
  answer to "keep **most** details for these rows", which the per-row `anonymize` boolean can't
  express. See [docs/selection-rules-v2.md](../docs/selection-rules-v2.md).

- **Cascade** — propagation of row selection + the `anonymize` flag from parent to child
  tables through the FK graph (`users` → `orders` → `payments`), preserving "preserve wins".

- **Link table** — a pivot the engine can't address by a single id (composite or missing primary
  key) and that nothing references, so its rows are chosen by **endpoint match** — keep every row
  whose foreign keys all point at rows already kept — rather than by a kept id set. Streams verbatim:
  every column is a key, so there is nothing to anonymize. `label_card_lookups`, Spatie's
  `model_has_roles`. Where no constraint declares an endpoint, its target is **inferred from the key
  column's name** and validated against the real table list (`grading_report_id` → `grading_reports`),
  reported every run and marked `→?` in the log. See
  [src/main/extract/link-tables.ts](../src/main/extract/link-tables.ts).

- **Row filter** — the predicate `streamRows` narrows a table with: an allowed-value set per column
  (ANDed `IN`s), plus the polymorphic form a link table needs — an OR of `(type = ? AND id IN (…))`
  groups, since which set an id must belong to is chosen per row by its type column.

- **Field strategy** — per-column anonymization: `preserve`, `redact` (null it),
  `fake` (faker generator), or `jitter` (perturb a numeric amount by a percent).

- **Identity key / seeded faker** — the stable value (real PK/email) hashed with SHA-256
  to seed faker, so one person's fake data is identical everywhere they appear. Cascaded
  children seed from the *parent's* identity, not their own row.

- **Dangling FK rule** — if a kept table references an *excluded* table, null out the
  orphaned FK value on write. Null is the safe v1 default; configurable per-column later.

- **Combined vs. split output** — per-workspace dump mode. Combined = one `.sql`
  (schema + data). Split = `{name}.schema.sql` + `{name}.data.sql`, so a team applies
  schema once and re-runs just the data file for fresh anonymized snapshots.

- **Reference vs. transactional** — see *Table classification* above.

- **Rowid alias** — a SQLite column declared *exactly* `INTEGER PRIMARY KEY` in a rowid table:
  it becomes another name for the row's internal `rowid` and auto-assigns on a NULL insert, whether
  or not `AUTOINCREMENT` was written. `INT PRIMARY KEY` is **not** one. It is what
  `getSequenceColumns` reports for SQLite, and it has no index of its own (so `PRAGMA index_list`
  never mentions it).

- **Safe integers** — the `better-sqlite3` mode Masq opens SQLite sources with, returning every
  INTEGER as a JS `bigint` so an int64 is exact. Off, values beyond 2^53 are silently rounded through
  a double. The adapter narrows each value straight back to a `number` (or a decimal string when that
  would lose precision) — see `narrowInteger`, and note it applies to `PRAGMA` output too.

- **Shadow table** — a real table SQLite creates to back a virtual table (an `fts5` index owns
  `…_config`, `…_content`, `…_data`, `…_docsize`, `…_idx`). `sqlite_master` reports them as ordinary
  tables; `PRAGMA table_list` labels them `shadow`, which is why introspection reads the latter.

- **Design token** — a named colour/size in `src/renderer/src/assets/tokens.css` (e.g. `--accent`,
  `--c-reference`, `--s-fake`). Stored as RGB triples so styles can add alpha. The only place colours
  are defined in the renderer; naive-ui's theme is built from them at runtime.

- **Tone** — the name of a token a badge, chip, segment or dot is coloured with (`ok`,
  `cls-reference`, `strat-fake`…), mapped in `components/ui/tones.ts`.

- **Pipeline step status** — the dot (done) or warning pill (attention, with a count) beside each
  sidebar item, derived in `stores/pipelineStatus.ts`. No indicator means "to do" or "can't tell yet".

- **Suspected PII column** — a column in a transactional table whose name matches the personal-data
  heuristic in `lib/pii.ts` and has no field strategy. Drives the Field Strategies banner and badge.
