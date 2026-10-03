# DB Subsetter & Anonymizer — Technical Spec (v1)

## 1. Purpose

A cross-platform desktop app (Mac / Windows / Linux) that connects to a production
database, selects a realistic *subset* of data, anonymizes sensitive fields, and
produces portable SQL dump files that developers can load into local or staging
databases — without ever giving them direct access to production data.

Primary use case: Example Shop's multi-app Laravel/MySQL environment, with secondary
support for Postgres and SQLite. **SQL Server is deferred to v2** (2026-08-20) — the `mssql`
dialect stays wired as a placeholder, but no adapter ships in v1.

---

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron** (not Tauri) | Subsetting/anonymization is fundamentally Node.js work (streaming, DB drivers, FK graph walking). Electron gives full Node in the main process; Tauri would require a Rust rewrite or a Node sidecar for no real benefit here. |
| Scaffold | `electron-vite` (vue-ts template) | Fast HMR, TS out of the box |
| Frontend | Vue 3 + TypeScript | Matches existing VILT familiarity |
| Backend | Node.js (Electron main process) + TypeScript | |
| Query builder | `knex` | Cross-dialect query execution (not introspection — see §4) |
| Drivers | `mysql2`, `pg`, `better-sqlite3`, `mssql` | Pure JS except `better-sqlite3` (native — needs `electron-rebuild`) |
| Fake data | `@faker-js/faker` | Deterministic seeding supported |
| Config store | `better-sqlite3`, app-local file in `userData` | Not the same DB as source/target — this is the app's own settings store |
| Packaging | `electron-builder` | Produces `.dmg`, `.exe` (nsis), `.deb`/`.AppImage` from one config |
| Credentials | Electron `safeStorage` (OS keychain) | Never store DB passwords in plaintext SQLite |

### Native module gotcha
`better-sqlite3` must be rebuilt against Electron's Node ABI:
```bash
npm install -D electron-rebuild
npx electron-rebuild -f -w better-sqlite3   # run as postinstall
```
`electron-builder` config needs:
```json
{ "asarUnpack": ["**/*.node", "node_modules/better-sqlite3/**"] }
```

---

## 3. High-Level Pipeline

```
1. Connect to source DB
2. Introspect: tables, columns, foreign keys        (dialect-specific adapter)
3. Classify tables: reference | transactional | excluded
4. For transactional tables: resolve SelectionRules → row IDs + anonymize flag
5. Cascade selection + anonymize flag through FK graph (parent → child)
6. Generate dump:
     - Schema DDL section (dialect-native CREATE TABLE)
     - Data DML section (streamed, batched INSERTs, anonymized per field config)
7. Write to file(s) — combined or split, per workspace setting
8. Record run metadata (row counts, status, output paths) in config store
```

---

## 4. Dialect Adapter Layer

Each dialect (MySQL, Postgres, SQLite, MSSQL) implements a common interface.
`knex` handles query *execution*; introspection is NOT unified across dialects
and needs per-adapter implementations (SQLite has no `information_schema`, uses
`PRAGMA` / `sqlite_master` instead).

```typescript
export interface DbAdapter {
  getTables(): Promise<string[]>;
  getForeignKeys(): Promise<ForeignKeyRef[]>;
  getColumns(table: string): Promise<ColumnInfo[]>;
  getColumnValues(table: string, columns: string[]): Promise<Record<string, unknown>[]>;
  sampleRandomIds(table: string, count: number): Promise<(string | number)[]>;
  getRowsReferencing(
    childTable: string, fkColumn: string, parentIds: (string | number)[]
  ): Promise<{ childId: string | number; parentId: string | number }[]>;
  streamRows(table: string, where?: Record<string, unknown[]>): AsyncIterable<Row>;
  getCreateTableStatement(table: string): Promise<string>;
}
```

Implementations: `MySQLAdapter`, `PostgresAdapter`, `SQLiteAdapter`, `MSSQLAdapter`.

**Random sampling caveat:** `ORDER BY RAND()/RANDOM()/NEWID()` forces a full
table scan + sort. Fine up to tens of thousands of rows; revisit (PK-range
sampling) if any root table is in the millions.

**Schema DDL generation:**
- MySQL: `SHOW CREATE TABLE`
- SQLite: `sqlite_master.sql` (original CREATE TABLE text, verbatim)
- Postgres: shell out to `pg_dump --schema-only --table=X` (don't hand-roll —
  too many edge cases: partial indexes, check constraints, sequences, custom types)
- MSSQL: best-effort, budget extra QA time (TDS auth/encoding edge cases)

**Connectivity — SSH tunnelling:** a production database is normally not directly
routable (bound to a private interface, reachable only via a bastion). Designed in
[docs/ssh-tunnel.md](ssh-tunnel.md): a local port forward via `ssh2`, opened and torn
down inside `withSourceAdapter` — the single choke point every source access already
passes through. Server-based dialects only. **Not built yet.**

---

## 5. Table Classification

Every table in scope is classified once, above the row-selection logic:

| Class | Behavior |
|---|---|
| `excluded` | Skipped entirely — not introspected, not dumped, not cascaded through |
| `reference` | Copied 100%, untouched, no anonymization (lookup/config tables) |
| `transactional` | Goes through SelectionRules → cascade → field anonymization |
| `structure` | DDL dumped, rows never are; cascade and backfill don't reach it (migration 013) |

`structure` is not the same as an unconfigured `transactional` table: that one is still a cascade
target, so a kept parent fills it from its children. `structure` is a guarantee.

**Framework presets.** A workspace records which framework its source belongs to (detected from the
discovered table names, overridable by hand). Each framework in the catalogue
(`src/shared/frameworks.ts` — Laravel, Rails, Django) names two sets of tables:

- `referenceTables` — dumped whole. Migration ledgers above all: a dump whose `migrations` /
  `schema_migrations` / `django_migrations` table is empty tells the framework nothing has ever run,
  so the next deploy re-applies every migration onto a populated database.
- `structureTables` — schema only. Sessions, cache, queues, admin logs: no useful developer data,
  but the app writes to them on first use, so the table has to exist.

Each classification records whether it was set by hand or written by a framework's presets, so
re-applying presets refreshes its own rows (picking up catalogue changes) without ever overwriting a
deliberate choice. Adding a framework is an edit to the catalogue, not a migration.

**Dangling FK rule:** if an excluded table is referenced by a kept table
(e.g. `orders.last_session_id → sessions.id`), null out the orphaned FK value
on write. Configurable per-column later; null is the safe v1 default.

---

## 6. Row Selection Rules

```typescript
export type SelectionStrategy = 'random' | 'pattern' | 'all' | 'explicit';

export interface SelectionRule {
  table: string;
  strategy: SelectionStrategy;
  anonymize: boolean;
  count?: number;              // 'random'
  column?: string;             // 'pattern'
  pattern?: string;            // 'pattern' — JS regex source
  values?: (string | number)[]; // 'explicit'
}
```

- **`random`**: resolved in-SQL (`ORDER BY RAND()/RANDOM()/NEWID() LIMIT n`) — fine, no dialect mismatch risk.
- **`pattern`**: resolved client-side in Node with a real `RegExp`, NOT pushed into SQL. MySQL `REGEXP`, Postgres `~`, and SQL Server (no native regex), plus SQLite (none without a custom function), all diverge — pulling `(id, column)` pairs and filtering in JS avoids the dialect mismatch entirely.
- **Merge precedence**: if a row matches multiple rules with conflicting `anonymize` values, **preserve wins** (an admin row must never end up partially anonymized because it also matched a random sample).

> **Superseded 2026-08-29 by [docs/selection-rules-v2.md](selection-rules-v2.md), which is built
> (migration 010).** The four strategies fused "which rows qualify" with "how many to take", so a
> rule that is *filtered and limited* ("users with no work email, created in the last 90 days, take
> 20") couldn't be expressed at all. v2 splits them into `where` + `take` and demotes regex to one
> operator among portable SQL ones; the four strategies survive as presets over the new model, and
> the merge precedence below is unchanged. **The type and example below describe v1** — read the v2
> doc for what ships.

Example (the 500-users-plus-admins case):
```typescript
const rules: SelectionRule[] = [
  { table: 'users', strategy: 'random', count: 500, anonymize: true },
  { table: 'users', strategy: 'pattern', column: 'email',
    pattern: '@example\\.com$', anonymize: false },
];
```

---

## 7. Cascade Through FK Graph

Row selection + anonymize flag propagates from parent to child tables
(`users` → `orders` → `payments`), preserving the same precedence rule
(preserve wins on conflict) at every level. When a child row is anonymized
because it cascaded from an anonymized parent, its **name/email-derived fields
are seeded from the parent's identity**, not its own row ID — this is what
keeps e.g. `payments.cardholder_name` consistent with `users.name` for the
same person across tables (see §8).

---

## 8. Field-Level Anonymization

Per-table, per-column strategy:

```typescript
export type FieldStrategy =
  | { kind: 'preserve' }
  | { kind: 'redact' }                              // null it out
  | { kind: 'fake'; generator: FakeGenerator }
  | { kind: 'jitter'; percent: number };             // perturb realistic amounts

export type FakeGenerator =
  | 'fullName' | 'email' | 'phone' | 'streetAddress'
  | 'creditCardNumber' | 'creditCardCVV' | 'iban' | 'companyName';
```

**Determinism & cross-table consistency:** faker is seeded from a SHA-256 hash
of a *stable identity key* (the originating entity's real PK/email), not
randomly per call and not per-row-in-isolation. This guarantees the same
person's fake name/email/address matches everywhere they appear, across
tables, on every re-run with the same source data.

```typescript
function seededFaker(seedSource: string): Faker { /* sha256(seedSource) → faker.seed() */ }
```

**Financial fields:** default recommendation is `preserve` for amounts/currency/status
unless there's a specific reason to jitter — check first whether "sensitive-looking"
columns (e.g. `card_last_four`) actually carry sensitive data at all (if PCI-compliant
via a gateway token, last-four digits alone usually don't).

---

## 9. Dump Generation

**Output = files, not a live target connection.** The target schema does not
exist ahead of time; the deliverable is a portable SQL file a dev loads into
their own local/staging DB.

**Dump dialect = source dialect, always** (v1 does not support cross-dialect
conversion — e.g. dumping a MySQL source as Postgres-loadable SQL — punted
as out of scope).

**Output mode is a per-workspace setting**, not per-run:
- **Combined**: one `.sql` file (schema + data)
- **Split**: `{name}.schema.sql` + `{name}.data.sql` — lets a team apply schema
  once and re-run just the data file repeatedly for fresh anonymized snapshots

```sql
ALTER TABLE workspaces ADD COLUMN dump_output_mode TEXT NOT NULL
  DEFAULT 'combined' CHECK (dump_output_mode IN ('combined', 'split'));
```

**Ordering & FK safety:**
- Tables written in topological (dependency) order for readability
- FK checks disabled for the duration of load (`SET FOREIGN_KEY_CHECKS=0` /
  `SET CONSTRAINTS ALL DEFERRED` / `PRAGMA foreign_keys=OFF`) — this also
  sidesteps circular-reference edge cases a perfect topo sort can't resolve alone
- In split mode, only the **data file** needs the FK-toggle header; the schema
  file is pure DDL

**Re-runnable data files:** in split mode, the data file should `TRUNCATE`/
`DELETE FROM` each table (reverse dependency order) before inserting, so devs
can re-run it against a non-empty local DB without PK conflicts.

**Streaming:** rows are pulled and written in batches (~500 rows/INSERT), never
buffered fully in memory.

---

## 10. Config Store (App-Local SQLite)

Location: `app.getPath('userData')/config.sqlite3` — separate from any
source/target database.

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  dump_output_mode TEXT NOT NULL DEFAULT 'combined'
    CHECK (dump_output_mode IN ('combined','split')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  dialect TEXT NOT NULL CHECK (dialect IN ('mysql','postgres','sqlite','mssql')),
  role TEXT NOT NULL CHECK (role IN ('source','target')),
  host TEXT, port INTEGER, database TEXT, username TEXT, file_path TEXT
  -- NOTE: no password column — see `credentials` table
);

CREATE TABLE credentials (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  encrypted_password BLOB NOT NULL   -- via Electron safeStorage
);

CREATE TABLE table_classifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('reference','transactional','excluded')),
  UNIQUE(workspace_id, table_name)
);

CREATE TABLE selection_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('random','pattern','all','explicit')),
  anonymize INTEGER NOT NULL CHECK (anonymize IN (0,1)),
  count INTEGER, column_name TEXT, pattern TEXT, explicit_values TEXT -- JSON
);

CREATE TABLE field_strategies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL, column_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preserve','redact','fake','jitter')),
  generator TEXT, jitter_percent REAL,
  UNIQUE(workspace_id, table_name, column_name)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  row_counts TEXT,       -- JSON, e.g. {"users": 500, "orders": 1240}
  output_files TEXT,     -- JSON: {"schema": path, "data": path} or {"combined": path}
  error_message TEXT
);
```

**Workspaces** = projects (e.g. "Example Shop"). Switching workspace is just a
`workspace_id` filter change — one shared SQLite file, not one file per
workspace. Simplifies backup and future "duplicate workspace as a starting
point" features.

**Migrations**: simple numbered-file runner (`_migrations` tracking table),
applied idempotently on app start.

---

## 11. Security Notes

- Source DB credentials never touch plaintext storage — use `safeStorage`
  (OS keychain: Keychain / DPAPI / libsecret) for all connection passwords.
- Config SQLite file holds structure/rules only, never secrets.
- Financial/PII field strategies default toward `fake`/`redact`; `preserve`
  should be an explicit, reviewed choice per field, not a default.
- SSH host keys must be **verified**, not blind-accepted — `ssh2` accepts any key if
  `hostVerifier` is unimplemented, which would hand the DB password to whoever answers
  on port 22. Fingerprint pinned per connection; mismatch is a hard failure. No
  "skip verification" option. See [docs/ssh-tunnel.md](ssh-tunnel.md).

---

## 12. Explicitly Out of Scope (v1)

- Writing directly to a live target DB connection (file-based dump only)
- Cross-dialect dump conversion (e.g. MySQL source → Postgres-loadable file)
- Point-and-click per-run config for non-technical users (config is workspace-defined, reusable)
- SQL Server support — **deferred to v2** as of 2026-08-20 (was already flagged as not a v1 blocker)

---

## 13. Suggested Build Order

1. Electron + Vite + Vue-TS scaffold, packaging pipeline working end-to-end (empty app, all 3 OS builds)
2. Config store: schema, migrations, workspace CRUD, connection CRUD + credential storage
3. MySQL adapter (introspection + streaming) — prove the pipeline on the dialect you'll use most
4. Table classification + exclusion UI, backed by config store
5. Selection rules (random + pattern) + merge logic + FK cascade
6. Field strategy engine (preserve/redact/fake/jitter) + seeded faker consistency
7. Dump generator: schema DDL + data DML, combined mode first, then split mode
8. Postgres adapter, then SQLite adapter
9. Run history UI (row counts, status, output file links)
10. ~~SQL Server adapter~~ — **deferred to v2 (2026-08-20)**; v1 ends at step 9.

**Post-v1, designed but unscheduled:** SSH tunnelling for source connections
([docs/ssh-tunnel.md](ssh-tunnel.md)) — arguably the highest-value thing left, since it
determines whether Masq can reach a real production at all.
