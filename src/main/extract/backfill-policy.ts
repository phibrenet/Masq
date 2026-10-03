import type { BackfillPolicyKind, FkBackfillPolicy, ForeignKeyRef, Row } from '@shared/types'
import type { TableRole } from './backfill'
import type { TableSelection } from './types'

/**
 * Per-edge backfill policy (migration 009): the two halves of "don't follow this foreign key".
 *
 * `backfillSelection` pulls in whatever a kept row points at, which is right for an *ownership*
 * reference and wrong for an *incidental* one — `submissions.user_id` says whose submission it is,
 * `submissions.welded_by_user_id` says which member of staff touched it. The FK graph cannot tell
 * them apart, so it is declared instead. Measured on a real Laravel schema: 26 FK columns point at
 * `users`, and following the incidental half turned a "20 random users" rule into a dump of 74 users.
 *
 * Marking an edge `null` means:
 *
 * 1. **backfill skips it** — no parent is pulled in (handled in `backfill.ts`), and
 * 2. **the writer nulls the column** on any row whose reference fell outside the subset (here).
 *
 * Both halves are required. Skipping alone leaves the reference dangling, which is the exact defect
 * backfill exists to prevent; nulling alone would blank references to rows that *are* in the dump.
 * A NULL references nothing, so the result is still referentially clean — it just stops growing.
 *
 * Splitting it this way is why the two live in different passes: the skip has to happen *during*
 * backfill, and the null can only be decided *after* it, once the kept set has settled and we know
 * which references really do point outside the subset.
 */

/** A validated policy set, ready for the two passes that consume it. */
export interface ResolvedPolicies {
  /** What backfill should do with one FK edge. Unlisted edges — and every morph edge — are followed. */
  policyOf: (table: string, column: string) => BackfillPolicyKind
  /** Child table → the columns the writer must null. Only edges that survived validation. */
  nullColumns: Map<string, string[]>
  /** Policies that could not be honoured, one message each. */
  warnings: string[]
}

/**
 * Validate declared policies against the live schema, dropping any that can't be honoured.
 *
 * Four ways a stored policy goes stale or was never safe, and none of them may fail the run — the
 * config store has no connection to the source, so it cannot have prevented any of them at save time:
 *
 * - **The edge no longer exists.** The column was renamed or the constraint dropped. The policy
 *   silently applies to nothing, so it is reported rather than left to look effective.
 * - **The column is NOT NULL.** Nulling it produces a dump that fails to load — a strictly worse
 *   outcome than the row growth the policy was trying to prevent — so it is downgraded to `follow`.
 *   The UI won't offer `null` here, but a column can become NOT NULL after the policy was saved.
 * - **Nullability is unknown.** Treated as NOT NULL: this decision fails closed, because guessing
 *   wrong in the other direction breaks the dump.
 * - **The foreign key targets a column that isn't the parent's primary key** — `orders.customer_email
 *   → users.email`, legal against any UNIQUE column. `buildNullEdges` tests a reference against the
 *   parent's kept **primary-key** values, so a perfectly valid email would match nothing and be
 *   nulled: silent destruction of real data, which is far worse than the growth the policy prevents.
 *   `backfillSelection` already declines to resolve non-PK foreign keys, and this cannot lean on that
 *   warning — the policy check runs *before* `pull`, so a policied edge never reaches it and nothing
 *   would be reported at all. Rejected here instead, and the edge is followed as usual.
 *
 * A policy on an excluded table is dropped without a warning: that table emits no rows, so the policy
 * is inert rather than wrong, and saying so would train the reader to ignore this list.
 *
 * @param nullableOf whether a child column accepts NULL — `undefined` when it wasn't introspected.
 * @param primaryKeyOf the parent's single-column primary key — `undefined` when it has none, is
 *   composite, or wasn't introspected. Absent fails closed, like unknown nullability.
 */
export function resolveBackfillPolicies(
  policies: FkBackfillPolicy[],
  foreignKeys: ForeignKeyRef[],
  nullableOf: (table: string, column: string) => boolean | undefined,
  isIncluded: (table: string) => boolean,
  primaryKeyOf: (table: string) => string | undefined = () => undefined
): ResolvedPolicies {
  const edgeKey = (table: string, column: string): string => `${table}.${column}`
  // Every constraint on a column, not just one: a column may legally carry more than one foreign key.
  const constraintsOf = new Map<string, ForeignKeyRef[]>()
  for (const fk of foreignKeys) {
    const key = edgeKey(fk.table, fk.column)
    const arr = constraintsOf.get(key) ?? []
    arr.push(fk)
    constraintsOf.set(key, arr)
  }

  const resolved = new Map<string, BackfillPolicyKind>()
  const nullColumns = new Map<string, string[]>()
  const warnings: string[] = []

  for (const policy of policies) {
    const label = edgeKey(policy.tableName, policy.columnName)
    if (policy.policy !== 'null') continue // `follow` is the default; storing it changes nothing
    if (!isIncluded(policy.tableName)) continue // excluded table emits no rows — inert, not wrong

    const constraints = constraintsOf.get(label) ?? []
    if (constraints.length === 0) {
      warnings.push(
        `"${label}" has a backfill policy but is not a foreign key in the source — the policy does ` +
          `nothing. Remove it, or re-check the column name.`
      )
      continue
    }
    if (nullableOf(policy.tableName, policy.columnName) !== true) {
      warnings.push(
        `"${label}" is set to null instead of backfilled, but the column is NOT NULL — nulling it ` +
          `would make the dump fail to load, so the reference is being followed as usual.`
      )
      continue
    }
    // Checked across **every** constraint on the column: one unresolvable target is enough to make
    // the emitted value untrustworthy, since the row has to satisfy all of them.
    const nonPk = constraints.find((fk) => fk.referencedColumn !== primaryKeyOf(fk.referencedTable))
    if (nonPk) {
      warnings.push(
        `"${label}" is set to null instead of backfilled, but it references ` +
          `${nonPk.referencedTable}.${nonPk.referencedColumn}, which is not that table's primary ` +
          `key — Masq can't tell which of those references are still valid, and would blank them ` +
          `all. The reference is being followed as usual.`
      )
      continue
    }

    resolved.set(label, 'null')
    const columns = nullColumns.get(policy.tableName) ?? []
    columns.push(policy.columnName)
    nullColumns.set(policy.tableName, columns)
  }

  return {
    policyOf: (table, column) => resolved.get(edgeKey(table, column)) ?? 'follow',
    nullColumns,
    warnings
  }
}

/** One column the writer nulls, plus the test for whether a given reference survives. */
export interface NullEdge {
  column: string
  /** True when this value points at a row the dump will actually contain. */
  isKept: (value: unknown) => boolean
}

/**
 * Turn the validated `null` policies into per-table writer instructions, using the **settled**
 * selection — so this must run after `backfillSelection`, not before.
 *
 * A reference is only nulled when its target really is absent. That matters for realism: a
 * `welded_by_user_id` that happens to point at one of the 20 selected users is a perfectly good row
 * of data, and blanking it would throw away truth for no integrity gain.
 *
 * Two shapes need no instruction at all and are dropped here rather than checked per row: a parent
 * dumped **whole** (a reference table) and a parent with an `all` rule (`keepAll`) both contain every
 * row the child could point at, so nothing can dangle into them.
 *
 * The kept set is keyed by `String(id)`, not by the raw value. An FK only has to be *comparable* to
 * the key it references, not identically typed — Postgres accepts an `int8` FK onto an `int4` PK and
 * node-pg then hands back a string for one and a number for the other. A `Set` compares with `===`,
 * so keying on raw values would report a perfectly good reference as absent and null it. Same trap,
 * and same fix, as `TableSelection.identities` (see `types.ts`).
 */
export function buildNullEdges(
  nullColumns: Map<string, string[]>,
  foreignKeys: ForeignKeyRef[],
  selection: Map<string, TableSelection>,
  roleOf: (table: string) => TableRole
): Map<string, NullEdge[]> {
  // **Every** constraint on a column, not just one. A column may legally carry more than one foreign
  // key — the same value referencing two different tables, which the row must satisfy in both. Keying
  // a plain `Map` on `table.column` silently kept whichever came last, so a value present in that
  // parent but missing from the other survived and dangled against the one that wasn't checked.
  const constraintsOf = new Map<string, ForeignKeyRef[]>()
  for (const fk of foreignKeys) {
    const key = `${fk.table}.${fk.column}`
    const arr = constraintsOf.get(key) ?? []
    arr.push(fk)
    constraintsOf.set(key, arr)
  }

  // One string-keyed set per parent table, shared by every edge into it.
  const keptKeys = new Map<string, Set<string>>()
  const keptKeysFor = (table: string): Set<string> => {
    let keys = keptKeys.get(table)
    if (!keys) {
      keys = new Set([...(selection.get(table)?.ids.keys() ?? [])].map(String))
      keptKeys.set(table, keys)
    }
    return keys
  }

  const result = new Map<string, NullEdge[]>()
  for (const [table, columns] of nullColumns) {
    const edges: NullEdge[] = []
    for (const column of columns) {
      const constraints = constraintsOf.get(`${table}.${column}`) ?? []
      if (constraints.length === 0) continue // validated already, but the map is the authority

      // One test per constraint that can actually fail. A value has to survive all of them, so
      // constraints that nothing can dangle into contribute no test rather than a constant `true`.
      const tests: ((value: unknown) => boolean)[] = []
      let alwaysDangles = false
      for (const fk of constraints) {
        const role = roleOf(fk.referencedTable)
        if (role === 'complete') continue // dumped whole — nothing can dangle into it
        if (role === 'omitted') {
          // The parent contributes no rows at all, so every reference into it dangles, whatever the
          // other constraints say. This is the one case the policy strictly improves on the status
          // quo: backfill can only *warn* about an excluded parent, nulling actually repairs it.
          alwaysDangles = true
          break
        }
        if (selection.get(fk.referencedTable)?.keepAll) continue // every row kept — can't dangle
        const keys = keptKeysFor(fk.referencedTable)
        tests.push((value) => keys.has(String(value)))
      }

      if (alwaysDangles) {
        edges.push({ column, isKept: () => false })
        continue
      }
      if (tests.length === 0) continue // nothing this column points at can be missing
      edges.push({
        column,
        // `every`, not `some`: the row must satisfy all its constraints, so a value that is kept in
        // one parent and absent from another is still a dangling reference and has to go.
        isKept: (value) => tests.every((test) => test(value))
      })
    }
    if (edges.length > 0) result.set(table, edges)
  }
  return result
}

/**
 * Null out the columns whose references point outside the subset, returning the row to emit.
 *
 * Copy-on-write: the row is only cloned when something actually changes, so the common case (every
 * reference kept) costs one lookup per edge and no allocation. The streamed row is never mutated in
 * place — `buildRowStream` may be handing back the driver's own object.
 *
 * A NULL value is left alone rather than "nulled": it already references nothing, and counting it
 * would inflate the reported total with rows this changed nothing about.
 */
export function applyNullEdges(
  row: Row,
  edges: NullEdge[],
  onNulled: (column: string) => void
): Row {
  let out = row
  for (const edge of edges) {
    const value = out[edge.column]
    if (value === null || value === undefined) continue
    if (edge.isKept(value)) continue
    if (out === row) out = { ...row }
    out[edge.column] = null
    onNulled(edge.column)
  }
  return out
}
