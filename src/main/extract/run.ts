import { createWriteStream } from 'fs'
import { mkdir, rename, rm } from 'fs/promises'
import { join } from 'path'
import { finished } from 'stream/promises'
import type { Writable } from 'stream'
import type {
  Connection,
  FieldStrategyRule,
  Row,
  Run,
  RunOutputFiles,
  TableIdentitySource,
  TableLocaleSource
} from '@shared/types'
import { withSourceAdapter, type DbAdapter } from '../adapters'
import { dumpDirectoryFor } from '../dump-dir'
import { listTableClassificationsByWorkspace } from '../config/repositories/table-classifications'
import { listSelectionRulesByWorkspace } from '../config/repositories/selection-rules'
import { listFieldStrategiesByWorkspace } from '../config/repositories/field-strategies'
import { listTableLocaleSourcesByWorkspace } from '../config/repositories/table-locale-sources'
import { listTableIdentitySourcesByWorkspace } from '../config/repositories/table-identity-sources'
import { listMorphRelationsByWorkspace } from '../config/repositories/morph-relations'
import { listFkBackfillPoliciesByWorkspace } from '../config/repositories/fk-backfill-policies'
import { getWorkspace } from '../config/repositories/workspaces'
import { getConnection } from '../config/repositories/connections'
import { createRun, completeRun, failRun } from '../config/repositories/runs'
import { resolveSelection } from './select'
import {
  CancelledError,
  registerRun,
  throwIfCancelled,
  unregisterRun,
  withCancellation
} from './cancel'
import { cascadeSelection } from './cascade'
import { applyFlagRules, type FlagReport } from './flag'
import { backfillSelection, type BackfillReport, type TableRole } from './backfill'
import {
  applyNullEdges,
  buildNullEdges,
  resolveBackfillPolicies,
  type NullEdge
} from './backfill-policy'
import { filterAddressableMorphEdges, findUnmappedTypeValues, morphEdgesFor } from './morph'
import { detectLinkTables, linkTableFilters, type LinkFilterReport } from './link-tables'
import { filterAddressable, primaryKeyColumn } from './pk'
import type { RowFilter } from './row-filter'
import { anonymizeRow, readPath } from './anonymize'
import { fakerFor } from './locale'
import { topologicalOrder } from './graph'
import {
  mysqlDumpDialect,
  sqliteDumpDialect,
  createPostgresDumpDialect,
  type DumpDialect
} from './dump-dialect'
import { parseSearchPath } from '../adapters/search-path'
import { writeCombinedDump, writeSplitDump, type DumpPlan, type DumpTable } from './dump-writer'
import { ownIdentity, type PkValue, type TableSelection } from './types'

/**
 * Extract orchestration (spec §3, steps 4–8): connect → introspect → resolve selection → cascade
 * → build per-table anonymized row streams → write the dump file(s) → record the run. Runs entirely
 * inside `withSourceAdapter`, so the source pool stays open for the whole stream and is torn down
 * after. A `runs` row tracks status (`running` → `completed`/`failed`).
 *
 * Anonymization identity (spec §7–§8): a row matched by a *rule* is its own entity, and a row the
 * **cascade** pulled in is seeded from the entity of the parent that pulled it — so
 * `payments.cardholder_name` matches `users.name` for the same person, across tables and across
 * re-runs. See `TableSelection.identities`.
 *
 * Known limitation of that: identity follows **every** cascade edge, because the cascade cannot tell
 * an ownership edge (`users → orders`) from an incidental one (`posts → comments`, where the
 * commenter is not the post's author). On an incidental edge the descendants of one root all share
 * that root's fake values, which is realistic for the former and wrong for the latter. Only matters
 * where a descendant carries a `fake` strategy on an identity-ish column; the fix, when it's needed,
 * is a per-table declared identity source rather than inferring it from the graph.
 */
export async function runExtract(
  connectionId: string,
  workspaceId: string,
  outputDir?: string
): Promise<Run> {
  const run = createRun(workspaceId)
  const signal = registerRun(run.id)
  // Accumulated as the pipeline goes, not returned at the end, so a run that *throws* still records
  // the warnings it had already produced — those usually describe the data shape that caused it.
  const warnings: string[] = []
  try {
    const connection = getConnection(connectionId)
    if (!connection) throw new Error('Connection not found.')
    // Every rule and strategy comes from `workspaceId`, so a connection from another workspace would
    // extract that database under configuration written for a different one.
    if (connection.workspaceId !== workspaceId) {
      throw new Error('That connection belongs to a different workspace.')
    }
    const result = await withSourceAdapter(connectionId, (adapter) =>
      // Wrapped, not threaded: every stage reaches the source through this adapter, so one proxy
      // makes the whole pipeline cancellable. See `cancel.ts`.
      executePipeline(
        withCancellation(adapter, signal),
        connection,
        workspaceId,
        outputDir,
        warnings,
        signal
      )
    )
    return completeRun(run.id, result.rowCounts, result.outputFiles, warnings) ?? run
  } catch (err) {
    // A cancel is a deliberate outcome, not a failure to report upward: record it and return the
    // run, so the renderer's `await` resolves normally and the history shows what happened. Stored
    // as `failed` because the `runs.status` CHECK has no `cancelled` — the message carries it.
    if (err instanceof CancelledError) {
      return failRun(run.id, 'Cancelled before it finished — no dump was written.', warnings) ?? run
    }
    failRun(run.id, (err as Error).message, warnings)
    throw err
  } finally {
    unregisterRun(run.id)
  }
}

interface PipelineResult {
  rowCounts: Record<string, number>
  outputFiles: RunOutputFiles
}

/**
 * The dump dialect matching a connection's source dialect (spec §9 — the dump is never converted).
 * Async and adapter-driven because the Postgres preamble needs live introspection: the target
 * schema(s) plus the extensions the DDL depends on (`getExtensions`), which `pg_dump` omits.
 */
async function buildDumpDialect(connection: Connection, adapter: DbAdapter): Promise<DumpDialect> {
  switch (connection.dialect) {
    case 'mysql':
      return mysqlDumpDialect
    case 'postgres':
      // Preamble = the schema(s) the extract read from + a CREATE EXTENSION for each installed
      // extension, so a schema using pgvector/pg_trgm/… produces a loadable dump.
      return createPostgresDumpDialect(
        parseSearchPath(connection.searchPath, connection.username),
        await adapter.getExtensions()
      )
    case 'sqlite':
      // Nothing to introspect for the dialect itself: one file, one schema, no extensions.
      return sqliteDumpDialect
    default:
      throw new Error(`No dump dialect for ${connection.dialect} yet.`)
  }
}

/**
 * Exported for the pipeline integration test, which drives it with a fake adapter. `runExtract`
 * is the production entry point and adds only run bookkeeping plus opening the real connection.
 */
export async function executePipeline(
  adapter: DbAdapter,
  connection: Connection,
  workspaceId: string,
  outputDir: string | undefined,
  /** Collector for run warnings — see `warn`. Mutated in place so a failed run keeps them. */
  warnings: string[],
  /**
   * Cancellation signal. The adapter is already wrapped to honour it, so this is only needed where
   * the pipeline loops *without* touching the adapter — the dump writer's per-row loop.
   */
  signal?: AbortSignal
): Promise<PipelineResult> {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) throw new Error('Workspace not found.')

  // ── Load config ──
  const classifications = listTableClassificationsByWorkspace(workspaceId)
  const rules = listSelectionRulesByWorkspace(workspaceId)
  const fieldStrategies = listFieldStrategiesByWorkspace(workspaceId)
  const localeSources = listTableLocaleSourcesByWorkspace(workspaceId)
  const morphRelations = listMorphRelationsByWorkspace(workspaceId)
  const identitySources = listTableIdentitySourcesByWorkspace(workspaceId)
  const backfillPolicies = listFkBackfillPoliciesByWorkspace(workspaceId)

  const classByTable = new Map(classifications.map((c) => [c.tableName, c.class]))
  const classOf = (t: string): string => classByTable.get(t) ?? 'transactional' // absence = default
  const isTransactional = (t: string): boolean => classOf(t) === 'transactional'

  // ── Introspect + scope ──
  // Dialect first — its Postgres preamble needs a live `getExtensions()` call (see buildDumpDialect).
  const dialect = await buildDumpDialect(connection, adapter)
  const allTables = await adapter.getTables()
  const foreignKeys = await adapter.getForeignKeys()
  // `structure` is included: its DDL is dumped. Only its *rows* are withheld, below.
  const included = allTables.filter((t) => classOf(t) !== 'excluded')
  const includedSet = new Set(included)
  const structureOnly = (t: string): boolean => classOf(t) === 'structure'
  const cascadeTarget = (t: string): boolean => isTransactional(t) && includedSet.has(t)
  // How backfill sees each table: subset rows are chosen (and repairable), reference tables are
  // dumped whole (nothing can dangle into them), excluded tables hold nothing either way.
  //
  // A `structure` table is `omitted` rather than `complete`, even though its DDL is in the dump:
  // `complete` asserts "every row is present, so nothing can dangle into it", and a table that
  // ships empty is the exact opposite. Calling it `complete` would leave every child row pointing
  // at a row that isn't there, with backfill believing it had nothing to repair. `omitted` is the
  // honest answer — it holds nothing — and it is what makes the FK to it get stripped or nulled
  // like any other absent parent.
  const roleOf = (t: string): TableRole =>
    !includedSet.has(t) || structureOnly(t) ? 'omitted' : isTransactional(t) ? 'subset' : 'complete'

  // ── Link tables ──
  // Tables the engine can't address by a single id but *can* still subset, by matching every
  // endpoint against the kept sets instead of keying rows (link-tables.ts). Detected here, before
  // the cascade pre-flights, so those can skip the tables this pass owns — a link table earning a
  // `can't be followed` warning per inbound edge would describe a limitation that no longer applies.
  // `allTables`, not `included`: `roleOf` skips the tables that aren't candidates anyway, and name
  // inference has to validate a guessed endpoint against every table that really exists — an
  // excluded one is a fact to resolve, not a guess to abandon.
  const links = await detectLinkTables(adapter, allTables, foreignKeys, morphRelations, roleOf)
  for (const message of links.warnings) warn(warnings, 'link', message)

  // ── Selection + cascade + backfill ──
  // Downward cascade first (kept parents pull their children), then upward backfill (kept rows pull
  // the parents they reference). Both are needed for a referentially complete subset: cascade alone
  // keeps a pivot row via one parent and leaves its other reference dangling, which no FK check
  // catches because the dump loads with enforcement off. See backfill.ts.
  //
  // Declared polymorphic relations join the downward pass as extra edges (docs/polymorphic-cascade.md).
  // Only relations with `cascadeDown` contribute, so an undeclared — or declared-but-not-ticked —
  // morph behaves exactly as it did before this existed.
  // Pre-flight the declared edges: a hand-declared relation can name a table the engine can't
  // address by single id (Spatie's `model_has_roles` is morph-shaped with a 3-column PK), and that
  // must warn rather than abort the run.
  const { edges: morphDownEdges, warnings: morphWarnings } = await filterAddressableMorphEdges(
    adapter,
    morphEdgesFor(morphRelations, 'down').filter(
      (e) => cascadeTarget(e.childTable) && !links.unaddressable.has(e.childTable)
    )
  )
  // Up edges are NOT filtered by `cascadeTarget`: their *child* may legitimately be a reference table
  // (dumped whole, so still a source of references that must resolve), and `pull` judges the target's
  // role itself. Nor are they pre-flighted on the child's PK — a whole-table read needs no PK, and
  // `pull` reports a child it can't address rather than failing the run.
  const morphUpEdges = morphEdgesFor(morphRelations, 'up')
  // Pre-flight the FK edges too, for the same reason as the morph ones: `cascadeSelection` addresses
  // rows by a single id, so a composite-PK child would throw out of `ensure()` and fail the entire
  // extract. Spatie's `model_has_roles` is exactly that shape *and* carries a real FK
  // (`role_id → roles`), so this only ever went unnoticed because nothing seeded `roles`.
  //
  // Tables `detectLinkTables` claimed are dropped before this runs: they no longer need cascading
  // into, so reporting them here would be a warning about a limitation that no longer bites. What's
  // left for this to catch is the genuinely unhandled — a table that errors on introspection, or one
  // whose classification changed since detection.
  //
  // Filtered for cascade ONLY — `foreignKeys` stays whole for `topologicalOrder` (which needs every
  // edge to order the DDL correctly) and for `backfillSelection` (whose `pull` reports a child it
  // can't read rather than failing).
  const { items: cascadeFks, warnings: fkWarnings } = await filterAddressable(
    adapter,
    foreignKeys.filter((fk) => cascadeTarget(fk.table) && !links.unaddressable.has(fk.table)),
    (fk) => ({ table: fk.table, label: `${fk.table}.${fk.column}` })
  )
  // Per-edge backfill policies (migration 009). Validated against the live schema first: the config
  // store can't know whether a column still exists or still accepts NULL, and an unhonourable policy
  // must degrade with a warning rather than fail the run or emit an unloadable dump. Nullability is
  // introspected only for the tables a policy actually names — usually a handful.
  const policyTables = new Set(backfillPolicies.map((p) => p.tableName))
  const policyColumns = new Map<string, Map<string, boolean>>()
  for (const table of policyTables) {
    if (!includedSet.has(table)) continue // never introspect a table the dump won't contain
    try {
      const columns = await adapter.getColumns(table)
      policyColumns.set(table, new Map(columns.map((c) => [c.name, c.nullable])))
    } catch (err) {
      if (err instanceof CancelledError) throw err
      // Leave it unknown — `resolveBackfillPolicies` fails closed and reports the edge.
    }
  }
  // The parent primary keys too, so a policy on a foreign key that targets some *other* unique column
  // can be rejected. Nulling is decided by testing a reference against the parent's kept PK values,
  // which for an `orders.customer_email → users.email` edge would match nothing and blank every valid
  // address. A composite or missing PK throws here and is simply left unknown, which fails closed.
  const policyEdges = new Set(backfillPolicies.map((p) => `${p.tableName}.${p.columnName}`))
  const parentPkColumns = new Map<string, string>()
  for (const fk of foreignKeys) {
    if (!policyEdges.has(`${fk.table}.${fk.column}`)) continue
    if (parentPkColumns.has(fk.referencedTable)) continue
    try {
      parentPkColumns.set(fk.referencedTable, await primaryKeyColumn(adapter, fk.referencedTable))
    } catch (err) {
      if (err instanceof CancelledError) throw err
      // Unknown — the policy is rejected with a warning rather than guessed at.
    }
  }
  const policies = resolveBackfillPolicies(
    backfillPolicies,
    foreignKeys,
    (table, column) => policyColumns.get(table)?.get(column),
    (table) => includedSet.has(table),
    (table) => parentPkColumns.get(table)
  )
  for (const message of policies.warnings) warn(warnings, 'backfill-policy', message)

  // A rule on a `structure` table can never run — the class withholds every row by definition. Say
  // so rather than dropping it silently: the rule is still sitting on the Rules screen looking
  // active, and a rule that is being ignored is exactly the thing someone needs told.
  for (const table of new Set(rules.filter((r) => structureOnly(r.table)).map((r) => r.table))) {
    warn(
      warnings,
      'selection',
      `"${table}" is classified structure-only, so its selection rule(s) were ignored and the ` +
        `table was dumped empty. Reclassify it transactional if you want rows from it.`
    )
  }

  const transactionalRules = rules.filter((r) => cascadeTarget(r.table))
  // One instant for the whole run, so `withinLast` means the same thing in every table's rules and
  // in the flag stage below — a long extract must not disagree with itself about "90 days ago".
  const now = new Date()
  const selection = await resolveSelection(adapter, transactionalRules, now)
  await cascadeSelection(adapter, selection, cascadeFks, cascadeTarget, morphDownEdges)
  const backfill = await backfillSelection(
    adapter,
    selection,
    foreignKeys,
    roleOf,
    morphUpEdges,
    policies.policyOf
  )
  reportBackfill(backfill, warnings)
  // Flag-only rules run last of the selection stages: their whole point is to act on rows cascade
  // and backfill pulled in, which don't exist until both have finished. Adds no rows (flag.ts).
  reportFlags(await applyFlagRules(adapter, selection, transactionalRules, now), warnings)
  // Second half of a `null` policy: now the kept set has settled, work out which references really do
  // point outside the subset. Anything still pointing at a kept row is left exactly as it is.
  const nullEdges = buildNullEdges(policies.nullColumns, foreignKeys, selection, roleOf)
  const nulled: Record<string, number> = {}
  // Unmapped values are checked against live data, not the config screen: the source can start
  // writing a new type value at any point after a relation was declared, and nothing revalidates.
  for (const message of fkWarnings) warn(warnings, 'cascade', message)
  reportMorphs(
    morphDownEdges.length,
    morphUpEdges.length,
    [...morphWarnings, ...(await findUnmappedTypeValues(adapter, morphRelations))],
    warnings
  )

  // ── Per-table strategy + locale lookups ──
  const strategiesByTable = new Map<string, Map<string, FieldStrategyRule>>()
  for (const fs of fieldStrategies) {
    const m = strategiesByTable.get(fs.tableName) ?? new Map<string, FieldStrategyRule>()
    m.set(fs.columnName, fs.rule)
    strategiesByTable.set(fs.tableName, m)
  }
  // Both of these are per-table "where does this value come from" hints, resolved per row below.
  const localeByTable = new Map(localeSources.map((l) => [l.tableName, l]))
  const identityByTable = new Map(identitySources.map((i) => [i.tableName, i]))

  // ── Link-table filters ──
  // Last of the selection stages, and pure: every endpoint is matched against the kept sets, which
  // aren't final until cascade, backfill and the flag rules have all run.
  const linkFilters = linkTableFilters(links.tables, selection, roleOf)
  // A link table's rows stream verbatim — it has no selection entry, so there is no per-row flag to
  // anonymize against. Every column of one is a key, so that is normally exactly right; a configured
  // strategy on one is the case where it isn't, and it must not be dropped in silence.
  for (const link of links.tables) {
    if ((strategiesByTable.get(link.table)?.size ?? 0) > 0) {
      warn(
        warnings,
        'link',
        `"${link.table}" is subset by matching its foreign keys, which can't anonymize per row — ` +
          `its field strategies are not applied. Give it a single-column primary key if its rows ` +
          `carry data that needs faking.`
      )
    }
  }
  reportLinkTables(linkFilters, warnings)

  // ── Build the ordered dump plan ──
  // An FK from an included table to a table that ISN'T in the dump makes the dump unloadable: the DDL
  // still says `… REFERENCES <absent>` and the load aborts with `relation "…" does not exist`. FK
  // enforcement being off doesn't help — this is DDL, not data. Strip those constraints, and say so:
  // the reference genuinely won't exist in the target, which the user should know.
  const absentParents = new Set(
    foreignKeys
      .filter((fk) => includedSet.has(fk.table) && !includedSet.has(fk.referencedTable))
      .map((fk) => fk.referencedTable.toLowerCase())
  )
  if (absentParents.size > 0) {
    const edges = foreignKeys
      .filter((fk) => includedSet.has(fk.table) && !includedSet.has(fk.referencedTable))
      .map((fk) => `${fk.table}.${fk.column} → ${fk.referencedTable}`)
    warn(
      warnings,
      'schema',
      `dropped ${edges.length} FK constraint(s) whose parent table isn't in the dump ` +
        `(the dump would not load otherwise): ${edges.join(', ')}`
    )
  }

  // ── Entity locale ──
  // The locale has to follow the **entity**, not the table. Identity already makes a descendant's fake
  // values come from its root entity, but `fakerFor` picks the *data set* those values are drawn from,
  // and a locale source is a per-table hint — so a person resolved as NL in `users` came out `en` in
  // `payments` and got a different name, defeating the consistency identity exists to provide.
  //
  // Keyed on the identity string, which is why this needs no change to the cascade: `identities`
  // already carries `users:42` down every edge, so one lookup per row is enough. Read from **every**
  // row of each locale-source table, not just the kept ones, because a *declared* identity source
  // (migration 008) can name an entity that isn't in the dump at all — `comments.user_id → users` for
  // a user no rule selected — and that entity still has to render in its own locale.
  //
  // Cost is one two-column read per table with a locale source (typically one), the same shape as a
  // `pattern` selection rule.
  const entityCountry = new Map<string, unknown>()
  for (const source of localeSources) {
    let pkColumn: string
    try {
      pkColumn = await primaryKeyColumn(adapter, source.tableName)
    } catch (err) {
      if (err instanceof CancelledError) throw err
      // Composite/missing PK: its rows can't be addressed by a single id, so nothing can key an
      // identity on them either. Report rather than fail — the per-row fallback below still applies.
      warn(
        warnings,
        'locale',
        `"${source.tableName}" has a country source but ${(err as Error).message} — its rows keep ` +
          `their own locale instead of their entity's.`
      )
      continue
    }
    const columns = [pkColumn, source.countryColumn]
    for (const row of await adapter.getColumnValues(source.tableName, columns)) {
      entityCountry.set(
        ownIdentity(source.tableName, row[pkColumn] as PkValue),
        countryValue(row, source)
      )
    }
  }

  const ordered = topologicalOrder(included, foreignKeys)
  const rowCounts: Record<string, number> = {}
  const dumpTables: DumpTable[] = []
  for (const table of ordered) {
    const columns = await adapter.getColumns(table)
    // Database-computed columns are dropped from the INSERT list — both dialects reject an explicit
    // value for them, and the value is recomputed on load. Rows still *stream* every column (the
    // DDL and the anonymizer see the full set); only the INSERT tuple is narrowed.
    const generated = new Set(await adapter.getGeneratedColumns(table))
    dumpTables.push({
      table,
      ddl: dialect.stripForeignKeysTo(await adapter.getCreateTableStatement(table), absentParents),
      columns: columns.map((c) => c.name).filter((name) => !generated.has(name)),
      // Postgres sequences don't self-heal after a load, so each sequence-backed column is reset
      // from MAX(column) after the data. Introspected, *not* filtered from `isPrimaryKey`: the
      // generated `setval` reads `MAX(column)`, which fails to parse for a type with no `max()`
      // overload (`uuid`). Only Postgres needs this introspection query.
      sequenceColumns: dialect.resetSequence ? await adapter.getSequenceColumns(table) : [],
      rows: buildRowStream(adapter, table, {
        reference: classOf(table) === 'reference',
        structure: structureOnly(table),
        link: linkFilters.filters.get(table),
        selection: selection.get(table),
        strategies: strategiesByTable.get(table),
        localeSource: localeByTable.get(table),
        identitySource: identityByTable.get(table),
        entityCountry,
        nullEdges: nullEdges.get(table),
        nulled,
        rowCounts,
        signal
      })
    })
  }

  // ── Write file(s) ──
  const dir = outputDir ?? dumpDirectoryFor(workspace)
  await mkdir(dir, { recursive: true })
  const base = `${sanitizeName(workspace.name)}-${timestamp()}`
  const plan: DumpPlan = {
    tables: dumpTables,
    dialect,
    dropExistingTables: workspace.dropExistingTables
  }

  // Written to `.partial` names and renamed only once the whole dump is on disk.
  //
  // The dump is streamed, so a run that stops mid-write — cancelled, or failed on row 900k of a
  // table — has already written a syntactically valid-looking prefix. Under the final name that is
  // a **loadable file that silently contains part of the data**, sitting in the dumps folder next to
  // real ones, while the run record says the run failed. Renaming last means the final name only
  // ever exists for a dump that finished.
  const targets =
    workspace.dumpOutputMode === 'split'
      ? [join(dir, `${base}.schema.sql`), join(dir, `${base}.data.sql`)]
      : [join(dir, `${base}.sql`)]
  const partials = targets.map((path) => `${path}.partial`)
  const streams = partials.map((path) => createWriteStream(path))

  try {
    if (workspace.dumpOutputMode === 'split') {
      await writeSplitDump(streams[0], streams[1], plan)
    } else {
      await writeCombinedDump(streams[0], plan)
    }
    for (const stream of streams) await endStream(stream)
  } catch (err) {
    // Tear the streams down and remove the partials. Best-effort by design: the original failure is
    // what the user needs to see, so a cleanup problem must not replace it.
    await Promise.all(
      streams.map(async (stream, i) => {
        stream.destroy()
        await rm(partials[i], { force: true }).catch(() => {})
      })
    )
    throw err
  }

  for (const [i, partial] of partials.entries()) await rename(partial, targets[i])

  const outputFiles: RunOutputFiles =
    workspace.dumpOutputMode === 'split'
      ? { schema: targets[0], data: targets[1] }
      : { combined: targets[0] }

  // After the write, not before: `nulled` is tallied as rows stream through the writer.
  reportNulled(nulled, nullEdges.size)

  return { rowCounts, outputFiles }
}

/**
 * The country value for a row, from a column or from a dot path inside that column's JSON.
 *
 * The path form exists because a column is not where every schema keeps the country: on the workspace
 * this was built for, `users.country_code` is populated on 3 of 18 rows while all 18 carry
 * `address.country`, so naming a column left 15 users on the `en` fallback with US-shaped postcodes.
 */
function countryValue(row: Row, source: TableLocaleSource | undefined): unknown {
  if (!source) return undefined
  const value = row[source.countryColumn]
  return source.countryPath ? readPath(value, source.countryPath) : value
}

/**
 * The identity a row **declares** it belongs to, or undefined to fall back.
 *
 * `${identityTable}:${value}` is built with the same `String()` coercion `ownIdentity` uses, which
 * matters: the value is read off this table's own column, whose type needn't match how the entity
 * table's PK is typed (an FK only has to be *comparable* to the key it references — node-pg returns
 * `int4` as a number and `int8` as a string). Coercing both sides to text means `42` and `'42'` land on
 * the same identity instead of quietly producing two different people.
 *
 * A NULL value returns undefined rather than an identity of `users:null`: the row genuinely doesn't
 * belong to an entity through this column, so the caller's fallback chain should decide.
 */
function declaredIdentity(row: Row, source: TableIdentitySource | undefined): string | undefined {
  if (!source) return undefined
  const value = row[source.identityColumn]
  if (value === null || value === undefined) return undefined
  return ownIdentity(source.identityTable, String(value))
}

interface RowStreamCtx {
  reference: boolean
  /** `structure` class: emit the DDL, never a row. Checked before every other decision. */
  structure: boolean
  /**
   * Endpoint-match predicate for a link table (link-tables.ts). Present = this table is subset by
   * matching its foreign keys rather than by a kept id set, so it has no `selection` entry at all.
   */
  link: RowFilter | undefined
  selection: TableSelection | undefined
  strategies: Map<string, FieldStrategyRule> | undefined
  /** Where this table's rows get their country from (column, or a path inside it). */
  localeSource: TableLocaleSource | undefined
  /** Declared owning entity for this table's rows, overriding the cascade's inference. */
  identitySource: TableIdentitySource | undefined
  /**
   * Identity string → that entity's raw country value, so a row renders in its *entity's* locale
   * rather than its own table's. Shared across tables; built once per run.
   */
  entityCountry: Map<string, unknown>
  /** FK columns to null when their reference falls outside the subset (migration 009). */
  nullEdges: NullEdge[] | undefined
  /** Tally of values nulled, keyed `table.column`. Shared across tables; reported after the run. */
  nulled: Record<string, number>
  rowCounts: Record<string, number>
  /**
   * Cancellation signal, checked per row. The adapter proxy can't cover this: `streamRows` is
   * checked once when its iterator is created and then yields for as long as the table is large,
   * which on the biggest table in a dump is most of the run.
   */
  signal?: AbortSignal
}

/**
 * The row stream for one table, consumed lazily by the dump writer. Four ways a table's rows get
 * chosen: `structure` tables emit none at all; reference tables stream verbatim; **link tables**
 * stream the rows whose endpoints are all kept (link-tables.ts); every other transactional table
 * streams its kept ids (all rows when a `keepAll` rule matched) and anonymizes each row flagged
 * `anonymize=true`. Row counts are tallied as rows are emitted.
 */
function buildRowStream(adapter: DbAdapter, table: string, ctx: RowStreamCtx): AsyncIterable<Row> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<Row> {
      const { reference, structure, link, selection, strategies, rowCounts } = ctx
      const { localeSource, identitySource, entityCountry, nullEdges, nulled } = ctx
      rowCounts[table] = 0

      // `structure`: the DDL section has already written the CREATE; this table contributes no
      // rows, unconditionally. Returning before the link/selection branches is what makes that a
      // guarantee rather than a side effect — a link filter or a cascaded selection would
      // otherwise put rows in a table the user asked to be empty.
      if (structure) return

      let where: RowFilter | undefined
      if (link) {
        where = link
      } else if (!reference) {
        // Transactional: nothing kept → emit no rows (schema still written by the DDL section).
        if (!selection || (selection.ids.size === 0 && !selection.keepAll)) return
        if (!selection.keepAll)
          where = { columns: { [selection.pkColumn]: [...selection.ids.keys()] } }
      }

      // Never for a link table: anonymizing is a per-row lookup keyed on the primary key, which is
      // the one thing a link table hasn't got. Reported by `executePipeline` rather than here, so a
      // configured-but-inapplicable strategy is said once per run instead of once per row.
      const anonymizing = !reference && !link && !!strategies && strategies.size > 0 && !!selection
      // Unique-column guard: fetched once and a shared per-column value set reused across rows,
      // so faked values on a UNIQUE column don't collide (would fail the constraint on load).
      const uniqueColumns = anonymizing ? new Set(await adapter.getUniqueColumns(table)) : undefined
      const usedValues = anonymizing ? new Map<string, Set<unknown>>() : undefined

      // A `keepAll` table streams unfiltered, so a row inserted after selection ran would arrive
      // here with no entry in `ids` — no flag, so no anonymization, so its real values in the dump.
      // Selection is the authority on what gets emitted; the missing WHERE is only a read shortcut.
      const selectedOnly = !reference && !link && !!selection?.keepAll

      for await (const row of adapter.streamRows(table, where)) {
        throwIfCancelled(ctx.signal)
        if (selectedOnly && !selection!.ids.has(row[selection!.pkColumn] as PkValue)) continue
        let out = row
        if (anonymizing && selection && strategies) {
          const pk = row[selection.pkColumn] as PkValue
          const flag = selection.ids.get(pk)
          if (flag) {
            // `identityKey` drives cross-table fake-value consistency: a row cascaded from a kept
            // parent is seeded from that parent's entity (spec §7), so `payments.cardholder_name`
            // matches `users.name` for the same person. Absent = the row is its own entity, which is
            // every rule-matched and every backfilled row — and the behaviour before identities
            // existed. `rowKey` stays per-row so jitter is still perturbed independently.
            // Precedence: a **declared** identity source wins, because it is the user stating what the
            // graph could only guess; then the identity the cascade propagated; then the row itself.
            const identityKey =
              declaredIdentity(row, identitySource) ??
              selection.identities.get(pk) ??
              ownIdentity(table, pk)
            // The entity's own country wins, so one person renders identically in every table that
            // carries their values. `has` rather than `??`: an entity with a *known* absent country
            // must stay on the default locale, not silently fall back to this table's hint and
            // diverge again — which is the exact bug this map exists to close.
            const faker = fakerFor(
              entityCountry.has(identityKey)
                ? entityCountry.get(identityKey)
                : countryValue(row, localeSource)
            )
            out = anonymizeRow(row, {
              strategies,
              identityKey,
              rowKey: ownIdentity(table, pk),
              faker,
              uniqueColumns,
              usedValues
            })
          }
        }
        // Applied last, and to **every** emitted row — preserved rows and reference-table rows
        // included. This is integrity, not anonymization: a reference that points outside the subset
        // dangles regardless of whether the row was faked, so exempting preserved rows would leave
        // exactly the broken references the policy exists to avoid. Anonymization runs first so that
        // a strategy on the column can't resurrect a value this decided to drop.
        if (nullEdges) {
          out = applyNullEdges(out, nullEdges, (column) => {
            const key = `${table}.${column}`
            nulled[key] = (nulled[key] ?? 0) + 1
          })
        }
        rowCounts[table]++
        yield out
      }
    }
  }
}

/**
 * Record a warning: to the console for whoever is watching a live run, **and** onto the run row so
 * the Runs screen shows it (migration 006). Console-only was the previous behaviour and it made these
 * invisible to anyone using the app normally — which is everyone.
 *
 * The `stage` prefix is kept in the stored text rather than held in a separate field: it is what
 * tells a reader whether "references will dangle" came from the backfill pass or the morph pass, and
 * the renderer only ever lists these strings. See migration 006 for why they aren't structured.
 *
 * Informational output (rows added, edges followed) deliberately does **not** come through here —
 * those aren't problems, and mixing them into a warnings list would train the reader to ignore it.
 */
function warn(warnings: string[], stage: string, message: string): void {
  const text = `${stage}: ${message}`
  console.warn(`[extract] ${text}`)
  warnings.push(text)
}

/**
 * Report what parent backfill did. Both halves matter to whoever reads the output: the added counts
 * explain a dump that's larger than the selection rules alone imply, and the warnings are the
 * references backfill *couldn't* repair — the only place a dump can still be referentially broken.
 */
function reportBackfill(report: BackfillReport, warnings: string[]): void {
  const added = Object.entries(report.added)
  if (added.length > 0) {
    const total = added.reduce((sum, [, n]) => sum + n, 0)
    console.log(
      `[extract] parent backfill added ${total} row(s) for referential integrity: ` +
        added.map(([table, n]) => `${table} +${n}`).join(', ')
    )
    // Per-edge attribution, largest first. "users +54" is the symptom; this is the only thing that
    // says *which* of the 26 FK columns pointing at `users` to declare a policy on, which is the
    // whole point of having policies. Ordered by size because that's the order you'd act on them in.
    const byEdge = Object.entries(report.addedByEdge).sort(([, a], [, b]) => b - a)
    for (const [label, n] of byEdge) console.log(`[extract]   ${label} +${n}`)
  }
  if (report.skipped.length > 0) {
    console.log(
      `[extract] backfill policy: not following ${report.skipped.length} edge(s) — ` +
        `${report.skipped.join(', ')}`
    )
  }
  for (const message of report.warnings) warn(warnings, 'backfill', message)
}

/**
 * Report what flag-only rules changed. Console-only for the counts, like backfill's: re-flagging is
 * what the user asked for, not a problem. A rule that changed *nothing* is warned about properly,
 * because that usually means it didn't match what its author expected.
 */
function reportFlags(report: FlagReport, warnings: string[]): void {
  const changed = Object.entries(report.changed)
  if (changed.length > 0) {
    console.log(
      `[extract] flag-only rules re-flagged ${changed.reduce((sum, [, n]) => sum + n, 0)} row(s): ` +
        changed.map(([table, n]) => `${table} ${n}`).join(', ')
    )
  }
  for (const message of report.warnings) warn(warnings, 'selection', message)
}

/**
 * Report what the `null` policies actually did. Informational, so console-only like the backfill
 * counts: nulling is what the user asked for, not a problem the run ran into.
 *
 * Worth printing even so — a count of zero means the policy changed nothing (every reference on that
 * edge pointed at a kept row anyway), which reads very differently from a policy that blanked
 * hundreds of values, and neither is visible from the row counts.
 */
function reportNulled(nulled: Record<string, number>, nullEdgeCount: number): void {
  if (nullEdgeCount === 0) return
  const entries = Object.entries(nulled).sort(([, a], [, b]) => b - a)
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  console.log(
    `[extract] backfill policy nulled ${total} reference(s) pointing outside the subset` +
      (entries.length > 0 ? `: ${entries.map(([label, n]) => `${label} ${n}`).join(', ')}` : '')
  )
}

/**
 * Report what the morph pass did and, more importantly, what it couldn't. An unmapped type value
 * looks exactly like "that entity owned no rows" in the output, so it has to be said out loud.
 */
function reportMorphs(
  downCount: number,
  upCount: number,
  messages: string[],
  warnings: string[]
): void {
  if (downCount > 0 || upCount > 0) {
    console.log(`[extract] following ${downCount} polymorphic edge(s) downward, ${upCount} upward`)
  }
  for (const message of messages) warn(warnings, 'morph', message)
}

/**
 * Report the link-table pass. The endpoint list is informational — it's the answer to "why does this
 * pivot hold these rows", which the row count alone can't give — so it goes to the console, while the
 * things that leave a reference unvouched-for go to the run's warnings. Same split as
 * `reportBackfill`: counts explain the dump, warnings are what's still wrong with it.
 */
function reportLinkTables(report: LinkFilterReport, warnings: string[]): void {
  if (report.notes.length > 0) {
    console.log(`[extract] matching ${report.notes.length} link table(s) on their endpoints:`)
    for (const note of report.notes) console.log(`[extract]   ${note}`)
  }
  for (const message of report.warnings) warn(warnings, 'link', message)
}

/** Filesystem-safe base name from a workspace name. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '') || 'dump'
}

/** Colon-free ISO timestamp for filenames. */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function endStream(stream: Writable): Promise<void> {
  stream.end()
  // `finished` rather than `once(stream, 'finish')`: the latter only ever resolves on success, so a
  // stream that *errors* while flushing (a full disk, a permission change under the dumps folder)
  // left the run waiting on an event that would never arrive — a hang with no message, which is the
  // hardest kind of failure to diagnose. This rejects with the real error instead.
  await finished(stream)
}
