# Project State

Always answers: "if I sat down right now, what would I work on?" Update whenever build
status changes.

_Last updated: 2026-10-03 (open-source alpha readiness cleanup); 2026-09-27 (UI refresh merged); 2026-09-24 (Linux dev-setup: `Electron uninstall` after a version bump; 2026-09-22: `obfuscate` field strategy; backtick DDL normalisation + interleaved drops; framework catalogue + classification provenance; `structure` table class; dump drop-tables option + encoding declaration built; ponytail audit reviewed and accepted cuts applied; workspace export/import built; Example Shop extract findings below)_

## Future feature — cross-dialect dumps (noted 2026-10-03)

Allow the output SQL dialect to differ from the source database dialect, for example
MySQL source → SQLite dump, so realistic subsets can be used locally with a different
database engine. Deferred; no implementation or release target agreed. Current dumps
still use the source dialect. Future work needs schema/type conversion and compatible
data serialization, while retaining the existing selection and anonymization guarantees.

## Fresh public repository — 2026-10-03

The new phibrenet/Masq remote was verified empty. Its initial commit contains the current source
snapshot, with v0.1.0-alpha.1 recreated on the new history. Older commit hashes and PR numbers in
memory refer to the previous development repository. The owner reports the Windows path fixes
passed and were merged. Current-file checks found no tracked local databases, .env/db.env files,
or common GitHub/AWS credential and private-key patterns; this is a limited check, not a complete
secret or confidentiality audit. Previously validated: lint, typecheck, build and 280 tests.

Next: verify the new GitHub CI results and configure main rules, external workflow approval,
security scanning, private vulnerability reporting (when public), and Pages if wanted. Settings
and Actions history from the previous repository do not transfer with the source snapshot.
The packaging HTTP-cache advisory and live-server/Electron boundary validation remain open.

## Windows CI path fixtures — 2026-10-03

Windows CI reported five assertions in dump-dir and workspace-store tests expecting POSIX paths.
A follow-up run exposed a second reset/preserve assertion in the same workspace test; it now reuses
the native folder fixture too. The export privacy check also uses a native path and JSON escaping,
so it checks the actual normalized value on Windows.
Fixtures now use tmpdir(), join() and the native separator, including a deliberately unnormalized
input for the redundant-segment check. Runtime path normalization is unchanged. The owner reports the Windows fix passed and was merged into main. Linux validation: lint, typecheck and all 280 tests passed.

## Open-source alpha readiness — 2026-10-03

README refreshed via PR #10, with synthetic screenshots and light/dark architecture images plus a
local interactive diagram link. Publication cleanup adds accurate safety/prerequisite/restore-limit
wording, fictional examples throughout tracked text, CONTRIBUTING.md, SECURITY.md, and Linux/macOS/
Windows CI (lint, typecheck, Electron-based tests and build). Existing user configurations are unchanged.
Historical decisions are retained, with company names/domains and personal example paths generalized.

Next: enable GitHub private vulnerability reporting before making the repository public (the local
GitHub CLI is unauthenticated, so this setting could not be verified or enabled); review Git
history for secrets or confidential data (working-tree cleanup does not remove old commits); run CI
on GitHub to verify all three platforms. No source history rewrite or publication was performed.
Live PostgreSQL raw-predicate/session tests, Electron 44 boundary checks and broader restore fixtures
remain open. The documentation describes these limits; the runtime protections are not changed here.

Validation: clean npm ci, lint, typecheck, 280 tests across 19 files and production build passed.
README/contributor/security local links and CI YAML structure checked; original company identifiers
and personal example paths are absent from tracked text. GitHub CI has not run from this checkout.
The clean install's npm audit reports 8 high-severity entries from one http-cache-semantics advisory
(GHSA-ch52-4w7c-c8xp) propagated through electron-builder's download/cache dependencies. A targeted
in-range update and npm audit fix --dry-run did not resolve it or change the lockfile. Track the
upstream fix; this packaging toolchain finding is not a demonstrated runtime data-leak path.


## Done 2026-09-27: UI refresh (merged via PR #9)

Implements [docs/masq-ui-refresh-spec.md](../docs/masq-ui-refresh-spec.md) — all five phases. See the
2026-09-27 entries in `decisions.md` for the choices (no Tailwind; tokens in `assets/tokens.css`).
Lint, typecheck and 280 tests pass; the built app was driven with Playwright on Linux against a copy
of the config store (every page, workspace menu, connection test, discovery, reading links, context
popover, light mode, 900px window, a full run from the top-bar Run button, keyboard on segmented
controls). **Not verified:** macOS traffic-light placement and the Windows overlay (no machines);
Playwright screenshots don't include the native overlay, so its look on Linux was not seen either.

Also merged: `AGENTS.md` is now canonical (CLAUDE.md imports it) and `THREAT_MODEL.md` was
added for security review. Open item from writing it: THREAT_MODEL §5.1 (a Postgres raw predicate may
be able to switch off the read-only session with `set_config`) — unverified, worth a test.

Known gaps (left as-is, no data to drive them): step status for Tables/Field Strategies needs a
discovery / column read in the current session; connection test results don't survive a restart;
field-strategy previews are illustrative only.

## Historical review blockers (2026-09-23; fixes merged)

Full review recorded in [docs/project-review-2026-09-23.md](../docs/project-review-2026-09-23.md).
The original review identified the reproduced `keepAll` anonymization bypass for newly inserted source
rows, raw SQL escaping the intended SELECT, MySQL integer/date precision loss, asynchronous dump
stream errors escaping cleanup, and Electron boundary hardening. Vue stale-response/cache issues
and small YAGNI cuts are also listed. The original review was read-only; the fixes below were
subsequently merged. The original 246-test pass did not cover those cases.

## Done 2026-09-23: project review fixes (branch `fix/project-review-2026-09-23`, merged via b0558ce)

All 11 findings in [docs/project-review-2026-09-23.md](../docs/project-review-2026-09-23.md), the
Linux keyring check and the suggested deletions — see the matching `decisions.md` entry. 249 tests
pass (3 new: mid-extract insert, stream error between rows, `NO_BACKSLASH_ESCAPES`). The built app
was driven with Playwright against a copy of the config store: the sandboxed preload works, there is
no `window.electron`/`process`, navigation away and `window.open` are refused, and a second instance
exits. **Not verified:** a Postgres read-only session (no local Postgres) and the renderer changes
beyond load/render (stale-response guards, load-error alert). **Also: that Playwright pass ran on
Electron 39.** The app is now on 44 (see decisions.md 2026-09-24) — re-run the boundary checks
against a 44 build before shipping.

## Next up (2026-09-23): deployment — paused on two decisions from the owner

Agreed so far: internal team first, public later; **macOS + Windows** only; **auto-update** via
`electron-updater`; no signing certificates yet. Nothing is built.

**Waiting on:**
1. **Where builds are published.** The source repo is private, and `electron-updater` can't read a
   private repo's releases without a token baked into the app. Proposed: a separate public repo
   (e.g. `phibrenet/masq-releases`) used only for GitHub Releases. Alternatives: S3 or a company
   file server (the `generic` provider).
2. **Signing.** Unsigned macOS apps can't auto-update (the macOS updater rejects them), so until
   there is an Apple Developer account, macOS gets a "new version available" link instead of a silent
   install. Windows auto-updates unsigned but shows SmartScreen on first install (Azure Trusted
   Signing fixes that later).

**Proposed order once decided:** (a) clean up `electron-builder.yml`: drop the template camera/mic
prompts and Linux block, set author/copyright, mac arm64 + x64, and replace the `example.com`
update URL; clear error when `pg_dump` is missing. (b) Add `electron-updater`. (c) GitHub Actions
building mac + Windows on a `v*` tag. (d) Write down the release steps.

## Built 2026-09-22: `obfuscate` field strategy (migration 016)

Scrambles the first or last N characters, leaving the rest intact — for values that must stay
recognisably themselves while ceasing to identify anyone (references, account numbers, licence
keys). Whole-column rule only; deliberately **not** a template binding action.

- ⚠ **Character class is preserved**: letter→letter (same case), digit→digit, punctuation
  untouched. So `ACE-2024-XY7781` → `ACE-2024-QM3419`. Don't "simplify" this to a single random
  charset — a column with a format CHECK, or a downstream parser, would stop accepting the result.
- ⚠ **Seeded on `column:value`, not the row.** Unlike `fake` (identity) and `jitter` (row). Two
  rows with the same reference scramble identically, so joins on the column survive the dump.
- ⚠ **Minimum 6, and the two enforcement points differ on purpose**: the repository *raises* a low
  count (it is the one path every write crosses), while workspace-transfer *rejects* it — silently
  importing someone's 3 as 6 would hide their choice from them. `OBFUSCATE_MIN_COUNT` in
  `src/shared/types.ts` is the single constant.
- Numbers/bigints are scrambled through their decimal form and returned as **text**, which sidesteps
  precision and int64-range questions; the digits still coerce into a numeric column. null, Buffer
  and Date are returned untouched, like `jitter` with a non-numeric value.
- Code points, not UTF-16 units — an emoji would otherwise shift the scrambled run and split a
  surrogate pair.

`tests/unit/obfuscate.spec.ts` (10 cases) plus repository and transfer cases in
`tests/config/store.spec.ts`.

✅ **Live-verified 2026-09-22**: a real extract carrying an `obfuscate` strategy was produced and
imported into MySQL cleanly. That run also re-exercised the whole MySQL dump path after the
2nd-pass quoting fixes — backtick-normalised DDL, the additive `sql_mode`, and the interleaved
`DROP`/`CREATE`.

⚠ **Still open, and unproven either way**: a UNIQUE column could collide. Two values differing only
inside the scrambled run can land on the same output. `fake` salts on collision for unique columns;
`obfuscate` deliberately does not, because per-value seeding is what makes joins survive. Not hit
on the verified run, but that says nothing about a wider column.

## Fixed 2026-09-22 (2nd pass, after import feedback): backticks normalised, drops interleaved

⚠ **The session-mode fix below did not work.** Stripping `ANSI_QUOTES` via `afterCreate` was
supposed to make `SHOW CREATE TABLE` return backticks; against a real `ANSI_QUOTES` source the next
export still carried double-quoted `CREATE TABLE`. Cause never determined. Do not re-file this as
fixed by the session hook.

Three changes, all from one destructive import:

1. **`toBacktickIdentifiers` in `adapters/mysql.ts`** rewrites captured ANSI-quoted DDL to
   backticks, deterministically. Gated on the statement's own table identifier being double-quoted
   — ⚠ that gate is load-bearing: in ordinary MySQL `"` is a *string* delimiter, so an
   unconditional rewrite would turn literals into identifiers. Backticks are valid under every
   mode, so this makes the file load anywhere. **This is the only mechanism** — the session hook
   that preceded it was deleted on review.
2. **The `sql_mode` line is additive**, not a replacement. It was clobbering an `ANSI_QUOTES` the
   importer had prepended to work around (1). `CONCAT(@@SESSION.sql_mode, ',NO_AUTO_VALUE_ON_ZERO')`
   with an `IF` for the empty-mode case.
3. **Each `DROP TABLE IF EXISTS` now sits immediately before its own `CREATE`** — reversing the
   earlier "all drops first". ⚠ **MySQL commits DDL as it runs and cannot roll it back**, so the
   failed CREATE left a database with 77 tables dropped and one created. Interleaved, the same
   failure costs one table. The cascade risk that motivated all-drops-first is theoretical
   (dependency order already prevents it outside FK cycles, which can't load from a combined dump
   anyway).

**Rule worth keeping, from the reporter: idempotent dumps are only idempotent if they run to
completion.** Order a destructive-then-rebuild file for what happens when it doesn't.

✅ **Live-verified 2026-09-22**: the next export imported cleanly into MySQL, no complaints. That
run exercised the whole MySQL dump path end to end — backtick-normalised DDL from an `ANSI_QUOTES`
source, the additive `sql_mode`, `SET NAMES utf8mb4`, interleaved `DROP`/`CREATE`, and the data
load. Postgres and SQLite remain unverified for these changes.

## Fixed 2026-09-22: dumps that loaded on one machine but not another (quoting)

Root cause was **not** the importing machine — it was the source server's `sql_mode` leaking into
the file. `SHOW CREATE TABLE` quotes identifiers per the session mode: with `ANSI_QUOTES` (or the
compound `ANSI`) it emits `"users"`, which any other MySQL reads as a *string literal*, so the load
dies on the first CREATE TABLE. Masq's own SQL was always backticked; only the captured DDL varied.

- **Read side** — `createKnex` runs an `afterCreate` stripping `ANSI_QUOTES` from the session mode
  (`STRIP_ANSI_QUOTES` in `knex-factory.ts`). Only that flag, not a pinned mode, so nothing else
  about DDL rendering changes.
- **Write side** — the dump pins `sql_mode = 'NO_AUTO_VALUE_ON_ZERO'` and restores the old value at
  the end (what mysqldump does). ⚠ `NO_AUTO_VALUE_ON_ZERO` is load-bearing, not cosmetic: without
  it an explicit `0` in an AUTO_INCREMENT column becomes a freshly generated id.
- **Postgres** — identifiers need nothing (`"x"` is standard, no mode changes it), but the dump now
  pins `standard_conforming_strings = on`, because `pg_dump`-captured DDL contains literals Masq
  never wrote which are only safe under the setting pg_dump assumed.
- **SQLite** — neither applies; it accepts every quoting style and has no settable session mode.

`DumpDialect.setEncoding` became `sessionSettings` + `sessionRestore`; encoding and quoting are the
same kind of "read what follows this way" statement and share the slot at the top of the file.

**Removed on review (2026-09-22):** the `STRIP_ANSI_QUOTES` session hook and its test are gone.
`toBacktickIdentifiers` makes the DDL correct deterministically, so asking the session to change
mode guarded nothing — and knex builds with backticks, which are valid under `ANSI_QUOTES` anyway.

## Built 2026-09-22: framework is a first-class concept (migration 015)

`src/shared/frameworks.ts` is the catalogue — **add a framework by editing that file**, no migration
needed. Each entry: id, label, detection `signature`, `referenceTables` (dumped whole),
`structureTables` (schema only). Laravel, Rails, Django so far.

- **`workspaces.framework`** — nullable. Set by detection on "Discover from source" *only when
  blank*; a mismatch with an already-set framework raises a banner offering the switch. Manual
  override in the Tables screen header.
- **`table_classifications.source`** — `'manual'` | `'preset:<frameworkId>'`. "Apply presets" adds
  missing rows, **refreshes rows the same framework's presets wrote**, never touches a manual one,
  and names what it skipped. One transaction in main (`applyFrameworkPresets`).
- ⚠ **Neither column has a CHECK**, unlike `class` beside them — the catalogue grows in code and a
  CHECK would cost a 12-step rebuild per framework. Validation is at the repository boundary, and
  both columns read defensively (unknown id → "none"/"manual").
- ⚠ **Detection signatures are deliberately narrow.** Laravel needs `migrations` *plus* a
  Laravel-specific companion — `migrations` alone is Phinx/Knex/anything. A confident wrong answer
  silently reclassifies tables; not detecting is the better failure.

**Bug found and fixed while building it:** migration ledgers (`migrations`, `schema_migrations`,
`django_migrations`) were never classified, so they defaulted to transactional and shipped **empty**.
That tells the framework nothing has run, and the next deploy re-applies every migration onto a
populated database. They're now `reference`, with a catalogue test forbidding a ledger from ever
being `structure`.

Migration 015 backfills: preset-shaped Laravel rows get `source = 'preset:laravel'`, and a workspace
holding them gets `framework = 'laravel'`.

**Not live-verified** — Rails and Django catalogues are written from knowledge of those frameworks,
never run against a real Rails or Django database.

## Built 2026-09-22: framework presets seed `structure` (migration 014)

The presets classified `sessions`/`cache`/`jobs`/… `excluded`, which drops the CREATE too. Wrong
premise: a dump has to stand up a **working** database, and the app writes to those tables on first
use — so a missing one surfaces as an app bug, not a dump gap. They carry no useful data *and* are
expected to exist, which is exactly `structure`.

- `LARAVEL_EXCLUSION_PRESETS` → **`LARAVEL_STRUCTURE_PRESETS`** (`src/shared/presets.ts`), writing
  `structure`. Button is now "Add framework presets"; it still skips already-classified tables.
- **Migration 014** repairs existing workspaces: `excluded` → `structure` for exactly the eleven
  preset names, only where still `excluded`. A deliberately-excluded table, and a preset name the
  user already moved elsewhere, are both left alone.
- `excluded` stays a class — right for another app's tables sharing the database, or an audit log
  too big to be worth the DDL. It is just no longer the answer to "this data isn't worth copying".

## Built 2026-09-22: `structure` table class — schema in the dump, never any rows (migration 013)

Asked for `sessions`: the table wanted in the dump, none of the production rows. There was no
honest way to say it, so a fourth class was added.

| class | CREATE TABLE | rows |
| --- | --- | --- |
| `excluded` | no | no |
| `structure` | **yes** | **never, guaranteed** |
| `transactional` | yes | whatever rules + cascade + backfill keep |
| `reference` | yes | all of them |

⚠ **The trap this replaces.** "Transactional with no selection rule" is *not* schema-only. A
rule-less transactional table is still a **cascade target**, so a kept parent pulls its children
down — and Laravel's `sessions.user_id` means any rule seeding `users` drags live session payloads
into the dump, silently. `tests/config/pipeline.spec.ts` asserts the trap and the fix side by side.

Implementation notes worth not re-deriving:
- `roleOf` returns **`omitted`** for a structure table, not `complete` — `complete` claims nothing
  can dangle into it, which is false for a table that ships empty.
- The short-circuit is the **first** thing `buildRowStream` does, ahead of the link-table and
  selection branches, or a link filter / cascaded selection could still fill it.
- A selection rule on a structure table produces a run **warning**; it isn't silently dropped.
- Named `structure`, not `schema` — `schema` already means a Postgres namespace here.

**Resolved the same day:** the presets now seed `structure`, not `excluded` — see the entry below.

✅ **Live-verified indirectly 2026-09-22**: the clean MySQL import above was of a dump from a
workspace with the framework presets applied, so `structure` tables loaded as empty tables and the
`reference` migration ledger loaded with its rows. The classification *engine* is still only
asserted through the pipeline with a fake adapter.

## Built 2026-09-22: dump drops tables, and declares its encoding (migration 012)

Two things a dump needs before it loads a **second** time into the same database.

- **`DROP TABLE IF EXISTS`** before the DDL, per-workspace switch on the workspace form
  (`workspaces.drop_existing_tables`). **Defaults on, and migration 012 backfills existing
  workspaces** — so every workspace's dumps change shape on upgrade, by design. Emitted as one
  ~~block in reverse dependency order before the first CREATE~~ — **superseded 2026-09-22**: each
  drop now sits immediately before its own CREATE, see the entry above. Postgres uses `CASCADE`. In
  split mode it lands in the **schema** file (wrapped in the FK toggle), not the data file, which
  keeps its TRUNCATEs.
- **Encoding**, first statement in every file: `SET NAMES 'utf8mb4'` / `SET client_encoding =
  'UTF8'` / nothing for SQLite. ⚠ **A per-dialect constant, not read from the source database** —
  the dump's bytes are always UTF-8 because Node writes them, so echoing a latin1 source back would
  mojibake the load. Don't "improve" this by introspecting it. The source's charset already rides
  along in the DDL's `DEFAULT CHARSET=` clause.
- **`createKnex` now opens MySQL with `charset: 'utf8mb4'`.** mysql2 defaulted to `utf8mb3`, which
  silently turned every emoji into `?` on the way out of the server, before Node ever saw it.

Covered by `tests/unit/dump-writer.spec.ts` (new) plus workspace CRUD and transfer cases in
`tests/config/store.spec.ts`. The transfer format stays at version 1 and treats
`workspace.dropExistingTables` as optional, so a config file shared before this still imports.

✅ **Live-verified 2026-09-22** for MySQL, via the clean import above. Postgres and SQLite are
still asserted at the file-text level only.

## Over-engineering audit 2026-09-21 — reviewed

[docs/ponytail-audit.md](../docs/ponytail-audit.md) was reviewed. Removed the unused mock,
placeholder, extract barrel and context-menu dependency; consolidated rule vocabularies and JSON
path navigation; replaced form preview handlers with one watcher; skipped sequence introspection for
dialects that do not reset sequences. Adapter, repository, store and IPC factories were declined:
they add indirection across code with different dialect, validation and update behavior. The target
connection option and the runs store's two-line source lookup stay; removing either brings little
benefit. All 179 tests, typecheck, lint and the production build pass after these edits.

## Raw SQL selection rule clarification 2026-09-21

Raw SQL is a WHERE predicate inside a generated query, not a standalone SELECT. A pasted SELECT
with a trailing semicolon failed only when the extract queried MySQL. The form now explains the
contract and validates the obvious full-query shape on save; the shared rule planner rejects it in
both preview and extract. The requested recent-user subset is expressible as a predicate with a
correlated `EXISTS`, plus `Random sample of 20` under Take.

## Built: portable workspace configuration

[docs/workspace-transfer.md](../docs/workspace-transfer.md) describes the versioned JSON format and
flow. Export/Import actions are in the workspace sidebar. Import validates before writing, creates a
new workspace with fresh IDs in one transaction, and excludes connection profiles, credentials, run
history, dumps, and the local output path. Recipients add their own connection. Full tests, lint,
typecheck, and production build passed. A throwaway Electron run verified the built renderer's
Export/Import buttons, file dialogs, IPC, and imported table setting; it caught and fixed a Vue proxy
that Electron could not clone across IPC.

## Example Shop extract finding 2026-09-21

One completed run: 670 users, 963 promotion codes, 638 partners. Staff was back to `take: none`
(flag only); 20 users are seeded and backfill adds 650. `promotion_codes` is still classified as
`reference`, so all of its rows were emitted. Its `partner_id` backfilled 638 partners; those partners'
`user_id` added 590 users, and `promotion_codes.redeemable_by_user_id` added another 49. The user
subsequently reclassified `promotion_codes` as `transactional` and reported a much smaller extract;
the new counts were not provided. Other edges may still add some users. The flag-only staff rule
preserves only matching staff already in the subset; it does not include all staff accounts.

### Earlier findings

Follow-up: both user-scoped pivots are now `transactional`, and the staff rule is `take: all`.
The 2026-09-21 run was cancelled after about five minutes during backfill. Prior runs already
showed that all-staff seeding traverses many actor FKs downward; this remains the likely size
driver. Missing staff country values are not involved: blank countries use the default English
faker locale, and preserved staff rows do not run faker for their own fields. Cancellation was
being swallowed by backfill and other best-effort reads, producing dozens of misleading warnings;
those catches now rethrow `CancelledError` immediately. The next decision is whether all staff
must be present or whether the flag-only rule meets the actual need. If all must be present,
selecting staff without cascading their children needs a separate rule option.

### Original finding

The latest completed run emitted 190,778 users. In the local workspace config,
`model_has_permissions` and `model_has_roles` are classified as `reference`, so their rows are
dumped whole; upward morph backfill then added 190,547 and 210 users respectively. Classify these
user-scoped pivots as `transactional` to let link-table endpoint matching restrict them. Keep
`role_has_permissions` as reference: it is static permission data.

The `users.email endsWith @example.com` rule currently has `take: none`, so it only preserves
matching users already included. If the desired extract truly includes every matching staff user,
change it to `take: all`; prior live runs showed that seeding all staff can expand the dump sharply
through actor FKs. A final users count can still exceed the rule seeds through other backfill edges.

## Built 2026-08-31: link tables (composite-PK pivots)

**Verified against Example Shop.** The 2026-08-29 run shipped four tables empty and carried four
`cascade: … can't be followed` warnings; the 2026-08-31 run has none of them and
`label_card_lookups` comes back with 155 rows. That run surfaced one more table —
`grading_report_user`, a pivot with **no FK constraints at all** — which is now handled by inferring
its endpoints from the column names (see the decisions follow-up). **That last part has not itself
been run yet**: the next thing worth doing is one more extract to confirm `grading_report_user` comes
back non-empty and that the inference warning names `grading_report_id → grading_reports,
user_id → users`.

The four tables were all composite-PK, so nothing could address their rows. They are now
subset by matching every endpoint against the kept sets
([src/main/extract/link-tables.ts](../src/main/extract/link-tables.ts)), which needs no row identity
at all. Two passes: `detectLinkTables` (schema-only, runs before the cascade pre-flights so they can
skip what it claims) and `linkTableFilters` (pure, runs after the kept sets settle).

`streamRows`' `where` widened from `Record<string, unknown[]>` to a `RowFilter`
([row-filter.ts](../src/main/extract/row-filter.ts)) so a polymorphic endpoint can compile to an OR of
`(type = ? AND id IN (…))` groups — all three adapters share one `applyRowFilter`. Full reasoning,
including why tuple primary keys were *not* built, in the decisions entry.

**To get `model_has_roles`/`model_has_permissions` fully restricted, the morph relation on
`model_type`/`model_id` has to be declared** on the Morphs screen. Undeclared, `role_id`/
`permission_id` still restricts but rows survive for models outside the subset — the run warns and
names the columns. Composite-PK tables that are *referenced* by something still dump empty, by design.

## ⚠ Read first: seeding a well-connected table explodes the dump

Learned by running it. Rule 2 of the v2 pair was written as *"users with a work email → **take all**,
preserve"*, which seeds 282 staff — and the run didn't finish. `cascadeSelection` follows **every**
inbound FK downward with **no policy gate** (migration 009 governs the *upward* direction only), and
in this schema ~13 of the 26 FK columns pointing at `users` are actor edges. Keeping one staff member
pulls in every record they ever touched; each of those cascades to its own children.

**The fix is a flag-only rule** (`take: { kind: 'none' }`, built 2026-08-29): say "preserve staff"
without seeding them, and let cascade/backfill pull in whichever staff the kept records reference.
Rule 2 should be written that way. Full reasoning in the decisions entry.

**Still unaddressed:** nothing caps downward cascade fan-out. A flag rule sidesteps it by not
seeding; a rule that genuinely must seed a well-connected table has no lever. That's the
"anchor-table" idea, still deferred.

## Also built 2026-08-29: dump folder + copy/reveal UI (migration 011)

Three UI additions, **visually verified** (not just typechecked):

- **Per-workspace dump folder.** `workspaces.dump_output_dir`, set from a native picker (or typed) in
  the workspace modal; blank = the default `<userData>/dumps`.
  [src/main/dump-dir.ts](../src/main/dump-dir.ts) is the one place a configured folder becomes a real
  path — it expands `~`, **requires an absolute path**, and is shared by the repository (rejects on
  write), the form (previews the resolution on blur) and the pipeline. Typed relative paths were the
  hazard: `dumps` resolves against the packaged app's working directory.
- **Open dump folder** in the OS file manager, and **Show in folder** per dump file.
- **Copy** for the folder path, each output path, the error message, the warnings, and a
  "Copy details" that renders the whole run card as plain text.

New `system:*` IPC surface (clipboard / shell / native pickers) — see the decisions entry for why the
clipboard can't use `navigator.clipboard` and why `openPath` is directories-only.

**The screenshot harness is back**, at `scratchpad/screenshot-main.ts` (gitignored), rewritten for
macOS — the Linux one described below was lost with the scratchpad. Build and run it with:

    ./node_modules/.bin/esbuild scratchpad/screenshot-main.ts --bundle --platform=node \
      --format=cjs --packages=external --alias:@shared=./src/shared --outfile=scratchpad/shot.cjs
    env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scratchpad/shot.cjs

It writes to a throwaway `userData`, so the real config store is never touched — which means it
*can* run migrations and seed, unlike the old one. **New trap:** the app's `runMigrations` bundles
its `.sql` with Vite's `import.meta.glob`, which esbuild can't evaluate; the harness reads the
migrations directory off disk instead. Shots land in `$TMPDIR/masq-shots`.

## Code-review fixes applied 2026-08-29 (post-build)

Four findings, all real, all fixed — 136 checks green:

1. **A malformed rule could fail *open*.** Lenient parsing degraded a corrupted `anonymize: false`
   rule to "all rows, preserved" — a whole table with real data. Rules now carry `invalid` and
   `planRule` refuses to run them; they stay editable. See the decisions entry; the reasoning error
   behind it is the reusable part.
2. **Cancelling mid-write left a partial dump under its final name** while the run record said no
   dump was written. Now written to `.partial` and renamed on success, with cleanup on failure.
   `endStream` also switched to `stream/promises`' `finished`, since `once(stream, 'finish')` would
   hang forever if the stream errored while flushing.
3. **`top N` returned different rows when a rule contained a regex** — the in-memory path sorted with
   `String()`, so `10` sorted before `2`. Now shares `compareValues` with the condition evaluator.
4. **Reloading the renderer mid-run stranded the UI on "Running…"** — `syncRunning` adopted the run
   but had no promise to await. It now polls until the main process reports nothing in flight.

## Also built 2026-08-29: run cancellation

`Stop run` on the Runs screen. Cancellation is a **`Proxy` around the `DbAdapter`** rather than a
signal threaded through every stage — everything long-running goes through the adapter, so one
wrapper covers selection, cascade, backfill and the dump writer. The exception is `streamRows`
(checked once at iterator creation), closed by a per-row `throwIfCancelled` in the dump writer.

**The proxy alone was not enough** — first attempt looked broken on a real run. The chunked adapter
methods run one query *per `IN (…)` chunk inside a single call*, so hundreds of queries passed
between two proxy checks. `withCancellation` now also sets `adapter.cancellationSignal`, and all 15
chunk loops across the three adapters check per chunk.

Cooperative: it stops at the *next* query or row, so a cancel during one long `ORDER BY RAND()` waits
for that query to return. A cancelled run is recorded as `failed` with a "cancelled" message — the
`runs.status` CHECK has no `cancelled` and SQLite can't ALTER a CHECK. `markInterruptedRuns()` at app
start closes out rows a dead session left `running`.

## Current status: selection rules v2 BUILT (migration 010) — NOT yet live-verified

**Built and green.** `npm test` (112 checks, 53 new), lint, typecheck and build are clean.

**Partially live-verified 2026-08-29, against the real MySQL source.** The app runs with migration
010 applied, and the Rules screen's **preview executed for real**: an `endsWith` condition on
`users.email` returned `Matched 282 · keeping 282`. That exercises the whole compile path end to end
on MySQL — `applyFilter` → `LOWER(??) LIKE ? ESCAPE '!'` → `countRows` → IPC.

**Still unexercised:** `selectRows`, take push-down, the take-withheld regex path, relative dates,
an actual extract run, and both other dialects. Running a full extract is the next thing.

**Why it exists:** v1's `SelectionStrategy` fused "which rows qualify" with "how many to take", and
each of its four values pinned one axis — `random` couldn't be filtered, `pattern` couldn't be
limited. So the pair of rules a real workspace wants on `users` could not be written at all:

1. no work email **and** created in the last 90 days → take 20, anonymize
2. has a work email → take all, preserve

What landed ([docs/selection-rules-v2.md](../docs/selection-rules-v2.md) has the full design, and the
build-order section marks each step):

- **Migration 010** rebuilds `selection_rules` around `conditions_json` + `take_json` + `match_mode`
  + `raw_where`, rewriting v1 rows in its own `INSERT … SELECT` via SQLite JSON1. Lossless: the four
  strategies are presets over the new model.
- **[extract/conditions.ts](../src/main/extract/conditions.ts)** — one operator table with two faces
  (`applyConditions` → SQL, `evaluateConditions` → Node). Regex is now *one operator* rather than the
  whole pattern mechanism; everything else pushes into the query.
- **`selectRows` / `countRows`** on all three adapters, replacing `sampleRandomIds`.
- **Condition-builder UI** with type-narrowed operators, the include-empty checkbox, and a **preview
  count** (`source:previewSelectionRule`), which shares `planRule` with the extract so what it counts
  is what a run keeps.

### ⚠ Three subtleties that are easy to break

Read the 2026-08-29 "three things the design got wrong" decisions entry before touching this. Short
version: (1) a regex in an `any` rule forces the **whole** filter client-side, because OR can't be
narrowed in stages; (2) the take must be **withheld from SQL** whenever a client-side condition
survives, or the limit caps rows before the regex runs; (3) the `LIKE` escape character is `!`
because neither SQLite nor MySQL can be relied on for `\`.

**Deliberately not built:** the preview's *overlap* count (matched/keeping are per-rule; overlap needs
two rules' PK sets intersected), and **cohorts** — the answer to "keep *most* details for staff",
which the per-row `anonymize` boolean can't express. Ship this, find out whether the boolean chafes.

_Previous status below._



## Current status: per-edge backfill policy BUILT (migration 009) — NOT yet live-verified

**Built, green, and never run against a real database.** `npm test` (59 checks, 21 new), lint,
typecheck and build are all clean; no extract has been run with a policy declared. That is the next
thing to do — see "if you sat down right now" below.

**Why it exists:** the Example Shop workspace's only rule is `users: random 20` and the 2026-08-27
dump holds **74 users**. All 54 extras came from `backfillSelection` following actor/staff FK columns
(`submissions.welded_by_user_id` and friends) — full diagnosis and the numbers in the 2026-08-29
decisions entry.

What landed:

- **Migration 009 / `fk_backfill_policies`** (workspace, table, column) → `follow` | `null`; absence
  means `follow`, so every existing workspace behaves exactly as before.
- **Engine:** `backfillSelection` takes a `policyOf` and skips `null` edges;
  [src/main/extract/backfill-policy.ts](../src/main/extract/backfill-policy.ts) resolves/validates
  policies and produces the writer's null instructions; `run.ts` applies them to every emitted row.
- **`BackfillReport.addedByEdge`** — per-edge attribution, console-logged largest-first. `users +54`
  alone gave you no way to know which of the 26 inbound edges to act on.
- **New "Backfill Management" screen** (`/backfill`), grouped by the table being linked *to* and
  sorted by how many links point at it, so the tables that grow sort to the top. `null` is only
  offerable on a nullable column. Copy is deliberately plain — it talks about *links* and *records*,
  names "backfill edge" once, and puts the mechanism behind a collapsed "How this works"; the first
  draft assumed the reader knew what a foreign key and a dangling reference were. Links on
  non-nullable columns can never be changed, so they're **hidden behind one toggle** (most of a real
  schema's ~90 links are fixed and were burying the handful you can act on); the toolbar and each
  group header say how many are held back so nothing disappears silently.
- **New IPC:** `config:{list,set,delete}FkBackfillPolicy*` and `source:listForeignKeys` (FK graph +
  per-column nullability in one call).

### ⚠ No policy is declared, and on this workspace none should be

**The 74 users are correct and wanted.** Example Shop keeps staff and customers in the same `users`
table, so `welded_by_user_id` / `qa_checked_by_user_id` / `artist_id` reference employees whose rows
the dev data needs. See the 2026-08-29 "staff and customers share `users`" decisions entry — read it
before acting on any of the numbers here.

So the feature ships **dormant**: absence of a policy means `follow`, so declaring nothing leaves
extract behaviour byte-for-byte as it was. Measured effect *if* the 14 nullable actor edges were
nulled: **74 → 50 users**. That is what the mechanism can do, not a target.

Getting a dump to exactly 20 users would need the **anchor-table** idea (rules are the only thing
that may add rows to a table; NOT NULL references to non-selected rows prune the child rather than
nulling it). Scoped, deliberately deferred, and **nobody currently wants it** — the growth is
bounded (backfill is up-only, so the 54 staff pull ancestors but never descendants) and it is the
data people actually want.

If dump *size* ever needs taming on this workspace, `users` is the wrong lever: the 2026-08-27 dump
is 1192 `ingested_collectible_images`, 315 `card_lookups`, 300 `grades` and 151
`ingested_collectibles`, all downward cascade from the 20 seed users. That would want a
cascade fan-out cap, which does not exist.

**Unrelated finding, not fixed:** the MySQL dumps' DDL uses ANSI double-quoted identifiers
(`CREATE TABLE "action_events"` — `SHOW CREATE TABLE` inherits `ANSI_QUOTES` from the source server)
while the data half is written with backticks. `mysqlDumpDialect` has no preamble, so nothing sets
`sql_mode` on the target: the dump only loads where the target's mode happens to match.

_Previous status below._

_Last updated: 2026-08-22 (test tooling added)_

## Where the code is right now (read this first)

- **A committed test suite exists** (`npm test` / `npm run test:watch`, 37 checks, ~0.4 s):
  Vitest run under **Electron's Node runtime** (`scripts/run-vitest.mjs` — required because
  better-sqlite3 is built for Electron's ABI and fails under plain Node; see the 2026-08-22
  decisions entry). Covers `search-path`, `json-paths`, `graph`/topo order, and the config store
  (migrations + four repos against throwaway stores). `tests/config/store.spec.ts` mkdtemps its
  own `MASQ_TEST_USERDATA` before any `getDb()` call — copy that pattern for any new store-touching
  spec. Container-based live verification stays in gitignored `scratchpad/`; don't move those into
  the default suite. `npm run lint` also green again (scratchpad bundles now eslint-ignored).

- **Everything is merged into `main`; no feature branches exist.** Working tree clean, typecheck /
  build / lint clean.
- `main` is ahead of `origin/main` (the two unloadable-dump bugs, the config sweep, and now the SQLite
  adapter) — unpushed.
- **The SQLite adapter is DONE and verified** (build-order step 8 complete). `SQLiteAdapter`
  ([src/main/adapters/sqlite.ts](../src/main/adapters/sqlite.ts)) + `sqliteDumpDialect` +
  `createKnex`/`makeAdapter`/`buildDumpDialect` cases. `scratchpad/sqlite-smoke.ts` — **118 checks, 0
  failures**, 4 phases (introspection / dialect / full pipeline loaded into a fresh DB / split mode
  applied twice). Needs no containers, so it is the cheapest end-to-end regression test in the repo:

      ./node_modules/.bin/esbuild scratchpad/sqlite-smoke.ts --bundle --platform=node \
        --format=cjs --packages=external --alias:@shared=./src/shared --outfile=scratchpad/sqlite-smoke.cjs
      ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scratchpad/sqlite-smoke.cjs

  Read the 2026-08-20 SQLite entry in [decisions.md](decisions.md) before touching it — five of its
  choices look wrong at first glance (safe integers on, read-only opens, bypassing `knex.stream()`,
  keeping an FK edge to a table that doesn't exist, a fail-open DDL stripper).
- **SQL Server is deferred to v2** (decision 2026-08-20) — it is no longer on the v1 path. The
  `mssql` dialect stays in the enum, the config store's CHECK constraint and the connection form, so
  a v2 adapter drops into `makeAdapter`/`createKnex`/`buildDumpDialect` exactly where MySQL, Postgres
  and SQLite already sit; until then those three throw a clear "isn't built yet" error for it.
- **SQLite is also verified through the REAL APP** — `scratchpad/sqlite-e2e-main.ts`, 40 checks, 0
  failures. A standalone Electron main that reuses the app's own IPC registrations, loads the built
  renderer, and *clicks*: Test on the connection card, Discover from source, Run extract. It then
  loads the produced dump into a fresh database and asserts subset / zero orphans / no surviving PII
  sentinel. Screenshots land in `/tmp/masq-e2e-shots` and were eyeballed. So the caveat that SQLite
  had only ever been driven from the main process is **closed**; `ConnectionFormModal`'s
  `isFileBased` branch is confirmed rendering a File path field with no host/port/username.

      npm run build   # the harness loads out/renderer — rebuild after any renderer change
      ./node_modules/.bin/esbuild scratchpad/sqlite-e2e-main.ts --bundle --platform=node \
        --format=cjs --packages=external --alias:@shared=./src/shared --outfile=scratchpad/sqlite-e2e.cjs
      env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
        --disable-gpu --ozone-platform=x11 --disable-software-rasterizer scratchpad/sqlite-e2e.cjs
- The app builds from the working tree, so **whatever is checked out is what a live extract uses**.
- **Migration 005 is applied to the real config store**, and the config sweep is applied to it too, so
  the next extract picks both up with no further action.
- **Migrations 006–008 are NOT yet applied to the real store** — it applies automatically
  on the next app start, since `runMigrations` runs every time. Verified on a *copy* of the real store
  (v5 → v8, all 22 field strategies / 5 morph relations / 10 runs / 1 locale source intact, the existing
  locale source keeping its column with a NULL path, FK check clean, idempotent) — deliberately not
  applied to the live one by hand.
- Backups: `~/masq-backups/` holds a pre-sweep snapshot plus this morning's, with restore steps in its
  README. Made with SQLite's backup API, not `cp` (the store is WAL-mode).

### Standing rule earned the hard way: fixtures lie, so assert your preconditions

Three separate times this session a **fixture gap read as a code regression or a false pass**:
the morph suite reported a failure because the loaded dump had `messages=0`; the template e2e reported
a leak because a real email sat at an *unbound* path; and an address assertion passed **vacuously**
because no row had an address. Two more of the same family: a **raw `knex` is not a faithful source**
(bypassing `createKnex` skips the `PG_VERBATIM_TEXT_OIDS` overrides, so jsonb arrives as JS objects),
and **real place names are useless canaries** (faker's own locale data contains "Brandenburg", so a
genuine fake collided with the supposedly-real value). Every new harness should print the fixture
counts it depends on and fail loudly when they're zero.

**Confirmed again on 2026-08-20 (SQLite adapter), and this is the sharpest instance yet:** two
assertions passed **vacuously** while the code under them was broken. `getColumns()`'s nullability was
inverted for every column, but the test only asserted a `NOT NULL` column was non-nullable — which a
constant `false` satisfies. And `getSequenceColumns()`'s WITHOUT ROWID guard never fired, but the only
WITHOUT ROWID table in the fixture had a TEXT primary key, so a *different* branch returned the right
answer anyway. Both were caught by widening the fixture, not by reading the code. **Assert both
directions of a boolean, and make sure the fixture row that exercises a branch actually reaches it.**
A third instance in the same session was the *harness* being wrong rather than the code: an int64
compared in JS failed against a dump that was perfectly correct, because the harness read the target
with a plain `better-sqlite3` handle and lost the precision itself — compare values like that **in
SQL**.

## Current status: template anonymizer BUILT (migration 005) — closes the JSON-column PII gap

[docs/template-anonymizer.md](../docs/template-anonymizer.md) is built: a `template` field strategy
binds JSON paths to generators and overlays them onto each row's real value, plus a builder UI that
samples the column and lists its paths. **Migration 005**, not 004 — morph took that number.

Driven by a live leak: turning on morph down-cascade brought `audits` back (0 → 82 rows) and
`audits.new_values` held **6 real emails + 9 bcrypt hashes** that no column strategy could reach.
End-to-end on that exact column: **bcrypt 9 → 0, all remaining emails faker-domain**, unbound keys
untouched, dump loads, byte-identical re-run.

Migration 005 is a **table rebuild** (SQLite can't alter a CHECK) — verified against a copy of the real
config store: all 15 strategies survived with an identical kind breakdown.

### ✅ All seven config screens visually verified 2026-07-30 — the long-standing gap is closed

Captured with `scratchpad/screenshot-main.ts`, a standalone Electron main that reuses the app's **own**
`registerConfigIpc`/`registerSourceIpc`/`registerExtractIpc`, loads the built renderer, and writes PNGs
via `webContents.capturePage()`. Read-only: migrations and seeding are deliberately **not** run, so the
real config store is never mutated. Shots land in `/tmp/masq-shots`.

    ./node_modules/.bin/esbuild scratchpad/screenshot-main.ts --bundle --platform=node \
      --format=cjs --packages=external --alias:@shared=./src/shared --outfile=scratchpad/screenshot.cjs
    env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
      --disable-gpu --ozone-platform=x11 --disable-software-rasterizer scratchpad/screenshot.cjs

**Four traps, each of which cost a wrong turn — worth knowing before reusing this:**
1. **`app.setName('masq')` before any `getPath('userData')`.** Run as `electron script.cjs` the name
   defaults to `Electron`, so `config/db.ts` opens an *empty* store in `~/.config/Electron`. Same
   identity trap as safeStorage (see blockers). Symptom: `no such table: workspaces`.
2. **Electron SIGSEGVs here without `--disable-gpu --ozone-platform=x11
   --disable-software-rasterizer`** (Wayland session).
3. **`show: false` won't paint naive-ui's *teleported* overlay**, so a modal is present in the DOM
   (`document.querySelectorAll('.n-modal').length === 1`) but missing from the capture. Use
   `win.showInactive()` — real paint, no focus stolen.
4. **A hidden window can hand back a stale frame.** The sidebar looked one route behind until
   `webContents.invalidate()` + a settle delay were added. That looked exactly like a real
   active-route bug; a DOM probe proved the highlight was correct on all six routes.

Everything renders correctly, including the template builder (path list with `in N/50` frequency tags,
`number`/`boolean`/`null` type tags, per-path action dropdown) and the Polymorphic screen (5 declared
relations, two morphs on `audits` in one card, down/up toggles).

**Four more traps, from the 2026-08-20 SQLite e2e harness** (`sqlite-e2e-main.ts`), which unlike the
screenshot harness has to *seed* config and therefore must never share a store:
5. **Isolate the config store with `app.setPath('userData', '/tmp/…')`** — immediately after
   `app.setName('masq')`, before anything calls `getPath`. Without it the harness migrates and writes
   the user's **real** workspace. The harness asserts the real store's mtime is unchanged; do the same
   in any harness that writes config.
6. **`runMigrations()` cannot be esbuild-bundled.** It loads `migrations/*.sql` through Vite's
   `import.meta.glob`, so a bundle dies with `import_meta.glob is not a function`. Apply the on-disk
   `.sql` files directly, as `migrate-real.ts` does — and note this leaves `migrate.ts` itself outside
   the harness's coverage.
7. **Trap 1's too-broad-selector lesson repeats for buttons.** The first `Edit` on the page is the
   *sidebar's workspace* Edit, so the harness opened an "Edit workspace" modal that then trivially
   satisfied a "no server-only fields" assertion. Scope to the card: `.conn__actions` → Edit.
8. **Rebuild the `.cjs` after ANY `src/` change.** The harnesses execute the esbuild *bundle*, not the
   TypeScript, so running `electron scratchpad/x.cjs` without re-running esbuild silently tests the
   previous build. This cost a long detour on 2026-08-20: a genuine cascade bug was fixed, the e2e was
   re-run from a stale bundle, still failed, and five debug scripts went looking for a second cause
   that did not exist. If a fix "doesn't take", rebundle before theorising.
9. **The Tables screen lists only *classified* tables until "Discover from source" is clicked**, and
   asserting on `document.body.innerText` passes vacuously because the input placeholder reads
   "Table name (e.g. users)". Click Discover, then read `.row__name` nodes. Likewise **naive-ui toasts
   auto-dismiss** — poll for the first non-empty `.n-message` instead of sampling once, or a run that
   succeeded reports an empty toast.

Two small real fixes came out of it: the Fields subtitle didn't mention `template`, and the
redact/remove dropdown labels truncated at the control width.

### ⚠ The scratchpad harnesses are fixture-dependent — and gitignored

`scratchpad/` is gitignored, so these notes are the only record. **Which dump you load as the source
silently changes what the morph suites can prove**: the 09:02 dump has `messages=177` and
`audits=206`, the 14:54 dump has `messages=0`. Loading the latter made
`morph-cascade-smoke` report "messages reached ONLY via the morph edge — 0 → 0" as a **failure** when
the code was perfectly correct — the source simply had no rows to pull.

That harness now prints its fixture's row counts and *skips* a table the source can't exercise, rather
than failing. Any new suite should do the same: **assert your preconditions, or a fixture gap reads as
a regression.** Use the 09:02 dump when a morph-only table needs to have data.

Each path offers four outcomes: **leave as-is**, **redact** (keep the key, null it), **remove** (drop
the key), or a generator. `redact`/`remove` were added after the first live run showed a fake-only
template has no answer for a secret — `audits.new_values` still held 9 bcrypt hashes. `action` defaults
to `fake` so bindings saved before it existed keep working.

### ✅ Config sweep applied 2026-08-20 — the real workspace's remaining PII is closed

16 → **22 strategies**, applied through the real repositories (so validated/serialized exactly as the
app does) and verified by producing a dump and loading it. Backup taken first:
`~/masq-backups/config-2026-08-20T10-20-39-pre-sweep.sqlite3`.

**Two choices were forced by the SOURCE SCHEMA, not preference — check this before adding more:**
- `users.password` is **NOT NULL**, so `redact` would make the dump fail to load → `fake/loremWords`.
- `audits.ip_address` is **`inet`**, so a text generator fails with `invalid input syntax for type
  inet` → `redact` is the only safe option.

Added: `project_invitations.normalized_email` (fake/email), `audits.ip_address` (redact),
`audits.user_agent` (redact), `users.password` (fake/loremWords), `users.phone` (fake/phone),
`users.remember_token` (redact). Merged into templates: `audits.new_values` +`password`/
`two_factor_secret`/`two_factor_recovery_codes` as **remove**; `users.address` +`county` → `state`.
Locale source: `users` → `country_code`.

**`users.address.country` is deliberately left real.** faker's `country()` returns a *random* country,
which would contradict the locale-derived city and postcode; a coarse country name is low-risk and
keeps the blob coherent. Revisit only if that judgement changes.

~~**Locale coverage is thin:**~~ **FIXED 2026-08-20 (migration 007).** `country_code` was populated on
only **3 of 18** users, so the rest fell back to `en` with US-shaped postcodes, while all 18 carried
`address.country`. A locale source is now `(column, optional json path)`, so pointing `users` at
`address` + `country` covers every row. **The real workspace's own config still names `country_code`** —
re-point it at `address` / `country` on the Field Strategies screen to actually get the coverage. Safe
to set on one table now: since 2026-08-20 the locale follows the *entity*, so descendants inherit it
rather than diverging (queue item 9, now done).

Verified end to end (harness `scratchpad/sweep-verify.ts`): dump loads; password non-null on 18/18
with 0 bcrypt; `remember_token`/`ip_address`/`user_agent` all NULL; `password` and
`two_factor_secret` keys gone from `new_values`; every bound address path faked with 0 sentinels
surviving; unbound `country` preserved 18/18; `address2` present in exactly the 10 source rows that
had it.

**Two harness traps this exposed, both worth remembering:**
1. **A raw `knex` is not a faithful source.** Bypassing `createKnex` skips the
   `PG_VERBATIM_TEXT_OIDS` parser overrides, so json/jsonb arrive as JS objects and the pg dialect
   renders them as Postgres *array* literals → `invalid input syntax for type json`. Always build the
   source connection with `createKnex`.
2. **Real place names are useless canaries.** Seeding "Brandenburg" as the *real* county and asserting
   it disappeared failed — faker's own locale data contains it, so a genuine fake collided with the
   sentinel. Use values faker can never produce (`__REAL_CITY__`).

**If you sat down right now**, the queue is:
1. ~~Excluded-parent unloadable dump~~ — **FIXED 2026-08-20**, `DumpDialect.stripForeignKeysTo`.
2. ~~Composite-PK FK-child risk~~ — **FIXED 2026-08-20**, `filterAddressable` pre-flight scoped to
   cascade's edge list only (`foreignKeys` stays whole for topo order and backfill).
3. ~~Still-unprotected PII on the real workspace~~ — **DONE 2026-08-20**, the config sweep closed all
   six (16 → 22 strategies); see the sweep section above for the two choices the source schema forced.
4. ~~**SQLite adapter**~~ **DONE 2026-08-20** (see the top of this file). SQL Server is **deferred to v2**, so SQLite is the last dialect for v1.
5. ~~Backfill/morph warnings are console-only~~ — **DONE 2026-08-20** (migration 006,
   `runs.warnings`). The Runs screen lists them per run with a warning-count tag; `failRun` keeps the
   ones collected before a failure. Informational output (rows backfilled, edges followed) stays
   console-only on purpose.
6. ~~Live-verify the config screens~~ — **DONE 2026-07-30**, all seven captured and reviewed; see the
   verification section above for the harness and its four environment traps.
7. ~~Cross-table anonymization identity~~ — **DONE 2026-08-20** (`TableSelection.identities`).
8. ~~**Declared per-table identity source** / locale-from-a-JSON-path~~ — **DONE 2026-08-20**
   (migrations 007 + 008). Two tables, not one, and the reasoning is in decisions.md. Both hints live
   on the **Field Strategies** screen, one row per table: "Country from [column] [json path]" and
   "Identity from [column] [entity table]".
9. ~~**Locale should travel with identity through the cascade**~~ — **DONE 2026-08-20.** The faker
   locale now follows the entity: `executePipeline` resolves each entity's country once and keys it on
   the identity string, so a descendant renders in its entity's locale. No cascade change was needed —
   the identity string is already carried everywhere. Reads *every* row of a locale-source table, since
   a declared identity source can name an entity that isn't in the dump. See decisions.md.

## Earlier status: polymorphic support COMPLETE — all three stages landed 2026-07-30

[docs/polymorphic-cascade.md](../docs/polymorphic-cascade.md) is fully built: config + builder UI
(migration 004), down-cascade, and up-backfill. Declaring a relation is still the opt-in and both
directions are per-relation flags, so an undeclared morph behaves exactly as it did before any of this
existed.

Verified on the real resconx schema with the user's own declarations:
- **down**: `audits` 0 → ~45 rows, `messages` 0 → ~30; with a fixed seed no other table moves.
- **up**: **40 repairable morph dangles → 0** (`calendars` Project refs, `audits` User refs).
- **up-only holds**: a backfilled target never expands its children.

**Two findings worth remembering:**
1. **"Dangling" is two things.** ~20 distinct morph references in resconx_staging point at rows
   **deleted upstream** (historical `audits` rows → long-gone users). No backfill can repair those;
   `getExistingIds` surfaces them as warnings instead of counting them repaired. They will appear in
   any dump — it's a source-data issue, not a Masq one.
2. **Backfill's seed had to include morph-carrying tables.** A morph-only table has no FK at all, so
   seeding from FK edges alone never visited `audits`. Reverting the union leaves 40 dangles while
   `calendars` (which has FKs) looks fine either way — testing only the FK-having table would have
   shown a false pass.

**Latent risk, not fixed:** `cascadeSelection`'s `ensure()` still throws on a composite-PK child
reached by a plain **FK** edge — `model_has_roles` has `role_id → roles`, so if `roles` ever becomes
kept the extract fails. Hasn't fired because nothing seeds `roles`. The morph paths are guarded
(`filterAddressableMorphEdges`), the FK path isn't.

**If you sat down right now**, the queue is:
1. **Excluded-parent unloadable dump** — an included table with an FK to an excluded table emits
   `ALTER TABLE … REFERENCES <excluded>` from `pg_dump` and the load dies. Fix in the dump writer:
   drop FK constraints whose parent isn't in the dump. Small, and it's a "dump doesn't load" bug.
2. **The composite-PK FK-child risk above** — same shape, now that morph made it visible.
3. **SQLite adapter** (rest of step 8), then **SQL Server** (step 10).
4. **Template anonymizer** for JSON columns (migration 005 — morph took 004).
5. Backfill/morph warnings are console-only; surfacing them on the Runs screen needs a `runs` column.

## Earlier status: morph stage 2 DONE (down-cascade)

A kept entity now pulls the rows it owns through a declared morph relation. Morph edges share
`cascadeSelection`'s worklist with FK edges (one `absorb` helper serves both), driven by
`morphEdgesFor(relations, 'down')`; the new cascade parameter defaults to `[]` so the opt-in guarantee
holds structurally. Verified on the real resconx schema with the relations the user actually declared:
**`audits` 0 → ~40 rows, `messages` 0 → ~27**, and with a fixed seed **no other table's count moves**.
Every kept row was checked to trace to a kept user through the declared type value. Full backfill
suite re-run on both dialects (25 → 0 unchanged) since `absorb` was extracted from proven code.
Harness: `scratchpad/morph-cascade-smoke.ts`.

**Composite-PK morph tables now warn instead of aborting the run** —
`filterAddressableMorphEdges` pre-flights declared edges. This was live ammunition: the real workspace
already declares `model_has_roles.model_type`, and that table's PK is `(role_id, model_type, model_id)`,
so ticking "down" would have failed the whole extract.

**If you sat down right now:** stage 3 — **morph up-backfill**. `morphEdgesFor(relations, 'up')`
already exists and `backfillSelection` is the up-only pass it plugs into; what's needed is
per-row-resolved target tables in that worklist (read `(type, id)` off kept rows, group by mapped
table, `getExistingIds`, recurse upward only). Concrete target measured on the 30 Jul dump:
`calendars → App\Models\Project` has **8 of 10 references dangling**, invisible to the FK orphan
check.

## Earlier status: morph stage 1 DONE (config + builder UI)

Migration 004 + `morph_relations`/`morph_type_map` + repo → IPC → store → **Polymorphic** screen are
built ([docs/polymorphic-cascade.md](../docs/polymorphic-cascade.md) stage 1). **Changes no extract
behaviour** — declaring is inert until stages 2-3 read it, which is why it could land alone.

Detection works well on real data: **20 candidates found in resconx's 73 tables, 16/16 type values
guessed correctly, zero needing the user to pick**, and 0 FK-constrained columns wrongly offered.
Verified against the real resconx schema **loaded from a Masq dump** — no source credentials needed,
a trick worth reusing. Migration 004 also applied cleanly to a copy of the real config store (all
data intact, `foreign_key_check` clean). Repo proven with the real code via an `electron` shim.
Harnesses: `scratchpad/morph-config-smoke.ts`, `scratchpad/morph-detect-smoke.ts`,
`scratchpad/migrate-real.ts` (all gitignored).

Code review then found two P2s in the **renderer wiring** (the layer that looked like "just IPC
wrappers"): detected-but-unmapped type values were invisible on already-declared relations (config
drift → an edge the engine would silently skip), and `detect()` left the target-table dropdowns empty
on a fresh session. Both fixed and covered by `scratchpad/morph-store-smoke.ts`, a headless Pinia
test that fails against the pre-fix code. **Lesson: renderer store logic is worth testing headlessly
— both bugs were behavioural, not visual, and no amount of eyeballing the screen would have shown
them.**

**Not visually verified** — the screen builds (own 54 kB chunk) and typechecks, but no window has been
opened on it. Same standing caveat as the other six config screens.

**If you sat down right now:** stage 2 — **morph down-cascade**. Adapter primitive
`getRowsReferencingMorph(childTable, typeColumn, typeValue, idColumn, parentIds)` (the existing
`getRowsReferencing` plus `AND typeColumn = ?`), pre-expand each declared relation × its type map into
morph edges indexed by parent table, then process them in `cascadeSelection`'s worklist alongside the
FK edges. Then stage 3 — **morph up-backfill**, which plugs into the built `backfillSelection` as
per-row-resolved target tables rather than a new pass.

Measured on the 30 Jul resconx dump, so the engine work has a target to hit: `saved_matches` holds
**4 dangling morph references** (3 of 3 `App\Models\Conference`, 1 of 11 `App\Models\Project`)
that the FK orphan check cannot see, because there is no constraint. Reclassifying the morph-only
tables to `transactional` also emptied them (`conferences` 265 → 0, `messages` 177 → 0), since nothing
can reach them today — stage 2 is what makes a real subset of those possible instead of choosing
between "whole table" and "empty".

## Earlier status: parent backfill DONE — the subset is now referentially complete

`backfillSelection` ([src/main/extract/backfill.ts](../src/main/extract/backfill.ts)) closes the
biggest correctness gap: after cascade, every kept row's FK parents are pulled in transitively, so a
dump no longer loads clean while silently holding dangling references. Runs in `executePipeline`
straight after `cascadeSelection`, always on. Live-verified 2026-07-30 on **both** dialects with a
fixture covering the pivot table, a 5-level self-referential chain, a transitive up-chain, a
reference table pointing at a subset table, and nullable FKs: **25 orphans → 0**, identical on
Postgres (real dump loaded into a fresh DB, orphans counted by LEFT JOIN) and MySQL. Deterministic
(re-run gave a byte-identical dump) and anonymization-safe (27 users, 27 distinct emails, 0 unfaked).
Harnesses: `scratchpad/backfill-smoke.ts` (Postgres, 4 phases) + `scratchpad/backfill-mysql.ts`
(MySQL) — both gitignored; `scratchpad/tsconfig.json` typechecks them, which matters (see the esbuild
lesson below).

### ⚠ Read this before touching anything that writes a selection key

Code review of this branch found a **silent PII-leak bug class** — three instances, all now fixed, see
the 2026-07-30 "Selection-key identity" decisions entry. Short version: `TableSelection.ids` is keyed
by PK value and `Map` compares with `===`, so **`42` and `'42'` are different rows**. Both occur for
real (node-pg returns `int4` as a number, `int8` as a *string*; config values are always JSON numbers),
and Postgres permits an `int8` FK onto an `int4` PK.

What makes it lethal: a mistyped key still passes everything else. The writer's `WHERE pk IN (…)` runs
**in the database**, which coerces — so the row is selected, lands in the dump, and the orphan count
reads zero. Only the in-process anonymize lookup misses, and the row goes out **with real PII**.
Reproduced at 5/5 backfilled rows and 3/3 explicitly-selected rows leaking real emails + names.

**Rule: never use a value as a selection key unless the driver produced it from the column that keys
that selection.** Feed ids through the new `getExistingIds(table, ids)` adapter primitive, which does
the comparison in SQL and hands back the parent's own PK values. Nothing enforces this at the type
level — `PkValue`'s doc comment is the only guard — so a fourth instance would look exactly like the
first three.

**If you sat down right now:** next is the morph work in
[docs/polymorphic-cascade.md](../docs/polymorphic-cascade.md), starting with stage 1 (the
`morph_relations` + `morph_type_map` config layer + builder UI, inert until the engine reads it).
Stage 3 (morph up-backfill) now has its mechanism already built and proven — it needs the
`TableRole`/worklist shape in `backfill.ts` extended with per-row-resolved target tables, not a new
subsystem.

Two things this pass deliberately left open:
- **An included table with an FK to an *excluded* table produces an unloadable dump** (new finding,
  see decisions 2026-07-30). `pg_dump`'s per-table DDL emits the trailing `ALTER TABLE … ADD
  CONSTRAINT … REFERENCES <excluded>` and the load dies with `relation "…" does not exist`. Backfill
  warns about the dangling data but can't help with the DDL. Fix belongs in the dump writer: drop FK
  constraints whose parent table isn't in the dump.
- **Backfill's warnings are console-only.** `runs` has no warnings column, so surfacing them on the
  Runs screen needs a migration. The three warning cases (excluded parent, non-PK FK target,
  composite-PK parent) are exactly the places a dump can still be referentially broken, so they're
  worth showing in the UI eventually.

## Earlier status: step 8 Postgres COMPLETE — full pipeline live-verified end to end

`PostgresAdapter` (`src/main/adapters/postgres.ts`) is written and wired into `makeAdapter`, so a
Postgres extract now runs the whole pipeline. Verified 2026-07-25 against a real PostgreSQL 16 by
replaying **run.ts's executePipeline stage for stage** through the real adapter (only the
Electron/keychain/config-store glue was substituted): introspect → `resolveSelection` →
`cascadeSelection` → `anonymizeRow` → `topologicalOrder` → dump writer → load into a fresh database.
Harness: `scratchpad/pg-pipeline.ts`.

What that run proved, on a `tenant` (non-`public`) schema of 7 tables:
- introspection: 5 FK edges, `format_type` column types, identity PK detected;
  `getUniqueColumns` returned `email,id,notes` — i.e. it **caught a bare `CREATE UNIQUE INDEX`** and
  correctly **excluded** a partial index and an expression (`lower(email)`) index
- selection: random 8 ∪ 3 pattern-matched admins, **preserve-wins held** (3 rows verbatim)
- anonymization: fake email stayed UNIQUE across rows, `redact` → NULL, `jitter` within ±10%,
  and **locale resolved per row from the country column** (NL rows got Dutch names, GB/US English)
- reference table dumped in full; excluded table absent from the dump entirely
- generated column omitted from INSERTs and recomputed on load; identity sequences → `MAX+1`
- combined **and** split mode load clean; split data file re-runs
- `pg_dump` failure paths give usable messages ("pg_dump was not found on this machine…",
  `Table "x" was not found in the search path (tenant)`)
- **DB passwords containing `$` and `\` work throughout** — verified 2026-07-25 with
  `Se$cret\Pa$$w0rd` across `ping`, introspection, data queries and the `pg_dump` subprocess. Safe by
  construction: nothing passes a password through a shell (`execFile`, not `exec`, with an `env`
  object), and knex/pg parameterises. A deliberately wrong password was rejected in the same run, so
  the passes weren't masked by trust auth or `~/.pgpass`.
- **`\restrict`/`\unrestrict` stripped from pg_dump DDL** (see decisions) — without it the dump loads
  under `psql` but is a syntax error in any other client.

### ~~⚠ Found during that run: dumps can load "successfully" while referentially broken~~ FIXED 2026-07-30

**Fixed by `backfillSelection` — see "Current status" at the top.** The diagnosis below is kept
because the measurements are the reason the fix exists.

**Not a Postgres bug — a `cascade.ts` design gap, and dialect-independent.** `cascadeSelection` keeps
a child row when **any** one FK parent is kept. A child with *two* parents (a pivot table — Laravel's
`team_user` is exactly this shape) therefore gets kept via parent A while its reference to parent B
dangles. Because the load runs with FK enforcement off and Postgres never re-validates, **psql exits
0 and the dev database silently contains dangling references.**

Measured both ways round, so it isn't a rule-configuration artifact:
- rule `teams: all` → `team_user` pulled all 40 rows, **31 with `user_id` pointing at absent users**
- no rule on `teams` → `team_user` got 11 rows, **all 11 with `team_id` pointing at absent teams**

Re-adding the FK constraint afterwards fails with `Key (user_id)=(4) is not present in table "users"`,
which is the honest verdict on the data.

The fix was the **upward/parent backfill** deferred on 2026-07-24 (see decisions) — **built and
live-verified 2026-07-30** on both dialects: after cascade, every kept row's FK parents are now pulled
in transitively.

`createPostgresDumpDialect(schemas)` + the sequence-reset writer stage are live-verified end-to-end
(2026-07-25) against a throwaway `postgres:16-alpine` container: extract from a **non-`public`
schema** → real `writeCombinedDump`/`writeSplitDump` → load into a fresh database → **every row of
every table md5-identical to the source**, in both output modes. Split mode additionally re-runs
correctly: after simulating local dev drift (extra rows), re-loading the same data file restored the
exact source state and left sequences at `MAX+1`. Covered types: jsonb, json, `text[]` (with commas /
quotes / backslashes / NULL elements), `int[]`, **`date[]`, `timestamp[]`, `timestamptz[]`,
`interval[]`, `json[]`, `jsonb[]`**, date, timestamp, timestamptz, numeric, bigint, boolean, bytea,
unicode, embedded quotes/newlines, NULLs, a UUID PK, an empty table, and a mutually self-referencing
FK. Harness: `scratchpad/pg-dump-smoke.ts` (not committed). See the two 2026-07-25 decisions entries
(the dialect build, then the code-review fixes).

Also landed as part of that work: `getSequenceColumns` on `DbAdapter` (+ MySQL impl),
`DumpDialect.preamble`/`resetSequence`, `DumpTable.sequenceColumns`, per-connection pg type-parser
overrides in `createKnex`, and dialect selection by connection dialect in `run.ts` (was hardcoded to
MySQL).

**Three traps to remember when touching this** (each cost a wrong turn during the build):
1. `resetSequence` is **not** self-guarding — `MAX(col)` is resolved at *parse* time and `uuid` has
   no `max()` overload, so only ever feed it introspected sequence-backed columns.
2. A **batched** multi-row INSERT checks FKs at statement end, so FK tests can pass for the wrong
   reason at the default batch size of 500. Use `batchSize: 1` to test FK behaviour honestly.
3. `PG_VERBATIM_TEXT_OIDS` must list every type **with its array OID** — pg's array parser recurses
   into the element parser, so a scalar-only override silently corrupts `date[]`/`json[]`/etc. It's
   written as `[scalar, array]` pairs for exactly this reason; add both or neither.

**Search-path parsing** (`parseSearchPath(raw, username?)`) is quote-aware: only unquoted commas
separate entries, `""` is an escaped quote, unquoted names fold to lower case (Postgres' rule),
quoted names stay verbatim, and `$user` resolves to the connection username. 23 cases verified.

### Identity + generated columns — FIXED 2026-07-25, both dialects live-verified

Two load-breaking gaps, found by probing features the earlier fixture didn't cover. Both fixed and
proven load-bearing (revert the fix → the load fails), on PG 16 **and** MySQL 8.4.

1. **`GENERATED ALWAYS AS IDENTITY`** — `DumpDialect.insertModifier` puts
   `OVERRIDING SYSTEM VALUE` between the column list and `VALUES` for Postgres. Emitted
   unconditionally (verified harmless on `BY DEFAULT` identity, plain `serial`, and a no-sequence
   uuid PK), so it can't be missed for a table. MySQL leaves it undefined.
2. **Generated columns dropped from the INSERT list** — `DbAdapter.getGeneratedColumns` +
   filtering in `run.ts`. **This also fixed a latent MySQL bug** (MySQL 8 rejects them with
   `ERROR 3105`); it had just never been hit. Rows still stream every column — only the INSERT
   tuple is narrowed, so DDL and the anonymizer are unaffected.

**Don't loosen the MySQL `extra` predicate in `getGeneratedColumns`.** MySQL 8 reports
`extra = 'DEFAULT_GENERATED'` for ordinary columns with an expression default
(`DEFAULT CURRENT_TIMESTAMP`, `DEFAULT (UUID())`). A `LIKE '%generated%'` match would silently drop
those real columns from every INSERT — verified it would have taken `made_at`, `updated_at`, and
`uuid_col`. It also matches `extra` only, never `generation_expression` (which doesn't exist before
MySQL 5.7 and would throw).

**Verified clean, so NOT outstanding:** 11 exotic types round-trip byte-identically — `int4range`,
`tsrange`, `money` (survived an `lc_monetary` change), `bit(4)`, `varbit`, `bytea[]`, enum, domain,
`'infinity'::timestamp`, `tsvector`, `uuid[]`. Sequence resets already handle identity columns
(`pg_get_serial_sequence` resolves them; `getSequenceColumns` matches `is_identity = 'YES'`), and
MySQL `AUTO_INCREMENT` still self-heals with no reset emitted.

A **MySQL** smoke harness now exists too (`scratchpad/mysql-smoke.ts`) — real `MySQLAdapter` →
`mysqlDumpDialect` → `writeCombinedDump` → load → md5 compare. Spin up an isolated
`mysql:8` container (`-e MYSQL_ROOT_PASSWORD=… -p 127.0.0.1:33306:3306`); there's a MySQL on the
host's 3306 but **don't test against it**.

**Search path is configurable end-to-end** (the user's own apps don't use `public`):
`Connection.searchPath` holds the raw as-typed value (single schema or `tenant, public` list,
matching Laravel's `DB_SEARCH_PATH`), migration `003_connection_search_path.sql` adds the column,
the connections repo round-trips it, `ConnectionFormModal` shows a Postgres-only "Search path"
field, and `src/main/adapters/search-path.ts` `parseSearchPath(raw, username?)` turns it into an
ordered schema list. 23 parser cases verified.

**Migration 003 is now confirmed applied in the real app** (2026-07-25): a live `npm run dev` boot
created `~/.config/masq/config.sqlite3` with `_migrations` = 1,2,3, the `connections` table carrying
the `search_path` column, and the usual 2 workspaces / 4 connections seeded. Previously only verified
against a simulated pre-003 database.

`pg_dump` 16.14 and `psql` are present on this dev machine (`/usr/bin/`). There are also
zitadel/authentik Postgres containers running — **live auth services, never test against those**;
spin up a throwaway (`docker run --rm -d -e POSTGRES_PASSWORD=… -p 127.0.0.1:55432:5432
postgres:16-alpine`) instead.

**Known limitation (search path lists):** the config model keys classifications / selection rules /
field strategies on a **bare table name**, so the same table name in two schemas on the path is
ambiguous. Fine for the common single-schema case; schema-qualifying the config model would touch
every screen, so it's deferred until something actually needs it.

### Live-tested against a real Laravel/pgvector app (resconx_staging) 2026-07-25/26

A real Postgres extract was run **from the app UI** (and via `runExtract` in a harness) against a
production-shaped staging DB (83 tables, pgvector). Findings, in priority order:

1. ~~**Dumps don't load on schemas using extensions.**~~ **FIXED 2026-07-26** —
   `getExtensions()` + `CREATE EXTENSION` in the Postgres preamble. Proven: the pgvector schema now
   loads clean into a `pgvector/pgvector:pg16` target (`vector(1536)` column + 8 `gin_trgm_ops`
   indexes all present), where before it aborted on `type "…vector" does not exist`.
2. ~~**Parent backfill in `cascade.ts`**~~ — **DONE 2026-07-30** (`backfill.ts`, see "Current
   status"). The dangling-FK gap was confirmed on real data first: **124 orphaned rows across 11 FK
   columns** (e.g. 87 `user_publications` → absent `publications`). **Worth re-running the resconx
   extract to confirm that number is now 0** — the synthetic fixture proves the mechanism, but real
   data is the verdict, and resconx also has the excluded-parent DDL case in play.
3. **Polymorphic (morph) relations are invisible to cascade** — cascade only walks declared FKs.
   **19 of resconx's 83 tables are morph-shaped** (`*_type`+`*_id`, no FK); 7 are morph-only so
   cascade can never reach them. **Design planned in
   [docs/polymorphic-cascade.md](../docs/polymorphic-cascade.md)** (with diagrams): model a morph
   relation as a per-row-resolved FK edge, config-declared (opt-in), traversed two ways — DOWN pulls
   a kept entity's owned rows, UP backfills dangling targets (shares machinery with the plain-FK
   parent-backfill, item #2). Type values assumed **canonical** — reconciling inconsistent spellings
   (FQCN vs bare alias) is out of scope, resolved upstream (user decision 2026-07-26). Staged:
   config+builder UI (**DONE 2026-07-30**) → down-cascade (**next**) → up-backfill. Stage 3's
   machinery already exists: `backfillSelection` (item #2) is the up-only pass morph backfill plugs
   into.
4. **Custom types beyond extensions** (enums / domains / composite) are still omitted — `pg_dump
   --table` skips them like it skipped extensions. resconx doesn't use any (its only non-builtin
   type, `vector`, comes from the now-handled extension), so untested, but the same preamble seam
   applies. Enum/domain DDL is harder to hand-roll than `CREATE EXTENSION`.
5. **No `schema-only` classification.** "Keep structure, drop rows" only happens as a side effect of
   `transactional` + no FK path (how `vector_embeddings` gets DDL-only today). Fragile — it silently
   changes if someone adds an FK. Worth a first-class class for derived/churn tables.
6. **Anonymization only covers configured columns**, and strategies were written for the MySQL
   schema — a real run left bcrypt hashes, addresses, DOBs, avatar URLs, `two_factor_secret`,
   `stripe_id` etc. in `users` untouched. User's stance (2026-07-26): this is on the user to
   configure carefully; note `audits`-style JSON blobs can't be column-anonymised at all (→ the
   template anonymizer).
7. **Template anonymizer for JSON columns** — planned in
   [docs/template-anonymizer.md](../docs/template-anonymizer.md). Overlay a row's real JSON, binding
   paths to existing generators, per-row locale + per-path seed. **Supersedes the earlier json-lorem
   idea.** Needs migration 004 (CHECK rebuild on `field_strategies`) + a builder UI (the bulk).
   Not built. Motivated by `users.address` (JSON, shape varies) and ~20 other json/jsonb columns.
8. **DONE 2026-07-26: 6 new generators** — `loremWords`/`loremSentence`/`loremParagraph`,
   `dateOfBirth`, `avatarUrl`, `url`. All cheap `FakeGenerator` additions, no migration. DOB pins
   faker's `refDate` — without it `date.birthdate()` is non-deterministic (defaults `refDate` to now),
   which would break re-run stability. `avatarUrl`/`url` target real PII (Google avatar URLs in
   `users.avatar_url`, website links). `loremParagraph` will overflow a tight `varchar` — intend it
   for `text`/`longtext` columns.

### Still open regardless of the live test

- ~~**SQLite adapter**~~ **DONE 2026-08-20.** SQL Server is **deferred to v2**, so v1's dialects are complete.
- ~~**Live-verify the Rules / Fields / Tables screens**~~ — **DONE 2026-07-30**, superseded by the
  seven-screen capture above (`screenshot-main.ts` covers `rules`/`fields`/`tables`); Tables and Runs
  were exercised again by the SQLite e2e harness on 2026-08-20.
- ~~**Cross-table anonymization identity**~~ — **DONE 2026-08-20**, and its two follow-ups with it:
  a **declared identity source** (migration 008) for edges the graph reads wrong, and the **locale
  following the entity** rather than the table. `scratchpad/identity-smoke.ts` (47 checks) covers the
  2-hop chain, the backfill exception, the UNIQUE-column tie-break, per-row jitter, the declared
  override, an entity absent from the dump, and re-run stability.

### How the Postgres divergences were resolved (all done — kept for reference)

`src/main/adapters/postgres.ts` was **not** a copy-edit of `mysql.ts`. What differed:

1. ~~**FK checks can't be toggled per-session.**~~ **DONE 2026-07-25** — `SET
   session_replication_role = replica`/`origin` fits the existing flat-string pair, so the
   `DumpDialect` interface didn't need reshaping after all. Proven load-bearing against a live DB.
2. ~~**Sequences don't self-heal.**~~ **DONE 2026-07-25** — post-data reset section in the writer
   (`resetSequence` + `sequenceColumns` + `getSequenceColumns`), empty-table-safe, verified.
3. ~~**`schema` ≠ `database`.**~~ **DONE 2026-07-25** — `Connection.searchPath` + migration 003 +
   form field + `parseSearchPath()`; `createKnex` sets the session search path. What's left is the
   adapter *using* the parsed list: scope every `information_schema` query with
   `whereIn('table_schema', schemas)` rather than MySQL's single-value `where`, and take the schema
   list as a constructor arg (`new PostgresAdapter(db, schemas)`) the way `MySQLAdapter` takes
   `database`.
4. **`getCreateTableStatement` shells out to `pg_dump --schema-only --table=X`** (spec §9 — don't
   hand-roll). Three gotchas: it's an **external system binary not bundled with the app**, so a
   packaged Masq needs a preflight check and a clear error; `pg_dump` **refuses to dump from a
   server newer than itself** (a PG 17+ server against this PG 16 client fails), so version
   detection matters; and pass `--no-owner --no-acl` or the DDL carries `ALTER TABLE … OWNER TO`
   for roles that don't exist locally. Its output is multi-statement, which the writer tolerates
   (`ddl` is an opaque blob, [dump-writer.ts:40](../src/main/extract/dump-writer.ts#L40) only
   normalizes the trailing semicolon).
   **Discovered while testing:** `pg_dump` output also carries session setup, notably
   `SELECT pg_catalog.set_config('search_path', '', false);`, which **wipes the search path the
   dialect preamble just set** and breaks every bare-identifier INSERT that follows. So
   `getCreateTableStatement` must strip `pg_dump`'s `SET …` / `set_config` / comment lines and return
   only the table DDL. The smoke harness does exactly this filtering — port it into the adapter.
   Note `pg_dump` emits FKs as trailing `ALTER TABLE … ADD CONSTRAINT`, so per-table DDL blobs stay
   loadable in topological order; a true FK **cycle** would still need all `CREATE TABLE`s emitted
   before all constraint `ALTER`s (not handled, and no FK toggle can rescue DDL — see decisions).
5. **`getUniqueColumns` has no `information_schema.statistics`.** Query `pg_index`/`pg_class`/
   `pg_attribute` — the constraint-based views (`table_constraints`) miss bare
   `CREATE UNIQUE INDEX`, which the anonymizer's collision guard needs to know about.
6. **`getForeignKeys` needs a different query.** Postgres `key_column_usage` has no
   `referenced_table_name`; join `table_constraints` + `key_column_usage` +
   `constraint_column_usage`, or read `pg_constraint.confrelid` directly.
7. ~~**`value()` serialization.**~~ **DONE 2026-07-25** — `postgresDumpDialect.value()` plus
   per-connection type-parser overrides in `createKnex` (verbatim text for
   date/timestamp/timestamptz/interval/json/jsonb). Verified across every awkward type.
8. **Still to do in the adapter, small ones:** `sampleRandomIds` is `ORDER BY RANDOM()` not
   `RAND()`; `getColumns` should keep aliasing to camelCase; `ping` can stay `SELECT 1`;
   `getSequenceColumns` = `column_default LIKE 'nextval(%'` OR `is_identity = 'YES'` (the smoke
   harness has the query). `truncate` is already handled in the dialect.
9. ~~**Untested Postgres-side concern: `jitter` on a pg `numeric`.**~~ **NOT A BUG — checked
   2026-07-25.** pg does return `numeric`/`bigint` as strings, but `anonymize.ts`'s `toNumber()`
   already coerces a numeric string, so jitter works correctly. Verified live: jittered
   `numeric(12,2)` balances all landed within ±10% of source. (A first test showed `NaN`, but that
   was the *harness* passing `jitterPercent` where the rule field is `percent` — esbuild strips types
   without checking them, so it slipped through. **Typecheck scratch harnesses**, or this class of
   error looks like a product bug.)

## Earlier status: Field Strategies screen built (step 6 UI slice)

The Field Strategies screen is the sixth repository→IPC→store→view slice. `field_strategies` now
has a full-CRUD repo (`src/main/config/repositories/field-strategies.ts` — create upserts on
`UNIQUE(workspace, table, column)`, edit updates by id; the `rule` discriminated union maps to/from
flat `kind`/`generator`/`jitter_percent` columns), four new `config:*` channels, a
`useFieldStrategiesStore`, a `FieldStrategyFormModal` (kind select switches the field set:
fake→generator, jitter→percent, preserve/redact→none), and a `FieldsView` grouping strategies by
table with a per-column strategy tag + edit/delete. Table picker reuses the transactional universe;
**column is a live-introspected dropdown** via a new `source:listColumns` channel (adapter
`getColumns`), cached per table in the discovery store, degrading to free-text if no source
connection. `typecheck` + `build` green (FieldsView own 20 kB chunk). Not yet eyeballed live.
See the 2026-07-24 decisions entry.

**Country-specific fakes (data-driven locale):** `FakeGenerator` expanded to include name parts
(firstName/lastName) and a full address set (streetAddress/secondaryAddress/city/state/zipCode/
country/countryCode), each documented with its faker v9 mapping in types.ts. Faker output must be
country-appropriate, resolved **per row from that row's own country column** (chosen over
workspace-wide or per-strategy locale — see 2026-07-24 decision). Config captured now via a new
`table_locale_sources` table (migration 002) + repo/IPC/`useLocaleSourcesStore`; the Fields screen
shows a per-table "Country from [column]" select in each group header (columns from live
introspection, degrades to free-text). The value→locale mapping + per-row resolution is engine
work (step 7, deferred).

## Earlier status: Selection Rules screen built (step 5 UI slice)

The Selection Rules screen is the fifth repository→IPC→store→view slice. `selection_rules` now
has a full-CRUD repo (`src/main/config/repositories/selection-rules.ts` — plain create/update/
delete by id, *not* upsert, since a table can carry several rules), four new `config:*` channels,
a `useSelectionRulesStore` (workspace-scoped `all`/`list` + `create`/`update`/`remove`), a
`SelectionRuleFormModal` (strategy-conditional fields: random→count, pattern→column+regex,
explicit→value list, all→none; regex is compile-validated), and a `RulesView` that groups rules
by table with a readable per-rule summary + anonymize/preserve tag + edit/delete. `typecheck` +
`build` green (RulesView is its own 35 kB chunk). Not yet eyeballed live. Backend consumption of
these rules (merge + cascade) is still the extract pipeline (steps 5–7 backend). See the
2026-07-24 decisions entry.

## Earlier status: MySQL adapter — introspection + connectivity (step 3, first half)

First live-source-DB code. `src/main/adapters/` has a `DbAdapter` interface (introspection
subset), a knex factory, and `MySQLAdapter` (tables/columns/FKs/`SHOW CREATE TABLE`/ping over
`information_schema`). A new `source:*` IPC namespace exposes `testConnection` (returns
`{ok, tableCount, error}`) and `listTables`; credentials are read from the keychain in main —
the renderer only passes a connection id. UI: Connections cards have a **Test** button (reports
table count); the Tables screen has **Discover from source** which introspects the workspace's
source connection and drives a discovered-list-as-universe classification view. `knex` + `mysql2`
added (pure JS, no native rebuild). `typecheck` + `build` green.

**Live-verified 2026-07-22:** Test button hit a real MySQL DB and reported 25 tables; Discover
from source populated the Tables screen with the expected tables. Proves the full path (keychain
password → knex/mysql2 → `ping`/`getTables` over `information_schema` → union-model classification
UI). `getColumns`/`getForeignKeys`/`getCreateTableStatement` have no live caller yet — exercised
once the extract slices use them. Data-movement adapter methods (stream/sample/cascade) are
deferred to the extract slices (steps 5–7). See the 2026-07-22 decisions entry.

## Earlier status: Connection + workspace CRUD complete in the UI

Both the Connections view and the sidebar Workspace switcher support the full lifecycle
(create/edit/delete). `components/ConnectionFormModal.vue` and `components/WorkspaceFormModal.vue`
each serve both create and edit via an optional prop; cards / the switcher carry Edit/Delete
actions, delete goes through a confirm dialog (workspace delete warns about connection cascade).
Verified live in a running window on 2026-07-21 (connection + workspace CRUD all working) — the
earlier "not yet eyeballed" caveats on these slices are now cleared. Right-click cut/copy/paste
also confirmed. Writes go through the existing `createConnection`
/ `updateConnection` / `deleteConnection` + `setPassword` IPC. Dialect-aware fields (server
host/port/database/username/password vs. sqlite file path), inline validation, and keychain
password storage (server dialects only, sent separately — never on the `Connection`; on edit,
only re-sent if retyped). The connections store has `create`/`update`/`remove` actions that
update the cached slice so the grid refreshes without a refetch. Right-click cut/copy/paste is
wired app-wide in the main process (`context-menu` handler in `src/main/index.ts`). `typecheck`
+ `build` green. Not yet eyeballed in a live window. See the 2026-07-21 entries below.

## Earlier status: config store built + wired (workspace/connections load from SQLite over IPC)

Step 2 (config store) is done and the live UI now runs on it, not mock. On launch the main
process opens `config.sqlite3` in `userData`, runs migrations, seeds two example workspaces on
first run, and exposes a narrow IPC surface; the Connections view renders from the DB. See the
"Done — step 2" section below and the 2026-07-20 entry in decisions.md.

## Earlier status: first UI slice built (app shell + Connections, mock-fed)

Electron + Vite + Vue-TS scaffold is in place (generated via
`@quick-start/create-electron`, vue-ts template, merged into the repo over our
existing files). `npm install` done, `npm run typecheck` green, `npm run dev` launches
the window with HMR. Packaging verified on macOS: `npm run build:unpack` produces
`dist/mac-arm64/Masq.app` (arm64), which boots cleanly as a packaged app (main + GPU +
network helpers spawn; uses `userData` at `~/Library/Application Support/masq`). Still
the default welcome UI — no app-specific code yet.

Windows/Linux installers not yet produced (cross-OS builds need CI or a
Windows/Linux host; deferred to a CI setup rather than blocking local dev on macOS).

## Build order (from spec §13)

Tracks the suggested sequence. Mark items as they complete.

- [x] 1. Electron + Vite + Vue-TS scaffold; packaging pipeline working end-to-end
      — scaffold, `npm run dev`, typecheck, and `build:unpack` (macOS `.app`, boots
      clean) all verified. Windows/Linux installers deferred to CI.
- [x] 2. Config store: schema, migrations, workspace CRUD, connection CRUD + credential storage
      — built in `src/main/config/`, exposed over IPC, and the workspace + connections stores
      now load from it. Full CRUD + credentials exist; the UI currently only *reads* (list).
- [x] 3. MySQL adapter (introspection + streaming) — introspection + connectivity live-verified;
      data-movement methods (`getColumnValues`, `sampleRandomIds`, `getRowsReferencing`,
      `streamRows`) now implemented (extract slice 1). The data-movement methods have no live
      caller yet — exercised once selection resolution (slice 2) lands.
- [x] 4. Table classification + exclusion UI, backed by config store — UI + persistence done
      (repository, IPC, store, view, Laravel framework presets), and **"Discover from source" feeds
      real introspected names** (`discovery` store → `source:listTables`). Confirmed in a running
      window 2026-08-20 by the SQLite e2e harness, which clicks Discover and reads the rows back.
- [x] 5. Selection rules (random + pattern) + merge logic + FK cascade — UI + backend done
      (extract slices 2–3, backfill slice 7). Merge = preserve-wins; cascade parent→child, then
      `backfillSelection` pulls kept rows' FK parents back up (2026-07-30) — the subset is
      referentially complete.
- [x] 6. Field strategy engine (preserve/redact/fake/jitter) + seeded faker consistency — UI +
      engine done (extract slice 4). Seeded per (identity, generator), and **cross-table
      same-person identity landed 2026-08-20** (`TableSelection.identities`) — step 6 is complete.
- [x] 7. Dump generator: schema DDL + data DML — combined + split both built (extract slice 5).
- [x] 8. Postgres adapter, then SQLite adapter — **both COMPLETE and verified end to end**
      (drivers, search-path config, dump dialects, sequence resets, type-parser overrides,
      `PostgresAdapter` + `SQLiteAdapter`, both wired into `makeAdapter`). SQLite landed
      2026-08-20 — safe integers, read-only opens, a real streaming cursor, and a fail-open DDL
      stripper; see decisions.md.
- [x] 9. Run history UI (row counts, status, output file paths) — RunsView + runs repo (slice 6).
      Not yet run against a live DB.
- [~] 10. SQL Server adapter — **DEFERRED TO v2 (2026-08-20)**, deliberately not built. Placeholder
      only: the `mssql` dialect remains wired through the enum, config CHECK and connection form.

## In progress

**UI-first build** (deliberate deviation from spec §13 — see decisions.md).

### Done — step 2: config store (SQLite) + IPC + live UI wiring
All under `src/main/config/`:
- `db.ts` — singleton `better-sqlite3` handle at `userData/config.sqlite3` (`foreign_keys=ON`,
  WAL). Never leaves the main process.
- `migrations/001_init.sql` — the full spec §10 schema (7 tables). `migrate.ts` — numbered-file
  runner via `import.meta.glob(... ?raw)`, `_migrations` tracking table, idempotent on startup.
- `repositories/workspaces.ts` + `connections.ts` — CRUD, snake_case↔camelCase at the boundary,
  `crypto.randomUUID()` ids. `credentials.ts` — `safeStorage` blob, throws if unavailable
  (never plaintext). `seed.ts` — two example workspaces on first run only.
- `src/main/ipc.ts` — `registerConfigIpc()`: one `config:<method>` `handle` channel per op.
  `src/shared/api.ts` — shared `ConfigApi` contract. Preload exposes `window.api.config`.
- Renderer: `stores/workspace.ts` + `stores/connections.ts` now load over IPC (mock imports
  gone); `App.vue` calls `workspace.load()` on mount, connections store watches the active
  workspace. Types unchanged, so views were untouched.

Verified: `typecheck` + `build` green; `npm run start` creates the DB, applies migration v1,
seeds 2 workspaces / 4 connections; restart re-runs nothing (idempotent). `build:unpack`
produces the `.app` with `better_sqlite3.node` correctly unpacked to `app.asar.unpacked` (that
binary loads + executes under Electron). **Not** visually eyeballed in a live window, and the
packaged GUI app didn't stay up when launched headlessly (unsigned-app / Gatekeeper
termination — see blockers) — both need an interactive session to confirm.

### Done — first UI slice: app shell + nav + Connections view (mock data)
Built and verified (`npm run typecheck` green, `npm run build` bundles clean — each
view lazy-loads as its own chunk):
- `src/shared/types.ts` — domain types (`Workspace`, `Connection`, `SelectionRule`,
  `FieldStrategy`, `Run`, `TableClassification`, `Run`) from spec §6/§8/§10.
  `FieldStrategyRule` is a discriminated union (matches spec §8); the `FieldStrategy`
  record wraps it with id/workspace/table/column. `@shared` alias wired into
  `electron.vite.config.ts` (renderer) + `tsconfig.web.json` paths.
- `src/renderer/src/mock/index.ts` — two example workspaces (Example Shop, Corner Shop)
  with connections/classifications/rules/field-strategies/runs, all typed.
- `router/index.ts` — hash history; routes `/connections` `/tables` `/rules`
  `/fields` `/runs` (`/` redirects to `/connections`), each `meta.title`d, lazy-loaded.
- `stores/workspace.ts` (list + current selection), `stores/connections.ts`
  (workspace-scoped slice via computed). Pinia setup-store style.
- `App.vue` — Naive UI providers (config/message/dialog) + `n-layout has-sider`;
  theme follows OS `prefers-color-scheme`, primary color `#7c5cff`.
- `components/AppSidebar.vue` — brand, workspace `n-select` switcher, `n-menu` nav
  (inline-SVG icons via render fns, no icon-lib dep), output-mode footer tag.
- `views/ConnectionsView.vue` — real, mock-fed card grid (role/dialect tags, target).
  `components/PlaceholderView.vue` reused by the other four section views.
- `main.ts` wires pinia + router; demo `Versions.vue` + welcome CSS/svgs removed;
  `main.css`/`base.css` trimmed to a neutral, theme-aware reset.

**Note:** the whole-library Naive UI import makes the renderer bundle ~1.1 MB. Fine
for now (desktop app, no network cost); revisit with per-component tree-shaking or
`unplugin-vue-components` if load time becomes noticeable.

GUI not yet eyeballed in a live window (build env has no display) — visual check is
`env -u ELECTRON_RUN_AS_NODE npm run dev` in an interactive terminal.

Uncommitted: the new UI files above + `package.json`/`package-lock.json` (three deps).

### Done — step 2b: New connection flow (2026-07-21)
- `components/ConnectionFormModal.vue` — `v-model:show`-driven modal (parent owns open state).
  Dialect select switches the field set: server dialects show host/port/database/username/
  password (default port filled per dialect); sqlite shows a file path. Inline required-field
  validation via `n-form` rules. Uses `useMessage()` for success/error toasts.
- `stores/connections.ts` — added `create(input, password?)` (calls `createConnection`, then
  `setPassword` if a password was given, then merges the row into `all`) and `remove(id)`.
- `views/ConnectionsView.vue` — button now enabled (guarded on a selected workspace), opens
  the modal; empty-state also gets an "Add one" action.
- Password is passed to `create` separately and never lives on the `Connection` shape — it
  goes straight to the keychain via `setPassword`.

### Done — step 2c: Edit/delete a connection (2026-07-21)
- `ConnectionFormModal.vue` — now takes an optional `connection` prop: null = create, a row =
  edit. Title, primary-button label ("Save changes"), and password placeholder ("Leave blank to
  keep current") switch on `isEdit`. The open-watcher seeds the form from the connection or
  blank. Password only re-sent to the keychain if the user types one. The dialect→port watcher
  was hardened to preserve a custom/loaded port (only overwrites when blank or still the prev
  dialect's default) so editing a non-default port no longer clobbers it.
- `stores/connections.ts` — added `update(id, patch, password?)` (calls `updateConnection`,
  optional `setPassword`, merges the row back into `all`).
- `ConnectionsView.vue` — each card gets an `#action` footer with Edit / Delete (quaternary
  buttons). Edit opens the modal in edit mode; Delete confirms via `useDialog().warning` then
  calls the store's `remove`. `typecheck` + `build` green. Not yet eyeballed live.

### Done — step 2d: Workspace create/edit/delete (2026-07-21)
- `components/WorkspaceFormModal.vue` — create/edit modal (name + `dumpOutputMode`), same
  optional-prop pattern as the connection modal (null = create, a row = edit). Create makes the
  new workspace active.
- `stores/workspace.ts` — added `create(input)` (creates + selects), `update(id, patch)`, and
  `remove(id)` (falls the selection back to the first remaining workspace when the active one is
  deleted).
- `components/AppSidebar.vue` — the Workspace switcher row gained a "＋" new-workspace button;
  below it, Edit / Delete for the current workspace. Delete confirms via `useDialog().warning`
  and warns that contained connections cascade (DB `ON DELETE CASCADE`); count comes from the
  connections store's `list`. `typecheck` + `build` green. Not yet eyeballed live.
- Note: deleting a workspace leaves its connections in the connections store's `all` cache
  (harmless — `list` filters by `currentWorkspaceId`, and switching workspaces reloads).

### Done — step 4 (partial): Tables classification screen (2026-07-22)
First real screen beyond Connections; the first slice to add its own repository + IPC channels.
- `src/main/config/repositories/table-classifications.ts` — CRUD over `table_classifications`.
  `setTableClassification` **upserts** on the `UNIQUE(workspace_id, table_name)` constraint
  (`ON CONFLICT … DO UPDATE`), so re-classifying replaces rather than errors. Absence of a row
  = the `transactional` default (no explicit "clear to default" beyond deleting the row).
- `src/main/ipc.ts` + `src/preload/index.ts` — three new `config:*` channels wired
  (`listTableClassificationsByWorkspace`, `setTableClassification`, `deleteTableClassification`);
  `src/shared/api.ts` gained the methods + `TableClassificationInput`.
- `src/shared/frameworks.ts` — framework catalogue + `detectFramework` (spec §5), shared main/renderer.
- `stores/tableClassifications.ts` — same shape as the connections store (`all` cache +
  workspace-scoped `list`, auto-load on workspace change). `setClass(name, class)` upserts;
  `applyExclusionPresets()` bulk-classifies the presets as excluded (skips already-classified).
- `views/TablesView.vue` — add-table-by-name row, per-row segmented class control
  (transactional/reference/structure/excluded), Remove, and an "Add framework presets" button. Empty state.
- **Why manual add:** no introspection yet (step 3), so the table list is populated by hand or
  presets for now; the MySQL adapter will later feed real names into this same store.
- `typecheck` + `build` green (TablesView is its own 26 kB chunk). Not yet eyeballed live.

### Fix — discovered tables now survive navigation (2026-07-24)
Bug: on the Tables screen, "Discover from source" populated the list, but navigating away and
back cleared it — routes are lazy-loaded so the view unmounts, and `discovered` was a
component-local `ref`. Moved discovery into `stores/discovery.ts` (`useDiscoveryStore`): holds
introspected names per workspace (`byWorkspace` map), a `discovering` flag, `sourceConnection`,
and the `discover()` action. Discovered names are a live-source concept (not persisted config),
so they live in memory for the session and reset only on app restart — re-discovering is a cheap
`listTables` call. `TablesView` now reads `discovery.tables`/`discovery.discovering`.

### Done — step 5 (partial): Selection Rules screen (2026-07-24)
Fifth repository→IPC→store→view slice. First slice where a table owns *many* rows (not one),
so the repo/store are full CRUD by id rather than upsert-on-unique.
- `src/main/config/repositories/selection-rules.ts` — CRUD over `selection_rules`. `anonymize`
  0/1↔boolean, `explicit_values` JSON↔`values[]`; `toColumns()` persists only the columns the
  chosen strategy uses (random→count, pattern→column+pattern, explicit→values), nulling the rest.
- `src/main/ipc.ts` + `src/preload/index.ts` — four new `config:*` channels
  (`listSelectionRulesByWorkspace`, `createSelectionRule`, `updateSelectionRule`,
  `deleteSelectionRule`); `src/shared/api.ts` gained the methods + `SelectionRuleInput`.
- `stores/selectionRules.ts` — workspace-scoped `all`/`list` + auto-load on workspace change;
  `create`/`update`/`remove` merge the saved row into the cache (connections-store shape).
- `components/SelectionRuleFormModal.vue` — create/edit, `v-model:show`, strategy-conditional
  field set; regex compile-validated; table field is a filterable+tag select seeded from
  transactional classifications but accepts any name; explicit values entered as free text
  (newline/comma split, numeric coercion).
- `views/RulesView.vue` — rules grouped by table, readable per-rule summary, anonymize/preserve
  tag, edit/delete (delete confirms via dialog). Empty state. `typecheck` + `build` green
  (own 35 kB chunk). Not yet eyeballed live.

### Done — step 6 (partial): Field Strategies screen (2026-07-24)
Sixth repository→IPC→store→view slice. All six config screens (connections, workspaces, tables,
rules, fields + the source adapter's read side) now exist.
- `src/main/config/repositories/field-strategies.ts` — CRUD over `field_strategies`. `rule`
  union ↔ flat `kind`/`generator`/`jitter_percent`; `createFieldStrategy` upserts on
  `UNIQUE(workspace, table, column)` (create-or-replace a column's strategy),
  `updateFieldStrategy` edits by id.
- `src/main/ipc.ts` + `src/preload/index.ts` — four new `config:*` channels;
  `src/shared/api.ts` gained the methods + `FieldStrategyInput`.
- `stores/fieldStrategies.ts` — workspace-scoped `all`/`list` + `create`/`update`/`remove`;
  create merges by id so an upsert-replace doesn't duplicate the cache row.
- `components/FieldStrategyFormModal.vue` — kind select switches the field set (fake→generator,
  jitter→percent, preserve/redact→none). Table picker = transactional universe; column free-text.
- `views/FieldsView.vue` — strategies grouped by table, per-column strategy tag, edit/delete.
  `typecheck` + `build` green (own 20 kB chunk). Not yet eyeballed live.

### Extract engine (steps 5–7 backend) — in progress, sliced
Sequenced as: (1) adapter data-movement methods → (2) selection resolution → (3) FK cascade →
(4) anonymizer (seeded faker + strategies + data-driven locale) → (5) dump writer → (6)
orchestration + run recording + trigger UI.

- **[x] Slice 1 — adapter data-movement methods (2026-07-24):** `getColumnValues`,
  `sampleRandomIds` (ORDER BY RAND, single-PK), `getRowsReferencing` (FK-cascade primitive,
  chunked IN), `streamRows` (knex `.stream()`, optional `col IN (…)` filter) added to `DbAdapter`
  + `MySQLAdapter`. Single-column-PK helper cached per adapter; throws clearly on composite/missing
  PK. `typecheck` + `build` green. No live caller yet (slice 2 exercises them).
- **[x] Slice 2 — selection resolution (2026-07-24):** `src/main/extract/select.ts`
  `resolveSelection(adapter, rules)` → `Map<table, TableSelection>` (`ids: Map<pk, anonymize>` +
  `keepAll`). random→`sampleRandomIds`, pattern→pull `(pk,col)` + JS `RegExp`, explicit→values,
  all→every pk. **Direct rule matches only** (rule-less tables get rows purely from cascade). Merge
  preserve-wins via `mergeKeep` (flag = AND across matches). `types.ts` = `TableSelection`/`PkValue`/
  `mergeKeep`; `pk.ts` resolves single-column PK (throws on composite).
- **[x] Slice 3 — FK cascade (2026-07-24):** `src/main/extract/cascade.ts`
  `cascadeSelection(adapter, selection, fks, isCascadeTarget)` — worklist BFS, parent→child only,
  preserve-wins, re-enqueues a row when newly kept or its flag drops to preserve (monotonic →
  terminates, safe on circular FKs). **No upward/parent-backfill** (spec seeds at roots — a rule on a
  child won't pull its parents; flagged as an enhancement). Assumes FK→parent-PK.
- **[x] Slice 4 — anonymizer (2026-07-24):** `@faker-js/faker` v10 added (pure JS, externalized —
  main bundle unchanged). `src/main/extract/anonymize.ts` `anonymizeRow(row, ctx)` applies a table's
  field strategies to an **anonymize=true** row (preserve rows copied verbatim by the caller, never
  reach here); columns without a strategy are left as-is. Determinism: faker is re-seeded before each
  value from `sha256(key)`→48-bit int — `fake` seeds on `identityKey:generator` (same person's fake
  name/email/address identical across tables + re-runs, independent of field order), `jitter` on
  `rowKey:column`. `locale.ts` `fakerFor(rawCountry)` maps a country value (ISO code or name, direct
  not FK) → a cached locale-chained `Faker` (`en_GB→en→base`, etc.), default `en`. Generator dispatch
  covers all 16 `FakeGenerator` values. `identityKey`/`rowKey` wiring (parent identity for cascaded
  children) lands in orchestration (slice 6).
- **[x] Slice 5 — dump writer (2026-07-24):** `dump-writer.ts` `writeCombinedDump` /
  `writeSplitDump` stream to Node `Writable`s (backpressure-aware), batched INSERTs (500/stmt,
  spec §9). Combined = FK-off → all DDL → all data → FK-on. Split = pure-DDL schema file +
  re-runnable data file (FK-off, TRUNCATE reverse-topo, inserts, FK-on). `dump-dialect.ts`
  `mysqlDumpDialect` delegates value/id escaping to mysql2's `escape`/`escapeId`. `graph.ts`
  `topologicalOrder` (Kahn, parents-first; cycle remainder appended — FK checks are off anyway).
  Takes `DumpTable[]` (ddl + columns + async row stream) already ordered; orchestration feeds it.
- **[x] Slice 6 — orchestration + run recording + trigger UI (2026-07-24):**
  `src/main/extract/run.ts` `runExtract(connectionId, workspaceId)` runs the whole pipeline inside
  `withSourceAdapter` (pool alive for the stream): load config → introspect → resolve selection →
  cascade → build topo-ordered `DumpTable[]` (each a lazy anonymized row stream) → write combined
  or split (per workspace `dumpOutputMode`) to `userData/dumps/{name}-{ts}.sql` → tally per-table
  row counts. `runs` repo records `running`→`completed`/`failed`. IPC: new `extract:*` namespace
  (`extract-ipc.ts`, registered in `index.ts`) + `config:listRunsByWorkspace`; preload gains
  `api.extract.runExtract` + `config.listRunsByWorkspace`; `ExtractApi` in shared/api. UI:
  `stores/runs.ts` (list + `run()` trigger) and a real `RunsView` (Run-extract button gated on a
  source connection; per-run status/duration/row-counts/output paths/error). `typecheck` + `build`
  green; faker externalized (main bundle 46 kB).
  **Live-verified 2026-07-24** against a real MySQL (`civic_admin`, 25 tables/18 FKs) via a headless
  esbuild harness driving the real stages (adapter→select→cascade→anonymize→writer, minus run.ts's
  app/keychain glue): sampled `users` (16) → cascaded to `team_user` (4); dump had correct FK
  toggles, verbatim DDL, batched INSERTs; first/last/email faked, other fields preserved; bcrypt
  hashes with `$`/`/` escaped correctly. Harness = `scratchpad/extract-smoke.ts` (not committed);
  run with `node --env-file=db.env` (db.env gitignored). run.ts's own glue still only runs in-app.
  **In-app verified 2026-07-24** (the layer the harness couldn't reach): a real Runs-screen click
  for the "Example Shop" workspace wrote split-mode `~/.config/masq/dumps/*.schema.sql` +
  `*.data.sql` — schema pure DDL in topo order, data file FK-off + reverse-topo TRUNCATEs +
  batched INSERTs + FK-on. So run.ts's config-store/keychain/IPC/UI glue works end-to-end.
  **JSON-column bug found + fixed:** mysql2 returns JSON columns as parsed objects; `escape()`
  turned them into SET-syntax (`` `k` = v ``)/`[object Object]`, corrupting INSERTs. Fixed in
  `dump-dialect.value()` — plain objects/arrays are `JSON.stringify`'d before escaping (Date/Buffer
  left to escape's own handling). Verified across object/array/nested/string/date/buffer/null.
  ~~**§8 gap:** anonymize identity is per-row~~ — **CLOSED 2026-08-20**: the cascade now carries the
  root entity's identity to its descendants (`TableSelection.identities`); see decisions.md.
  **Watch-item:** datetime timezone — a JS `Date` serializes in *local* tz (a shift); the live dump
  looked correct (mysql2 returned strings here), but consider `dateStrings: true` on the mysql2
  connection to guarantee verbatim datetimes.
  **UNIQUE-column collisions — FIXED (2026-07-24):** adapter `getUniqueColumns` (single-column
  UNIQUE/PRIMARY indexes) feeds the anonymizer, which tracks emitted values per unique column and
  deterministically salts the seed (`base:dupN`) on collision, keeping the first-attempt value
  identical to the non-unique case (cross-table consistency preserved). Proven: 300 identities on a
  ~1000-value generator → 38 collisions without the guard, 0 with it, deterministic across re-runs.
- **[x] Slice 7 — parent backfill + selection-key type fixes (2026-07-30):** `src/main/extract/backfill.ts`
  `backfillSelection(adapter, selection, foreignKeys, roleOf)` — a **second, up-only worklist** run
  after `cascadeSelection`, so every kept row's FK parents get pulled in transitively. Deliberately
  never expands a backfilled row's *children* (that would drag in unbounded subtrees); rows added for
  integrity are flagged `anonymize = true` via `mergeKeep`, so preserve-wins still holds. Tables are
  classified into a 3-way `TableRole`: `subset` (transactional — source *and* target), `complete`
  (reference — dumped whole, so a source but never a target) and `omitted` (excluded — neither).
  New adapter primitive `getReferencedIds(childTable, fkColumn, childIds?)` on both MySQL + Postgres
  (distinct non-null FK values; `childIds` omitted = whole table, for `keepAll`/reference). Three
  unrepairable-edge cases **warn instead of throwing**: excluded parent, FK onto a non-PK unique
  column, composite-PK parent. Warnings + added counts go to the console via `reportBackfill`.
  **Live-verified on both dialects — see "Current status" at the top for the numbers.**
  Code review then found the **selection-key identity** bug class (see the warning at the top and the
  2026-07-30 decisions entry): three places used a value as a `Map` key that the driver hadn't typed
  from that key's own column, leaking real PII into dumps while every integrity check stayed green.
  Fixed in `backfill.ts`, `cascade.ts` and `select.ts` via the new `getExistingIds` primitive
  (plus canonical-string matching in cascade). Also from that review: unrepairable-edge warnings now
  fire **only when a dangling value actually exists**, so an unused optional FK or an empty reference
  table no longer cries wolf.

### Other open slices
- **Live-verify the Rules + Fields + Tables screens** in a running window when interactive
  (incl. the field-strategy column dropdown + country-column select hitting a real source).
- **Run history UI (step 9)** — folds into extract slice 6 (needs a `runs` repo + channels).

## Backend work (following spec §13 order)

Steps 2–7 and 9 are done (see above). Next: **step 8 — Postgres adapter**; drivers are in,
the adapter itself is the work (divergence checklist under "Current status").

Later: CI to produce Windows/Linux installers (cross-OS half of step 1).

## Appearance: dark by default (2026-08-20)

`useThemeStore` holds a three-state preference — `dark` (default), `light`, `system` — cycled from the
sidebar footer and persisted in `localStorage` (a per-machine UI preference, not project data; also has
to resolve synchronously at first paint). `App.vue` feeds `isDark` to naive-ui and renders
`<n-global-style />`, **which is load-bearing**: without it the components theme but `document.body`
stays white underneath, flashing on load. The e2e asserts the computed body luma, not the label.

## What is actually left for v1 (2026-08-20)

The build order is complete — every step is `[x]` except SQL Server, deliberately deferred to v2 — and
queue items 1–9 above are all closed. What remains is **shipping and one UX gap**, not engine work:

1. **Packaging + CI** (the cross-OS half of step 1). Installers for Windows/Linux via CI, which runs
   straight into the code-signing gap in the blockers below: an unsigned packaged `.app` won't stay
   running when launched headlessly, and `electron-builder` reports "0 valid identities". This is the
   only thing between the current state and something a teammate can install.
2. **`hasPassword` is never called by the renderer.** It exists in `ConfigApi` and is wired through
   preload, but no view uses it — so "saved but wrong" and "never saved" look identical, and on edit a
   blank password field silently keeps the previous value. It cost real debugging time on 2026-07-25.
   Small, self-contained, and the last known rough edge in the UI.
3. **SSH tunnelling — designed 2026-08-20, unscheduled, and not v1.** Full plan in
   [docs/ssh-tunnel.md](../docs/ssh-tunnel.md). Not on the v1 list, but worth knowing it exists:
   Masq currently reaches only what the desktop can already route to, and a production DB normally
   isn't. Lands inside `withSourceAdapter` (the only `createKnex` caller in `src/`) as a `127.0.0.1`
   port forward via `ssh2`, plus migration 009 and an SSH section on the connection form. Read the
   doc's *Testing* section before starting — a tunnel test against a directly-reachable DB **passes
   vacuously**, same family as the SQLite nullability trap.
4. **Watch-items, not tasks:** random sampling is `ORDER BY RAND()` (full scan — fine to tens of
   thousands of rows, revisit with PK-range sampling if a root table hits millions); `migrate.ts` itself
   is exercised by no harness (its `import.meta.glob` can't be esbuild-bundled, so the harnesses apply
   the `.sql` files directly); and MySQL's `getSequenceColumns` has no live caller since
   `AUTO_INCREMENT` self-heals.

## Known blockers / watch-items

- **`safeStorage` blobs are bound to the *app identity*, which breaks scratch debug scripts.** A
  credential written by the real app cannot be decrypted by a bundle run as
  `./node_modules/.bin/electron script.cjs` — you get
  `Error while decrypting the ciphertext provided to safeStorage.decryptString`. That is **not**
  corruption: Electron looks the master key up in the keyring under `app.getName()`, which defaults to
  `Electron` for a loose script. Call **`app.setName('masq')`** (plus
  `app.setPath('userData', '~/.config/masq')`) before `whenReady` and the same blob decrypts fine.
  Backend here is `gnome_libsecret`. Encrypt-and-decrypt *within one script* always works, which makes
  this easy to misdiagnose as a storage bug.
- **No UI feedback on whether a connection has a stored password.** `hasPassword` exists in
  `ConfigApi` and is wired through preload, but **no renderer code calls it**. So "saved but wrong"
  and "never saved" look identical in the app, and on edit a blank password field silently keeps the
  previous value. This cost real debugging time on 2026-07-25 — worth surfacing in
  `ConnectionFormModal` / the connection card.
- **`FATAL: The SUID sandbox helper binary … is not configured correctly` on Ubuntu 24.04.**
  Real, fatal, and **re-appears after every `npm install`** that re-extracts Electron — npm cannot set
  setuid bits, so `node_modules/electron/dist/chrome-sandbox` lands as `lloyd:lloyd 755` when Electron
  needs `root:root 4755`. Nothing to do with any system Chromium: this is Electron's *own bundled*
  sandbox helper. Fix (re-run after each install):
  ```
  sudo chown root:root node_modules/electron/dist/chrome-sandbox
  sudo chmod 4755      node_modules/electron/dist/chrome-sandbox
  ```
  **Why it appears only from some terminals** — confirmed from `journalctl -k` audit records
  2026-07-25: Chromium prefers the *namespace* sandbox and only falls back to the SUID helper when
  unprivileged `userns_create` is refused. From a **VS Code snap** terminal the process runs under
  profile `snap.code.code`, which is in **complain** mode → `apparmor="ALLOWED"` → namespace sandbox
  works → no error. From a normal **unconfined** terminal, Ubuntu 24.04
  (`kernel.apparmor_restrict_unprivileged_userns=1`) transitions it into the `unprivileged_userns`
  profile, which returns `apparmor="DENIED" … capname="sys_admin"` → SUID fallback → abort. So the
  same checkout runs from one terminal and aborts from another; don't read that as flaky code.
  Rejected alternatives: `--no-sandbox` (weakens Chromium's sandbox, and baking it into the repo
  imposes that on everyone), and `sysctl kernel.apparmor_restrict_unprivileged_userns=0` (drops a
  system-wide hardening measure for all software, to fix one dev dependency).
- **`Error: Electron uninstall` from `electron-vite dev` means the binary was never downloaded.**
  Seen 2026-09-24 after bumping `electron` 39 → 44: `node_modules/electron` had `index.js` but no
  `dist/` and no `path.txt`, which is the file `getElectronPath` reads — so electron-vite aborts
  before the app starts, with nothing about downloads in the message. The npm package's own
  postinstall download had not run (an `--ignore-scripts` install, or a failed/interrupted fetch).
  Fix without a reinstall: `node node_modules/electron/install.js` (it reuses `~/.cache/electron`
  if the zip is already there). Then **rebuild the native module** — a version bump changes the
  ABI (44 → 149) and the old `better_sqlite3.node` will not load: `npx electron-builder
  install-app-deps`. And redo the `chrome-sandbox` chown above: the fresh `dist/` is unprivileged
  again.
- **`Schema org.gnome.desktop.interface does not have key font-antialiasing` on `npm run dev` is
  HARMLESS — ignore it.** Not a Masq bug and nothing to fix. It's Chromium's GTK init, and it appears
  because a terminal inside the **VS Code snap** exports `GSETTINGS_SCHEMA_DIR` (and a snap-first
  `XDG_DATA_DIRS`) pointing at the snap's bundled GNOME schemas, which predate that key: the system
  schema at `/usr/share/glib-2.0/schemas` declares it (`gsettings get … font-antialiasing` → `'rgba'`
  when pointed there), the snap's copy has zero occurrences of it. GTK falls back to a default and
  the app boots normally — verified 2026-07-25: the line is logged *after* `starting electron app…`,
  nothing follows it, no crash markers, and the run created `~/.config/masq/config.sqlite3`. Running
  from a terminal outside the VS Code snap makes it disappear. **Don't "fix" it with
  `sudo glib-compile-schemas`** — the system cache is already correct and newer than its XML.
- **`ELECTRON_RUN_AS_NODE=1` in agent/CI shells** makes `npm run dev` crash with
  `Cannot read properties of undefined (reading 'isPackaged')` — the Electron binary
  runs as plain Node, so `app` is undefined. Launch with this var unset
  (`env -u ELECTRON_RUN_AS_NODE npm run dev`). A normal interactive terminal is fine.
- **`better-sqlite3` native rebuild** against Electron's ABI is handled by the
  `electron-builder install-app-deps` postinstall (`npmRebuild: false` in
  `electron-builder.yml`) — see decisions.md. Confirmed working on first add (ABI 140) and again on the Electron 44 bump (ABI 149). Its
  `.node` is unpacked from asar via `asarUnpack: '**/node_modules/better-sqlite3/**'`.
  Note: to run any script against this module outside Electron (e.g. a smoke test), use
  Electron's own node: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron script.cjs`
  (plain `node` fails with a NODE_MODULE_VERSION mismatch — that's expected, it's built for
  Electron, not system Node).
- **Unsigned packaged `.app` won't stay running when launched headlessly** on this macOS
  (Gatekeeper / `task_name_for_pid` termination; electron-builder skips signing — "0 valid
  identities"). The `.app` builds fine and the native module is proven to load; this is a
  code-signing gap, not a config-store bug. Confirm the packaged GUI in an interactive login
  session, and sort signing before shipping installers.
- **Random sampling** uses `ORDER BY RAND()` (full scan + sort). Fine to tens of
  thousands of rows; revisit with PK-range sampling if any root table hits millions.
- **SQL Server** — **deferred to v2 (2026-08-20)**, so its TDS auth/encoding edge cases are no
  longer a v1 concern at all. Kept as a placeholder dialect, not a shipping target.
