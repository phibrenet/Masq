# Project review — 23 September 2026

Reviewed working tree at `382bf81`, including the existing uncommitted MorphsView copy change.
Scope: main/preload/renderer boundaries, Vue state and forms, config persistence, extraction,
adapters, dump generation, dependencies, build configuration, and committed tests.

The architecture is reasonably lean and the Vue structure is conventional. The release blockers
are data safety and Electron hardening, rather than a need for architectural refactoring.
No application code was changed for this review.

P1 = fix before distributing production-derived dumps or releasing to teammates.
P2 = concrete correctness or platform issue to fix next.
“Reproduced” below means an isolated local fixture; no production database was accessed.

## Findings

### 1. P1 — New rows can bypass anonymization during an all-rows extract

**Locations:** `src/main/extract/run.ts:615`, `src/main/extract/run.ts:633`,
`src/main/extract/select.ts:60`.

An unfiltered `take: all` sets `keepAll`. Selection records the current IDs and their flags,
but the later dump stream drops the ID restriction. A row inserted between those reads is
streamed with an undefined flag; `if (flag)` skips its field strategies and emits the original
values. These reads do not share a consistent source snapshot.

**Reproduced:** selection returned ID 1; the source stream returned IDs 1 and 2. With a redact
strategy on email, the completed dump contained `(1, NULL)` and
`(2, 'inserted-during-extract@example.test')`.

**Smallest fix:** do not emit transactional rows absent from the resolved selection. Alternatively
remove the `keepAll` read optimization and use the selected IDs consistently. A consistent snapshot
would address broader concurrent-source changes, but is not necessary to close this leak.
Add this case to the existing pipeline test.

### 2. P1 — Raw predicates can escape the SELECT and execute additional SQL

**Locations:** `src/shared/raw-where.ts:2`, `src/main/extract/conditions.ts:311`,
`src/main/adapters/knex-factory.ts:92`.

The validator rejects a few prefixes and a trailing semicolon, but accepts internal statement
separators. Wrapping text in parentheses does not contain it. Imported workspaces can carry raw
predicates, and preview/extract execute them using the saved source credentials. Server connections
are not forced into read-only transactions.

**Reproduced at query generation:** an accepted predicate produced a PostgreSQL query consisting
of the intended COUNT, a separate DELETE, and another SELECT, with no bindings. No destructive SQL
was executed. Actual mutation requires credentials with write privileges; MySQL's default rejection
of multiple statements does not protect the PostgreSQL path.

**Fix:** enforce source reads at the database boundary and reject multi-statement raw input.
For the smallest safe product surface, disable the raw escape hatch until that boundary is enforced;
the structured condition builder already covers normal selection. A larger keyword blacklist is
not a reliable read-only guarantee. Cover preview and extract through the shared path.

### 3. P1 — MySQL reads lose integer and timestamp precision

**Location:** `src/main/adapters/knex-factory.ts:69`.

The MySQL connection leaves `supportBigNumbers` and `dateStrings` at their lossy defaults.
Unlike the PostgreSQL and SQLite branches, it does not preserve values before the pipeline sees them.
Rounded primary keys can merge distinct selection entries, and fractional timestamps lose precision
even on preserved rows.

**Reproduced with the installed mysql2 packet parser:** both `9007199254740992` and
`9007199254740993` decoded as `9007199254740992`; `2026-09-23 12:34:56.123456` serialized as
`2026-09-23 12:34:56.123` after its Date conversion.

**Smallest fix:** use mysql2's existing exact-number and date-string options, then exercise ID
selection/cascade and dump serialization with those driver return types. No custom parser is needed.
See [mysql2 connection options](https://sidorares.github.io/node-mysql2/docs/examples/connections/create-connection).

### 4. P1 — A dump stream error can escape error handling and abort the run process

**Locations:** `src/main/extract/dump-writer.ts:40`, `src/main/extract/run.ts:490`,
`src/main/extract/run.ts:803`.

`write()` listens for errors only while waiting for backpressure. `finished()` is attached after
all rows have been written. An asynchronous open/write error while the writer is awaiting a source
row therefore emits an unhandled `error` event. The surrounding async `try/catch` cannot catch an
EventEmitter error. Split mode also creates the data stream before the schema is finished.

**Reproduced:** a Writable reporting an asynchronous simulated ENOSPC while the row iterator
waited caused an uncaught stream error and child-process exit 1; the caller's rejection handler
did not run. In Electron this escapes the normal failed-run/partial-file cleanup path.

**Fix:** observe each stream's errors from creation through close, and propagate failure into the
writer promise. Use Node stream completion/error facilities rather than a global uncaught-exception
handler. Include a delayed-row/erroring-stream regression check.

### 5. P1 — The Electron boundary still exposes unnecessary scaffold privileges

**Locations:** `src/preload/index.ts:110`, `src/main/index.ts:28`,
`src/main/index.ts:36`, `src/main/ipc.ts:178`; the other three IPC registrars use the same pattern.

The renderer gets both the narrow application API and the unused toolkit `electronAPI`.
The installed toolkit exposes generic IPC send/invoke/listener methods and a copy of process
environment variables. No renderer code consumes it. The window explicitly disables sandboxing,
does not block navigation away from the app, and forwards every new-window URL to `openExternal`.
All IPC handlers discard the sender event.

These are confirmed boundary gaps, not a claim that an XSS exploit was found. A compromised or
unexpected renderer document would have more privilege than this application needs.

**Smallest fix:** remove the toolkit bridge and dependency; keep the explicit `window.api` wrappers;
enable sandboxing after verifying the bundled preload only requires supported modules; block
unexpected navigation; allowlist external URL schemes; validate the expected sender frame in the
IPC registration paths. Also validate main-process operation invariants: `runExtract` currently
accepts a connection from one workspace with another workspace's anonymization configuration.
See [Electron's security checklist](https://www.electronjs.org/docs/latest/tutorial/security).

### 6. P2 — MySQL output does not establish the string-escaping mode it requires

**Location:** `src/main/extract/dump-dialect.ts:176`.

The header preserves `NO_BACKSLASH_ESCAPES` if the importing session has it, while values use
mysql2/sqlstring backslash escaping. For example, `O'Reilly` is emitted as `'O\'Reilly'`, which
is not a valid representation under that mode; backslashes can also load incorrectly.

**Evidence:** reproduced the emitted literal and inspected the generated session settings.
An actual MySQL restore under this mode was not run. The underlying serializer explicitly requires
the mode to be disabled: [sqlstring documentation](https://github.com/mysqljs/sqlstring).

**Smallest fix:** temporarily remove that specific mode for the import and restore the original
mode afterward, retaining the intended ANSI_QUOTES behavior. Test apostrophes and backslashes under
both settings. Do not revert to overwriting unrelated user modes.

### 7. P2 — Vue forms accept stale async results

**Locations:** `src/renderer/src/components/SelectionRuleFormModal.vue:198` and `:347`,
`FieldStrategyFormModal.vue:269` and `:315`, `MorphRelationFormModal.vue:126`.

Select table A and then B while A's request is slow: A can resolve last and replace B's column
options. JSON-path discovery has the same problem. For rule previews, editing the form clears the
preview, but an older request subsequently restores a count for the previous rule beneath the
current inputs. The reset does not invalidate the in-flight request.

**Smallest fix:** use watcher cleanup or a request-generation token; guard result, error, and loading
updates together. Invalidate previews on input changes and modal closure. IPC requests need not be
physically cancelled to ignore stale responses. Avoid a generic async framework.
See [Vue watcher side-effect cleanup](https://vuejs.org/guide/essentials/watchers.html#side-effect-cleanup).

### 8. P2 — Schema caches outlive the database they describe

**Locations:** `src/renderer/src/stores/discovery.ts:22` and `:67`,
`src/renderer/src/views/FieldsView.vue:57`; related caches exist in morphRelations/backfillPolicies.

Discovery keys columns by workspace and table, not the source connection/configuration. Editing a
source's host/database/search path or replacing that connection leaves the old columns cached.
The force argument has no current callers and Discover refreshes only table names.
FieldsView adds a second cache keyed solely by table name, which also survives a workspace switch
while the view remains mounted.

**Reproduced with the real Pinia stores:** load `users` from database A, update the connection to
database B, load `users` again. A's columns were returned and the source API had been called only once.

**Smallest fix:** invalidate source-derived caches when the effective source configuration changes;
clear or remove the view-local cache on workspace change. Guard late responses from refilling an
invalidated cache. Reuse the discovery store rather than maintaining two authorities for columns.

### 9. P2 — List conditions change the values the user entered

**Location:** `src/renderer/src/components/SelectionRuleFormModal.vue:278`.

`parsedList` converts every numeric-looking item through `Number`, regardless of the selected
column's type. A text identifier `00123` becomes `123`, and `9007199254740993` becomes
`9007199254740992`. This changes which rows are included or preserved before the backend sees
the intended value.

**Smallest fix:** retain list input as strings, as scalar input already does, or convert only when
the column is numeric and conversion is lossless. Add a check for leading-zero text and an int64 ID.

### 10. P2 — Startup assumes exclusive ownership without acquiring it

**Locations:** `src/main/index.ts:85`, `src/main/config/repositories/runs.ts:129`.

Every launch marks every `running` record interrupted, justified by the comment that one process
owns the store. There is no single-instance lock. Starting a second process while the first is
extracting marks the first process's live run failed; the second process cannot cancel that run
because controllers exist only in the first process.

**Smallest fix:** acquire Electron's single-instance lock before migrations/recovery, and focus the
existing window on a second launch. No distributed run ownership scheme is needed.
See [Electron requestSingleInstanceLock](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata).

### 11. P2 — Config-load failures are presented as empty or stale data

**Locations:** `src/renderer/src/App.vue:27`,
`src/renderer/src/stores/selectionRules.ts:57`, and sibling workspace-scoped store watchers.

Watchers launch `void loadForWorkspace(id)` without a rejection handler or exposed error state.
A failed IPC read produces an unhandled rejection while the screen continues to show an empty list
or cached rules. The startup workspace load has the same problem. A user cannot distinguish
“there are no rules” from “the rules failed to load.” Overlapping loads also unconditionally clear
the shared loading marker when an older request finishes.

**Smallest fix:** expose and render load failures with a retry; clear loading only for the request
that owns it. Handle these failures where they occur rather than adding a global promise-error
framework or replacing the explicit stores with a factory.

## Conditional platform finding

**Linux credentials:** `src/main/config/credentials.ts:11` checks only
`safeStorage.isEncryptionAvailable()`. Linux's `basic_text` backend does not provide OS-secret-store
protection. Reject that backend if Linux remains supported; macOS/Windows are the currently planned
release targets, so this is not a blocker for that narrower release. Verified against the installed
Electron API declarations and [safeStorage's platform guarantees](https://www.electronjs.org/docs/latest/api/safe-storage).
No Linux runtime test was performed.

## YAGNI cuts worth making

- **delete:** Remove the unused generic Electron bridge, isolation-disabled fallback, Window type and `@electron-toolkit/preload` dependency; the existing application bridge replaces them. `src/preload/index.ts:2`.
- **delete:** Replace unused MySQL/SQLite sequence introspection bodies with `return []`; the pipeline already calls them only for a dialect with sequence resets. Keep the shared adapter contract. `src/main/adapters/mysql.ts:76`, `src/main/adapters/sqlite.ts:211`.
- **delete:** Remove unused `deletePassword`, `connections.byId`, `workspace.loaded`, `discovery.cachedColumns`, and `tableClassifications.classifiedNames`; repository deletion already cascades credentials. Their definitions/exports are their only source references.
- **yagni:** Stop offering SQL Server for new connections while every connection attempt rejects it. Retain stored dialect compatibility for existing configurations. `src/renderer/src/components/ConnectionFormModal.vue:40`.
- **delete:** Remove template camera/microphone descriptions and placeholder update publishing configuration before release. Neither represents implemented app behavior. `electron-builder.yml:27`.

Estimated net: roughly **75–100 source/config lines and one direct dependency** removable, excluding
lockfile changes. This is a proposal, not an applied or measured patch.

## Practices already worth keeping

- Vue uses `<script setup lang="ts">`, `defineProps`, `defineModel`, computed derived state, and
  Pinia setup stores. Route components load lazily; hash routing supports the current file-based app.
- Database access, filesystem work, and credential decryption remain in main. The application IPC
  wrappers are explicit and typed, and the renderer does not receive decrypted stored passwords.
- Config SQL uses bound values; migrations and workspace imports use transactions. Credentials are
  separate from shareable workspace configuration. SQLite sources open read-only.
- The adapter interface has three implementations and captures actual dialect differences.
  Explicit repositories/stores are easier to audit than a generic CRUD or store factory here.
- Native dialogs, clipboard, menus, AbortController, and streams already replace many dependencies.
- Keep the comments documenting verified dialect behavior. Their length is not itself bloat.

Do not split components merely to hit a line-count target, introduce base adapter classes, replace
Pinia/Naive UI, add a query-cache library, or move the engine to workers without a measured need.
Correctness fixes above need no architectural rewrite.

## Validation and limits

- `npm run typecheck`: passed.
- `npm exec eslint -- .`: no errors; three Prettier warnings in the pre-existing MorphsView edit.
- `npm test`: **246 tests passed across 18 files**. Config/pipeline tests were also run separately.
- `npm run build`: passed for main, preload, and renderer.
- Temporary local reproductions confirmed findings 1, 3, 4 and 8. Finding 2 was reproduced through
  validation and SQL generation only; finding 6 through serialization and documented mode semantics.
- The committed suite covers engine/config behavior, but contains no renderer component tests or
  real Electron IPC/security tests. The pipeline fixture uses a fake MySQL adapter, not a live server.
- This was not a packaged-GUI, signing, Windows/Linux, live MySQL/PostgreSQL restore, or dependency
  vulnerability audit. Electron's macOS task-name diagnostic appeared during tests but did not fail them.

Existing limitations remain relevant: PostgreSQL cyclic FKs cannot be restored by the current
per-table DDL ordering; table-only `pg_dump` output does not supply all custom-type dependencies;
obfuscation can collide on UNIQUE columns; non-PK FK targets are not generally supported. These need
explicit restore fixtures or clearly bounded support, not additional speculative abstractions.

Recommended order: close the raw-data and source-write paths; fix exact value handling and stream
errors; harden Electron; then repair Vue invalidation/caches and make the small deletions above.
