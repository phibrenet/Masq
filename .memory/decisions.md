# Decisions Log

Append-only record of architectural and technical decisions. Newest at the top.
Each entry: **date — decision**, then the *why*. Don't delete; supersede with a new
entry and link back if a decision is reversed.

Entries below marked _(from spec v1)_ were established in the initial technical spec
([docs/db-subsetter-spec.md](../docs/db-subsetter-spec.md)) rather than during build.

---

## 2026-10-03 — Start the public repository from a source snapshot

The owner created a new phibrenet/Masq repository after choosing to keep development history
private. Publish the current tracked files as one new root commit, retaining the existing code,
tests, synthetic screenshots and generalized project memory. Recreate v0.1.0-alpha.1 on this
new history. Historical commit hashes and PR numbers below describe the previous development
repository. The old local Git metadata is preserved separately; no old commits or branches are
pushed to the new repository. A snapshot removes old Git history from the new remote, not from
previous clones, forks, archives or any sensitive content still present in current files.


## 2026-10-03 — Use native absolute path fixtures in cross-platform tests

The first Windows CI run found five assertions assuming POSIX separators. Use OS temp paths and
native separators in dump-dir and workspace CRUD fixtures; do not change runtime normalization
or weaken comparisons by accepting either separator. Construct redundant segments manually so
the normalization assertion still tests work done by Masq, rather than pre-normalizing its input.


## 2026-10-03 — Prepare a source-only public alpha with explicit safety limits

Keep the new synthetic screenshots and diagram links; qualify privacy, referential-integrity and
read-only claims against the actual code and threat model. Document external pg_dump, native-module
setup, preservation defaults and known restore limits so new users can judge an alpha accurately.
Replace company-specific examples, domains and personal example paths across tracked source, tests,
docs and memory with fictional equivalents. This supersedes the earlier first-run demo naming;
decision content and chronology are retained, and existing persisted workspaces are not migrated.
Git history is not rewritten, so a historical publication audit remains necessary.

Use Node 22 and npm ci for Linux/macOS/Windows CI, with lint, typecheck, Electron-based tests and
build, without release or signing steps. Add contributor guidance and a private GitHub reporting
policy; the repository setting must be enabled before publication. No runtime security boundary
changes are made, and the known raw-predicate risk remains open rather than being described as fixed.

A clean install reported one HTTP-cache advisory propagated into eight high-severity audit entries
through electron-builder. An in-range transitive update and npm audit fix dry run did not resolve it;
retain the lockfile and record the finding rather than force unrelated Electron upgrades or silently
ignore the advisory. Production build, lint, typecheck and 280 tests pass with the clean install.


## 2026-09-29 — README screenshots come from a synthetic database; diagram Pages site is dormant

The README was rewritten for the first alpha with screenshots in `docs/screenshots/`. They were
taken from the built app on a throwaway `--user-data-dir` profile against a faker-generated
Laravel-style shop (SQLite, "Corner Shop" workspace), never the real config store. The first-run
seed's "Example Shop" workspace was deleted from that profile because it names internal hostnames.
Retake them the same way: 1440×900 window, `--force-device-scale-factor=2`, dark theme, plus a light
variant of the hero (`field-strategies-light.png`, served via `<picture>`). The architecture PNGs
are `docs/diagrams/dialect-connections.html?embed=1&theme=…` rendered at 2× and cropped.

`.github/workflows/pages.yml` publishes the interactive diagram to GitHub Pages, but the job is gated
on `github.event.repository.visibility == 'public'`. The repo is private and the `phibrenet` org is
on the free plan, which has no Pages for private repos. Gating means the job is skipped rather than
failing on every push. To go live: make the repo public, set Settings → Pages → Source to "GitHub
Actions", then re-run the workflow.

## 2026-09-27 — AGENTS.md is the canonical agent guide; THREAT_MODEL.md added

CLAUDE.md and AGENTS.md were hand-kept copies and had drifted: AGENTS.md still called SQL Server
"best-effort" and listed an `mssql` driver that isn't a dependency. A CI reviewer reading it would
have reviewed against the wrong facts. AGENTS.md is now the single source (most non-Claude agents
read it), and CLAUDE.md only imports it with `@AGENTS.md`. AGENTS.md gained a short "Reviewing a
change" section listing the rules a diff is checked against.

`THREAT_MODEL.md` (repo root) is written from the code, and each control cites the file that
enforces it, so a security reviewer can check claims instead of trusting them. It separates known
and accepted weaknesses (§5) so they aren't re-reported on every PR. One of them is new and not
verified: on Postgres, a raw predicate could call `set_config(...)` and switch off the read-only
session for later queries on that pooled connection. No CI workflow was added, at the owner's
request.

## 2026-09-27 — UI refresh: CSS-variable tokens + naive-ui, not Tailwind

Spec: [docs/masq-ui-refresh-spec.md](../docs/masq-ui-refresh-spec.md) (branch `feat/ui-refresh`).
The spec assumed Vue + Tailwind and said to adapt if the stack differed. The renderer is naive-ui
with scoped CSS and no Tailwind, so **no Tailwind was added**. Instead:

- **Tokens** live only in `src/renderer/src/assets/tokens.css` as RGB triples (`--accent: 124 92 255`),
  used as `rgb(var(--x) / alpha)`. A light set sits under `:root[data-theme='light']`, switched by the
  theme store, so the existing Appearance setting keeps working (dark stays default and is the design
  target).
- **naive-ui reads the same tokens at runtime** (`theme/naive.ts` → `getComputedStyle`), because it
  can't take `var()` (it parses colours to derive hover shades). One definition, no drift.
- **Tones by name, not class concatenation**: badges, chips, segments and dots set `--tone` from the
  static table in `components/ui/tones.ts`. The spec's "build class maps statically" concern was about
  Tailwind purging; this is the equivalent without it.
- **Fonts bundled** via `@fontsource/inter` + `@fontsource/jetbrains-mono` (offline-safe; CSP is
  `default-src 'self'`).
- Shared primitives in `components/ui/` (Panel, SegmentedControl, Badge, MenuButton, StatusDot,
  FilterChips, EmptyState, SkeletonRows, TopBarActions, EngineIcon, AppIcon).

## 2026-09-27 — Frameless window; two small preload additions

`titleBarStyle: 'hidden'` with a Window Controls Overlay on Windows/Linux and traffic lights on macOS.
The renderer's 40px top bar is the drag region and reserves the overlay width via
`env(titlebar-area-*)` (140px fallback). Two additions crossed the boundary, both explicitly needed
by the spec: `window.api.platform` (layout differs per OS) and `system:setTitleBarTheme(dark)` so the
overlay recolours when Appearance switches to light (otherwise a dark strip sits over a light bar).
Overlay colours live in `src/main/title-bar.ts`.

## 2026-09-27 — Sidebar step status is derived, never stored; unknown shows nothing

`stores/pipelineStatus.ts` computes each step from what the other stores hold. Where the data isn't
in hand (no discovery this session → Tables; no columns read → Field Strategies) the step shows no
indicator rather than guessing. Connection test results are **session-only**
(`stores/connectionTests.ts`) — a test describes *now*, not the connection, so it isn't persisted.
Consequence: the sidebar badges/dots reset on restart until a test / discovery runs again.
Review follow-up (2026-09-29): a connection's result is dropped on any edit or delete
(`connectionTests.forget`, called from the connections store), because an edit keeps the id and a
password change is invisible to the renderer. A test still in flight across an edit is discarded.
Backfill counts as done once links have been read, including when there are none
(`backfillPolicies.edgesLoaded`).

## 2026-09-27 — PII heuristic: spec regex, plus word boundaries for short tokens

The spec's regex matched `ip` inside `description` and `stripe_id` and flagged `email_verified_at`
on the real Example Shop schema. `lib/pii.ts` keeps the spec pattern but requires `ip|zip|dob|ssn` to
be a whole `_`/`-` segment and skips `*_at`/`*_on` timestamps. Only transactional tables are checked
(strategies only apply there), and only tables whose columns were already read this session; reading
the rest is an explicit "Read their columns" click. Field-strategy previews are **illustrative
examples** (`lib/strategyDisplay.ts`), not samples — a real sample would mean reading the source from
the renderer.

## 2026-09-27 — Tables: Reset only on hand-set rows

Per the spec, Reset (delete the classification row) now appears only on `source = 'manual'` rows,
marked with an accent dot. Preset-sourced rows no longer offer Reset; re-applying presets or picking
a class covers them. Unclassified rows show a subtle "default" label and an "Unclassified" filter chip.

## 2026-09-27 — `runs.syncRunning` yields to a run this renderer started

The top bar's Run button navigates to Runs and starts a run in one gesture. The Runs screen's mount
calls `syncRunning()`, whose IPC could answer "nothing running" before main registered the new run,
flipping `running` back to false mid-extract (no progress bar, no Stop). `run()` now marks its own
in-flight run and `syncRunning` leaves `running` alone while it is set.

## 2026-09-24 — Electron 39 → 44, kept after an unplanned `npm audit fix --force`

The bump was not planned. `npm audit fix --force` was run against an advisory in the `@electron/get`
2.x subtree (`extract-zip` / `fs-extra` / `yauzl`); the only remedy npm found was Electron 44, which
moves to `@electron/get` 5. The log says so outright: `warn audit Updating electron to 44.4.5, which
is a SemVer major change`. Electron is the sole major in the resulting lock diff — everything else
is patch/minor churn from that same subtree.

**Kept rather than reverted** because 44 is what clears the advisory, and the suite is green on it:
typecheck passes, 249/249 tests pass, `npm audit` reports zero. Reverting would mean pinning back to
`^39.2.6` and carrying the advisory with no upgrade path short of this same major.

⚠ **What this bump has *not* been checked against.** The Electron boundary work in the entry below —
sandboxed preload, no `window.electron`/`process`, refused navigation and `window.open`, the
single-instance lock, `ipc-guard` caller checks — was Playwright-verified on **39**. A major jump is
where those boundaries move. Re-run that check against a 44 build before shipping; don't read the
2026-09-23 verification as covering 44.

⚠ **The install left the tree half-updated**, which is the failure mode to recognise if this recurs:
neither Electron's own postinstall nor our `electron-builder install-app-deps` postinstall ran, so
`node_modules/electron/dist` was missing entirely (→ `Error: Electron uninstall` from
`electron-vite dev`) and `better_sqlite3.node` was still built for the old ABI. `ignore-scripts` is
`false`; the reify step appears to have swapped the package without firing lifecycle scripts. After
any forced dependency surgery, verify both by hand — see the watch-item in
[state.md](state.md) for the recovery commands. The native module has since been rebuilt against
ABI 149.

## 2026-09-23 — Project review fixes: where each guarantee is now enforced

From [docs/project-review-2026-09-23.md](../docs/project-review-2026-09-23.md). All eleven findings
were accepted. The choices a future reader would otherwise have to reverse-engineer:

- **Selection decides what is emitted, even for `keepAll`.** The unfiltered stream is kept as a read
  shortcut, but a row absent from `selection.ids` is dropped (`buildRowStream`). A row inserted
  mid-extract used to come out with no anonymize flag, so with its real values. We chose this over
  a consistent snapshot, which would be the broader fix for concurrent writes but isn't needed to
  close the leak. Trade-off: a link row can now point at a dropped late parent.
- **Source reads are read-only at the database, and raw predicates can't contain `;` at all.**
  `createKnex` opens every MySQL/Postgres pooled connection with a read-only session
  (`SET SESSION TRANSACTION READ ONLY` / `default_transaction_read_only = on`). `rawWhereError`
  refuses any semicolon, even inside a string literal: telling the two apart needs per-dialect
  quoting rules, and one that slips through runs a second statement. Verified on MySQL 8.0: a
  DELETE and a multi-statement predicate are both rejected. We kept the raw predicate option
  rather than disabling it.
- **mysql2 `supportBigNumbers` + `dateStrings`.** Same stance as the Postgres verbatim OIDs: unsafe
  integers arrive as exact strings (safe ones stay numbers), and datetimes arrive as the server's
  text with full microseconds. Verified live against 2^53+1 and `.123456`.
- **The MySQL header now removes `NO_BACKSLASH_ESCAPES`.** This refines the 2026-09-22 "additive
  sql_mode" decision below rather than reversing it: every other mode the operator set is kept
  and the whole mode is restored at the end. `mysqlEscape` output is a syntax error under that
  mode (verified: `'O\'Reilly'` fails on 8.0).
- **Electron boundary.** `@electron-toolkit/preload` was removed, so only `window.api` crosses the
  bridge. The window is sandboxed, navigating away from the app is refused, and `openExternal` only
  handles http(s). Every IPC channel is registered through `registerHandlers` (`ipc-guard.ts`),
  which rejects callers other than the app's own top-level document. `runExtract` rejects a
  connection from another workspace. There is also a single-instance lock, because startup
  recovery assumes it owns the store.
- **Renderer caches are keyed by `discovery.sourceKey`** (connection id plus the fields that choose
  the database), not by workspace, so editing a source invalidates them without explicit clearing.
  Async form loads use a request counter, and store loads expose `loadError`, shown with a retry.

## 2026-09-23 — App icon: `art/subset-icon.svg` is the source; macOS gets a padded variant

The icon is drawn as a full-bleed rounded tile. Windows (`build/icon.ico`), Linux and the
runtime window icon (`build/icon.png`, `resources/icon.png`) use it edge to edge. The macOS
`build/icon.icns` puts the tile at 824px on a 1024 canvas instead, which is Apple's icon grid;
a full-bleed tile looks oversized next to other apps in the Dock. The PNGs are rendered with
`@resvg/resvg-js` (it handles the gradients and `feDropShadow`), the `.ico` with `png-to-ico`,
and the `.icns` with macOS `iconutil`. Re-render all four from the SVG whenever the art changes.

## 2026-09-22 — `obfuscate` field strategy: scramble N characters, preserving character class

A fifth field-strategy kind (migration 016, a 12-step rebuild since `kind` carries a CHECK).
`fake` replaces a value outright and loses every property of the original; `redact` empties it.
Neither suits a value that has to stay *recognisably itself* while ceasing to identify anyone — a
customer reference, an account number, a licence key, the things quoted back in support tickets.

Three decisions worth keeping:

**Character class is preserved.** A letter becomes a random letter of the same case, a digit a
random digit, and a dash, dot, `@` or space is left exactly as it was. The alternative — any
alphanumeric for anything in range — scrambles harder but destroys the value's format, and a column
with a CHECK constraint or a downstream parser would then reject what used to pass. Non-ASCII
letters are left alone too: substituting `é` with `k` changes the UTF-8 byte length, which can
overflow a column sized in bytes.

**Seeded on the value, not the row.** Every other strategy seeds on identity (`fake`) or on the row
(`jitter`). This one seeds on `column:value`, so two rows holding the same reference scramble to the
same output and a join or lookup on that column survives the dump. Seeding per row would break that
silently, and this rule suits exactly the columns people join on. The trade is the one every
deterministic mask makes: identical outputs reveal identical inputs.

**A minimum of 6, enforced at the repository boundary rather than in a CHECK.** Scrambling one or
two characters leaves a reference trivially re-identifiable by anyone holding the original list —
anonymization in appearance only. The repository is the single path every write passes through, so
the floor holds for the form, an imported file and any future caller alike; a CHECK would have
pinned it in a third place that could disagree. The two enforcement points differ on purpose: the
repository **raises** a low count, while the workspace-transfer reader **rejects** it, because a
shared file asking for 3 was written by someone who believed 3 was enough and silently importing it
as 6 would hide that from them.

Scoped to a whole-column rule; not offered as a template binding action inside JSON columns.

## 2026-09-22 — Backticks are normalised into the DDL, and drops sit with their creates

Import feedback, and two genuine defects. Supersedes the two entries below it from the same day.

**1. Asking the session for backticks was not enough.** The previous entry fixed identifier quoting
by stripping `ANSI_QUOTES` from the source session (`STRIP_ANSI_QUOTES`, an `afterCreate` hook) so
`SHOW CREATE TABLE` would hand back backticks. On a real `ANSI_QUOTES` source it **did not take
effect** — the next export still carried double-quoted `CREATE TABLE` statements — and I could not
determine why remotely. A dump's portability is too important to rest on a setting we can only
request, so the captured DDL is now rewritten deterministically instead:
`toBacktickIdentifiers` (`adapters/mysql.ts`) converts ANSI-quoted identifiers to backticks, gated
on the statement's own table identifier being double-quoted. That gate is what makes it safe — in
ordinary MySQL a `"` is a *string* delimiter, so an unconditional rewrite would turn literals into
identifiers; under `ANSI_QUOTES` that ambiguity doesn't exist. Backticks are the right target
because they are valid under **every** mode: `ANSI_QUOTES` adds `"` as an identifier quote, it never
removes the backtick. The session hook stays as belt-and-braces; nothing depends on it now.

**2. The dump was overriding a setting the operator had chosen.** `SET SESSION sql_mode =
'NO_AUTO_VALUE_ON_ZERO'` replaced the mode outright, silently discarding an `ANSI_QUOTES` the person
running the import had prepended to the stream to work around defect 1. It is now additive —
`CONCAT(@@SESSION.sql_mode, ',NO_AUTO_VALUE_ON_ZERO')`, with an `IF` for the empty-mode case. A dump
has no business overwriting the importing session's configuration, and once identifiers are
backticks it has no reason to: nothing in the file needs the mode cleared.

**3. Drops now sit with their creates, not in a block up front.** This reverses
"all of the drops go out before any of the CREATEs" from the `structure`/drop entry below. That was
chosen to stop a Postgres `DROP … CASCADE` reaching a constraint the same file had just created —
but for that a child would have to be dropped after its parent was created, which dependency order
already prevents except among circularly-referencing tables, and those cannot load from a combined
dump either way (the first `ALTER TABLE … ADD CONSTRAINT` in the cycle names a table the file has
not created yet). So the cascade risk was theoretical.

The blast radius was not. **MySQL commits every DDL statement as it runs and cannot roll them back**,
so when defect 1 failed the first CREATE, all 77 preceding DROPs had already committed and the
database was left holding one table. Interleaved, that same failure costs exactly one table:
everything before it is rebuilt, everything after it is untouched. The reporter's phrasing is the
rule worth keeping — *idempotent dumps are only idempotent if they run to completion* — and a
destructive-then-rebuild file has to be ordered for what happens when it doesn't.

## 2026-09-22 — A dump states its own quoting rules, on both the read and write side

Reported symptom: a dump that imports on one machine fails on another with quotation-mark errors.
The machine doing the import was never the variable — the **source server's** `sql_mode` was leaking
into the file.

`SHOW CREATE TABLE` renders identifiers according to the *session's* mode: with `ANSI_QUOTES` in
effect (directly, or via the compound `ANSI` mode that contains it) it emits `"users"`, without it
`` `users` ``. Masq copies that text into the dump verbatim. Any MySQL not running `ANSI_QUOTES`
reads `"users"` as a **string literal**, so the load dies on the first CREATE TABLE. Everything
Masq itself writes was already backticked via `mysqlEscapeId`; it was only the captured DDL that
varied, which is why it looked like a machine difference.

Fixed at both ends, because either alone is only half a contract:

- **Read side** — `createKnex` now runs an `afterCreate` that strips `ANSI_QUOTES` from the session
  mode, so captured DDL is always backticked. Only that one flag is removed, rather than pinning a
  whole mode, so everything else about how the server renders DDL is untouched. The value is
  rebuilt in SQL (wrap the list in commas, replace `,ANSI_QUOTES,` with `,`, trim) so it costs one
  round trip and can't leave the empty list element a naive REPLACE would.
- **Write side** — the dump pins `sql_mode = 'NO_AUTO_VALUE_ON_ZERO'` for the load and restores the
  previous value at the end, which is what `mysqldump` does. `NO_AUTO_VALUE_ON_ZERO` is not
  incidental: without it an explicit `0` in an AUTO_INCREMENT column is replaced by a freshly
  generated id, so a subset legitimately containing a zero id comes back different.

Postgres needed the analogous statement for a different reason. Identifier quoting needs nothing —
`"x"` is the standard spelling and no mode changes it — but `standard_conforming_strings` decides
whether a backslash inside `'…'` is an escape. `escapeLiteral` already emits the `E'…'` form where
it must, which is correct either way; the DDL captured from `pg_dump`, however, contains literals
Masq never wrote, and those are only safe under the setting pg_dump assumed. So the dump pins it on,
as pg_dump does. SQLite needs neither: it accepts every quoting style and has no session mode a
script could set.

`DumpDialect.setEncoding` was broadened to `sessionSettings` (plus `sessionRestore`) rather than
adding a third member — encoding and quoting are the same kind of statement, both saying "read what
follows this way", and both belong before anything else in the file.

## 2026-09-22 — Framework becomes a first-class concept, with classification provenance

"Framework" had been a hardcoded Laravel name list plus a button that seeded it. That does not
survive a second framework: nothing recorded which framework a workspace *was*, and a preset-written
classification was indistinguishable from a hand-set one — so re-applying could only skip what was
already there, and migration 014 had to identify its own earlier writes by matching table names, a
trick that works exactly once.

Three parts, all in migration 015 plus `src/shared/frameworks.ts`:

**A catalogue, in code rather than data.** `FRAMEWORKS` carries an id, a label, a detection
signature, and two table lists per framework (Laravel, Rails, Django to start). Adding a framework
is an edit to that file — which is why neither `workspaces.framework` nor
`table_classifications.source` carries a CHECK constraint, unlike `class` beside them: an id set
that grows with the code would otherwise cost a 12-step SQLite rebuild per framework. Validation
sits at the repository boundary, and both columns read defensively so an id written by a newer build
degrades to "none" rather than becoming a value nothing can resolve.

**Detection, offered rather than imposed.** `detectFramework` matches a signature against the
discovered table names: `all` tables must be present, plus one of `any` when given. Discovery sets
the framework **only when the workspace has none**; a mismatch with an already-set framework raises
a banner instead. Signatures are deliberately narrow — Laravel needs `migrations` *and* a
Laravel-specific companion, because `migrations` alone is a name Phinx, Knex and half the world's
hand-rolled runners also use. A confident wrong answer silently reclassifies tables, so an
undetected framework is much the better failure.

**Provenance, which is what makes re-applying a repair.** `table_classifications.source` is
`'manual'` or `'preset:<frameworkId>'`. Applying presets adds missing rows, refreshes rows this same
framework's presets wrote, and never touches a hand-set one — reporting the skipped names, since the
whole point is that someone chose those. Done as one transaction in main: a half-applied preset set
leaves a workspace in a state nobody chose and the caller no way to tell how far it got.

**A correctness bug found while building the catalogue.** Migration ledgers were never classified at
all, so they defaulted to transactional — empty unless a rule or a cascade happened to fill them. A
dump whose `migrations` / `schema_migrations` / `django_migrations` table is empty tells the
framework nothing has ever run, and the next deploy or `migrate` re-applies every migration against
an already-populated database. They are now `reference` (copied whole), with a catalogue test
asserting no ledger can ever be listed as `structure`.

## 2026-09-22 — Framework presets mean "none of this data", not "none of this table"

The Laravel presets classified `sessions`, `cache`, `jobs` and the rest `excluded`, which drops the
CREATE along with the rows. That was wrong about what a dump is for: it has to stand up a **working**
database, and the app writes to `sessions` and `cache` on the first request that reaches them. A
table missing from the dump surfaces as a failure in the app, which reads as an app bug rather than
a gap in the dump — the worst possible place for that to show up.

These tables carry no useful developer data *and* are expected to exist. `structure` (the class
added earlier the same day) is exactly that, so the presets now write `structure`:
`LARAVEL_EXCLUSION_PRESETS` → `LARAVEL_STRUCTURE_PRESETS`, and the button reads "Add framework
presets".

Migration 014 repairs existing workspaces, narrowly: `excluded` → `structure` for exactly the eleven
preset names, and only where the class is still `excluded`. A table excluded deliberately keeps that
choice, and so does a preset name the user already moved somewhere else — the only rows rewritten
are ones this app's own button wrote. Scoping it that tightly is what makes rewriting stored user
config defensible at all.

`excluded` stays a class and stays right for a table that genuinely should not be in the dump:
another app's tables sharing the database, or an audit log too large to be worth the DDL. What
changed is that it is no longer the default answer for "this data is not worth copying" — that
question is now `structure`'s.

## 2026-09-22 — A fourth table class, `structure`, because "no rule" is not a guarantee

Wanting a table's schema with none of its rows — `sessions` was the case — had no honest way to be
said. The three existing classes each got it wrong: `excluded` drops the CREATE as well, so the app
fails on its first write to the table; `reference` means "copy 100%", the exact opposite; and
`transactional` with no selection rule only *looks* like schema-only.

That last one is the finding that forced the decision. A rule-less transactional table is still a
**cascade target**, so a kept parent pulls its children down. Laravel's `sessions.user_id` means any
rule that seeds `users` at all drags live session payloads into the dump — with no rule anywhere in
the workspace saying so, and nothing in the UI hinting at it. Verified end to end in
`tests/config/pipeline.spec.ts`, which asserts both halves: the trap, and `structure` defeating it.

So the guarantee had to be stated rather than inferred from the absence of configuration.
`structure` (migration 013, a 12-step rebuild since `class` carries a CHECK) dumps the DDL and no
rows, ever. Three details decided along the way:

- **`roleOf` reports `omitted`, not `complete`.** `complete` asserts "every row is present, so
  nothing can dangle into it" — the opposite of a table that ships empty. Calling it `complete`
  would leave children pointing at rows that aren't there while backfill believed it had nothing to
  repair. `omitted` makes an FK to it get nulled or stripped like any other absent parent.
- **The short-circuit is the first thing `buildRowStream` does**, before the link-table and
  selection branches. A link filter or a cascaded selection would otherwise still put rows in a
  table the user asked to be empty, which would make the class a suggestion rather than a guarantee.
- **A selection rule on a structure table warns** instead of being silently dropped. The rule is
  still sitting on the Rules screen looking active; the run says it was ignored and why.

Named `structure` rather than `schema` deliberately: `schema` already means a Postgres namespace
throughout this codebase (`searchPath`, `CREATE SCHEMA`, the split dump's schema file), and
`structure` is mysqldump's word for the same idea.

## 2026-09-22 — Dumps drop tables by default, and declare their own encoding

Two gaps in the dump header, both of which only show up on the *second* load of a dump.

**`DROP TABLE IF EXISTS`** is now emitted before the DDL, controlled by a per-workspace switch
(`workspaces.drop_existing_tables`, migration 012) that defaults **on — including for existing
workspaces**. Without it a combined dump loads exactly once: a re-load stops at the first
`table already exists` and nothing after that point runs, so "refresh my local copy from the latest
dump" meant dropping the database by hand first. A dump that can't be re-applied is a bug in
whichever workspace produced it rather than a preference some workspaces hold, which is why the
migration backfills 1 instead of preserving today's output. The opt-out is for loading into a
database that also holds data the recipient keeps.

Drops go out as one block in **reverse** dependency order, entirely before the first CREATE, rather
than interleaved `DROP`/`CREATE` per table. Postgres drops `CASCADE` (a dependent view or an FK
from outside the dump set would otherwise refuse the drop), and a cascade running after a CREATE
could silently remove a constraint the same file had just added. In split mode the drops go in the
**schema** file, wrapped in the FK toggle — the data file keeps its TRUNCATEs, since it re-runs
against a schema that is meant to still exist.

**Encoding** is now declared at the very top of every file: `SET NAMES 'utf8mb4'` (MySQL),
`SET client_encoding = 'UTF8'` (Postgres), nothing for SQLite, whose encoding is fixed when the
database file is created. This is a per-dialect **constant, deliberately not introspected from the
source** — the tempting version. The dump is written by `createWriteStream`, so its bytes are UTF-8
whatever the source's charset is; echoing a latin1 source back as `SET NAMES latin1` would tell the
loading client to read UTF-8 bytes as latin1 and mojibake every non-ASCII value on the way in. The
source's charset is already carried where it belongs, in the per-table `DEFAULT CHARSET=` clause of
the DDL, and the server transcodes into it from the client encoding.

Found while wiring that up: **mysql2 defaults the connection charset to `UTF8_GENERAL_CI`**, the
3-byte `utf8mb3`. Reading a `utf8mb4` column over that connection had the server replace every
astral-plane character (emoji, most obviously) with `?` *before* it reached Node — so the dump was
faithfully recording a `?` with nothing downstream able to tell. `createKnex` now opens MySQL
connections with `charset: 'utf8mb4'`, which is what makes the dump's own `SET NAMES` true end to
end.

## 2026-09-21 — Audit cuts keep dialect and store boundaries explicit

The [ponytail audit](../docs/ponytail-audit.md) identified repeated adapter data queries, config
repository CRUD, workspace-scoped Pinia stores, and IPC wrappers. We removed dead code and shared
small vocabularies/helpers, but did not introduce base classes or factories for those larger groups.
SQLite's integer narrowing and streaming, repository validation/upsert rules, and store update
semantics vary; hiding those differences behind generic configuration would make them harder to
verify. A runtime IPC method list would also duplicate the type-only `ConfigApi` contract it aims to
replace. Keep these paths explicit until a concrete maintenance problem justifies consolidation.

## 2026-09-21 — Workspace sharing uses versioned configuration JSON

Workspace export/import shares table classifications, selection and field rules, locale/identity
sources, morph mappings, and backfill policies as versioned JSON. It omits connection profiles and
credentials, run history, dump files, and the machine-local dump folder; recipients add their own
source connection. This keeps the file portable and avoids sharing hostnames or secrets by accident.
Import always creates a new workspace with fresh IDs inside one SQLite transaction, so a failed
import cannot leave a partial configuration or overwrite another workspace. The JSON is validated
before insert, especially selection rules, because the ordinary config reader's lenient fallbacks
must not widen a malformed imported rule.

## 2026-09-21 — Cancellation escapes best-effort extract reads

The all-staff extract was cancelled in backfill, but its read error was treated like a stale schema
edge. Backfill then tried every remaining edge and logged dozens of `Could not read …: Cancelled`
warnings; morph and locale probes did the same. These catches now rethrow `CancelledError` before
turning an ordinary read failure into a warning, so the run stops at the first cancelled read and
records only its normal cancelled status. The reference-pivot change reduced the previous user
population explosion, but selecting all staff still expands through actor FKs; cancellation cleanup
does not change that traversal.

## 2026-08-31 — Composite-PK pivots are subset by *endpoint match*, not by generalising the row key

A run against the Example Shop schema warned on four tables and shipped every one of them **empty**:
`label_card_lookups`, `model_has_roles`, `model_has_permissions`, `role_has_permissions`. All four
have composite primary keys, so `filterAddressable` dropped their edges, no selection entry was ever
created, and `buildRowStream` emitted nothing. Every user in the dump had no roles and every label
had no cards — a subset a developer can't log into.

The obvious fix is to generalise `PkValue` to a key tuple and push it through selection, cascade,
backfill, `getExistingIds`, three adapters and the `table:pk` identity format. **Rejected for now.**
The per-column type-canonicalization invariant that `types.ts` documents (an id is only usable as a
selection key if the driver produced it from the column that keys the selection) gets considerably
worse as a tuple, and it buys only composite-PK tables that are *referenced* by something or that
hold anonymizable data — neither of which any real schema we've run against has.

**What was built instead** ([src/main/extract/link-tables.ts](../src/main/extract/link-tables.ts)):
a link table needs no row identity at all. A single-column PK is required for three things — merging
a row's anonymize flag during cascade, re-enqueueing the row so its own children get followed, and
the per-row lookup that anonymizes it. A pivot needs none: nothing references it, so cascade never
traverses out of it, and every column is a key, so there is nothing to fake. Which leaves one
question with an exact answer:

> Keep every row whose endpoints are all already kept.

That is a `WHERE a IN (…) AND b IN (…)` — a `RowFilter`, which `streamRows` already applies. No new
key type, no change to cascade, backfill or identity.

**It is also better than cascading would be, even where cascade could run.** Cascade keeps a pivot
row when **any one** parent is kept and backfill then drags the other parent in — the population
inflation the 2026-08-29 state entry opens with. Endpoint match adds *nothing* to any other table and
is referentially complete by construction, so this is the answer the shape wanted rather than a
workaround for a missing feature. If tuple keys ever do land, pivots should keep using this path.

**Two passes, and the split is load-bearing.** `detectLinkTables` is schema-only and runs *before*
the cascade pre-flights, because run.ts has to know which tables this pass owns in order to drop them
from `filterAddressable` — otherwise each one still earns a `can't be followed` warning per inbound
edge, describing a limitation that no longer applies. It returns `unaddressable` (every subset table
without a single-column PK, claimed or not) so this module becomes the single voice on the topic: one
clear per-table message instead of one per edge. `linkTableFilters` is pure and runs last, after
cascade, backfill and the flag rules have settled the kept sets.

**Morph endpoints needed a wider predicate.** `model_has_roles (role_id, model_type, model_id)` can't
be written as an AND of INs — the set `model_id` must belong to is chosen per row by `model_type`. So
`streamRows`' `where` became a `RowFilter` (`{ columns, morphs }`,
[row-filter.ts](../src/main/extract/row-filter.ts)) compiling to an OR of `(type = ? AND id IN (…))`
groups. The declared type map is read **whatever the relation's `cascadeDown`/`backfillUp` flags
say**: those govern traversal, and no traversal happens here — all this needs is the map's other job,
naming which table a type value points at.

**Deliberate degradations, each with a warning rather than a silent choice:** an endpoint whose
parent is *excluded* empties the table (a link to an absent row is meaningless, and the DDL FK is
already stripped); a declared-but-unmapped morph leaves that pair unrestricted rather than emptying
the table over half-finished config; key columns covered by neither an FK nor a declared relation are
named in a warning that points at the Morphs screen, which is exactly Spatie's `model_type,
model_id` before the relation is declared. Link tables also stream **verbatim** — no per-row flag
exists to anonymize against — so a field strategy configured on one is reported, not dropped quietly.

**Zero-code alternative, still valid for the static ones:** classifying a pivot as *reference* dumps
it whole. Right for `role_has_permissions`; wrong for anything user-scoped, which would ship rows
pointing at users the subset doesn't contain.

### Follow-up the same day — a link table's endpoints are inferred from column names when no constraint declares them

The first real run fixed three of the four tables and left `grading_report_user (grading_report_id,
user_id)` empty with "no foreign keys, so there is nothing to match its rows against". Accurate: it's
a Laravel pivot written with plain `unsignedBigInteger` columns and never `->constrained()`, so the
database declares no relation at all. That shape is common enough that stopping there would leave the
feature half-useful.

So a link table's unconstrained **primary-key** columns now have their target guessed from the column
name, reusing `guessTargetTable` from
[morph-detect.ts](../src/main/adapters/morph-detect.ts) — strip `_id`, snake-case, pluralise, and
accept only a name that matches a **real table**. `grading_report_id → grading_reports`,
`user_id → users`. The guesser is shared rather than reimplemented so the two paths can't drift.

**Why this one is safe to apply without asking, where morph detection isn't:** a wrong guess can only
ever *narrow* what's kept. It cannot produce a dangling reference, emit a row that shouldn't be in the
dump, or make the file unloadable — the worst case is a pivot with fewer rows than it should have.
Morph detection, by contrast, feeds cascade and can *add* unbounded populations, which is why that one
stays confirm-not-author.

Restricted to primary-key columns deliberately: for a link table those are exactly the endpoints, and
a `*_id` column outside the key is payload — inferring a relation for it would narrow the pivot on
something that isn't part of what the row joins. Columns a real FK or a declared morph already speaks
for are never overridden, and a self-referential guess is dropped.

**It warns every run.** This is the one endpoint the database doesn't vouch for, so the assumption
stays visible until a real constraint replaces it, and the run log marks inferred endpoints `→?`
against a declared endpoint's `→`. One warning per table, not per column.

## 2026-08-29 — A `system:*` IPC surface for the desktop shell, and a per-workspace dump folder

Three UI asks, one new seam. Clipboard, file manager and native pickers now live behind
`system:*` ([src/main/system-ipc.ts](../src/main/system-ipc.ts)), alongside `config:*`, `source:*`
and `extract:*` — separate because none of it touches a database, which keeps those three about data.

**The clipboard goes through IPC rather than `navigator.clipboard`** because that API needs a secure
context, which a packaged app loading over `file://` is not guaranteed to be. Electron's `clipboard`
behaves identically in dev and packaged, so a copy button can't work in one and silently fail in the
other.

**`openPath` is directories-only, and checks rather than trusts.** `shell.openPath` on a *file* asks
the OS to open it with its default handler, which for a `.exe`/`.command` means executing it. Nothing
in this app passes anything but a dump folder, so the `stat` guard costs nothing — but "the renderer
can ask main to launch an arbitrary path" only needs to be true once. Files use
`showItemInFolder`, which reveals and never runs.

**Migration 011 — `workspaces.dump_output_dir`.** Dumps were hardcoded to `<userData>/dumps`, a path
inside the app's support directory that nobody looks in and nowhere anyone wants a file they intend
to hand to a developer. NULL/blank means the default, resolved at run time by `dumpDirectoryFor` —
deliberately *not* baked into the store, since `app.getPath('userData')` differs per OS and between
dev and packaged builds, so one machine's answer would follow the config file somewhere it's wrong.
Plain `ADD COLUMN`, unlike 005 and 010: no CHECK constraint involved.

`dumpDirectoryFor` is the single place "blank means default" is decided — the pipeline picks the
folder with it and the Runs screen displays the folder with it, so the button always opens what the
next run will write to.

**One repository subtlety worth remembering:** `updateWorkspace` uses `'dumpOutputDir' in patch`
rather than `patch.x ?? existing.x`. Clearing the folder back to the default is a legitimate edit,
and the `??` merge every other field uses would silently refuse it.

**Code review caught the folder being taken on trust** — a field that accepts typed text was storing
it unchanged. Two ways that goes wrong, both silent: a **relative** path (`dumps`) resolves against
`process.cwd()`, which for a packaged app launched from Finder or the Start menu is neither the
project directory nor necessarily writable, so the dump lands somewhere nobody looks or the run fails
at the very last step; and a leading `~` is *shell* syntax, so Node would create a directory
**literally named `~`** in that same unpredictable place.

Now [src/main/dump-dir.ts](../src/main/dump-dir.ts) `normalizeDumpDir` expands `~`/`~/…`, requires
the result to be absolute, and is used in all three places that matter: the repository rejects a bad
path on write (so the column only ever holds paths meaning the same thing wherever the app starts),
the workspace form previews the resolution inline on blur (`~/Desktop/dumps` visibly becomes a real
path), and `dumpDirectoryFor` falls back to the default for a stored value that somehow isn't
absolute — reachable only by hand-editing the store, and the Runs screen reads through the same
function so it shows the default too. Consistently visible beats silently misplaced. `~someone/…` is
rejected rather than guessed at: only a shell can resolve another user's home.

**Also caught: a lost-update race on the Runs screen.** `loadDumpDir` captured the workspace id
before its await but assigned unconditionally after it, so two switches resolving out of order left
Copy and Open pointed at the previous workspace's folder. Re-checked after the await — the same guard
the discovery store already uses for its per-workspace cache.

**Verified by screenshot, not just typecheck.** The harness `state.md` documented had been lost with
the gitignored scratchpad, and was Linux-specific anyway; it's rebuilt at
`scratchpad/screenshot-main.ts` for macOS. One trap the old notes didn't have: the app's own
`runMigrations` bundles its `.sql` files with Vite's `import.meta.glob`, which **esbuild cannot
evaluate** — which is exactly why the original harness skipped migrations. Reading the same directory
off disk is the faithful equivalent and lets the harness exercise a brand-new migration.

## 2026-08-29 — Lenient config parsing must not fail *open*: a widened preserve rule is a PII leak

**Caught in code review, and the reasoning that produced the bug is the part worth keeping.**
`selection-rules.ts` read stored rules leniently — dropping conditions it couldn't parse, defaulting
an unrecognised take to `all` — and its comment defended that explicitly: *"a rule that loses a
condition selects more rows than intended, never fewer, so the failure mode is a bigger dump rather
than a silently-missing cohort."*

That argument is **wrong for exactly the rules that matter most**. It reasons about dump *size* and
never about the `anonymize` flag. A corrupted `anonymize: false` rule — the one that says "these rows
keep their real names and emails" — degrades to `where: []`, `take: all`, preserve: **an entire table
dumped with real data**, which is the precise outcome this app exists to prevent. "Bigger dump" and
"more unanonymized rows" are not the same failure at all.

**The rule now: lenient parsing is fine, silent lenient parsing is not.** Both parsers report what
they had to repair, `toSelectionRule` records it in a new `SelectionRule.invalid`, and `planRule`
**refuses to run** any rule carrying it. The rule still opens on the Rules screen — the one place it
can be fixed — showing a "needs fixing" tag and the reason; the modal warns that what's displayed is
the *widened* reading and that saving makes it permanent. Saving rewrites the JSON from the parsed
model, which clears the flag.

Failing the whole run rather than skipping the rule is deliberate: skipping a preserve rule silently
anonymizes rows that were meant to be kept verbatim, which is a quieter wrong answer than stopping.

**Generalisable:** when a fallback widens what a security-relevant rule matches, "be forgiving" is a
bug. Ask what the *permissive* direction means for the flag, not just for the row count.

## 2026-08-29 — Run cancellation: wrap the adapter, don't thread a signal

Prompted by a run that appeared to hang and could not be stopped: the only lever was quitting the
app, which stranded the `runs` row as `running` forever (nothing ever swept it).

**The design choice worth knowing: cancellation is a `Proxy` around the `DbAdapter`, not an
`AbortSignal` passed down through every stage.** Every long-running thing the pipeline does goes
through the adapter, so one wrapper in `runExtract` makes selection, cascade, backfill *and* the dump
writer cancellable without touching a single stage's signature — and it lands within one query rather
than at some coarser checkpoint. The check happens **before** delegating, so a source the user asked
to be left alone gets no further load.

The one gap the proxy can't see is `streamRows`: it's checked when the iterator is *created*, then
yields for as long as the table is big — which on the largest table is most of the run. The dump
writer's row loop calls `throwIfCancelled` per row to close it. That's the only place a signal is
threaded, and the only place it needs to be.

Three smaller calls:

- **A cancel resolves, it doesn't reject.** `runExtract` catches `CancelledError` and returns the run
  record, so the renderer's `await` settles normally and the history shows what happened.
- **Stored as `failed` with a "cancelled" message, not a new status.** `runs.status`'s CHECK has no
  `cancelled`, and SQLite can't ALTER a CHECK — a truthful status would cost a full table rebuild for
  a label. Revisit if a rebuild is happening anyway.
- **`markInterruptedRuns()` at app start** closes out rows left `running` by a dead session. Safe
  because one process owns the config store, so nothing can legitimately be in flight before the
  first window opens.

**Cancellation is cooperative, and the UI says so:** it stops at the *next* query or row, so a cancel
issued during one long `ORDER BY RAND()` waits for that query to return. It does not kill in-flight
SQL.

**Follow-up the same day — the proxy alone was not enough, and Stop looked broken.** A second gap,
found while watching a real run refuse to stop: the **internally chunked** adapter methods
(`getRowsReferencing`, `getReferencedIds`, `getExistingIds` and their morph variants) slice a large id
set into `IN (…)` chunks and run **one query per chunk inside a single call**. With `IN_CHUNK = 1000`,
a cascade over a few hundred thousand ids issues hundreds of queries between two proxy checks — so
the adapter ground on for minutes after the user pressed Stop. Fixed by having `withCancellation` set
`adapter.cancellationSignal` on the target as well as proxying it, and checking per chunk in all
fifteen loops across the three adapters.

**The general lesson, which will recur:** wrapping an interface gives you a check *per call*, and
that's only as fine-grained as the calls are. Any method that loops internally — chunked queries,
streamed rows — needs its own check, and those are exactly the methods that take the longest.

## 2026-08-29 — Flag-only rules: "don't anonymize staff" is not "include all staff"

**Found by running it.** The two motivating v2 rules were written as *(1)* 20 recent non-staff users,
*(2)* users with a work email → **take all**, preserve. Rule 2 seeds 282 staff, and the run didn't
finish.

**Why that explodes, and it isn't the rule's fault:** `cascadeSelection` indexes **every** inbound FK
and expands every kept parent into every child referencing it, with **no policy gate** — migration
009's `fk_backfill_policies` governs the *upward* direction only. In this schema 26 FK columns point
at `users` and around half are actor edges (`welded_by_user_id`, `qa_checked_by_user_id`,
`photoed_by_user_id`, `card_lookups.artist_id`), so keeping one staff member pulls in every record
they ever touched, and each of those cascades to its own children. 282 staff seeds ≈ extract the
database.

**The real gap: every rule both selects and flags.** The only way to set `anonymize: false` on a row
was to *seed* it, so "preserve our staff" was inexpressible without also including all of them. What
was wanted is: seed the customers, let cascade and backfill pull in whichever staff those records
reference, and preserve *those*.

**`take: { kind: 'none' }`** — a rule that adds no rows, applied by the new `applyFlagRules` stage
**after** cascade and backfill, against whatever is by then in the subset. Three things make a
tacked-on selection stage safe:

1. **A matched row that isn't already kept is skipped.** It can lower an `anonymize` flag and nothing
   else, so the subset never grows and nothing above it is invalidated.
2. **Preserve-wins still governs the merge**, so an *anonymizing* flag rule is a no-op. That follows
   from §6 rather than being an oversight — a late stage able to un-preserve a row would defeat the
   precedence rule's purpose. The modal warns when one is written that way.
3. **No migration.** It's another shape in the existing `take_json` column.

**Not cohorts.** It sets one boolean for a whole row, so "keep staff names but still fake their phone
numbers" is still out of reach. It solves the case that actually turned up, which is the argument for
keeping cohorts deferred rather than the argument against it.

**Still true and still unaddressed:** nothing caps *downward* cascade fan-out. A flag rule sidesteps
it for this case by not seeding; a rule that genuinely needs to seed a well-connected table has no
lever. See the "anchor-table" note in state.md.

## 2026-08-29 — An empty `n-form` rule descriptor is not "no rule" — it means `type: 'string'`

Found live: adding a second `users` rule failed with **"count is not a string"** and refused to save.
The rules object used the house pattern of `condition ? {…} : {}` to switch validation off for a
field the current form shape doesn't use — but async-validator (under naive-ui) treats `{}` as a rule
with no validator, which defaults to a **string type check**. `model.count` holds a number the whole
time, so the disabled row-count input failed validation whenever the take was *All matching rows*.

Reproduced directly, outside the app:

```js
new Schema({ count: {} }).validate({ count: 500 })  // → "count is not a string"
```

**Fix: add the key conditionally rather than setting it to `{}`.** `SelectionRuleFormModal` now
builds its `FormRules` object imperatively and only includes the fields the current shape uses.

**Why this hadn't bitten before, and where it still might.** `FieldStrategyFormModal` has the same
`percent: … : {}` pattern with a numeric `model.percent`, and it works — because its form item is
behind `v-if="model.kind === 'jitter'"`, and **naive-ui only validates *mounted* form items**. The
v2 rule modal's Take section is always mounted, so the latent bug became a real one. The field-
strategy instance is one removed `v-if` away from the same failure; left alone for now, but it is the
same bug waiting.

The design below was written and then built the same day. Three decisions it didn't anticipate, all
of them load-bearing:

**1. The push-down hybrid is only valid under `match: 'all'`.** The plan said "push what you can,
re-check the regex over the survivors". That's correct for AND, which lets you narrow in stages, and
**wrong for OR**: `email matches /x/ OR created_at >= cutoff` pushed as just the date drops every row
that qualified only via the regex. A silently smaller subset, with nothing anywhere to notice it. So
one non-pushable condition in an `any` rule forces the *whole* filter client-side — which costs
exactly what a v1 `pattern` rule already cost (one full-table read), never more. `partitionConditions`
owns that in one place.

**2. The take has to be withheld from SQL whenever a client-side condition survives.** A `LIMIT`
pushed alongside an unevaluated regex caps the rows *before* the regex runs — sampling 20 and keeping
the 3 that match is a different rule from keeping 20 that match. So in that case rows come back
unlimited, Node filters, and the take is applied in memory: a **shuffle** for `sample` (slicing a
database's natural order would bias every sample toward the oldest rows, the one thing a random
sample exists to avoid) and a sort for `top`.

**3. The `LIKE` escape character is `!`, not `\`.** Escaping a user's `%` and `_` needs a named
`ESCAPE` clause, because **SQLite has no default escape character at all** — a `\` in a SQLite LIKE
pattern is a literal backslash. And `\` can't be the named one: MySQL treats a backslash as an escape
*inside the string literal too*, so `ESCAPE '\'` needs a doubling that then depends on the server's
`NO_BACKSLASH_ESCAPES` mode. `!` has no special meaning in a string literal on any of the three.

**Also decided, smaller:** the two faces of the operator table (SQL and JS) live in **one module**
that the adapters import, inverting the usual extract → adapters direction. The arrow is aesthetic;
splitting one operator table across two files so they can disagree is not. It's acyclic — the module
imports only knex's types and `@shared/types`.

**Built and green, never run live.** All six build-order steps landed; 112 checks pass (53 new). But
every test is a pure function or a stubbed adapter, so the SQL each dialect generates has been
*asserted* and never *executed*. Same caveat as the backfill-policy entry below, and the same next
step: run it against a real source.

## 2026-08-29 — Selection rules v2: split `strategy` into filter + take; typed operators, not regex

> **Built the same day** — see the entry above for the three things this plan got wrong. Statuses
> here describe the design as written, not the shipped code.

**Design only, no code** — [docs/selection-rules-v2.md](../docs/selection-rules-v2.md). Prompted by a
pair of rules on one table that v1 cannot express: *(1)* users with **no work email** and **created
recently** → take 20, anonymize; *(2)* users **with** a work email → take all, preserve.

**The diagnosis: `SelectionStrategy` fuses two orthogonal axes.** A rule answers "which rows qualify"
*and* "how many of them to take", and the four strategies each pin one axis: `random` can't be
filtered, `pattern` can't be limited, and `pattern` filters one column by one regex so an AND of two
conditions has nowhere to go. The whole filtered-**and**-limited half of that grid is unreachable. So
the fix is not a fifth strategy — it's `where: Condition[]` + `take: all | sample N | top N`, over
which all four v1 strategies are presets.

**Regex is demoted from *the* mechanism to *one operator*, and the reason is not taste.** Two
independent arguments:

1. **It can't express most real filters.** "created within 90 days" is not a regex; neither is `> 100`,
   `IS NULL` or `IN (…)`. Regex describes the shape of a string, and string shape is the minority of
   what people filter on.
2. **It can't be pushed into SQL, and everything else can.** The 2026-07 decision to resolve `pattern`
   client-side was right *for regex* (MySQL `REGEXP` / Postgres `~` / SQLite-has-none all diverge) and
   stands. But that argument **does not extend to `=`, `<`, `IS NULL`, `IN`, `LIKE`, `BETWEEN`**, which
   are portable verbatim across all three dialects. v1 transfers an entire table to keep a handful of
   rows; pushed down it's one indexed `WHERE … LIMIT 20`.

   **The hybrid is the part to get right:** push the pushable conditions, then pull `(pk, col)` pairs
   only for the *surviving* rows and apply the `RegExp` to those. A regex condition costs a narrowed
   read, not a full-table read.

**Four traps the interface absorbs rather than delegates.** In rough order of how badly each would
bite:

- **NULL.** "no work email" written as `email NOT LIKE '%@example.com'` silently drops every NULL
  email — three-valued logic, the predicate is NULL, the row is gone. Nobody means that. Negative
  operators emit `(col IS NULL OR col NOT LIKE ?)` **by default**, with the choice visible and
  quantified ("☑ include the 3,100 users with no email"). Hidden entirely on a NOT NULL column.
- **Relative dates resolve in Node, not SQL.** `DATE_SUB` / `now() - interval` / `datetime('now',…)`
  share no syntax. One cutoff instant computed at run start and bound as a parameter — which also
  stops a long extract disagreeing with itself about where "90 days ago" is, and makes the cutoff a
  loggable value. Storing *relative* is the point: an absolute `created_at > '2026-05-31'` rots.
- **"Limit 20" is not 20 rows.** `users: random 20` → 74 in the dump (see the two entries below).
  The field is labelled **Seed rows** and links to Backfill Management. The rules screen is where that
  should be confessed, not a console log.
- **Overlapping rules** waste sample slots invisibly (preserve-wins already handles the *anonymize*
  conflict correctly). Answered by a **preview count** — one `SELECT COUNT(*)` per rule, which also
  catches typo'd columns, empty match sets and NULL traps *before* a 40-minute extract, and doubles as
  the validator for the `rawWhere` escape hatch.

**`top N` (ordered) alongside `sample N` (random), because determinism is already load-bearing.**
Faker is seeded from a stable identity key precisely so a re-run reproduces byte-identical fake data
(spec §8) — a random seed set throws that away at step one. `top` makes a whole dump reproducible, and
"the 20 most recent users" is usually what "recent users" meant anyway.

**Flat `match: all|any`, not nested groups.** Covers both motivating cases and nearly every real one;
nested trees need drag targets, depth indentation and a precedence model to serve cases `rawWhere`
already handles. A flat list is a strict subset of any tree, so widening later needs no data migration.

**Storage: JSON columns, not a child table.** A condition is never addressed alone, never queried
across rules, and has no life outside its rule — it fails the store's "one table per concept" grain
(migration 008) and matches the `explicit_values` / `template_json` precedent. Cost: no CHECK
validation, so shape-checking sits at the repository boundary where `parseValues` already is.
Migration 010 is a **full 12-step rebuild** (SQLite can't ALTER a CHECK, as migration 005 found),
which makes the v1 → v2 rewrite free — it rides the `INSERT … SELECT`.

**`explicit` carries a sentinel:** its PK column name is a *source-schema* fact the config store
doesn't hold, and migrations run at app start with no source connection. `column: null` means "the
primary key", resolved at extract time — which also survives a PK rename. Quiet fix along the way:
v1's `explicit` only ever compares against the PK (via `getExistingIds`) despite the modal's
`admin@example.com` placeholder implying otherwise; as `column in (…)` it finally does what the
placeholder always said.

**Explicitly NOT solved: partial preservation.** Case 2 says "keep **most** details" — but `anonymize`
is a boolean *per row* while field strategies are per-column and *table-wide*, so a staff user is
wholly verbatim or wholly faked. "Keep their name, still fake their phone" has nowhere to live. This
is a field-strategy limitation that selection rules merely expose, and the clean fix is **cohorts** (a
rule labels its rows; a field strategy scopes to a label). Engine cost is small — `TableSelection.ids`
is already `Map<PkValue, boolean>` and becomes `Map<PkValue, {anonymize, cohort?}>`, cascade
propagates it the same way. Real cost is a new dimension on the Fields screen plus a precedence rule
for two-cohort rows. **Deferred deliberately:** ship filter+take, run it, find out whether the boolean
actually chafes. `cohort?: string` is additive when it does.

## 2026-08-29 — Example Shop: staff and customers share `users`, so backfill growth is WANTED

**Read this before acting on the entry below it.** The per-edge backfill policy was built to tame a
`users: random 20` rule producing 74 users. The user's verdict on seeing the diagnosis: **the extra
54 are staff, and they belong in the dump.** `submissions.welded_by_user_id`,
`qa_checked_by_user_id`, `photoed_by_user_id`, `card_lookups.artist_id` and the rest reference
employees who live in the same `users` table as customers, so pulling them in is what makes the dev
data usable — a submission welded by nobody is worse than a larger dump.

So **no policy is declared on this workspace, and the feature ships dormant** (absence = `follow`,
so behaviour is unchanged). The mechanism stays as an escape hatch for edges that genuinely don't
matter; the 74 → 50 figure in the entry below is a *measurement of what the feature could do*, not a
target anyone wants to hit.

**The correction worth remembering, because it will recur:** nullability is a *hint* about ownership,
not a verdict. This schema marks every actor FK `DEFAULT NULL … ON DELETE SET NULL` and every
ownership FK `NOT NULL … ON DELETE CASCADE`, which reads like a clean ownership/incidence split — and
it is, structurally. But whether an "incidental" reference is worth keeping is a **domain** question
the schema cannot answer. Ask before assuming a reference is noise.

Also confirmed, and reassuring: the growth is **bounded, not compounding**. Backfill is up-only, so
the 54 staff pull their own ancestors but never their descendants. 74 does not drift toward 700.

## 2026-08-29 — Per-edge backfill policy (migration 009): declare which FKs backfill may follow

> **Superseded in application, not in mechanism** — see the entry above. The feature is built and
> correct; the workspace that motivated it decided not to use it.

**Driven by a real measurement, not a hypothetical.** A workspace whose *only* selection rule is
`users: random 20` produced a dump holding **74 users**. Diagnosed off the 2026-08-27 dump rather
than by re-running: none of the growth is cascade (`users` has no inbound FK from a seeded table, no
self-reference, and all nine declared morph relations are `backfill_up` with **zero rows** in the
morph tables), so all 54 extra rows came from `backfillSelection`.

**26 FK columns point at `users`, and the schema itself splits them in two:** every ownership edge is
`NOT NULL … ON DELETE CASCADE` (`submissions.user_id`, `submission_batches.parent_user_id`) and every
actor edge is `DEFAULT NULL … ON DELETE SET NULL` (`welded_by_user_id`, `photoed_by_user_id`,
`qa_checked_by_user_id`, `encapsulated_by_user_id`, `card_lookups.artist_id`, …). Backfill follows
both because an FK carries no such distinction. Measured: nulling the 14 nullable actor edges takes
74 → **50**; the remaining 30 are second-order chains (`partners.user_id` and
`submission_intakes.user_id` are 9-for-9 exclusive) and are **not** addressed by this — see the
still-open note in state.md.

**The decision: declare it, don't infer it.** `fk_backfill_policies` (workspace, table, column) →
`follow` | `null`. Absence means `follow`, so every existing workspace is unchanged.

Four choices inside it worth knowing:

1. **`null` is two halves, in two passes, and both are required.** `backfill.ts` *skips* the edge
   (no parent pulled in); `run.ts` *nulls* the column on rows whose reference fell outside the subset.
   Skipping alone leaves the exact dangling reference backfill exists to prevent. They can't share a
   pass: the skip must happen *during* backfill, the null can only be decided *after* it, once the
   kept set has settled. Hence `extract/backfill-policy.ts` holding `resolveBackfillPolicies` /
   `buildNullEdges` / `applyNullEdges`.
2. **A reference is only nulled when its target is genuinely absent.** A `welded_by_user_id` that
   happens to point at one of the 20 selected users is real data; blanking it buys no integrity.
3. **A naming heuristic was considered and rejected** (`*_by_*_id` → don't follow, ~40 lines, no
   config). It changes every workspace's output silently, offers no override when wrong, and misses
   `card_lookups.artist_id` / `label_orders.label_artist_id` in the very schema that motivated it.
4. **NOT NULL is validated twice, and fails closed.** The UI won't offer `null` on a non-nullable
   column, and `run.ts` re-checks at extract time (a column can become NOT NULL after the policy was
   saved) and **downgrades to `follow` with a warning** — an unloadable dump is strictly worse than
   the row growth the policy was avoiding. Unknown nullability is treated as NOT NULL.

**Two defects found in code review of this work, both fixed, both worth knowing because the second
is a shape the rest of the engine also assumes away:**

1. **A `null` policy on a foreign key targeting a non-PK unique column destroyed data, silently.**
   `orders.customer_email → users.email` is legal against any UNIQUE column, but `buildNullEdges`
   tests a reference against the parent's kept **primary-key** values — so every valid email matched
   nothing and was blanked. It could not lean on `backfillSelection`'s existing `nonpk` warning
   either: the policy check runs *before* `pull`, so a policied edge never reaches it and **nothing
   reported it anywhere**. Now rejected in `resolveBackfillPolicies`, which takes a `primaryKeyOf` and
   fails closed on an unknown (composite/missing) PK.
2. **A column may carry more than one foreign key**, and `new Map(fks.map(…))` kept only the last.
   Backfill skipped every constraint on the column (correct) while nulling checked one, so a value
   present in that parent and missing from another survived and dangled. `buildNullEdges` now
   collects every constraint and requires the value to survive all of them. The migration comment
   claiming "a column carries at most one FK" was simply wrong and has been corrected.

**Testing lesson, and it is the state.md "fixtures lie" rule again in a new costume:** the first
multi-constraint tests **passed against the reinstated bug**. A last-wins implementation keeps the
*last* constraint, so a fixture whose last parent is the restrictive one agrees with it by luck. Both
were rewritten to be asymmetric in *both* directions (a value unique to each parent, and the
whole-table parent placed last), then verified by reinstating each defect and watching them fail. **A
regression test for a last-wins bug is worthless unless it would also fail for a first-wins one.**

**Morph edges are deliberately not covered:** `morph_relations.backfill_up` already says "don't
follow this upward", and two switches for one behaviour is one too many.

**Also landed, and arguably the more useful half day-to-day:** `BackfillReport.addedByEdge`.
`added` said `users +54` and left no way to find out which of the 26 columns to act on. Attribution
is to the edge that **first** pulled each row in — a parent reachable from three edges is counted
once, because the other two find it already kept. Deterministic traversal makes that stable.

## 2026-08-22 — Committed test framework: Vitest, run under Electron's Node runtime

`npm test` / `npm run test:watch` now exist, backed by a committed `tests/` suite
(37 checks across 4 files: `search-path`, `json-paths`, `graph`/topo order, and the config
store — migrations + workspace/connection/selection-rule/field-strategy repos against a
throwaway store). The gitignored `scratchpad/` harnesses remain the home of container-based
live verification (pg/mysql) — those do not move into the default suite.

Three choices worth knowing about:

1. **Vitest over node:test.** The toolchain is already Vite (electron-vite), so vitest needs no
   parallel build setup; and unlike the esbuild-bundled scratchpad harnesses, vitest understands
   Vite's `import.meta.glob` — meaning `runMigrations()` runs unmodified in tests (scratchpad trap
   #6 closed for tests).
2. **Tests execute under Electron, not system Node** (`scripts/run-vitest.mjs` spawns
   `ELECTRON_RUN_AS_NODE=1 electron …vitest.mjs`). Forcing reason: `better-sqlite3` is rebuilt to
   Electron's ABI by `postinstall`, verified failing (`NODE_MODULE_VERSION` mismatch) and passing
   under plain Node vs electron-as-node. A wrapper script rather than an env-var prefix in the npm
   script so it stays cross-platform.
3. **`electron` is aliased to `tests/support/electron-shim.ts`** in `vitest.config.ts` (same trick
   as scratchpad's shim): main-process config code imports `{ app } from 'electron'`, which doesn't
   resolve outside the app runtime. The shim serves `getPath('userData')` from
   `MASQ_TEST_USERDATA`; anything else fails loudly. Each store spec file mkdtemps its own dir
   before any `getDb()` call, so parallel workers can't share a SQLite file.

Also: `scratchpad/` added to eslint's ignores — its `.cjs` bundles were contributing ~13k lint
problems (1538 errors), so `npm run lint` had been failing at HEAD before this work. And a pass
of `prettier --write` was applied to the handful of src files that had drifted from prettier
3.9.5's formatting (formatting only, no logic changes).

One behaviour pinned by the new suite that looks surprising but is correct:
`createFieldStrategy`'s upsert **keeps the original row id** on conflict — the fresh
`randomUUID()` in the INSERT is discarded on `DO UPDATE`.

---

## 2026-08-20 — SSH tunnelling designed as a local port forward, not driver stream injection

Design captured in [docs/ssh-tunnel.md](../docs/ssh-tunnel.md); **no code written**. Recorded now
because the choice between the two mechanisms has a non-obvious forcing reason that would otherwise be
re-litigated.

`mysql2` and `pg` both accept a `stream` option, so an `ssh2` channel could go straight to the driver
with no local listening port at all — strictly better on exposure. It was rejected because it **breaks
Postgres**: table DDL comes from a `pg_dump` subprocess (`PostgresAdapter.getCreateTableStatement`),
which authenticates on its own and needs a real TCP endpoint for `-h`/`-p`. An in-process duplex stream
is invisible to it. A `127.0.0.1` port forward serves knex and `pg_dump` through one mechanism; the
stream approach would need a second, different path for Postgres DDL.

Two consequences worth knowing before building it:

- The tunnel's effective host/port must reach **both** `createKnex` *and* `makeAdapter`. Only the
  former is the obvious one, and getting it wrong tunnels the queries while `pg_dump` dials the
  unroutable address — Postgres-only, and it surfaces minutes into a run rather than at connect time.
- `ssh2`'s `hostVerifier` accepts **any** host key when unimplemented. For a tool that exists to reach
  production that is a live MITM hole (the DB password goes to whoever answers on 22), so fingerprint
  pinning is part of the feature, not a hardening pass afterwards. No opt-out checkbox — it would be
  ticked once by everyone, forever.

It lands entirely inside `withSourceAdapter`, the only caller of `createKnex` in `src/`, which is why
this is a contained feature rather than a refactor. That single choke point wasn't designed for this,
but it's what makes it cheap.

## 2026-08-20 — Dark mode by default, and a self-referential-FK identity bug the theme work exposed

### Dark by default, with a real choice

The app already followed `prefers-color-scheme`; it only *looked* light because the test environment
reports light. "Default to dark" could have been a one-line hard-code, but that would have removed the
OS-following behaviour outright, so the preference is now a three-state choice — `dark` (the default),
`light`, `system` — cycled from a control in the sidebar footer.

Stored in **`localStorage`, not the config store**. It is a per-machine UI preference, not project data:
not workspace-scoped, never shared with a teammate, and putting it in `config.sqlite3` would mean a
migration, a repository, an IPC channel and a store for one enum. It also has to be readable
*synchronously* at first paint — an async IPC round-trip would flash the wrong theme.

**`<n-global-style />` was the missing piece.** naive-ui themes its own components, not the page: the
layout rendered dark while `document.body` stayed `rgb(255,255,255)` underneath, which shows as a white
flash before Vue mounts and at overscroll. Caught only because the harness asserts the *computed body
background luma* rather than trusting the switcher's label — the screenshot looked perfect either way.
The first icon glyphs (`◗`/`◒`/`◍`) fell back to tofu in the bundled font stack and were dropped for
plain words.

### The bug it exposed: a row is never a different row of its own table

Adding a locale source to the e2e fixture made a new cross-table assertion possible — every comment's
faked `author_email` should equal its own author's faked email — and it failed on **21 of 25 pairs**.

Cause: `users.manager_id → users`. The cascade propagated identity down that edge, so a subordinate's
own `users` row inherited their **manager's** identity, and their `users.email` came out as the
manager's fake email, while a declared `comments.user_id → users` used their real own identity. Two
different fake people for one row.

Fix: cascade never assigns an identity that belongs to the child's *own* table. Leaving no entry means
"this row is its own entity", which is right for every self-reference — a subordinate is still their own
person, a reply is its own comment, a replacement order is its own order. Matched on the identity's
table prefix rather than `parentTable === childTable`, so a transitive cycle back into the same table is
covered too; a false positive could only ever mean "be your own entity", the safe default.

`identity-smoke.ts` had **no self-referential FK**, which is exactly why it never caught this — the app
e2e did. The fixture now has one, and asserts a subordinate keeps no inherited identity.

### Process lesson worth more than the fix

After fixing the cascade, the e2e was re-run **from a stale esbuild bundle** and still failed, sending
five debug scripts hunting a second cause that did not exist. The harnesses execute the `.cjs`, not the
TypeScript. **If a fix "doesn't take", rebundle before theorising** — recorded as trap 8 in state.md.

---

## 2026-08-20 — The faker locale now follows the entity, not the table

Closes the interaction flagged an hour earlier in the same session (see the per-table hints entry
below): identity fixed the faker *seed*, but the locale picked the *data set*, and a locale source is a
per-table hint — so one person came out "Ivy van de Meer" in `users` (NL, from `address.country`) and
"Garett Schowalter" in `payments.cardholder_name` (no locale source of its own, so `en`). That defeated
the exact consistency cross-table identity exists to provide.

### Keyed on the identity string, so the cascade needed no change at all

The first sketch was to propagate the locale down the cascade alongside the identity, mirroring
`TableSelection.identities`. That turned out to be unnecessary: the identity string (`users:42`) is
*already* carried to every descendant, so resolving each entity's country **once** and keying it on that
string is enough. `cascade.ts` and `types.ts` are untouched; the whole change is one map built in
`executePipeline` plus a lookup in the row stream. Preferring the cheaper design here was worth the
extra thought — the propagation version would have added a second overlay map to keep in sync with the
first, for identical behaviour.

### Every row, not just the kept ones

`entityCountry` reads the whole locale-source table rather than only rows in the subset, because a
**declared** identity source (migration 008) can name an entity that is not in the dump at all —
`comments.user_id → users` for a user no rule selected — and that row still has to render in its own
locale. Proven with a control value from the real `anonymizeRow`: a comment whose author is absent from
the dump comes out "Thomas Hendriks" (that user's NL locale) rather than "Shania Cummerata" (the
default), and the two genuinely differ, so the assertion bites.

Cost is one two-column read per table with a locale source — typically one — the same shape a `pattern`
selection rule already performs.

### `has`, not `??`

The lookup is `entityCountry.has(identityKey) ? get(…) : countryValue(row, localeSource)`. An entity
with a **known absent** country must stay on the default locale rather than silently falling back to the
current table's hint and diverging again, which is the bug being closed. `??` would have reintroduced it
for exactly the rows most likely to hit it.

A table whose PK is composite or missing can't key an identity, so it keeps per-row locale resolution
and says so as a `locale:` run warning rather than failing.

### Verified

`identity-smoke.ts` (47 checks) now asserts the *fix* where it previously asserted the bug as KNOWN, and
adds the three-way match — one person, one name across `users`, `payments` **and** a `comments` row whose
identity was *declared* rather than inherited. End to end through the real app: 10 of 10 kept comments'
faked `author_email` equal their own author's faked email, on a fixture where the commenter is
deliberately never the post's author.

---

## 2026-08-20 — Two per-table value-source hints: locale from a JSON path, and a declared identity source

The pair queued when cross-table identity landed. Both are "where does this value come from, for this
table" hints, and they are **two tables, not one** — see the schema note below. Migrations 007 and 008.
Verified by `scratchpad/identity-smoke.ts` (40 checks), by both migrations applied to a **copy of the
real config store**, and in the running app (`sqlite-e2e-main.ts`, screenshot eyeballed).

### Locale from a JSON path (007)

`table_locale_sources.country_column` names a *column*, which is not where every schema keeps the
country. Measured on the real workspace: `users.country_code` is populated on **3 of 18** rows, so 15
users fell back to `en` and got US-shaped postcodes and phone numbers — while all 18 carry a perfectly
good country at `users.address.country`. Naming a column could not reach it, so this was a feature gap,
not a misconfiguration.

A source is now `(column, optional path)`. Path absent → the column's own value, exactly as before.
The dot-path reader is `readPath`, added **next to `overlayPath`/`deletePath` in `anonymize.ts`** rather
than in a new module, so one file defines what a path means: same segments, same refusal to descend
into an array or a non-object, same "absent, not an error" for a path this row lacks. It handles both
forms a JSON column arrives in (Postgres/SQLite hand over text, mysql2 hands over an object) and
returns `undefined` for text that doesn't parse — a column that isn't really JSON is a
misconfiguration to fall back from, not a reason to fail a run.

### Declared identity source (008)

Cross-table identity follows the cascade graph, which cannot distinguish an *ownership* edge
(`users → orders`) from an *incidental* one (`posts → comments`). Declaring `comments.user_id → users`
overrides it, so each comment takes its own commenter's fake name. Precedence in `run.ts` is
**declared → cascade → the row itself**: a declaration is the user stating what the graph could only
guess.

**The entity table is stored, not derived from the FK graph.** Deriving it would fail exactly where the
feature is most needed: Laravel schemas frequently carry no FK constraints at all (the same reason
`morph_relations` must be declared), and a table can hold two FKs to the same parent, which no lookup
can disambiguate. The harness fixture makes this concrete — its `comments.user_id` has no constraint,
so the cascade can only reach the table through the *post owner*, which is the wrong person.

`declaredIdentity` coerces with `String()`, matching `ownIdentity`. That matters: the value is read off
this table's own column, whose type needn't match the entity table's PK (node-pg returns `int4` as a
number and `int8` as a string), and coercing both sides to text keeps `42` and `'42'` on one identity
instead of quietly producing two people.

### Why two tables and not one

They share a *shape*, not a meaning, and the config store's grain is one table per concept
(`table_classifications`, `selection_rules`, `field_strategies`, `table_locale_sources`,
`morph_relations`). Their consumers differ too — locale feeds `fakerFor`, identity feeds
`anonymizeRow`'s `identityKey`. Merging them would produce rows whose meaning depends on which columns
happen to be non-NULL. Renaming `table_locale_sources` into a general "field sources" table was the
other option and was rejected as churn through the repo, IPC channel names, store and UI for a
cosmetic gain.

### ⚠ Interaction found while testing: locale splits a shared identity

**Identity fixes the faker *seed*; the locale picks the *data set* — and a locale source is per-table.**
So one identity in two tables whose locale sources differ produces two different names. Reproduced:
with `users` reading NL from `address.country` and `payments` having no locale source, user 2 is
"Ivy van de Meer" in `users` and "Garett Schowalter" in `payments.cardholder_name`, defeating the very
consistency cross-table identity exists to provide.

**Pre-existing** — it arrived with cross-table identity, not with these hints; it was simply invisible
until a locale source covered part of an identity chain. Not fixed here, and not a one-liner: the
locale would have to travel *with* the identity through the cascade, the way the identity itself now
does. Asserted in the harness as a KNOWN behaviour so it cannot change silently, and queued.
Workaround meanwhile: set the same locale source on every table in an identity chain, or none.

---

## 2026-08-20 — SQL Server deferred to v2; run warnings surfaced on the Runs screen (migration 006)

Two decisions from the same session, recorded together because the first is what made room for the
second.

### SQL Server is deferred to v2

Build-order step 10 is **not being built for v1**. It was always flagged "best-effort, not a v1
blocker", and with MySQL, Postgres and SQLite all complete and verified, the remaining v1 value is in
making what exists *legible* rather than adding a fourth dialect with known TDS auth/encoding risk.

Kept as a **placeholder, not removed**: the `mssql` value stays in the `Dialect` union, in the config
store's `CHECK (dialect IN (…))` constraint, and in the connection form's dialect list. So a v2 adapter
drops into `makeAdapter` / `createKnex` / `buildDumpDialect` at the three seams the other three already
occupy, and until then those seams throw a clear "isn't built yet" error. Ripping the enum out would
mean a migration to widen the CHECK again later, for nothing.

**Known rough edge accepted:** the connection form still *offers* SQL Server, so a user can save an
mssql connection and only discover at Test time that no adapter exists. Left alone deliberately — the
error is clear and it is pre-existing behaviour; marking it "(v2)" in the form is a one-line change if
it ever confuses anyone.

### Run warnings are now visible in the app (migration 006)

The extract already produced the most important thing it has to say — the references backfill
**couldn't** repair, the FK constraints stripped from the DDL, unmapped polymorphic type values,
tables it couldn't address by a single-column PK — and sent all of it to `console.warn`. Invisible to
anyone running the app normally, which is everyone. Each of those describes a way the dump is quietly
*less complete* than the selection rules imply, so it belongs on screen.

- **Migration 006** adds `runs.warnings` as a plain `ADD COLUMN` (no CHECK change, so none of the
  table-rebuild dance 005 needed). Verified against a **copy of the real config store** (backup API,
  not `cp` — it is WAL-mode): v5 → v6, all 22 field strategies / 10 runs / 2 workspaces / 3
  connections intact, `foreign_key_check` clean, idempotent on a second pass.
- **Stored as a JSON array of already-formatted, stage-prefixed strings** (`"backfill: …"`,
  `"schema: …"`), not a structured shape. The renderer only lists them, so parsing them into
  code/table/column fields would be a schema to maintain with no reader. The prefix stays *inside* the
  text because it is what tells you whether "references will dangle" came from the backfill pass or
  the morph pass.
- **Empty is stored as NULL, not `[]`**, so "nothing to report" and "predates the column" are
  indistinguishable to the renderer — correct, since neither has anything to show.
- **`failRun` carries warnings too.** They are collected into an array threaded through
  `executePipeline` rather than returned from it, precisely so a run that *throws* keeps what it had
  already produced — the pipeline usually warns about the data shape several stages before whatever
  finally fails.
- **Informational output stays console-only** (rows backfilled, morph edges followed). Those aren't
  problems, and mixing them into a warnings list is how you train a reader to ignore the list.

Verified in the real app: the e2e harness fixture now includes an included table with an FK to an
**excluded** one, which produces both a `backfill:` and a `schema:` warning; the Runs screen shows a
"2 warnings" tag on the summary line and both messages beneath it, and the screenshot was eyeballed.

---

## 2026-08-20 — Cross-table anonymization identity: an overlay on the selection, not a new map value

Spec §7's promise — a cascaded child's fake fields "are seeded from the parent's identity, not its own
row ID", so `payments.cardholder_name` matches `users.name` for the same person — is now implemented.
This was the last correctness gap flagged against build-order step 6. Verified by
`scratchpad/identity-smoke.ts` (22 checks) over the spec's own `users → orders → payments` chain.

### `TableSelection.identities` is a partial overlay, deliberately

The obvious implementation is to widen `ids: Map<PkValue, boolean>` into
`Map<PkValue, {anonymize, identity}>`. Rejected: `ids` is read in five places and written through
`mergeKeep`'s preserve-wins rule, and every one of those call sites would have had to change for a
value that is **absent on most rows**. Instead a second map carries identity, with the invariant that
**an absent entry means "this row is its own entity"** — so `run.ts` falls back to
`ownIdentity(table, pk)`, which is byte-for-byte the previous behaviour. The field is **required** on
the interface (not optional) so the compiler flagged all three construction sites; a silently missing
map would have degraded to "no cross-table consistency" without any error.

### Who inherits, and who doesn't

- **Rule-matched rows** get no entry — they *are* the root entity.
- **Cascade** copies the parent's identity down, falling back to the parent's own key. Reading the
  parent's *own* identity rather than recomputing from the parent table is what makes it survive a
  multi-hop chain: a payment two hops from `users` is `users:42`, not `orders:7`. A 1-hop fixture
  cannot tell those apart, which is why the harness uses the spec's 2-hop example.
- **Backfill** deliberately gives a pulled-up parent **no** entry. A user dragged in because one of
  their posts was kept is still their own person; inheriting the child's identity would make two
  unrelated users share a name whenever they shared a kept descendant.
- **`rowKey` stays per-row**, so `jitter` is unaffected. Verified: two payments of the same entity with
  identical source amounts still get different jitter (53 vs 54 from 50.0). Had `rowKey` been left
  equal to `identityKey` — as it was before, when both were `table:pk` — every row of one entity would
  have been perturbed identically, which is a *new* bug the change could easily have introduced.

`mergeIdentity` is **first-write-wins**: a child reachable from two kept parents (a pivot, or two FKs
onto the same table) must not depend on which edge was walked last. Unlike the anonymize flag there is
no "safer" identity, so any deterministic choice is correct — and cascade's traversal order is already
deterministic (it is what makes a re-run byte-identical). Confirmed stable across re-runs.

### Known limitation, and why it isn't fixed by guessing

Identity follows **every** cascade edge, because the cascade cannot distinguish an *ownership* edge
(`users → orders`) from an *incidental* one (`posts → comments`, where the commenter is not the post's
author). On an incidental edge every descendant of one root shares that root's fake values — realistic
for the former, wrong for the latter, and a mild realism regression for a table like
`comments.author_email` which previously got a distinct value per row.

Spec §7 specifies the graph-following behaviour, so that is what ships. It only bites where a
descendant carries a `fake` strategy on an identity-ish column. The fix, when it is wanted, is a
**declared per-table identity source** — the same shape as `table_locale_sources` ("this table's
locale comes from column X"), which is already the established idiom for exactly this kind of
per-table hint. Inferring it from the FK graph would just be a different guess.

---

## 2026-08-20 — SQLite adapter: safe integers, read-only opens, real streaming, lazy FK targets

The SQLite adapter (build-order step 8's second half) is `SQLiteAdapter` + `sqliteDumpDialect` +
`createKnex`/`makeAdapter`/`buildDumpDialect` cases. Verified by `scratchpad/sqlite-smoke.ts`
(118 checks, 4 phases: introspection, dialect, full pipeline loaded into a fresh database, split-mode
applied twice). Five decisions are worth recording because each one was a fork with a wrong-looking
default.

### 1. `safeIntegers: true`, then narrow every value back — silent int64 corruption otherwise

`better-sqlite3` funnels INTEGERs through a JS double by default, so `9223372036854775807` reads back
as `9223372036854776000` — **silently, with nothing to catch**. Safe integers is the only way to see
an int64 exactly, but it returns *every* integer as a `bigint`, which `PkValue` (`string | number`),
`Map` keys and `value()` can't take. So `narrowInteger` maps each value to a `number` when lossless
and to its **decimal string** when not — the same shape node-pg already produces for `int8`.

Widening `PkValue` to include `bigint` was the alternative, and it is *more* correct: a quoted literal
relies on SQLite's column affinity to become an integer again, which holds for any INTEGER/NUMERIC
column but not for an untyped (BLOB-affinity) one. Rejected for now because it means widening the
`DbAdapter` signatures and both working adapters for a case (an int64 beyond 2^53 in a column declared
with no type) that no realistic schema has. **That is the escalation path if it ever bites.**

The narrowing is applied to **every** read, introspection included — not a style choice. Safe integers
apply to `PRAGMA` output too, so `table_xinfo.hidden` arrives as `3n` and `index_list.unique` as `1n`,
and a `=== 1` test against those is silently false forever. Both bugs were live in the first draft:
`getGeneratedColumns` returned `[]` (so the dump tried to INSERT into a generated column and
**failed to load**) and `getUniqueColumns` saw no unique index at all. Neither showed up in the
obvious assertion — `notNull === 0` returning false still "passes" against a `NOT NULL` column, which
is precisely the vacuous-pass trap in the standing fixtures-lie rule.

### 2. Read-only opens, because for a file dialect the "never touch production" promise is enforceable

`options.readonly` closes a real footgun beyond the obvious one: a read-write open **creates** an empty
database when the file is missing, so a mistyped path would leave a stray `.sqlite` behind *and report
a successful connection test*. Read-only fails cleanly instead. The WAL worry turned out to be
unfounded — verified a read-only open against a live WAL (writer attached), an orphaned `-wal` from a
dead writer, and db + `-wal` at mode 444 with no `-shm`. `ping()` is `SELECT COUNT(*) FROM
sqlite_master`, not `SELECT 1`, so it actually reads the file; a non-database file fails at open
(`file is not a database`).

### 3. `streamRows` bypasses knex, because knex's SQLite "stream" is not one

knex's sqlite3 dialect (which the better-sqlite3 client inherits) implements `_stream` as
`statement.all()` then `rows.forEach(row => stream.write(row))` — the whole result set is materialized
first. That silently violates spec §9's never-buffer-a-table contract. The query is still *built* with
knex (quoting, `whereIn`, bindings) and then run against the pooled driver handle with
`better-sqlite3`'s genuinely lazy `iterate()`. The iterator is explicitly closed before the handle
returns to the pool, or abandoning iteration early leaves the connection stuck "busy executing a
query". Pool size stays at the shared default for **deadlock safety**: a single-member pool would make
any introspection call issued during a stream wait forever on the member the generator holds.

### 4. A dangling FK target is kept as an edge, not dropped

SQLite resolves an FK's parent lazily, so `CREATE TABLE t (x REFERENCES gone(id))` is accepted against
a database where `gone` doesn't exist — neither server dialect can produce this. Dropping the edge
from `getForeignKeys` was the first instinct and it is wrong: the dangling `REFERENCES` then survives
into the emitted DDL, and because tools including `better-sqlite3` turn `PRAGMA foreign_keys` **ON**
(SQLite's own default is OFF), the developer's first INSERT into that table fails with
`no such table: main.gone`. Keeping the edge routes it through the machinery that already exists —
`run.ts` puts it in `absentParents`, `stripForeignKeysTo` removes it, `backfillSelection` reports an
`omitted` target, `topologicalOrder` ignores out-of-set edges, and the cascade never walks to it.
Verified both ways: the stripped DDL loads *and* accepts an INSERT with enforcement back on.

`PRAGMA foreign_key_list` needs two more repairs the other dialects don't: the parent column comes back
**NULL** when the DDL referenced the parent implicitly (`REFERENCES users`), and the parent name comes
back with **whatever casing the DDL used**, since SQLite compares identifiers case-insensitively while
every layer above compares them exactly.

### 5. `stripForeignKeysTo` for SQLite is inline and fail-open; no `resetSequence` at all

`sqlite_master.sql` is stored **verbatim**, not regenerated, so there is no canonical shape to parse:
Laravel's sqlite migrations put an entire `CREATE TABLE` with a table-level `foreign key(...)
references ...` on **one line**, which MySQL's line-oriented stripper cannot touch. So table-level and
column-level references are matched as inline fragments (table-level first, or its `REFERENCES` gets
caught by the column-level pattern and leaves a stray `FOREIGN KEY (…)`). Because free text can hide a
`REFERENCES` inside a string default or CHECK expression, the edit is **fail-open**: if the result is
no longer a balanced `CREATE TABLE`, the original DDL is returned. Loadability never depends on the
strip succeeding (see 4) — only the loaded database's usability does.

No `resetSequence`: SQLite self-heals like MySQL. Verified — inserting an explicit `id = 500` into an
`AUTOINCREMENT` table moved `sqlite_sequence.seq` to 500 and the next auto id was 501. Note
`sqlite_sequence` is empty until the first insert, so it is useless for *detecting* AUTOINCREMENT;
`getSequenceColumns` reports the **rowid alias** instead (a lone PK declared exactly `INTEGER` in a
rowid table), which auto-assigns whether or not AUTOINCREMENT was declared.

### Smaller divergences, all verified

- `PRAGMA table_list` for `getTables`, not `sqlite_master`: the latter reports a virtual table **and
  its shadow tables** as `type='table'` (one `fts5` table contributes six rows), which would put
  internal tables in the dump. `table_list` labels them `virtual`/`shadow` and views `view`.
- `PRAGMA table_info` **omits** generated columns while `SELECT *` returns them, so `getColumns` uses
  `table_xinfo` — otherwise the streamed rows carry columns introspection never reported.
- A single-column `INTEGER PRIMARY KEY` is the rowid alias and has **no `index_list` entry at all**, so
  `getUniqueColumns` adds the PK separately from the indexes.
- `NOTNULL` is a SQLite keyword, so `AS notNull` is a syntax error regardless of case — the alias has
  to be quoted.
- Non-finite REALs: SQLite stores `Infinity`/`NaN` as NULL itself (the literal `9e999` is also null),
  so `value()` emitting `NULL` for them loses nothing. A NUL byte is the one thing a text literal
  can't carry, so such a string is emitted as `CAST(X'…' AS TEXT)`, which round-trips exactly.
- No version skew is possible, unlike Postgres' external `pg_dump`: the SQLite reading the file is the
  one bundled into `better-sqlite3` (3.53.2 here).

---

## 2026-08-20 — Two unloadable/throwing-extract bugs fixed: strip absent-parent FKs, pre-flight PKs

Both were "the extract fails or emits something that can't load", both surfaced by earlier work rather
than by a user report, and both are now reproduced-then-fixed with the failure proven load-bearing.

### 1. An FK to a table that isn't in the dump makes the dump unloadable

Excluding a table that an **included** table references left `… REFERENCES <excluded>` in the DDL, and
the load aborted with `relation "…" does not exist`. Turning FK enforcement off doesn't help — this is
DDL, not data — so the whole dump was worthless.

New `DumpDialect.stripForeignKeysTo(ddl, absentTables)`, per-dialect because the DDL shape differs
*fundamentally*:

- **Postgres**: `pg_dump` emits each FK as its own trailing `ALTER TABLE … ADD CONSTRAINT` statement,
  so the whole statement goes. The regex is bounded by `[^;]` so it can't swallow the next statement,
  and narrowed to `FOREIGN KEY` because **`PRIMARY KEY` constraints share the exact same
  `ALTER TABLE … ADD CONSTRAINT` shape** and must survive.
- **MySQL**: `SHOW CREATE TABLE` inlines FKs as comma-separated items *inside* the body — so removing
  one that happens to be the **last** item leaves `…,\n) ENGINE=…`, a syntax error. The comma is
  repaired afterwards. This is the sharp edge, and it's why the MySQL side is verified by feeding the
  stripped DDL to a real MySQL 8 rather than only asserting on strings.

`bareTableName` normalises `app.orgs` / `"app"."orgs"` / `` `orgs` `` / `ORGS` to `orgs`, so one
`absentTables` set serves both dialects — consistent with the bare-name config model.

The dropped constraints are **reported**, not silently removed: the reference genuinely won't exist in
the target, which the user should know about.

### 2. A composite-PK child reached by a plain FK threw out of the whole extract

`cascadeSelection`'s `ensure()` resolves a single-column PK, so a composite-PK child killed the run.
Fixed the same way morph edges already were — a pre-flight — but the important part is **scope**: the
filter applies to cascade's edge list **only**. `foreignKeys` stays whole for `topologicalOrder`
(which needs every edge to order DDL correctly) and for `backfillSelection` (whose `pull` already
reports a child it can't read). Filtering globally would have quietly corrupted DDL ordering.

Refactored morph's `filterAddressableMorphEdges` to delegate to a new generic
`filterAddressable(adapter, items, describe)` in `pk.ts`, so both edge kinds share one implementation
and one per-table cache.

**This was latent, not theoretical:** Spatie's `model_has_roles` has a three-column PK *and* a real
`role_id → roles` FK. It only ever went unnoticed because nothing in the real workspace seeds `roles`.

### Verified 2026-08-20 — 21 checks, both failures reproduced first

- **Strippers (unit, against DDL captured from live servers):** absent-parent FK removed, present-parent
  FK kept, `PRIMARY KEY` untouched, CREATE TABLE body untouched, no-op when nothing is absent; MySQL
  last-item **and** middle-item removal both leave valid syntax with no dangling comma.
- **Stripped MySQL DDL loaded into real MySQL 8** — parses and creates the table.
- **End to end (Postgres):** without the strip the dump **fails to load**; with it the dump loads, the
  excluded table is absent, `docs` keeps all 20 rows, and only the resolvable FKs survive.
- **Composite-PK:** without the pre-flight the extract **throws**; with it the run completes, the child
  is reported, contributes no rows, and its parent is still selected.
- Full regression on both dialects: PG + MySQL backfill (25 orphans → 0), int8/int4 and explicit-rule
  anonymization, morph down + up, template engine/e2e, store + config harnesses.

**Harness fix along the way:** the template e2e asserted "every remaining email is a faker one" across
the whole column, which conflated *the engine failed* with *you didn't bind that path*. On a different
fixture a real email survived at the unbound `recovery_email` path — correct overlay behaviour read as
a regression. The assertion is now **per path**: bound paths must be clean, unbound ones carrying real
emails are reported as information. Same class of mistake as the morph fixture trap.

## 2026-07-30 — Template anonymizer built (migration 005): overlay inside JSON, form-preserving

Implements [docs/template-anonymizer.md](../docs/template-anonymizer.md). A new `template` field-strategy
kind binds JSON paths to existing generators and **overlays** them onto each row's real value — the only
strategy that can reach a value nested in a blob.

Motivated by a live leak rather than a hypothetical: enabling morph down-cascade brought `audits` back
into the dump (0 → 82 rows), and `audits.new_values` carried **6 real emails and 9 bcrypt hashes** that
no column-level strategy could touch. Redacting the whole column would have emptied the audit payload.

- **Migration 005, not 004.** The plan claimed 004; morph shipped first and took it, exactly as both
  plans agreed. 005 is a full **table rebuild** because SQLite cannot alter a CHECK constraint — the
  risk is losing existing rows, not adding the column.
- **Overlay, never generate.** A path with no binding is untouched; a bound path the row doesn't have
  is **skipped, not created**. That is what lets rows of differing shape all survive, and it's checked
  both ways round.
- **Form-preserving, and this is the sharp edge.** Postgres delivers `json`/`jsonb` as verbatim *text*
  (the `PG_VERBATIM_TEXT_OIDS` override) while mysql2 delivers a parsed *object*, and each dialect's
  `value()` expects that same form back. Text in → text out, object in → object out; returning the
  wrong one resurrects the `[object Object]` / double-encoding corruption fixed on 2026-07-24.
- **Clones before overlaying.** `anonymizeRow` copies the row shallowly, so a nested object is still
  shared with the source row — overlaying in place would mutate the caller's data. Explicitly tested.
- **Seeded per leaf** on `identityKey:column:path`, per the plan. Two paths bound to the same generator
  (`address1`/`address2` → `streetAddress`) therefore get *different* values, which a
  seed-on-generator scheme would have collapsed. Cross-column consistency with the scalar `fake`
  strategy is deliberately not attempted: a bound leaf is identified by where it lives.
- **Locale comes free.** The whole blob generates from the row's already-resolved `fakerFor(country)`,
  so a row's faked city and postcode agree — the single biggest reason a template beats hand-rolling.
- **Corrupt `template_json` degrades to zero bindings** (inert), not a throw and — far more importantly
  — not an emptied column.

### Three places the plan was under-specified

- **Sample 50 rows, not one.** The plan said one sample. Shape variance is the *entire* reason for
  overlay semantics, and one sample shows one shape, so the user would never think to bind a key the
  other rows carry. Discovery unions across the sample and reports `presentIn` per path. On the real
  `audits.new_values` that surfaced 21 paths at wildly different frequencies (`firstname` 9/50,
  `email` 6/50) because each row audits a different model — a single sample would have shown one model.
- **Paths cross IPC, never values.** The sample is production data; returning values to the renderer
  would move real PII into the UI for nothing. `JsonPathSample` carries path + JS types + `presentIn`.
- **A saved binding survives a later sample.** The builder unions discovered paths with the strategy's
  stored ones, so a binding whose key isn't in *this* sample stays editable instead of vanishing on
  save. Without that, re-opening a strategy after a schema/data change would quietly delete bindings.

Also: `sampleColumnValues` is a new adapter primitive rather than reusing `getDistinctValues`, because
Postgres `json` (as opposed to `jsonb`) has **no equality operator** — `SELECT DISTINCT` on it fails
outright, and json columns are precisely what this is for.

The plan's open decision "flag if a bound path was a number" is answered in the **UI**: each builder row
shows the detected type, so binding a `number` leaf to a string generator is visible before saving. The
engine still replaces it, per decision 4.

### `redact` and `remove` added the same day, after the first live run

The first real dump exposed the gap immediately: `audits.new_values` still carried **9 bcrypt hashes**,
because a template that can only *fake* has no answer for a secret. There is no useful fake password.

`TemplateAction` = `'fake' | 'redact' | 'remove'`, and the two new ones are deliberately distinct
rather than one "exclude":

- **`redact`** keeps the key and sets it to `null` — shape-preserving, for code that expects the key.
- **`remove`** deletes the key entirely, so its former presence can't be inferred. This is what a
  secret wants.

`action` is **optional and defaults to `'fake'`**, which is what makes it backward compatible: the real
workspace already had 11 bindings persisted as bare `{ path, generator }`, and those keep working
untouched. The repo's binding filter had to be relaxed accordingly — a generator is required only for
`fake`, since `redact`/`remove` legitimately carry none. Both actions honour the same
never-create-a-key rule as `fake`: a path this row lacks is a no-op, not an invention.

One dropdown per path covers all four outcomes; the two actions lead the list because they're what
secrets need. Verified: remove/redact on flat and nested paths, through both the object and text forms,
creating nothing when absent, plus an action-less legacy binding still faking.

### Verified 2026-07-30

- **35 engine unit checks** (pure function, no DB): both dialect forms round-trip; optional path faked
  when present and *not created* when absent; nested paths; null/non-JSON/number/top-level-array all
  untouched; re-run stable; two same-generator paths differ; locale changes output; source row not
  mutated.
- **Migration 005 against a copy of the real config store**: 15 existing strategies survived the
  rebuild with an identical kind breakdown (`fake=10 redact=5`), `foreign_key_check` clean, widened
  CHECK accepts `'template'`. Repo round-trip covers blank-path dropping, action-only bindings
  persisting without a generator, kind switching nulling the other kind's columns both ways, and
  corrupt payload → inert.
- **End to end on real `audits.new_values`** (real pipeline → real dump → load into a fresh database):
  dump loads, 82/82 rows, every value still a JSON object, **9 bcrypt hashes → 0 via
  `password → remove`**, **8 emails all faker-domain** (the 6 real ones gone), unbound
  `projects_count` present in the same 6 rows, bound `email` key not invented (8 → 8), and a
  byte-identical re-run.
- Full regression on both dialects: PG + MySQL backfill (25 orphans → 0), int8/int4 and explicit-rule
  anonymization, morph down-cascade and up-backfill, stage-1 store/config harnesses.

**Not visually verified** — the builder builds (FieldsView 27 kB → 38 kB) and typechecks, but no window
has been opened on it.

**Known gap kept from the plan:** arrays are out of v1 (`keywords`, `attachments`). Discovery *shows*
array paths with an `array` type tag rather than hiding them, so a bound-but-ignored path reads as a
documented limit instead of a bug.

## 2026-07-30 — Morph stage 3: up-backfill shares the plain-FK pass; "dangling" splits in two

Stage 3, and the last of [docs/polymorphic-cascade.md](../docs/polymorphic-cascade.md). A kept row's
morph reference now resolves to a row that is also kept — the integrity half, and the one no FK check
could ever catch because no constraint exists.

The plan's instruction to build this *with* the plain-FK parent backfill was right: both go through one
`pull(edge)` step inside `backfillSelection`, because "ensure these parent ids are kept" doesn't care
whether the parent table's name came from a constraint or from a resolved type value. Only the read
differs, so `pull` takes it as a thunk — which also preserves the cheap role/`keepAll` short-circuits
ahead of any query.

New primitive `getReferencedIdsMorph` on both dialects (`getReferencedIds` + `AND typeColumn = ?`).
Up edges are deliberately **not** filtered by `cascadeTarget` (their child may legitimately be a
reference table, dumped whole and still a source of references) and **not** pre-flighted on the child's
PK (a whole-table read needs no PK).

### The structural fix: backfill's seed must include morph-carrying tables

The seed loop keyed on `parentEdges` — tables with outbound **FKs**. A morph-*only* table has none:
resconx's `audits` has zero constraints. So it was never visited, and its morph references could not be
repaired however the relation was declared. The seed is now the union of both edge kinds' child tables.

Proven load-bearing: revert the union and 40 repairable `audits` dangles survive, while `calendars` —
which does have FKs — is repaired either way. That asymmetry is exactly the trap; testing only against
a table with FKs would have shown a pass.

Also made `pull` warn instead of throwing when an edge can't be *read* (composite-PK child, a declared
column that no longer exists). Same stance as the rest of this file, and it now protects the FK path too.

### "Dangling" is two different things, and only one is Masq's to fix

Initially I asserted that up-backfill should drive morph dangles to zero. It didn't — 75 → 59 — and the
code was right while the assertion was wrong. A reference whose target **was deleted upstream** is
pre-existing source corruption no backfill can repair: `audits` rows are historical records, so the
audited user may be long gone. Splitting the measurement:

- **40 repairable dangles → 0** (targets that exist in the source and simply weren't selected)
- **59 rows / ~20 distinct ids already broken in the source**, now reported per edge
  (`audits.auditable_type=App\Models\User has 20 value(s) with no matching row in "users"`)

Worth stating plainly because it's a real finding about the *source*: **resconx_staging itself holds
orphaned polymorphic references.** They'll appear in any dump, and no subsetting logic can fix them —
`getExistingIds` is what surfaces them instead of silently counting them repaired.

### Verified 2026-07-30 on the real resconx schema + data, user's own declarations

- `calendars` (classified `reference`, dumped whole): 7 repairable Project dangles → **0**.
- `audits` (zero FKs): 33 repairable User dangles → **0**.
- Backfill pulled users 6 → 11 and projects up the chain; `institutions`/`project_types`/
  `project_stages` grew too, i.e. it recursed to *their* parents.
- **Up-only holds:** with down-cascade off, `project_task_cards`, `project_invitations`,
  `user_publications` and `documents` counts are byte-identical between runs — a backfilled target
  never expands its children.
- Harness: `scratchpad/morph-backfill-smoke.ts`.

**Regression:** the whole suite re-run on both dialects after refactoring `pull` out of proven code —
PG + MySQL backfill (25 orphans → 0), the int8/int4 and explicit-rule anonymization checks, all three
unrepairable-edge warnings with no false positives, morph down-cascade, and the stage-1 store/config
harnesses.

**Latent risk noticed, not fixed:** `cascadeSelection`'s `ensure()` still throws on a composite-PK
child reached by a plain **FK** edge. `model_has_roles` has `role_id → roles`, so if `roles` ever
becomes kept, the extract fails. It hasn't fired because nothing seeds `roles`. The morph paths are now
guarded; the FK path is not.

## 2026-07-30 — Morph stage 2: down-cascade as a second edge kind in the same worklist

Stage 2 of [docs/polymorphic-cascade.md](../docs/polymorphic-cascade.md). A kept entity now pulls the
rows it owns through a declared morph relation — the coverage half of morph support.

- **One traversal, two edge kinds.** The plan's core reframing (a morph relation is an FK whose
  parent table is chosen per row by a sibling column) pays off here: morph edges go through the
  *same* worklist, the same preserve-wins `mergeKeep`, and the same re-enqueue as FK edges. The merge
  step was factored into a local `absorb(childTable, pairs)` that both paths call, so there is exactly
  one implementation of "keep these children" and no chance of the two drifting.
- **New adapter primitive `getRowsReferencingMorph`** on both dialects — `getRowsReferencing` plus
  `AND typeColumn = ?`. NULL type columns are excluded by the equality test itself, so nulls need no
  special case.
- **`morphEdgesFor(relations, direction)`** expands declared relations × their type maps into edges,
  selecting on the relation's own `cascadeDown`/`backfillUp` flag. `cascadeSelection`'s new parameter
  **defaults to `[]`**, so any caller that doesn't know about morphs behaves exactly as before — the
  opt-in guarantee holds structurally, not just by convention.
- **Unmapped type values are checked against live data at extract time**, not trusted from the config
  screen: the source can start writing a new value at any point after a relation was declared and
  nothing revalidates in between. Reported, never silently skipped — silence here is
  indistinguishable from "that entity owned no rows", which is the exact failure morph support exists
  to remove.

### Composite-PK morph tables must warn, not abort — found before it could bite

`filterAddressableMorphEdges` pre-flights every declared edge and drops those whose child table has
no single-column PK, reporting each.

This matters more than it sounds. **Morph relations are declared by hand, so config can point the
engine at a table it cannot subset** — and composite-PK morph tables are completely normal: Spatie's
`model_has_roles` and `model_has_permissions` are morph-shaped with a three-column PK, detection
suggests both, and the user had *already declared* `model_has_roles.model_type` on the real workspace.
Verified against the live schema: its PK is `(role_id, model_type, model_id)`. Without the pre-flight,
ticking "down" on it would throw out of `ensure()` and **fail the entire extract** rather than warn.
A pre-flight rather than a guard inside the cascade because this is a *config* validity question, and
it keeps `cascadeSelection` free of error-collection plumbing. Same stance as `backfillSelection`'s
unrepairable edges: Masq flags, the user resolves.

### Verified 2026-07-30 on the real resconx schema + data (loaded from a Masq dump)

Using the morph relations the user actually declared in the app, with `down` ticked:

- **`audits` 0 → 29-58 rows and `messages` 0 → 4-44 rows** (varies with the random seed), and with a
  **fixed** seed *no other table's count changes at all* — so the gain is attributable to the morph
  edges and nothing else. Both tables are morph-only (`audits` has zero FK constraints), so they were
  previously unreachable by any means.
- **Correctness, not just quantity:** every kept row was checked to trace to a kept user through the
  declared type value. This caught a real subtlety — `messages.reply_to_message_id → messages.id` is
  self-referential, so a morph-seeded message legitimately pulls its *replies*, which may be from
  other users. The assertion now accounts for that path explicitly rather than being loosened; an
  unexplained row would still mean the type predicate had leaked. 40 `audits` rows with a non-User
  `auditable_type` were correctly left out.
- `model_has_roles` warned (`composite primary key (role_id, model_type, model_id)`) and contributed
  no rows; the run completed.
- `audits.auditable_type` warned about its unmapped bare `user` value — the source-hygiene case from
  the 2026-07-26 entry, surfacing exactly as designed.
- Opt-in mechanism unit-checked: `cascadeDown: false` → 0 down edges, `backfillUp` independent of it,
  no mappings → no edges.
- Held across three random seeds. Harness: `scratchpad/morph-cascade-smoke.ts`.

**Regression:** because `absorb` was extracted from proven code, the full backfill suite was re-run on
both dialects — 25 orphans → 0 unchanged, the int8/int4 cascade and both anonymization checks still
pass, plus the stage-1 config and store harnesses.

**Harness lesson (again):** `scratchpad/tsconfig.json` extended only the *node* config, so a harness
importing renderer stores couldn't typecheck (no `@renderer` alias, no `window.api` declaration). It
now includes both path aliases plus `preload/index.d.ts` and `renderer/src/env.d.ts`. Two real errors
were hiding behind the noise.

## 2026-07-30 — Morph stage 1: config + builder UI (migration 004), inert until the engine reads it

First stage of the polymorphic plan ([docs/polymorphic-cascade.md](../docs/polymorphic-cascade.md)).
Lands the declaration model and the screen to fill it, and **changes no extract behaviour** — stages
2 (down-cascade) and 3 (up-backfill) are what read this config. That's the point of the staging: it
ships safely on its own and lets real morphs be declared before the engine can act on them.

- **Migration 004** (morph beat the template anonymizer to the number, per the plan's tie-break, so
  that plan takes 005). `morph_relations` + `morph_type_map`, the latter `ON DELETE CASCADE` on the
  former.
- **Two independent direction flags, with asymmetric defaults**: `cascade_down` **off**,
  `backfill_up` **on**. Down changes the dump's *size*, so declaring a relation must not silently
  grow the subset; up is *integrity*, matching the always-on plain-FK parent backfill. Both are
  per-relation, and toggleable straight from the list without opening the form.
- **`UNIQUE (workspace, table, type_column)`, not (workspace, table).** A table can carry two morphs
  — resconx's `calendars` has both `calendarable_*` and `eventable_*`. Detection found exactly that,
  which is what confirmed the key.
- **The relation and its type map are one aggregate.** A relation with no mappings resolves to
  nothing, so they're never usefully edited apart; the repo reads/writes them together and a save
  **replaces** the whole map rather than diffing it (small map, and a replace can't leave a stale
  mapping behind). One deliberate exception: `updateMorphRelation` only rewrites the map when the
  patch actually carries one, so a toggle-only update from the list view leaves mappings untouched.
- **Create upserts on the unique key**, matching the field-strategies repo. The primary flow is
  "confirm this detected candidate", which must re-declare rather than fail.
- **Blank targets are dropped, not persisted** (both in the modal and the repo). The builder shows a
  row for every type value found, including ones the guesser couldn't resolve — an unmapped row is a
  visible prompt, not a saved mapping that resolves to nothing.

### Detection: guess, but validate the guess against the real table list

`detectMorphCandidates(adapter)` in [morph-detect.ts](../src/main/adapters/morph-detect.ts) makes the
UI confirm-not-author: find `X_type` columns with an `X_id` sibling, read the distinct type values
present, and best-guess each value's target (class basename → snake_case → pluralised).

Two decisions that make a naming heuristic safe here:

1. **A guess is only offered if the table actually exists.** `guessTargetTable` tries candidate forms
   in most-specific-first order (unchanged, then `+es`/`y→ies`, then `+s`) and returns `undefined`
   when none match, so the UI asks rather than proposing a plausible table name that isn't real.
   Irregular plurals we don't model (`Person` → `people`) simply fall through to that.
2. **A column pair whose id side already has an FK is skipped.** That's a plain relation — its target
   doesn't vary — so offering it would be noise. Keyed on the *id* column, which is precisely what a
   real morph leaves unconstrained.

Distinct type values are capped at 50: a genuine morph type column holds a handful, so an unbounded
`DISTINCT` would only ever be expensive on a column that isn't one. New adapter primitive
`getDistinctValues(table, column, limit)` on both dialects.

**Verified 2026-07-30 against the real resconx_staging schema** (loaded from a Masq dump, so no source
credentials needed — a reusable trick for schema-shaped tests):

- **20 morph candidates found in 73 tables**, matching the plan's predicted ~19 of 83.
- **16 of 16 type values guessed correctly; zero needed the user to pick.** Real Laravel FQCNs
  (`App\Models\Conference` → `conferences`) and the bare-alias case both resolved.
- `audits.user_type` holds *both* `App\Models\User` and bare `user` — the "two spellings of one
  entity" case the plan calls a source-hygiene problem. Worth noting that the guesser maps both to
  `users` correctly, so **for detection it's harmless**; the plan's concern is about the engine
  trusting canonical values, which stands.
- **0 FK-constrained columns offered** as morphs.
- Guesser unit cases pass including `APIClient` → `api_clients`, `Media` → `media` (uncountable),
  `Category` → `categories`, forward-slash namespaces, and the two deliberate `undefined`s.

Config store proven with the **real repository code** (an `electron` shim supplies `app.getPath` so it
runs under `ELECTRON_RUN_AS_NODE`): upsert reuses the row, map replace-not-merge, toggle-only update
preserves the map, two morphs on one table, and both cascade deletes (relation → mappings, workspace →
relations). Migration 004 also applied to a **copy of the real config store** — 2 workspaces, 3
connections, 15 field strategies, 32 classifications, 7 runs all intact, `foreign_key_check` clean.

**Harness limitation worth knowing:** `migrate.ts` reads its files via Vite's `import.meta.glob`,
which esbuild can't resolve, so both harnesses apply the same on-disk `.sql` files with the same
semantics instead of calling `runMigrations`. The runner itself is unchanged and already proven by
migrations 1–3 in the real app.

### Code-review fixes: config drift must be visible, and detection must arm its own dropdowns

Two P2s found by review of this branch, both in the renderer wiring — the layer that looked like
"just IPC wrappers" and therefore hadn't been tested. Both reproduced first, then fixed, and the
regression test fails against the pre-fix code (4 checks).

1. **Detection hid missing mappings for already-declared relations.** A declared relation is filtered
   out of `undeclaredCandidates`, and the edit form loaded only *persisted* mappings — so if the source
   started writing a new type value after the relation was declared, re-running detection found it but
   the UI showed it nowhere. The engine log-and-skips an unmapped edge, so that morph reference would
   dangle while the config looked complete. This directly contradicted the plan's own "surfacing it
   prompts the user to complete the map".
   Fixed both ends: `unmappedValuesFor(relation)` in the store, surfaced as a warning block on the
   declared relation's card (with the Edit button turning amber), **and** merged into the edit form's
   map with the guessed target prefilled, so noticing and fixing are one click apart.
2. **`detect()` didn't populate the target-table options.** The type→table dropdowns read
   `discovery.tables`, which only the Tables screen ever filled, so on a fresh session every
   unresolved guess had to be typed by hand against an empty list — even though detection had the full
   table list internally and discarded it.
   Fixed by topping up the discovery cache inside `detect()` **when cold**, run concurrently with
   detection (independent query → no extra wall-clock) and with its failure swallowed (detection is
   what the user asked for; the selects still accept free text). Chosen over changing
   `detectMorphCandidates` to return the table list — that would have made a composite return shape
   out of a single-purpose API — and over auto-discovering on view mount, which would fire a
   production query on screen open and break this project's explicit-action convention.

Declaring by hand on a session where nothing has been detected still opens with an empty table
dropdown; that path relies on the documented free-text fallback.

**Not visually verified.** The screen builds (own 54 kB chunk) and typechecks, but no window has been
opened on it — same standing caveat as the other config screens. Note both review findings were
*behavioural in the store*, not visual, and a headless Pinia test caught them: worth reaching for
before assuming a renderer gap needs eyes.

## 2026-07-30 — Selection-key identity: a PK value is only a valid `Map` key if the DRIVER typed it

Found by code review of the parent-backfill branch, then reproduced live. **The most dangerous bug
class this codebase has hit so far**, because its failure mode is a silent PII leak that leaves every
other check green.

`TableSelection.ids` is a `Map<PkValue, boolean>` keyed by primary-key value, and the dump's row
stream decides whether to anonymize a row with `ids.get(row[pkColumn])`. `Map` keys compare with
`===`, so **`42` and `'42'` are different rows as far as that lookup is concerned** — and the two
representations arrive from different places all the time:

- **An FK column need only be *comparable* to the key it references, not identically typed.** Postgres
  accepts an `int8` FK onto an `int4` PK (it records separate `conpfeqop`/`conffeqop` equality
  operators in `pg_constraint` precisely for this), and `node-postgres` returns `int4` as a JS number
  but `int8` as a **string** (to avoid precision loss). MySQL is stricter here and rejects the
  mismatch outright (`ERROR 3780 … are incompatible`), so this is Postgres-specific — verified both.
- **Config values are JSON**, so an `explicit` rule's `values: [42]` is a JS number regardless of how
  the driver types that table's PK.

The lethal part is that a mistyped key still *satisfies* everything else. The dump writer's
`WHERE pk IN (…)` filter is evaluated **by the database**, which coerces happily — so the row is
selected, appears in the dump, and passes every referential-integrity check. Only the in-process
anonymize lookup misses, and the row is emitted **verbatim, with real PII**. Reproduced: 5 of 5
backfilled `authors` and 3 of 3 explicitly-selected rows dumped with real emails and real names while
the orphan count read zero.

**Rule: never use a value as a selection key unless it came from the column that keys the selection.**
Three instances found and fixed, all in this change:

1. `backfillSelection` — parent ids read off the child's FK column. Fixed by a new adapter primitive
   `getExistingIds(table, ids)`, which re-reads them through the parent's own PK, so **the comparison
   happens in SQL** (where the database's own coercion rules apply) and the values come back typed
   the way the row stream will emit them. Bonus: ids with no matching row are dropped, so an
   already-broken source is reported instead of silently counted as repaired.
2. `cascadeSelection` — `getRowsReferencing` reports each match's parent id as the *child's FK column*
   types it, and that was looked up directly in the parent's id map. Milder symptom (the child is
   silently never cascaded — under-inclusion, not a leak), same root cause. Fixed by matching on
   canonical `String(id)` form against the ids actually requested, which is safe because every
   returned value equals one of them. Verified load-bearing: reverting it drops the cascaded children
   from 6 to **0**.
3. `resolveSelection`'s `explicit` branch — config values used directly as keys. Fixed via
   `getExistingIds`. The other three strategies were already safe (`random`, `pattern` and `all` all
   take driver-typed values straight from the adapter), which is exactly why this went unnoticed.

Rejected alternative: **canonicalize every selection key to a string** at the boundaries. It would
work and preserves bigint precision, but it touches every producer and consumer of `TableSelection`
(select, cascade, backfill, the row stream, the writer's `WHERE` builder), and a single missed site
reintroduces the same silent leak. Resolving through the database keeps the authority for "are these
the same row?" in the one place that actually knows — and needs no coordination between call sites.

**Still unguarded by construction** — if a fourth instance appears it will be this shape: a value that
reaches `ids` without a round trip through its own column. `PkValue`/`TableSelection` carry a warning
in their doc comments, but nothing enforces it at the type level. A branded `PkKey` type resolved only
by the adapter would; not worth it yet.

## 2026-07-30 — Parent backfill built: a separate up-only pass, always on, unrepairable edges warn

Implements the fix required by the 2026-07-25 "cascade keeps a child on ANY one parent" entry, and
**closes it**. New stage [backfill.ts](../src/main/extract/backfill.ts) `backfillSelection`, run by
`executePipeline` immediately after `cascadeSelection`.

- **A separate pass, not another edge kind inside `cascadeSelection`.** The two walk opposite
  directions and must not be allowed to interleave: cascade goes parent → child, backfill child →
  parent, and a backfilled row must **never** be fed back into down-cascade. Keeping them as two
  passes with two worklists makes that structural rather than a rule someone has to remember. It is
  also what the morph up-backfill will reuse (see the 2026-07-26 morph entry) — same "ensure these
  parent ids exist in table T" mechanism, different way of naming the parent table.
- **Up only, and that's the whole safety story.** Rows added for integrity get their own parents
  pulled in (recursively — or the dangle just moves up a level) but never their children. Bounded by
  one ancestor chain per dangling reference; expanding children would drag in unbounded subtrees.
- **Always on, no toggle.** It's a correctness fix, not a feature: the alternative is a dump that
  loads clean and is silently broken. It *does* enlarge a dump, which the run log now explains
  (`[extract] parent backfill added N row(s)…`). A workspace toggle can be added if anyone actually
  wants the old behaviour back.
- **Backfilled rows are flagged `anonymize = true`** (via `mergeKeep`, so preserve-wins still holds
  for rows that were already selected). A row dragged in purely for integrity was never matched by a
  preserve rule, so there's no reason to emit it verbatim.
- **Reference tables are backfill *sources*, never *targets*.** A reference table is dumped whole, so
  nothing can dangle *into* it — but its own FKs can point at a subset table (`plans.created_by →
  users`), and that case is real. Modelled as a 3-way `TableRole` (`subset`/`complete`/`omitted`)
  derived from the classification, rather than a pile of booleans.
- **Unrepairable edges warn, they don't throw or silently drop** — matching the morph plan's "Masq
  flags, the user resolves" stance. Three cases, each reported once: parent classified **excluded**
  (unfixable by design — tells the user to reclassify), FK onto a **non-PK** unique column (the same
  limitation cascade already carries), and a **composite-PK** parent (`primaryKeyColumn` throws; the
  pass catches it per-table so one unsupported parent can't kill an otherwise-good run).
- **New adapter primitive `getReferencedIds(childTable, fkColumn, childIds?)`** — distinct non-null
  FK values, the upward mirror of `getRowsReferencing`. `childIds` omitted = the whole table, which is
  how `keepAll` selections and reference tables are read. NULLs are dropped in SQL (a NULL FK
  references nothing). Implemented in both MySQL and Postgres adapters, chunked the same way.

**Live-verified 2026-07-30 on both dialects** — identical results, and the fix is provably
load-bearing (turn backfill off and the orphans come straight back):

- Fixture covering every shape: the `team_user` pivot, a 5-level self-referential `manager_id` chain,
  a transitive up-chain (`team_user → teams → institutions`), a reference table pointing at a subset
  table, and nullable FKs holding NULL.
- **Postgres** (`postgres:16-alpine`, non-`public` schema, real dump loaded into a fresh DB, orphans
  counted by direct LEFT JOIN per introspected FK): **25 orphans across 3 FK columns → 0**. Backfill
  added `users +6, teams +10, institutions +6`; `institutions` went 0 → 6, proving transitive
  recursion, and `team_user` stayed at 21, proving children are *not* expanded.
- **MySQL** (`mysql:8`): same fixture, same numbers — 25 → 0, same added counts.
- Anonymization survives: 27 users, 27 distinct emails, 0 unfaked — backfilled rows are anonymized
  and the UNIQUE collision guard still holds across the enlarged set.
- Re-running produced a **byte-identical dump**, so the pass is deterministic.
- All 3 unrepairable-edge cases warned and the run completed.

**LEFT JOIN, not `VALIDATE CONSTRAINT`, is the only honest integrity check** — as the morph plan
already noted. The constraints come out of `pg_dump` already marked valid, so `VALIDATE` no-ops and
reports success on a broken database.

**Found while testing, NOT fixed here (new, separate gap):** if an **included** table has an FK to an
**excluded** table, the dump is **unloadable** — `pg_dump`'s per-table DDL emits the trailing
`ALTER TABLE … ADD CONSTRAINT … REFERENCES <excluded>`, and the load fails outright with
`relation "…" does not exist`. Not a regression and nothing to do with backfill (backfill only warns
about the dangling *data*), but it means excluding a referenced table is currently worse than the
warning implies. Needs the writer to drop FK constraints whose parent isn't in the dump. Logged in
[state.md](state.md).

## 2026-07-26 — Polymorphic (morph) cascade: model it as a per-row-resolved FK edge

Design for morph-relation support in the cascade, planned in
[docs/polymorphic-cascade.md](../docs/polymorphic-cascade.md) (with Mermaid diagrams). Key choices:

- **A morph relation = an FK whose parent table is chosen per row by the `*_type` sibling column.**
  So it slots into the existing FK-driven BFS ([cascade.ts](../src/main/extract/cascade.ts)) as a
  second edge kind, rather than a separate subsystem.
- **Two directions, separable:** *down* (keep an entity → pull its owned morph rows; new coverage,
  opt-in per relation) and *up* (a kept row's morph ref dangles → backfill the target; integrity).
  **Up shares its mechanism with the plain-FK parent-backfill** ("ensure these parent ids exist in
  table T"), so build the two together. Backfill **recurses up, not down** — pull an ancestor's own
  parents but never expand its children, or one dangling ref drags in an unbounded subtree.
- **Config-declared, not inferred.** Morphs carry no constraint, so the user declares them; declaring
  is the opt-in (undeclared morphs behave exactly as today). UI is seeded by auto-detecting
  `*_type`/`*_id` pairs, introspecting distinct type values, and best-guessing the type→table map
  (basename → snake_case plural).
- **Type values are assumed canonical — data hygiene is out of scope (user decision, 2026-07-26).**
  A column mixing `App\Models\User` and bare `user`/`admin` for the *same* entity (resconx's `audits`,
  `model_has_roles`) is a source inconsistency normalised **upstream** (data fix, or a consistent
  Laravel `enforceMorphMap`), not something Masq reconciles. Masq maps each canonical value and
  **surfaces any it can't map**; deliberate morph-map aliases (distinct real targets) are still just
  normal map entries.
- Staged: config + builder UI (inert, lands alone) → down-cascade → up-backfill with item #2.
  Migration 004/005 shared with the template-anonymizer plan (whichever lands first takes 004).

## 2026-07-26 — JSON anonymization: template-overlay strategy chosen over json-lorem

The earlier "json-lorem" idea (replace every string in a JSON blob with lorem) is **superseded** by a
**template anonymizer**: overlay a row's real JSON, binding chosen paths to the existing generators,
with per-row locale + per-path seeding. Reasons: real data (`users.address`) has *shape that varies
per row* (5 vs 6 keys), so overlay (walk the actual value, replace only bound paths) beats emitting a
fixed template; and it produces realistic, locale-consistent output instead of noise. It composes the
existing `FakeGenerator`s rather than adding new ones ("on top of the default ones"). Full design:
[docs/template-anonymizer.md](../docs/template-anonymizer.md). Not built — needs migration 004 (CHECK
rebuild on `field_strategies`) and a builder UI.

## 2026-07-26 — New generators `loremWords` + `dateOfBirth`; DOB must pin faker's refDate

Added two `FakeGenerator`s (no migration — they slot into the existing `fake` kind: type union +
`GENERATORS` map + modal option groups). Two things worth keeping:

- **`dateOfBirth` pins `refDate`.** `faker.date.birthdate()` defaults `refDate` to **now** (it
  subtracts an age from the current instant), so the same seed produces a *different* date each run —
  which silently breaks Masq's re-run stability guarantee. Verified: unpinned → non-deterministic;
  pinned to a constant (`2025-01-01`) → a pure function of the seed. The engine re-seeds per value, so
  the only remaining source of drift was this hidden `now` dependency.
- **`dateOfBirth` returns `YYYY-MM-DD` text, not a JS `Date`.** A `Date` would hit the Postgres dialect
  as an ISO *datetime* — wrong type text for a `date` column, and tz-shiftable (the same class of bug
  the `PG_VERBATIM_TEXT_OIDS` override fixed). Formatting via `toISOString().slice(0,10)` in UTC keeps
  it date-only and shift-proof.
- Verified through the real `anonymizeRow` path: re-run stable, distinct per identity, DOB matches
  `^\d{4}-\d{2}-\d{2}$`, lorem stays short (safe for `varchar`), originals replaced.
- **`avatarUrl`** (`image.avatar()`) added shortly after — deterministic under seed, ~75-char URL
  (safe for `varchar(255)`), no gotcha. Motivated by real Google avatar URLs (`googleusercontent.com`)
  left untouched in `users.avatar_url` during the live test — genuine PII (identifies the account).
- **`loremSentence`/`loremParagraph`/`url`** added next — same footing, all seed-deterministic.
  `loremParagraph` (~100 chars) will overflow a tight `varchar`; it's for `text`/`longtext` (noted in
  the type doc + UI label). `url` = `internet.url()` (a generic website URL; faker also offers
  `image.url`/`domainName`/`username` if a more specific one is ever needed). Faker's URL/avatar
  values point at real external hosts (placeholders, not the person's) — fine for dev data, but they
  are live-fetchable, so not for a fully air-gapped output.

## 2026-07-26 — Postgres extensions recreated in the dump preamble, not per-table

`pg_dump --schema-only --table=X` deliberately dumps only that table — it emits **no**
`CREATE EXTENSION`, so a schema using pgvector/pg_trgm produced a dump that failed on load with
`type "…vector" does not exist` (a real-world blocker, hit on resconx_staging). Fix:

- **`getExtensions()` on `DbAdapter`** (`{name, schema}[]`) — Postgres reads `pg_extension` joined to
  `pg_namespace`, excluding `plpgsql` (always present in `pg_catalog`); MySQL returns `[]`.
- **The dialect preamble recreates them**, not the per-table DDL, because extensions are
  database-level objects. `createPostgresDumpDialect(schemas, extensions)` now emits, in this
  order: `CREATE SCHEMA` (for search-path *and* extension schemas) → `CREATE EXTENSION IF NOT EXISTS
  … WITH SCHEMA …` → `SET search_path`. **`WITH SCHEMA` is mandatory, not cosmetic**: the pg_dump'd
  table DDL references the type schema-qualified (`resconx_staging.vector(1536)`), so the extension
  must be created in that exact schema or the type stays unresolved. Order is load-bearing both ways
  (schema before extension before the DDL that uses its types).
- **The dialect is now built *inside* `executePipeline`**, not in the old synchronous
  `dumpDialectFor(connectionId)`, because the preamble needs a live `getExtensions()` call. MySQL
  short-circuits to the static `mysqlDumpDialect` without ever calling it — its path is untouched.
- **Scope: extensions only.** Custom types (enums/domains/composite) are the same class of pg_dump
  omission and would use the same preamble seam, but resconx uses none (its only non-builtin type is
  the extension's `vector`), and their DDL is much harder to hand-roll than `CREATE EXTENSION`. Left
  as a follow-up (see state.md).
- **Requires the extension to be installed on the target server** (`CREATE EXTENSION` needs the
  `.so`). Can't fix that from a dump — but now it fails with a clear, actionable error instead of
  silently omitting the extension. Proven end-to-end: the pgvector dump loads clean into a
  `pgvector/pgvector:pg16` target (`vector(1536)` column + all 8 `gin_trgm_ops` indexes present).

## 2026-07-25 — pg_dump's `\restrict` meta-commands must be stripped from DDL

Modern `pg_dump` (16.10+ / 17.6+, from the 2025 security fixes) brackets its output with
`\restrict <token>` … `\unrestrict <token>`. Those are **psql meta-commands, not SQL**, and the first
version of `stripPgDumpSessionLines` didn't remove them, so a pair ended up inside every table's DDL
blob.

This survived the whole first round of end-to-end testing because every one of those tests loaded the
dump with `psql`, which understands the meta-commands and pairs them per table. It only showed up when
a later test happened to print the DDL's first line. **Masq's deliverable is a *portable* `.sql` file
(spec §9)** that a developer may open in a GUI client or push through a driver, and there it dies on
`syntax error at or near "\"` — proven both ways by executing the same DDL through `node-pg` with the
filter off and on.

The filter now drops any line starting with a backslash. No SQL statement begins with one, so this is
safe and also covers whatever meta-command pg_dump adds next. **Lesson worth keeping: validating a
"portable SQL file" only through `psql` doesn't validate portability** — psql accepts things no other
client will.

## 2026-07-25 — Cascade keeps a child on ANY one parent, so multi-parent rows dangle (FIXED 2026-07-30)

**Superseded by the 2026-07-30 parent-backfill entry above — implemented and live-verified on both
dialects.** Kept for the diagnosis and the measurements.

Surfaced by the first full Postgres pipeline run. **Supersedes the "no upward parent-backfill" note in
the 2026-07-24 extract-engine entry by showing it is not a nice-to-have but a correctness bug**, and
it is dialect-independent.

`cascadeSelection` keeps a child row when **any** one of its FK parents is kept. A child with two
parents — a pivot table, e.g. Laravel's `team_user(user_id, team_id)` — is therefore kept via parent A
while its reference to parent B dangles. The load runs with FK enforcement off and Postgres never
re-validates, so **psql exits 0 and the dev database silently holds dangling references**. Measured
both ways so it isn't a rule artifact: `teams: all` → 31 of 40 `team_user` rows had absent users; no
rule on `teams` → all 11 rows had absent teams. Re-adding the constraint afterwards fails with
`Key (user_id)=(4) is not present in table "users"`.

Decision: **the parent backfill deferred on 2026-07-24 is now a required fix**, not an enhancement —
after cascade, every kept row's FK parents must be pulled in transitively. Not yet implemented; a
workspace whose rules happen to cover every parent of every kept child is unaffected. Recorded rather
than fixed in the same change so the adapter work stays reviewable on its own.

## 2026-07-25 — PostgresAdapter: bare names resolved against the search path, DDL via pg_dump

The read half of step 8. Decisions worth not re-deriving:

- **Bare table names, resolved to the first schema on the search path that holds them, and cached.**
  Masq keys its whole config model on an unqualified name, and `createKnex` sets the session
  `search_path`, so *data-movement* queries need no schema handling — they resolve exactly as the
  source app's own queries do. Introspection can't rely on that (an `information_schema` predicate
  needs a concrete schema), so `schemaOf()` resolves a bare name **in search-path order, not
  alphabetically**, matching Postgres' own resolution. A same-named table in a second schema on the
  path is therefore only reachable as the first — inherent to the bare-name config model.
- **`getUniqueColumns` reads `pg_index`, not `information_schema.table_constraints`.** The latter only
  knows named constraints and would miss a bare `CREATE UNIQUE INDEX`, which enforces uniqueness just
  as hard and would fail the load if the anonymizer duplicated a value. Predicate uses
  `indnkeyatts = 1` (so an index with INCLUDE columns still counts as single-column) and
  `indpred IS NULL` (a *partial* unique index only constrains its subset, so the column isn't
  globally unique). Expression indexes drop out for free — their `indkey[0]` is 0, matching no
  `attnum`. Verified live: a table with a bare unique index, a partial index and a `lower(email)`
  index returned only the genuinely-unique columns.
- **`getForeignKeys` reads `pg_constraint`** — Postgres' `key_column_usage` has no referenced-table
  column (unlike MySQL). `generate_subscripts` walks `conkey`/`confkey` in step so a composite FK
  emits one edge per column pair, matching the per-column rows MySQL produces. Chosen over
  multi-argument `unnest(conkey, confkey)` because subscripts are unambiguously valid in any position.
- **`getColumns` reads `pg_attribute` + `format_type`** rather than `information_schema.columns`:
  `format_type` gives the native type text (`numeric(12,2)`), the closest analogue to MySQL's
  `column_type`, and the primary-key join against `pg_index` stays cheap.
- **DDL shells out to `pg_dump`** (spec §9). Three things this had to handle, all found by testing:
  `--no-owner --no-acl` (or the DDL carries `OWNER TO` for roles absent on a dev box); stripping
  `pg_dump`'s session preamble, because its
  `SELECT pg_catalog.set_config('search_path','',false)` would **wipe the search path the dump's own
  preamble just set** and break every bare-identifier INSERT after it; and quoting the `--table`
  pattern, since an unquoted mixed-case name folds to lower case and matches nothing.
- **`pg_dump` is preflighted once per adapter, not per table**, because both failure modes are
  environmental and deserve a clear message rather than a cryptic spawn error on table one: the binary
  is **not bundled with the app**, and `pg_dump` **refuses to dump from a server newer than itself**
  (so PG 16 client tools against a PG 17 server fail on everything). It authenticates independently of
  the knex pool via `PGPASSWORD`, which is why `makeAdapter` now receives the password.

## 2026-07-25 — Identity + generated columns: `OVERRIDING SYSTEM VALUE` and a narrowed INSERT list

Closed the two load-breaking gaps found by probing the dialect against Postgres features the fixture
didn't cover. Both were verified fixed **and** proven load-bearing by negative tests (revert the fix,
watch the load fail), on live PG 16 and MySQL 8.4.

- **`DumpDialect.insertModifier`** — an optional clause emitted between the INSERT column list and
  `VALUES`. Postgres sets it to `OVERRIDING SYSTEM VALUE` so a `GENERATED ALWAYS AS IDENTITY` column
  accepts the dumped value; without it the load dies on `cannot insert a non-DEFAULT value into
  column "id"`. MySQL leaves it undefined.
  **Emitted unconditionally for Postgres, not per-table**, because it's cheaper and can't be missed
  for one table. Verified harmless where there is nothing to override: `GENERATED BY DEFAULT AS
  IDENTITY`, a plain `serial` PK, and a table with no sequence or identity at all all accept it.
  Requires PG 10+, which is where identity columns arrived anyway.
- **`DbAdapter.getGeneratedColumns`** — database-computed columns (`GENERATED ALWAYS AS (…)`) are now
  dropped from the INSERT column list in `run.ts`. Both engines reject an explicit value for them
  (Postgres: `cannot insert a non-DEFAULT value into column "total"`; MySQL 8: `ERROR 3105 … is not
  allowed`), and the value is recomputed on load — verified identical to source. **This was a latent
  bug in the MySQL path too**, not something Postgres introduced; it had simply never been hit.
  Rows still *stream* every column — the DDL and the anonymizer see the full set, only the INSERT
  tuple is narrowed.
- **Identity ≠ generated, and they're handled oppositely.** Postgres reports an identity column as
  `is_identity=YES` / `is_generated=NEVER`; identity *values are dumped* and forced in with the
  override, generated values are *omitted*. Keeping them as two separate adapter methods
  (`getSequenceColumns`, `getGeneratedColumns`) reflects that.
- **The MySQL predicate matches `extra` narrowly on purpose.** MySQL 8 reports
  `extra = 'DEFAULT_GENERATED'` for an ordinary column with an expression default
  (`DEFAULT CURRENT_TIMESTAMP`, `DEFAULT (UUID())`). A loose `LIKE '%generated%'` would have silently
  dropped those *real* columns from every INSERT — losing data quietly, the worst failure mode here.
  Verified against MySQL 8.4: the narrow predicate selects only the two genuine generated columns,
  while the loose one would also have taken `made_at`, `updated_at`, and `uuid_col`.
  It matches on `extra` **only** — `generation_expression` arrived in 5.7 and a missing column would
  throw and fail the entire extract, whereas `extra` exists in every version (and generated columns
  don't predate 5.7). Bare `virtual`/`persistent` equality covers older MariaDB spellings.

## 2026-07-25 — Code-review fixes: array type OIDs, `$user`, quote-aware search-path parsing

Three review findings against the same-day Postgres work, all reproduced against a live PG 16 and
all real. Worth recording because two of them were *my* wrong assumptions, not oversights.

- **Verbatim type overrides must list each type WITH its array form** (P1, the serious one). pg's
  array parser recurses into the element parser, so overriding only the scalar OIDs left
  `date[]`/`timestamp[]`/`timestamptz[]`/`interval[]`/`json[]`/`jsonb[]` on pg's defaults and
  reintroduced exactly the corruption the override existed to prevent. Reproduced: a `date[]` of
  `{2026-07-25,2026-01-01}` emitted as `{"2026-07-24T23:00:00.000Z",…}` (a day early);
  `interval[]` emitted as an array of **JSON objects** (`{"days":1,"hours":2}`); and a `json[]`
  element of `[1,2]` became a *nested* `{{"1","2"}}` — a multidimensional array literal that no
  longer matches the column and fails to load. `PG_VERBATIM_TEXT_OIDS` is now built from explicit
  `[scalar, array]` pairs so the invariant is visible: **add both, or neither.** Array types whose
  elements pg already returns dump-safely (`text[]`, `numeric[]`, `uuid[]`, `bool[]`, `int[]`) stay
  out — `pgArrayLiteral` renders those correctly. Confirmed via `pg_type.typcategory='A'` that these
  six are the complete set of affected array types.
- **`$user` is resolved from the connection username, not dropped** (P2). Postgres' stock
  `"$user", public` intentionally prefers the role's own schema when it exists; silently rewriting
  that to `public` reads the wrong same-named tables or misses tables entirely. `parseSearchPath`
  now takes an optional `username` and substitutes it (matching what the server does with
  `CURRENT_USER`), which fixes the session path and introspection scoping in one go — no need for
  the two separate code paths the review suggested, since a resolved concrete name is equivalent for
  both and Postgres ignores a non-existent schema on the path. Dropped only when no username is
  available, since an unresolved placeholder can't scope an `information_schema` query. Verified
  end-to-end: connecting as `alice` with `"$user", public` gave session path `alice, public` and a
  bare `things` resolved to `alice.things`, not `public.things`.
- **Search-path parsing is quote-aware** (P2). Splitting on every comma turned the valid
  `"tenant,archive", public` into three schemas. Now a hand-written tokenizer treats only *unquoted*
  commas as separators, reads `""` as one escaped quote, keeps whitespace inside quotes significant,
  and **lower-cases unquoted entries** to match Postgres' identifier folding (so introspection scopes
  to the schema the session actually resolves) while leaving quoted entries verbatim. Parser suite is
  23 cases; knex was confirmed to quote an odd schema name correctly in its `SET search_path`.

Regression-checked after the fixes: the full end-to-end suite still passes in combined and split
mode with the six array types folded permanently into the fixture — md5-identical rows, split data
file still re-runnable after simulated drift, sequences still `MAX+1`.

## 2026-07-25 — Postgres dump dialect: FK toggle, sequence resets, and a search-path preamble

Built `createPostgresDumpDialect` and the sequence-reset stage, all **verified end-to-end against a
real PostgreSQL 16** (throwaway container): dump a non-`public` schema → load into a fresh database
→ every row of every table hashes identically to the source, in both combined and split mode.

- **FK enforcement toggles via `SET session_replication_role = replica` / `origin`** — what
  `pg_dump --disable-triggers` uses. It fits the existing flat-string `disableForeignKeys` pair, so
  **the `DumpDialect` interface did NOT need reshaping** for this (the earlier worry was unfounded).
  Rejected `ALTER TABLE … DISABLE TRIGGER ALL` (per-table, doesn't fit a single string) and
  `SET CONSTRAINTS ALL DEFERRED` (only works on `DEFERRABLE` constraints). Costs a superuser-ish
  privilege on load, which is fair for a local dev database. Proven load-bearing: a mutually
  self-referencing FK loads with the toggle and fails with `parent_manager_id_fkey` without it.
- **The toggle protects DML only — DDL ordering is still load-bearing.** No FK toggle rescues
  `CREATE TABLE … REFERENCES <missing table>`; `topologicalOrder` is what makes combined dumps
  loadable. (MySQL differs here: `FOREIGN_KEY_CHECKS=0` *does* let you create a table referencing a
  missing one.)
- **Sequence resets are a new post-data writer section** (`resetSequence?` on `DumpDialect`,
  `sequenceColumns?` on `DumpTable`). Needed because a Postgres sequence keeps its pre-load value
  where MySQL's `AUTO_INCREMENT` self-heals — so `mysqlDumpDialect` deliberately omits
  `resetSequence` and the section is skipped entirely.
- **The reset statement is the user's usual form, hardened for empty tables.** Theirs —
  `setval(pg_get_serial_sequence(t,c), (SELECT MAX(c) FROM t), true)` — is a **silent no-op on an
  empty table** (`setval` is strict, `MAX` is NULL). That's routine in a subsetter, where a table can
  legitimately contribute zero rows, so we use `COALESCE(MAX(c),1)` with `MAX(c) IS NOT NULL` as
  `is_called`: empty → next value 1, populated-with-gaps → `MAX+1`. Both verified.
- **`getSequenceColumns` was added to `DbAdapter` because the reset is NOT self-guarding.** The
  first attempt filtered on `isPrimaryKey` assuming a non-sequence PK would no-op (NULL sequence +
  strict `setval`). Wrong: `MAX(col)` is resolved when the statement is *parsed*, and `uuid` has no
  `max()` overload — `ERROR: function max(uuid) does not exist` kills the statement and everything
  after it. Only emitting resets for introspected sequence-backed columns fixes it; no runtime guard
  can.
- **`postgresDumpDialect` is a factory, not a constant, because the dump needs a preamble.** The
  writer emits **bare** identifiers (Masq keys its whole config model on bare table names), so a
  dump taken from a non-`public` schema wouldn't resolve on load. Each file now opens with
  `CREATE SCHEMA IF NOT EXISTS …` + `SET search_path TO …`, built from the connection's parsed search
  path. `public` is skipped when creating (exists everywhere; `CREATE SCHEMA` can trip on ownership).
- **Postgres type parsing is overridden per-connection so the dump can't corrupt values.**
  `createKnex` passes a `types.getTypeParser` that returns verbatim server text for
  date/timestamp/timestamptz/interval/json/jsonb. Two reasons, both verified: (1) `node-pg` parses a
  `date` into a **local-timezone** `Date`, so `2026-07-25` became `2026-07-24T23:00Z` under BST and
  re-serializing shifted it a day; (2) `json`/`jsonb` parse to objects, and a json column holding a
  top-level array becomes a JS `Array` **indistinguishable from a real `int[]`/`text[]` column** —
  one needs `[1,2]`, the other `{1,2}`, so guessing from the value is a coin flip. Keeping JSON as
  text means any remaining JS array is genuinely an array column. This is the Postgres analogue of
  the `dateStrings: true` watch-item noted for mysql2.
- **Array values get a real Postgres array literal**, not JSON — elements always double-quoted
  (verified `'{"1","2"}'::int[]` is accepted), `"`/`\` backslash-escaped, bare `NULL` for nulls.
- **`TRUNCATE … CASCADE` is mandatory, not defensive.** Postgres refuses to truncate a table
  referenced by an FK *even when the referencing table is empty*, and `session_replication_role`
  does not relax it (both verified). Caveat worth knowing: CASCADE can reach a referencing table
  *outside* the dump set.
- **Batched INSERTs mask intra-statement FK violations.** A multi-row INSERT checks FKs at statement
  end, so a forward reference *within one batch* satisfies itself. Relevant when reasoning about FK
  behaviour — a test at the default batch size of 500 can pass for the wrong reason.

## 2026-07-25 — Postgres schema scoping: store the raw search path, don't assume `public`

**Confirmed with the user (2026-07-25): their own apps run on a non-`public` search path**, so the
"just default to `public`" shortcut was wrong from the start. Postgres needs real schema config.

- **The stored field is `Connection.searchPath`, holding the value *as typed*** — not a parsed
  schema list, and not a single `schema` column. Reason: it mirrors what the app being subsetted
  already declares (Laravel's `DB_SEARCH_PATH`, Postgres' `search_path`), so a user can copy the
  line across from their `.env` and it round-trips verbatim. Supporting a comma-separated list
  fell out of that for free, and lists are common in multi-tenant/extension setups.
- **Order is preserved.** Postgres resolves an unqualified name against the first schema in the
  path that has it, so `tenant, public` ≠ `public, tenant`. The parser keeps the given order.
- **`$user` is dropped at parse time.** It's resolved by the server per session, so it can't scope
  an `information_schema` query up front. It's the leading entry in Postgres' stock
  `"$user", public` default and the schema usually doesn't exist, so dropping it leaves the
  intended `public`. Blank/absent → `['public']`, so callers always get at least one schema.
- **Parsing lives in `src/main/adapters/search-path.ts`**, not in the repo or the form — both
  `createKnex` (session `searchPath`) and the future `PostgresAdapter` (scoping
  `information_schema` queries) need the same list, and the raw string is what's persisted.
- **`createKnex` now handles postgres; `makeAdapter` still refuses it.** A Postgres connection can
  be saved and a pool opened, but introspection/extract throws a specific "adapter isn't built
  yet" error rather than a generic one. Splitting it this way let the config half land and be
  verified without waiting on the adapter.
- Migration `003_connection_search_path.sql` is `ALTER TABLE … ADD COLUMN` (nullable, no default),
  so it's a safe in-place upgrade for an existing `config.sqlite3`. Verified on a simulated
  upgrade: pre-existing MySQL rows survive with `search_path` NULL → `undefined`, and NULL round-
  trips to the `public` fallback. Note the column lands *after* `file_path` in ordinal position —
  harmless, since the repo maps `SELECT *` by name and names its INSERT columns explicitly.
- **Known limitation:** Masq's config model keys everything (classifications, selection rules,
  field strategies) on a **bare table name**, so a table of the same name in two schemas on the
  path is ambiguous. Tracked in `state.md` rather than solved now — schema-qualifying the whole
  config model would ripple through every screen.

## 2026-07-25 — Postgres drivers: `pg` + `pg-query-stream` + `@types/pg` (three packages, not one)

Step 8 groundwork. The spec (§2) lists `pg` as the Postgres driver, but adding *only* `pg` would
have left a runtime hole:

- **`pg-query-stream` is required, not optional.** `knex` declares it as a `peerDependency`
  (`^4.14.0`) and loads it lazily for `.stream()` on Postgres. Our `streamRows` is built on
  `query.stream()`, so without this package Postgres extraction would typecheck, build, connect,
  introspect, and then fail **only at dump time** — the worst place to find out. Installed
  explicitly alongside `pg`.
- **`@types/pg` is a separate devDependency** — `pg` 8.x ships no bundled types (no `types`/
  `typings` field in its package.json), unlike `mysql2`.
- **Both runtime packages are pure JS**, so no `electron-builder install-app-deps` rebuild
  concern — same as `mysql2`, unlike `better-sqlite3`.

**Dump escaping will delegate to `pg`'s own routines**, mirroring the 2026-07-24 decision to reuse
`mysql2`'s `escape`/`escapeId` rather than hand-rolling an escaper. Verified that `pg` exports
`escapeLiteral` / `escapeIdentifier` at module level (`import { escapeLiteral } from 'pg'`), so
`postgresDumpDialect` gets the same shape as `mysqlDumpDialect`. Note `escapeLiteral` returns a
**leading space** before the `E'…'` form when the value contains a backslash (` E'back\\slash'`) —
deliberate on pg's part so the result is safe to concatenate; harmless inside a `VALUES` tuple.

Verified on 2026-07-25: installed, `pg` + `pg-query-stream` load, `knex({client:'pg'})` constructs
a `Client_PG` with a working `.stream()`, `typecheck` + `build` green. No live Postgres server hit
yet. The introspection/DDL/FK-toggle divergences this exposes are tracked in `state.md` (step 8).

## 2026-07-24 — Extract engine: sliced pure stages over the adapter, run inside withSourceAdapter

The extract pipeline (steps 5–7) is built as small composable stages under `src/main/extract/`,
each a mostly-pure function over the `DbAdapter`: `resolveSelection` → `cascadeSelection` →
(`anonymizeRow` per row) → `writeCombined/SplitDump`, tied together by `run.ts`. Decisions:

- **Orchestration runs entirely inside `withSourceAdapter`** rather than opening a bespoke handle —
  the callback can be long-lived, so the source pool stays up for the whole stream and tears down in
  the existing `finally`. No new connection-lifecycle code.
- **Selection is seed-only; cascade fills descendants.** `resolveSelection` records only direct
  rule matches; rule-less transactional tables get rows purely from `cascadeSelection` (parent→child
  BFS). No upward parent-backfill — the spec seeds at roots, so a rule on a child won't pull parents.
- **Preserve-wins encoded as flag AND** (`mergeKeep`): a kept row's anonymize flag is the AND of all
  sources that kept it, so any preserve (`false`) is sticky. Cascade re-enqueues a row only when
  newly kept or when its flag drops to preserve; flags are monotonic → terminates on circular FKs.
- **Determinism via re-seed-per-value**, not a free-running faker: `sha256(key)`→48-bit seed before
  each generated value. `fake` keys on `identityKey:generator` (order-independent, so the same
  person's fake name is identical across tables/columns/re-runs); `jitter` on `rowKey:column`.
- **§8 cross-table identity is a known gap.** `run.ts` currently keys identity per row (`table:pk`),
  which gives determinism + re-run stability + within-row consistency but NOT same-person values
  across tables (users.name vs payments.cardholder_name). Closing it needs the cascade to carry the
  root entity's identity to descendants; the `identityKey`/`rowKey` seam is already threaded through.
- **Dump escaping delegates to mysql2** (`escape`/`escapeId`) — literal SQL text, but reusing the
  driver's own routines avoids a hand-rolled escaper. Writer is dialect-agnostic behind `DumpDialect`.
- **FK safety = checks-off wrapper + topo order** (spec §9). Combined wraps everything; split's data
  file additionally TRUNCATEs in reverse-topo for re-runnability; split's schema file is pure DDL.
- **Runs recorded in the config store** (`runs` table): `running` on start, `completed` (row counts +
  output paths) or `failed` (message) on settle. Output defaults to `userData/dumps/` (a path picker
  is a later UX add). No live DB run yet — logic verified by typecheck/build + review only.

## 2026-07-24 — Faker output is country-specific, resolved data-driven per row

The `fake` field strategies must produce **country-appropriate** values (GB postcode `SW1A 1AA`
vs US ZIP `90210`, GB vs US phone formats, etc.). Faker does this via locales (`en_GB`, `en_US`,
`nl`, …). Decision on *where the country comes from*: **data-driven — resolved per row from that
row's own country column**, not a fixed per-workspace or per-strategy locale. Chosen over a flat
workspace locale because a real DB holds users from many countries, and over per-strategy locale
because that would let one person's faked name (GB) and address (US) diverge — the spec §8
identity-consistency guarantee needs a *single* locale per identity.

Config model (built as a slice): a per-table **locale source** — `table_locale_sources`
(`workspace_id`, `table_name`, `country_column`, unique per workspace+table) — names the column
whose value gives the row's country. Migration `002`. Repo/IPC/store/UI follow the established
pattern; the country column is picked from the live-introspected column list on the Fields screen,
per table group.

Deferred to the engine (step 7): the actual value→locale mapping and per-row resolution.
**Confirmed with the user (2026-07-24): country columns hold direct values, NOT FK ids** — so the
engine maps the column value straight to a faker locale (ISO alpha-2 or country name: `GB→en_GB`,
`US→en_US`, `NL→nl`); no join/lookup-table resolution path is needed. Unmappable/blank values fall
back to a default locale. Cascade (spec §7) propagates a parent's resolved locale to child fake
fields, so only root/independent identity tables need a country column configured.

## 2026-07-24 — Field Strategies screen (step 6 UI): union ↔ flat columns, upsert-by-column

Sixth repository→IPC→store→view slice (spec §8). Choices worth recording:

- **The `rule` discriminated union is stored flat.** `field_strategies` has `kind` +
  kind-specific `generator`/`jitter_percent` columns; the repo's `toRule()`/`toColumns()` map
  between that and the domain's `FieldStrategyRule` union. Only the kind-relevant column is
  written (fake→generator, jitter→jitter_percent), the rest null — same discipline as the
  selection-rule repo.
- **Create upserts on `UNIQUE(workspace, table, column)`, edit updates by id.** Unlike selection
  rules (many per table), a column has exactly one strategy, so `createFieldStrategy` does
  `INSERT … ON CONFLICT … DO UPDATE` (create-or-replace a column's strategy without a unique
  crash); `updateFieldStrategy(id, patch)` handles in-place edits including table/column renames
  cleanly. The store's `create` merges by id so a replace doesn't duplicate the local cache row.
- **Column is a live-introspected dropdown** (added same day). Selecting a table calls a new
  `source:listColumns` channel (adapter `getColumns` → `withSourceAdapter`), cached per
  `${workspaceId}::${table}` in the discovery store, and populates the column select with
  `name — dataType (PK)` labels. It's still a `tag` select, so a missing/failed introspection (no
  source connection, network error) degrades gracefully to a hand-typed name rather than blocking
  the form. The table picker reuses the selection-rule modal's transactional-universe options.

## 2026-07-24 — Selection Rules screen (step 5 UI): plain CRUD, not upsert

The Selection Rules slice (repo + `config:*` IPC + store + `SelectionRuleFormModal` + `RulesView`)
followed the established repository→IPC→store→view pattern, with two choices worth recording:

- **Plain CRUD keyed by id, not upsert-on-unique** (unlike table classifications). A table
  legitimately carries *several* rules — the spec §6 canonical example is "random 500 users"
  **plus** "keep all `@example.com` admins" on the same table — so there's no unique
  `(workspace, table)` constraint to upsert against. Store exposes `create`/`update`/`remove`
  like the connections store.
- **Only strategy-relevant columns are persisted.** The repo's `toColumns()` writes `count`
  only for `random`, `column`/`pattern` only for `pattern`, `explicit_values` (JSON) only for
  `explicit`; everything else is nulled. Keeps a rule row honest to its strategy and avoids
  stale fields lingering when a rule's strategy is edited.
- **`explicit` values are entered as free text** (one per line or comma-separated) and parsed
  on submit; numeric-looking tokens coerce to numbers so `values` round-trips as
  `(string | number)[]`. The table field is a `filterable` + `tag` select whose options are the
  **transactional universe** — discovered tables (from the discovery store) ∪ explicitly-
  transactional classifications, minus reference/excluded — because a discovered table defaults
  to transactional *without* a classification row, so filtering on explicit rows alone left the
  list empty. Still accepts any typed name (no hard coupling to discovering/classifying first).
- **Pattern matching stays client-side** — no change from the spec §6 decision; the modal only
  validates that the regex *compiles* (`new RegExp(...)`). Actual matching lands with the
  extract pipeline (steps 5–7 backend), which will consume these rows.

## 2026-07-22 — MySQL adapter (step 3): introspection first, `source:*` IPC namespace

First live-source-DB code. Decisions worth not reverse-engineering later:

- **Adapter interface built incrementally, not all-at-once.** `src/main/adapters/types.ts`
  `DbAdapter` currently has only the **introspection subset** (`getTables`, `getColumns`,
  `getForeignKeys`, `getCreateTableStatement`, `ping`). The spec §4 data-movement methods
  (`streamRows`, `sampleRandomIds`, `getRowsReferencing`, `getColumnValues`) are deliberately
  deferred to the extract slices (steps 5–7), where they're designed alongside selection
  rules + cascade + the dump generator. Chose a growing interface over stub-throwing methods.
- **`source:*` IPC is a separate namespace from `config:*`** (`src/main/source-ipc.ts`, its own
  `registerSourceIpc()`). These hit external DBs — slower, can fail on network/auth, read
  credentials. Keeping them apart from the config-store channels keeps each surface honest.
- **Renderer passes a connection *id*, never a password.** `withSourceAdapter(connectionId, fn)`
  reads the password from the keychain in the main process, opens a short-lived knex pool,
  runs `fn`, and always `destroy()`s in a `finally`. One-shot handles for test/introspect;
  long-lived streaming for dumps will manage its own handle later.
- **`testConnection` returns a result object `{ ok, tableCount?, error? }`, not a throw.** A
  failed health check is an expected outcome, and IPC error serialization is lossy — so
  failure travels as data. `listTables` throws (surfaced as a message toast).
- **Introspection column-name casing** handled by aliasing every `information_schema` column
  to camelCase in the query, so result keys are deterministic across MySQL versions.
- **`knex` + `mysql2` added** (both pure JS — no native rebuild, unlike better-sqlite3).
  Externalized by electron-vite; knex loads the `mysql2` client dynamically at runtime.
  `mysql2` pulls in a `fast-uri` transitive with a high-sev URI-parsing advisory — not on a
  path we exercise (we don't parse untrusted URIs); left un-fixed to avoid a breaking bump.
- **Tables screen uses a "discovered-list-as-universe, classifications-as-overrides" model.**
  Introspected names form the displayed universe; a table with no classification row shows the
  `transactional` default without persisting anything (preserves the step-4 "absence = default"
  design). Introspection targets the workspace's first `source`-role connection.

## 2026-07-21 — New connection flow: form-modal convention

First write-path in the UI. Conventions set here that later forms (edit mode, workspace
create/rename) should follow:

- **Modal owns nothing; parent owns visibility via `v-model:show`** (`defineModel`). Keeps the
  form reusable and the open/close state where the trigger lives.
- **Mutations go through the Pinia store, not the view.** `connections.create(input, password?)`
  wraps the two-call sequence (`createConnection` → `setPassword`) and merges the returned row
  into the cached `all` so `list` updates without a refetch. Views never touch `window.api`
  directly for writes.
- **Password never joins the `Connection` shape.** It's a separate arg to `create`, sent once
  to `setPassword` (keychain), consistent with the 2026-07-15 safeStorage decision. Only shown
  for server dialects; sqlite has no password field.
- **Dialect drives the field set** in one form (server host/port/database/username/password vs.
  sqlite file path) rather than separate forms per dialect — validation rules are computed off
  the selected dialect.

## 2026-07-20 — Config store (step 2): module shape, migrations, IPC surface

Built the app-local config store (spec §10) and wired the live UI onto it. Decisions made
during the build:

- **Migrations loaded via `import.meta.glob('./migrations/*.sql', { query: '?raw' })`.** The
  `.sql` files stay on disk as git-tracked source (as decided 2026-07-15), but Vite inlines
  their contents into the bundled main process at build time — so there's no need to locate
  or ship loose `.sql` files at runtime (they'd otherwise be awkward to resolve inside
  `app.asar`). The runner (`src/main/config/migrate.ts`) tracks applied versions in a
  `_migrations` table and applies each unapplied file in a transaction, idempotently on
  every app start. Verified: 2nd boot re-runs nothing.
- **IPC surface = narrow per-operation `ipcMain.handle` channels, never a DB handle.** One
  `config:<method>` channel per operation, names mirroring the `ConfigApi` interface
  (`src/shared/api.ts`). The renderer only ever calls typed methods on `window.api.config`
  (preload wraps each as an `ipcRenderer.invoke`). The raw `better-sqlite3` handle stays in
  the main process. `ConfigApi` is the single shared contract implemented on both sides.
- **`safeStorage` is guarded, never degrades to plaintext.** `credentials.ts` throws if
  `safeStorage.isEncryptionAvailable()` is false rather than writing an unencrypted password
  (spec §11). Only the encrypted blob is stored, keyed by `connection_id`.
- **`@shared` alias extended to the main + preload builds** (was renderer-only) so all three
  layers import the domain types from one place; matching path added to `tsconfig.node.json`.
  IDs use Node's built-in `crypto.randomUUID()` — no new dep.
- **First-run seed** (`seed.ts`): inserts the two example workspaces + their connections
  (moved out of the renderer mock) only when `workspaces` is empty, so restarts never
  duplicate. Demo content, nothing project-specific.

_Superseded scope note:_ the "next up = step 2" wiring is now done for the **workspace** and
**connections** stores (they load over IPC); Tables/Rules/Fields/Runs stay on the renderer
mock until their screens are built.

## 2026-07-15 — Build order: UI-first with mock data (deviates from spec §13)

The spec's build order (§13) is deliberately backend-first — it front-loads the
riskiest work (FK-graph walking, dialect adapters, streaming dumps). We're **not**
following that order here. This is a learning project, so we're going **UI-first**:
design the screens against mock data, then slot the real backend (config store,
adapters, dump engine) in behind them.

**Why this isn't throwaway work:** the domain is modelled as TypeScript types
(`src/shared/types.ts`) first — `Workspace`, `Connection`, `SelectionRule`,
`FieldStrategy`, `Run`, etc., straight from spec §6/§8/§10. Mock data conforms to those
types and the UI binds to them; when the real backend lands it returns the *same*
types, so views don't change — only the data source behind them does. The UI becomes
the contract the backend must satisfy.

The spec §13 sequence still stands as the *backend* build order; we're just building
the frontend shell ahead of it. Superseding the "next up = step 2 (config store)" note
in state.md.

## UI stack: Naive UI + vue-router + Pinia

- **Naive UI** (component library) — TS-native, idiomatic Vue 3, theming via
  `n-config-provider`, enough components for the data-dense screens this tool needs.
  Components imported explicitly per SFC (no auto-import plugin) for learning clarity.
  If a screen later needs a heavy data grid (e.g. table classification), consider
  bringing in PrimeVue's DataTable alongside rather than switching wholesale.
- **vue-router** with **hash history** (`createWebHashHistory`) — safest under
  Electron's `file://` production loading.
- **Pinia** — shared renderer state (current workspace, connections).

## 2026-07-15 — Scaffolded with electron-vite (quick-start); native rebuild via install-app-deps

Used `@quick-start/create-electron` (vue-ts template) to generate the scaffold, then
merged it into the repo, keeping our own `.gitignore` / `README.md` / `.vscode/`
extensions+settings and taking the generator's `launch.json`, configs, and `src/`.
Declined the auto-updater plugin and download-mirror options (can add an updater later).

Pinned by the generator: Electron 39, Vue 3.5, Vite 7, electron-vite 5, TS 5.9,
electron-builder 26.

**Native-module rebuild** is handled by the `postinstall: electron-builder
install-app-deps` script with `npmRebuild: false` in `electron-builder.yml`. This is
the current, supported replacement for the manual `electron-rebuild -f -w` that the
spec (§2) and CLAUDE.md describe — when we add `better-sqlite3`, `install-app-deps`
rebuilds it against Electron's ABI automatically. (Spec text predates the scaffold;
treat this entry as the operative approach.)

## 2026-07-15 — Scope: general-purpose tool, not app-specific

The app is a **general-purpose** DB subsetter/anonymizer meant to run against many
different projects and databases. Example Shop's Laravel/MySQL environment is the
*origin* use case (what it was first proven against), which is why MySQL is built out
first and the default table-exclusion presets are Laravel-flavored — but those are
editable defaults, not baked-in assumptions. No design decision should hard-code
anything project-specific; treat any such coupling as a bug. Every project is just another
workspace.

## 2026-07-15 — Electron, not Tauri _(from spec v1)_

Subsetting/anonymization is fundamentally Node.js work: streaming, DB drivers, FK
graph walking. Electron gives full Node in the main process. Tauri would force a Rust
rewrite or a Node sidecar for no real benefit here.

## 2026-07-15 — `knex` for query *execution* only, not introspection _(from spec v1)_

Introspection is genuinely not unified across dialects (SQLite has no
`information_schema` — uses `PRAGMA`/`sqlite_master`). So each dialect gets a
per-adapter `DbAdapter` implementation for introspection + streaming; `knex` only
smooths over cross-dialect query execution.

## 2026-07-15 — Pattern selection resolved client-side in Node, not in SQL _(from spec v1)_

MySQL `REGEXP`, Postgres `~`, SQL Server (no native regex), and SQLite (none without a
custom function) all diverge. Pulling `(id, column)` pairs and filtering with a real JS
`RegExp` avoids the dialect mismatch entirely. (Random selection, by contrast, *is*
pushed into SQL — `ORDER BY RAND()/RANDOM()/NEWID() LIMIT n` — no mismatch risk there.)

## 2026-07-15 — Merge precedence: "preserve wins" on conflict _(from spec v1)_

If a row matches multiple selection rules with conflicting `anonymize` flags, preserve
wins. An admin row must never end up partially anonymized because it also happened to
match a random sample. This precedence holds at every level of the FK cascade too.

## 2026-07-15 — Anonymization seeded from a stable identity key _(from spec v1)_

faker is seeded from `sha256(stable identity key)` — the originating entity's real
PK/email — not randomly and not per-row-in-isolation. Guarantees the same person's
fake name/email/address is consistent everywhere they appear, across tables, on every
re-run with the same source data. Cascaded child rows seed from the *parent's* identity
(e.g. `payments.cardholder_name` stays consistent with `users.name`).

## 2026-07-15 — Output is files, dump dialect = source dialect _(from spec v1)_

Deliverable is a portable `.sql` file a dev loads themselves; no live target
connection (v1). No cross-dialect conversion (MySQL source → Postgres file) — punted.
Per-workspace combined vs. split output mode; split lets teams apply schema once and
re-run just the data file for fresh snapshots (data file self-truncates in reverse
dep order + toggles FK checks off).

## 2026-07-15 — Postgres schema DDL via `pg_dump`, not hand-rolled _(from spec v1)_

Too many edge cases to hand-roll (partial indexes, check constraints, sequences,
custom types). Shell out to `pg_dump --schema-only --table=X`. MySQL uses
`SHOW CREATE TABLE`; SQLite uses verbatim `sqlite_master.sql`; MSSQL is best-effort.

## 2026-07-15 — Credentials in OS keychain via `safeStorage`, never plaintext _(from spec v1)_

DB passwords go through Electron `safeStorage` (Keychain / DPAPI / libsecret). The
app's own config SQLite store (in `userData`) holds structure/rules only — never
secrets. `credentials` table stores only the encrypted blob.

## 2026-07-15 — One shared config SQLite file, workspace_id as the partition _(from spec v1)_

Workspaces = projects. Switching workspace is a `workspace_id` filter change, not a
separate file. Simplifies backup and a future "duplicate workspace" feature.
Migrations: numbered-file runner with a `_migrations` table, applied idempotently on
app start. **These migration `.sql` files are source — they stay tracked in git**
(the `.gitignore` dump rules are scoped to output dirs precisely to avoid catching them).
