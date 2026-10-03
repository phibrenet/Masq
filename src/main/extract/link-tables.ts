import type { ForeignKeyRef, MorphRelation } from '@shared/types'
import type { DbAdapter } from '../adapters'
import { guessTargetTable } from '../adapters/morph-detect'
import { CancelledError } from './cancel'
import type { TableRole } from './backfill'
import type { MorphAlternative, MorphFilter, RowFilter } from './row-filter'
import type { TableSelection } from './types'

/**
 * Link tables: subsetting a table the engine can't address by a single id.
 *
 * ## The problem
 *
 * Selection, cascade and backfill all key rows on one primary-key value (`PkValue`), so a table with
 * a composite — or absent — primary key can't take part: `filterAddressable` drops its edges with a
 * warning, no selection entry is ever created for it, and the dump writer emits **zero rows** for it.
 * That's the right failure for a table holding data, and the wrong one for the tables it actually
 * hits, which are almost always pivots: `label_card_lookups (label_id, card_lookup_id)`, Spatie's
 * `model_has_roles (role_id, model_type, model_id)`. Shipping those empty means every user in the
 * dump has no roles and every label has no cards.
 *
 * ## Why they don't need addressing
 *
 * A single-column PK is needed for three things: merging a row's anonymize flag during cascade,
 * re-enqueueing the row so its *own* children get followed, and looking the row up per-row in the
 * writer to anonymize it. A link table needs none of them — nothing references it, so cascade never
 * traverses out of it, and every column is a key, so there is nothing to fake.
 *
 * Which leaves one question with an exact answer that needs no row identity at all:
 *
 * > **Keep every row whose endpoints are all already kept.**
 *
 * `WHERE label_id IN (kept labels) AND card_lookup_id IN (kept card_lookups)` — a `RowFilter`, which
 * `streamRows` already applies. No selection entry, no id set, no new key type.
 *
 * ## It is also better than cascading would be
 *
 * Even for a pivot the engine *can* address, cascade keeps a row when **any one** parent is kept and
 * backfill then drags the other parent in — the population inflation `.memory/state.md` opens with.
 * Endpoint match adds nothing to any other table and is referentially complete by construction, so
 * it's the answer this shape wanted rather than a workaround for a missing feature.
 *
 * ## Two passes
 *
 * Detection is schema-only and runs early (`detectLinkTables`), because run.ts must know which tables
 * are handled here before it pre-flights the cascade edges — otherwise every link table earns a
 * `can't be followed` warning for a limitation that no longer applies. Building the filters
 * (`linkTableFilters`) is pure and runs last, once the kept sets have settled.
 */

/**
 * An endpoint the schema doesn't declare, inferred from the key column's name (`inferEndpoints`).
 * Treated exactly like a foreign key once resolved — the only difference is where it came from, and
 * that difference is reported rather than buried.
 */
export interface InferredEndpoint {
  column: string
  targetTable: string
}

/** A table this pass will subset by endpoint match, with the edges that define its endpoints. */
export interface LinkTable {
  table: string
  /** Ordinary foreign keys out of the table. */
  foreignKeys: ForeignKeyRef[]
  /** Declared polymorphic relations on the table (docs/polymorphic-cascade.md). */
  morphRelations: MorphRelation[]
  /** Key columns whose target came from their name because no constraint declares one. */
  inferred: InferredEndpoint[]
  /** Its primary-key columns, or empty for a table with no primary key at all. */
  pkColumns: string[]
}

export interface LinkDetection {
  tables: LinkTable[]
  /**
   * Every subset table without a single-column primary key, link or not. run.ts excludes these from
   * the cascade pre-flights so this module is the single voice on the limitation — one clear message
   * per table instead of one per inbound edge.
   */
  unaddressable: Set<string>
  warnings: string[]
}

/**
 * Find the tables that can be subset by endpoint match.
 *
 * A candidate is a subset table (transactional + included) with no single-column primary key. It
 * qualifies when **nothing references it** — a table that is referenced has to be addressable, since
 * a child's FK value has to be matched against a kept parent row — and when it has at least one
 * endpoint to match on.
 *
 * Tables that don't qualify are reported here and stay empty, as before.
 */
export async function detectLinkTables(
  adapter: DbAdapter,
  tables: string[],
  foreignKeys: ForeignKeyRef[],
  morphRelations: MorphRelation[],
  roleOf: (table: string) => TableRole
): Promise<LinkDetection> {
  // Compared case-insensitively: a false negative here would treat a genuinely referenced table as a
  // leaf and subset it by endpoint, so this is the one place worth being lenient about name casing.
  const referenced = new Set<string>()
  for (const fk of foreignKeys) referenced.add(fk.referencedTable.toLowerCase())
  for (const relation of morphRelations) {
    for (const mapping of relation.typeMap) {
      if (mapping.targetTable) referenced.add(mapping.targetTable.toLowerCase())
    }
  }

  const fksByTable = new Map<string, ForeignKeyRef[]>()
  for (const fk of foreignKeys) {
    const arr = fksByTable.get(fk.table) ?? []
    arr.push(fk)
    fksByTable.set(fk.table, arr)
  }

  const morphsByTable = new Map<string, MorphRelation[]>()
  for (const relation of morphRelations) {
    const arr = morphsByTable.get(relation.tableName) ?? []
    arr.push(relation)
    morphsByTable.set(relation.tableName, arr)
  }

  // Every table in the source, not just the included ones: an inferred name has to be validated
  // against what really exists, and a target that turns out to be *excluded* is a fact worth
  // resolving (the filter then empties the pivot, with its own warning) rather than a failed guess.
  const tableSet = new Set(tables)
  const detection: LinkDetection = { tables: [], unaddressable: new Set(), warnings: [] }

  for (const table of tables) {
    if (roleOf(table) !== 'subset') continue // reference tables are dumped whole; excluded hold nothing
    let pkColumns: string[]
    try {
      pkColumns = (await adapter.getColumns(table)).filter((c) => c.isPrimaryKey).map((c) => c.name)
    } catch (err) {
      if (err instanceof CancelledError) throw err
      continue // can't introspect it — the dump loop reports that far more usefully than this can
    }
    if (pkColumns.length === 1) continue // ordinary: selection/cascade address it by id

    detection.unaddressable.add(table)
    const key =
      pkColumns.length === 0 ? 'no primary key' : `composite primary key (${pkColumns.join(', ')})`

    if (referenced.has(table.toLowerCase())) {
      detection.warnings.push(
        `"${table}" has a ${key} and is referenced by another table, so its rows can't be matched ` +
          `to a kept parent — it will be dumped empty. Give it a single-column key, or classify it ` +
          `as reference to dump it whole.`
      )
      continue
    }

    const tableFks = fksByTable.get(table) ?? []
    const tableMorphs = morphsByTable.get(table) ?? []
    // Key columns no constraint speaks for. A pivot created with plain `unsignedBigInteger` columns
    // — Laravel's `grading_report_user (grading_report_id, user_id)` with no `->constrained()` — has
    // nothing in the schema to match on, but its column names say exactly what it joins.
    const inferred = inferEndpoints(table, pkColumns, tableFks, tableMorphs, tableSet)

    if (tableFks.length === 0 && tableMorphs.length === 0 && inferred.length === 0) {
      detection.warnings.push(
        `"${table}" has a ${key} and no foreign keys, so there is nothing to match its rows ` +
          `against — it will be dumped empty. Classify it as reference to dump it whole.`
      )
      continue
    }

    if (inferred.length > 0) {
      // Said every run, deliberately. This is the one endpoint the database itself doesn't vouch
      // for, so the assumption has to stay visible until a real constraint replaces it.
      detection.warnings.push(
        `"${table}" has no foreign key on ${inferred.map((e) => e.column).join(', ')}, so ` +
          `${inferred.length === 1 ? 'its target was' : 'their targets were'} inferred from the ` +
          `column name${inferred.length === 1 ? '' : 's'}: ` +
          `${inferred.map((e) => `${e.column} → ${e.targetTable}`).join(', ')}. Check that's right — ` +
          `adding the foreign key to the source would make it certain.`
      )
    }

    detection.tables.push({
      table,
      foreignKeys: tableFks,
      morphRelations: tableMorphs,
      inferred,
      pkColumns
    })
  }

  return detection
}

/** Suffix that marks a key column as a reference. Laravel's convention, and the only one used. */
const ID_SUFFIX = '_id'

/**
 * Guess what a link table's unconstrained key columns point at, from their names.
 *
 * A pivot written with plain `unsignedBigInteger` columns declares no relation at all, so endpoint
 * matching has nothing to work with and the table dumps empty — which is what
 * `grading_report_user (grading_report_id, user_id)` did. The names, though, are unambiguous, and
 * they're the same convention `detectMorphCandidates` already guesses a morph target from. This
 * reuses that guesser, so the two agree by construction: strip `_id`, snake-case, pluralise, and
 * **accept only a name that matches a real table**.
 *
 * Restricted to **primary-key columns**, which for a link table are exactly the endpoints — a
 * `*_id` column outside the key is payload, and inferring a relation for it would narrow the pivot
 * on something that isn't part of what the row joins.
 *
 * Safe to apply without asking, for two reasons that don't hold elsewhere in the engine: a wrong
 * guess can only ever *narrow* what's kept (it can't produce a dangling reference or leak a row),
 * and validating against the live table list means an unrecognised name yields nothing rather than a
 * plausible-looking table that doesn't exist. It is still reported every run — see the caller.
 */
export function inferEndpoints(
  table: string,
  pkColumns: string[],
  foreignKeys: ForeignKeyRef[],
  morphRelations: MorphRelation[],
  tableSet: Set<string>
): InferredEndpoint[] {
  const spokenFor = new Set(foreignKeys.map((fk) => fk.column))
  for (const relation of morphRelations) {
    spokenFor.add(relation.typeColumn)
    spokenFor.add(relation.idColumn)
  }

  const inferred: InferredEndpoint[] = []
  for (const column of pkColumns) {
    if (spokenFor.has(column)) continue
    if (!column.endsWith(ID_SUFFIX)) continue
    const base = column.slice(0, -ID_SUFFIX.length)
    if (!base) continue
    const targetTable = guessTargetTable(base, tableSet)
    // A self-reference would restrict the pivot against its own kept set, which it hasn't got.
    if (!targetTable || targetTable === table) continue
    inferred.push({ column, targetTable })
  }
  return inferred
}

export interface LinkFilterReport {
  /** Table → the predicate its rows are streamed under. */
  filters: Map<string, RowFilter>
  /** `table: col → parent, …` per link table, for the run log. */
  notes: string[]
  warnings: string[]
}

/**
 * Turn detected link tables into row filters, against the settled selection.
 *
 * Pure: every question it asks — is this parent dumped whole, which of its rows are kept — is
 * answered by `selection` and `roleOf`, so this runs after cascade, backfill and the flag rules with
 * no further database access.
 */
export function linkTableFilters(
  links: LinkTable[],
  selection: Map<string, TableSelection>,
  roleOf: (table: string) => TableRole
): LinkFilterReport {
  const report: LinkFilterReport = { filters: new Map(), notes: [], warnings: [] }

  /**
   * The ids a reference into `parent` may take: `undefined` for no restriction (the parent is in the
   * dump in its entirety, so any value it holds is present), otherwise the exact kept set — which is
   * empty when nothing was kept, and an empty allowed set correctly keeps no link rows.
   */
  const allowedIds = (parent: string): unknown[] | undefined => {
    if (roleOf(parent) === 'complete') return undefined // reference table, dumped whole
    const sel = selection.get(parent)
    if (sel?.keepAll) return undefined
    return sel ? [...sel.ids.keys()] : []
  }

  for (const link of links) {
    const columns: Record<string, unknown[]> = {}
    const morphs: MorphFilter[] = []
    const covered = new Set<string>()
    const matched: string[] = []

    /**
     * Restrict one plain endpoint to its target's kept rows. Shared by declared foreign keys and
     * inferred ones — once you know which table a column points at, it makes no difference whether a
     * constraint said so or the column's name did. `arrow` is the only thing that differs, marking
     * an inference in the log so the two are never confused when reading a run.
     */
    const restrict = (column: string, target: string, arrow: string): void => {
      covered.add(column)
      // An endpoint the dump doesn't contain can't be matched against anything, and a link to an
      // absent row is meaningless — so the table empties rather than shipping rows that reference
      // nothing. Said out loud, because emptying a table on the strength of one classification is
      // exactly the kind of thing that should never be silent.
      if (roleOf(target) === 'omitted') {
        report.warnings.push(
          `"${link.table}" will be empty: its ${column} endpoint references "${target}", which is ` +
            `excluded from the dump.`
        )
        columns[column] = []
        matched.push(`${column} ${arrow} ∅`)
        return
      }
      const allowed = allowedIds(target)
      if (allowed === undefined) return // parent dumped whole — nothing to restrict
      columns[column] = allowed
      matched.push(`${column} ${arrow} ${target}`)
    }

    for (const fk of link.foreignKeys) restrict(fk.column, fk.referencedTable, '→')
    // `→?` rather than `→`: the schema doesn't declare this one, so a run's log says which endpoints
    // rest on a guess without having to cross-reference the warning.
    for (const endpoint of link.inferred) restrict(endpoint.column, endpoint.targetTable, '→?')

    for (const relation of link.morphRelations) {
      covered.add(relation.typeColumn)
      covered.add(relation.idColumn)
      // The declared type map is read whatever the relation's `cascadeDown`/`backfillUp` flags say.
      // Those govern *traversal* — whether a kept entity pulls rows in, whether a kept row pulls its
      // target up — and neither is happening here. All this needs is the map's other job: saying
      // which table a type value names, without which the pair can't be restricted at all.
      const alternatives: MorphAlternative[] = []
      for (const mapping of relation.typeMap) {
        if (!mapping.typeValue || !mapping.targetTable) continue
        if (roleOf(mapping.targetTable) === 'omitted') continue // target absent → drop those rows
        const allowed = allowedIds(mapping.targetTable)
        alternatives.push(
          allowed === undefined
            ? { typeValue: mapping.typeValue }
            : { typeValue: mapping.typeValue, ids: allowed }
        )
      }
      if (alternatives.length === 0) {
        // A relation declared but not yet mapped. Leaving the pair unrestricted keeps the rows that
        // the table's other endpoints already vouch for, which is a better answer than emptying the
        // table over a half-finished piece of configuration.
        report.warnings.push(
          `"${link.table}".${relation.typeColumn} has no usable type mappings, so its rows aren't ` +
            `matched on that endpoint — some may reference rows outside the dump.`
        )
        continue
      }
      morphs.push({
        typeColumn: relation.typeColumn,
        idColumn: relation.idColumn,
        alternatives
      })
      matched.push(`${relation.typeColumn}/${relation.idColumn} → ${alternatives.length} type(s)`)
    }

    // Key columns nothing vouches for. Almost always an undeclared polymorphic pair — Spatie's
    // `model_has_roles` reaches here with `model_type, model_id` uncovered until the relation is
    // declared — so the message names the fix rather than just the symptom.
    const uncovered = link.pkColumns.filter((c) => !covered.has(c))
    if (uncovered.length > 0) {
      report.warnings.push(
        `"${link.table}": ${uncovered.join(', ')} ${uncovered.length === 1 ? 'is' : 'are'} not ` +
          `covered by a foreign key or a declared polymorphic relation, so rows are kept for every ` +
          `value there — some may reference rows outside the dump. Declaring the relation on the ` +
          `Morphs screen restricts them.`
      )
    }

    report.filters.set(link.table, { columns, morphs })
    report.notes.push(
      `${link.table}: ${matched.length > 0 ? matched.join(', ') : 'no restriction'}`
    )
  }

  return report
}
