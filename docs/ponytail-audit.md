# Ponytail audit — whole-repo over-engineering pass

_Run 2026-09-21 against `main` @ `3f80d42`. Scope: `src/**` (~11,200 TS lines + ~8,800 Vue lines).
Over-engineering only — correctness, security and performance are explicitly **out of scope** and
belong to a separate review pass. The findings below record the original proposals._

Tags: `delete:` dead code · `stdlib:` reinvented standard library · `native:` dependency doing what
the platform already does · `yagni:` abstraction with one implementation / config nobody consumes ·
`shrink:` same logic, fewer lines.

## Review outcome — 2026-09-21

Applied 4, 6–12 and 15. For 9, the run now skips sequence introspection on dialects that do not
reset sequences; the adapter methods remain available. Also corrected the stale driver list in
`CLAUDE.md`.

Declined 1–3 and 5: the proposed base class and factories would hide dialect, validation, store
update and IPC differences behind generic machinery. Declined 13: removing the target choice would
make existing target connections harder to edit. Declined 14: a two-line lookup does not justify a
dependency on the discovery store.

---

## Findings, biggest cut first

1. **`shrink:`** the three adapters' data-movement halves are the same file three times. `MySQLAdapter`
   lines 155–321 and `PostgresAdapter` lines 258–424 differ by **8 lines out of 167**, and half of
   those 8 are comments — the only real divergence is `RAND()` vs `RANDOM()`. `SQLiteAdapter` 352–511
   is the same shape again with `narrowRow`/`narrowInteger` sprinkled through it. Replacement: one
   `KnexDataMovement` base class (or a mixin) holding `getColumnValues`, `selectRows`, `countRows`,
   `getRowsReferencing(Morph)`, `getReferencedIds(Morph)`, `getExistingIds`, `getDistinctValues`,
   `sampleColumnValues`, `primaryKeyColumn`, with two hooks — `randomExpr` and a `narrow(row)` that
   defaults to identity. Introspection stays per-dialect, which is where the genuine difference lives.
   [`src/main/adapters/{mysql,postgres,sqlite}.ts`] · **~-270**

2. **`shrink:`** ten config repositories repeat the same five functions over a row-mapper: a
   `XRow` interface, a `toX(row)`, `listXByWorkspace`, `getX`, `createX`/`setX`, `updateX`, `deleteX`.
   Replacement: one `workspaceRepo({ table, columns, toDomain })` helper that generates list/get/
   delete and the insert/upsert; the three repositories with real logic (`selection-rules`' lenient
   parsing, `morph-relations`' child table, `workspaces`' path validation) keep hand-written bodies
   and use the helper for the rest.
   [`src/main/config/repositories/*.ts`] · **~-250**

3. **`shrink:`** nine Pinia stores are the same workspace-scoped collection store. `all` ref,
   `list` computed filtered on `workspace.currentWorkspaceId`, `loadingWorkspaceId`, an identical
   `loadForWorkspace`, `create`/`update`/`remove` that splice `all`, and the identical
   `watch(currentWorkspaceId, …, { immediate: true })`. Replacement: a
   `defineWorkspaceCollectionStore(name, api)` factory; `morphRelations` and `runs` compose it and
   add their extra concerns on top.
   [`src/renderer/src/stores/*.ts`] · **~-200**

4. **`delete:`** `src/renderer/src/mock/index.ts` — 193 lines of fixture data from the UI-first build
   phase. Nothing imports it (the only surviving references are the word "mock" in doc comments).
   Replacement: nothing; `src/main/config/seed.ts` already does this job against the real store.
   [`src/renderer/src/mock/index.ts`] · **-193**

5. **`shrink:`** the `config:*` IPC surface is declared three times: as `ConfigApi` (38 methods),
   as 38 pass-through `async (x) => repoFn(x)` handlers, and as 38 `ipcRenderer.invoke('config:name', x)`
   wrappers. Only `exportWorkspace` and `chooseWorkspaceImport` have a body worth reading. Replacement:
   one `const configImpl = { listWorkspaces, createWorkspace, … }` object mapping names to the repo
   functions directly (they already match arity), and a preload `config` built by iterating the
   `ConfigApi` key list through a channel-name factory. The `ConfigApi` type stays — it's the contract.
   [`src/main/ipc.ts:75-171`, `src/preload/index.ts:11-99`] · **~-120**

6. **`shrink:`** the operator and generator vocabularies are written out as string lists three times
   each. `ConditionOp` lives in `shared/types.ts` as a union, again as a `Set` in
   `repositories/selection-rules.ts:29`, and again as an array in `workspace-transfer.ts:123`.
   `FakeGenerator` lives as a union in `shared/types.ts`, as `GENERATORS` keys in `anonymize.ts:38`,
   and again as an array in `workspace-transfer.ts:142`. `NEGATIVE_OPS` exists in both
   `extract/conditions.ts:351` and `lib/conditions.ts:83`; the duration units in both
   `lib/conditions.ts:103` and `workspace-transfer.ts:182`. Replacement: export one
   `CONDITION_OPS`/`FAKE_GENERATORS`/`DURATION_UNITS` `as const` array per vocabulary from
   `@shared/types` and derive the union with `(typeof X)[number]`; every other site imports it.
   Today a new operator has to be added in five places and nothing fails if you miss one.
   [`src/shared/types.ts`, `src/main/config/workspace-transfer.ts`,
   `src/main/config/repositories/selection-rules.ts`, `src/renderer/src/lib/conditions.ts`] · **~-60**

7. **`delete:`** `src/renderer/src/components/PlaceholderView.vue` — 38 lines, zero references anywhere
   in `src`. Replacement: nothing.
   [`src/renderer/src/components/PlaceholderView.vue`] · **-38**

8. **`delete:`** `src/main/extract/index.ts` re-exports 20 names; its one importer
   (`extract-ipc.ts:3`) takes `runExtract`. Everything else already imports from the concrete module.
   Replacement: `import { runExtract } from './extract/run'` and delete the barrel.
   [`src/main/extract/index.ts`] · **-21**

9. **`yagni:`** `getSequenceColumns` runs a real introspection query on MySQL and SQLite, and both
   implementations document in their own comments that *"nothing consumes this today"* — correctly,
   because only `postgresDumpDialect` defines `resetSequence`. `run.ts:425` calls it once per table
   regardless, so every MySQL and SQLite run pays an extra query per table for a value that is
   discarded. Replacement: `return []` in both (or, better, guard the call site with
   `dialect.resetSequence ? await adapter.getSequenceColumns(table) : []`), and delete the two
   detection queries.
   [`src/main/adapters/mysql.ts:76-86`, `src/main/adapters/sqlite.ts:211-233`, `src/main/extract/run.ts:425`] · **~-25**

10. **`native:`** `electron-context-menu` is a declared runtime dependency with **zero imports** —
    `src/main/index.ts:39` hand-rolls the context menu in 20 lines against `webContents.on('context-menu')`,
    which is the right call. Replacement: drop the dependency from `package.json`.
    [`package.json`] · **-1 dep**

11. **`shrink:`** `SelectionRuleFormModal.vue` wires `resetPreview` onto fourteen separate
    `@update:value` / `@update:checked` handlers, two of them as inline multi-statement arrow
    functions in the template. Replacement: one `watch(model, resetPreview, { deep: true })` and
    delete every handler; `onColumnChange` keeps its own call for the operator fix-up.
    [`src/renderer/src/components/SelectionRuleFormModal.vue`] · **~-14**

12. **`shrink:`** `overlayPath` and `deletePath` in `anonymize.ts` carry byte-identical path-navigation
    preambles (split, filter, walk all but the last segment, refuse arrays and non-objects).
    Replacement: one `resolveParent(target, path): { node, leaf } | undefined`; both become three lines.
    Note while you're in there: the doc comment at `anonymize.ts:221-228` describes `overlayPath`
    but is stranded above `readPath`'s own doc comment — one of the two is orphaned.
    [`src/main/extract/anonymize.ts:221-305`] · **~-15**

13. **`yagni:`** a connection can be saved with `role: 'target'` — the form offers it
    (`ConnectionFormModal.vue:44`), the schema CHECKs it, the Connections list badges it — and nothing
    ever reads one. Both consumers (`stores/discovery.ts:33`, `stores/runs.ts:29`) look for
    `role === 'source'` and ignore the rest, because Masq's deliverable is a `.sql` file, not a load.
    Replacement: drop the option from the form until something loads a dump; keep the column so
    existing rows survive. **Flagging rather than recommending** — if direct-load into a target is on
    the roadmap, this is scaffolding you deliberately left, not bloat. Your call.
    [`src/renderer/src/components/ConnectionFormModal.vue:44`, `src/shared/types.ts:17`] · **~-20**

14. **`shrink:`** the `sourceConnection` computed is defined identically in `stores/discovery.ts:33`
    and `stores/runs.ts:29`. Replacement: `runs` reads `discovery.sourceConnection`.
    [`src/renderer/src/stores/runs.ts:29`] · **-2**

15. **`shrink:`** `compareValues` is a one-line exported wrapper around the private `compare` in the
    same module. Replacement: export `compare` as `compareValues` directly.
    [`src/main/extract/conditions.ts:431-433`] · **-4**

**net: ~-1,230 lines, -1 dep possible.**

---

## Explicitly *not* cut

Listed because they look like the findings above and aren't — worth recording so a later pass doesn't
re-litigate them.

- **The comment density.** 3,255 of 11,229 TS lines are comments (29%); `adapters/types.ts` is 73%,
  `dump-dialect.ts` 49%. Ponytail's usual line is "if the explanation is longer than the code, delete
  the explanation" — it does not apply here. Almost all of these record a *verified empirical fact*
  about a driver or dialect (`node-pg` shifting a `date` by a day under BST, `better-sqlite3`
  silently rounding an int64, `\restrict` breaking a portable `.sql`, `TRUNCATE` needing `CASCADE`
  even against empty children). That's the expensive knowledge in this repo; the code is the cheap
  part. Leave them. The one thing worth tightening is where a comment re-explains the *design* rather
  than a finding — `run.ts`'s stage banners already say it once, and `backfill.ts`'s five-heading
  module docblock says much of it a second time.
- **`extract/conditions.ts` holding both an SQL face and a JS face.** Two implementations of one
  operator table is normally a red flag; here they must agree or you get silent wrong-rows, and
  splitting them across the adapter boundary is precisely what would let them drift. The file says so.
- **The per-dialect introspection.** Genuinely different (no `information_schema` in SQLite, `pg_dump`
  shell-out for Postgres DDL). Only the *data-movement* half is duplicated — see finding 1.
- **`filterAddressable` / `pk.ts` existing alongside the adapters' private `primaryKeyColumn`.**
  Different callers, different failure modes (throw vs. warn-and-skip). Finding 1 collapses the three
  private copies; `pk.ts` stays.
- **`mergeKeep` / `mergeIdentity` as named functions over two-line bodies.** They encode
  preserve-wins and first-write-wins, the two invariants the whole engine rests on. Inlining them
  would be the bad kind of shorter.
- **`scratchpad/`.** Gitignored local harnesses, not part of the repo.

## Two small doc corrections spotted in passing

- `CLAUDE.md` lists `mssql` among the drivers in the tech-stack line; it isn't in `package.json`
  (correctly — SQL Server is deferred to v2). Worth rewording so the stack list matches what's
  installed.
- `src/main/extract/anonymize.ts:221-228` — orphaned doc comment, see finding 12.

## Suggested order, if you take any of it

The dead code (4, 7, 8) is risk-free and lands in one commit. The duplication collapses (1, 2, 3, 5)
are each a single-concern refactor with existing test coverage behind them —
`tests/unit/*.spec.ts` covers the extract stages and `tests/config/store.spec.ts` the repositories,
so 1 and 2 are verifiable. Finding 6 is the one with ongoing value: it turns "add an operator in five
places" into "add it in one", and the type system starts enforcing the rest.
