import type { BackfillPolicyKind, ForeignKeyRef } from '@shared/types'
import type { DbAdapter } from '../adapters'
import type { MorphEdge } from './morph'
import { CancelledError } from './cancel'
import { primaryKeyColumn } from './pk'
import { mergeKeep, type PkValue, type TableSelection } from './types'

/**
 * Parent backfill (spec §7, the upward half of the cascade): make every kept row's foreign keys
 * point at a row that is **also** kept. Runs *after* `cascadeSelection` and mutates the same
 * `selection` map.
 *
 * ## Why this exists
 *
 * `cascadeSelection` walks parent → child and keeps a child when **any one** of its FK parents is
 * kept. A row with two parents — a pivot table like Laravel's `team_user` is exactly this shape —
 * therefore gets pulled in via parent A while its reference to parent B dangles. Nothing catches
 * it: the dump loads with FK enforcement off and neither MySQL nor Postgres re-validates
 * afterwards, so the load exits 0 and the dev database silently holds broken references. Measured
 * on real schemas: 31 of 40 `team_user` rows, and 124 orphans across 11 FK columns on a
 * production-shaped Laravel app.
 *
 * ## Up only — never down
 *
 * Backfill adds exactly the **ancestor** rows needed for integrity. A row pulled in to satisfy a
 * dangling reference has its own parents pulled in too (or the dangle just moves up a level), but
 * its *children* are deliberately never expanded — one dangling reference would otherwise drag in
 * an unbounded subtree and defeat the point of subsetting. That is why this is a separate pass with
 * its own worklist rather than another edge kind inside `cascadeSelection`.
 *
 * ## Flag
 *
 * A row pulled in purely for integrity is flagged `anonymize = true`: it was never matched by a
 * preserve rule, so there is no reason to emit it verbatim. Merging via `mergeKeep` keeps
 * preserve-wins intact for rows that *were* already selected.
 *
 * ## Two edge kinds
 *
 * Declared **foreign keys**, and resolved **polymorphic edges** (docs/polymorphic-cascade.md) whose
 * target table came from a per-row `*_type` value. Both go through the same `pull` step, because
 * "ensure these parent ids are kept" doesn't care where the parent table's name came from — which is
 * exactly why the plan said to build the two together. A dangling *morph* reference is the more
 * dangerous of the two: no constraint exists that could ever catch it, so a dump can report zero FK
 * orphans while still being broken.
 *
 * ## Not every edge is worth following
 *
 * Following an edge is right for an *ownership* reference and wrong for an *incidental* one, and
 * nothing in the FK graph distinguishes them: `submissions.user_id` says whose submission it is,
 * `submissions.welded_by_user_id` says which member of staff touched it. Following both is why a
 * "20 random users" rule can produce a dump holding 74 users — the staff drag in populations nobody
 * selected, and each of those rows then pulls its own ancestors.
 *
 * `policyOf` is where that judgement is declared (migration 009). An edge marked `null` is skipped
 * here, and the dump writer emits NULL for the column on any row whose reference points outside the
 * subset — so the dump stays referentially clean, it just stops growing. This pass only *skips*;
 * producing the NULL is `run.ts`'s job, because it needs the settled selection.
 */

/**
 * How the dump treats a table, from backfill's point of view — derived from its classification.
 *
 * - `subset`   — transactional + included: its rows are *chosen*, so a reference into it can
 *                dangle, and backfill may add rows to it.
 * - `complete` — reference + included: dumped whole, so a reference into it can never dangle and
 *                there is nothing to add. Still a backfill *source*, because a reference table's
 *                own FKs can point at a subset table.
 * - `omitted`  — excluded (or absent from the source): contributes no rows and can receive none,
 *                so a reference into it is unrepairable and gets reported instead.
 */
export type TableRole = 'subset' | 'complete' | 'omitted'

export interface BackfillReport {
  /**
   * Parent ids added per table, purely for referential integrity. Each one is verified to exist in
   * the parent (see `getExistingIds`), so these are rows the dump really will emit.
   */
  added: Record<string, number>
  /**
   * The same additions attributed to the **edge that first pulled each row in**, keyed by the edge's
   * label (`submissions.welded_by_user_id`, `audits.user_type=App\Models\User`).
   *
   * "First" is the honest word: a parent reachable from three edges is counted once, against whichever
   * ran first, because the other two find it already kept and add nothing. So these numbers say *this
   * edge is why the row is here*, not *this many rows depend on this edge* — the second question can
   * only be answered by removing the edge and re-running. Traversal order is deterministic, so the
   * attribution is stable across runs.
   *
   * Exists because `added` alone says "users +54" and leaves you no way to find out which of the 26
   * FK columns pointing at `users` to declare a policy on.
   */
  addedByEdge: Record<string, number>
  /** Edges backfill could not repair — one message each, deduplicated per edge. */
  warnings: string[]
  /** Edges skipped by a `null` policy, by label — what the writer must NULL out downstream. */
  skipped: string[]
}

/** A unit of work: read these child rows' FK values. `ids` omitted = every row in the table. */
interface Task {
  table: string
  ids?: PkValue[]
}

/**
 * Pull in every kept row's missing FK parents, transitively upward, until nothing is missing.
 *
 * Terminates because kept sets only ever grow, are bounded by the source's row count, and a table
 * is only re-enqueued for ids that were *newly* added — so self-referential and circular FKs
 * settle on the same fixpoint as any other shape.
 *
 * @param roleOf how the dump treats a table (see `TableRole`).
 * @param morphEdgeList resolved up-direction morph edges (`morphEdgesFor(relations, 'up')`). Defaults
 *   to none, so a caller that doesn't know about morphs behaves exactly as before.
 * @param policyOf per-edge policy for a **foreign key** (migration 009). Defaults to `follow` for
 *   every edge, which is the behaviour before policies existed. Morph edges aren't consulted: a
 *   declared relation already carries its own `backfillUp` switch, and two ways to say the same thing
 *   is one too many.
 */
export async function backfillSelection(
  adapter: DbAdapter,
  selection: Map<string, TableSelection>,
  foreignKeys: ForeignKeyRef[],
  roleOf: (table: string) => TableRole,
  morphEdgeList: MorphEdge[] = [],
  policyOf: (table: string, column: string) => BackfillPolicyKind = () => 'follow'
): Promise<BackfillReport> {
  const report: BackfillReport = { added: {}, addedByEdge: {}, warnings: [], skipped: [] }
  const warned = new Set<string>()
  // An edge is reached once per queued task, so it would otherwise be reported once per batch.
  const skippedSeen = new Set<string>()
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    report.warnings.push(message)
  }

  // Index both edge kinds by the **child** table they leave from — the opposite of
  // `cascadeSelection`'s index, because this pass walks child → parent.
  const parentEdges = new Map<string, ForeignKeyRef[]>()
  for (const fk of foreignKeys) {
    const arr = parentEdges.get(fk.table) ?? []
    arr.push(fk)
    parentEdges.set(fk.table, arr)
  }

  const morphEdges = new Map<string, MorphEdge[]>()
  for (const edge of morphEdgeList) {
    const arr = morphEdges.get(edge.childTable) ?? []
    arr.push(edge)
    morphEdges.set(edge.childTable, arr)
  }

  // Tables whose PK can't address a row (composite / missing). Introspected once, then skipped.
  const unaddressable = new Set<string>()

  /** The selection entry for a table backfill may add to, or undefined if it can't be addressed. */
  async function ensureSubset(table: string): Promise<TableSelection | undefined> {
    const existing = selection.get(table)
    if (existing) return existing
    if (unaddressable.has(table)) return undefined
    try {
      const sel: TableSelection = {
        table,
        pkColumn: await primaryKeyColumn(adapter, table),
        ids: new Map(),
        identities: new Map(),
        keepAll: false
      }
      selection.set(table, sel)
      return sel
    } catch (err) {
      if (err instanceof CancelledError) throw err
      // A composite-PK parent is a known engine limitation, not a reason to fail the whole run —
      // report the unrepairable edge and carry on.
      unaddressable.add(table)
      warnOnce(`pk:${table}`, `Cannot backfill "${table}": ${(err as Error).message}`)
      return undefined
    }
  }

  // Seed from every table that emits rows and carries an outbound reference of **either** kind. The
  // morph half is load-bearing, not symmetry for its own sake: a morph-only table has no FK at all
  // (resconx's `audits` has zero constraints), so seeding from `parentEdges` alone would visit it
  // never and its morph references could not be repaired.
  const queue: Task[] = []
  for (const table of new Set([...parentEdges.keys(), ...morphEdges.keys()])) {
    const role = roleOf(table)
    if (role === 'omitted') continue
    if (role === 'complete') {
      queue.push({ table }) // dumped whole — every row's references need checking
      continue
    }
    const sel = selection.get(table)
    if (!sel) continue // transactional with nothing kept
    if (sel.keepAll) queue.push({ table })
    else if (sel.ids.size > 0) queue.push({ table, ids: [...sel.ids.keys()] })
  }

  /**
   * One edge to follow upward. `read` is a thunk so the query only runs once the cheap role/keepAll
   * checks have passed — an edge into a table that's dumped whole needs no query at all.
   */
  interface UpEdge {
    /** `child.column` (FK) or `child.type_column=value` (morph) — used in messages and warning keys. */
    label: string
    parentTable: string
    read: () => Promise<(string | number)[]>
    /** FK only: the column the edge references, validated against the parent's PK. */
    referencedColumn?: string
  }

  /**
   * Ensure every id this edge references exists in the parent, then recurse upward from whatever was
   * added. Shared by the FK and morph paths: "make sure these parent ids are kept" is the same
   * operation regardless of whether the parent table came from a constraint or from a resolved type
   * value — which is exactly what the plan predicted when it said to build the two together.
   */
  async function pull(edge: UpEdge): Promise<void> {
    const role = roleOf(edge.parentTable)
    if (role === 'complete') return // dumped whole — a reference into it can't dangle
    // Cheap pre-check, no query: an `all` rule already keeps every row of the parent.
    if (selection.get(edge.parentTable)?.keepAll) return

    // Read what these rows actually reference *before* judging the edge. An edge whose kept rows hold
    // no non-null value dangles nowhere, so it needs neither repair nor a warning — an unused optional
    // relation, or an empty reference table, must stay silent rather than claim references will dangle
    // when none exist.
    let referenced: (string | number)[]
    try {
      referenced = await edge.read()
    } catch (err) {
      if (err instanceof CancelledError) throw err
      // A child table that can't be addressed by a single id (composite PK), or a declared relation
      // naming a column that no longer exists. Report and carry on rather than failing the run.
      warnOnce(`read:${edge.label}`, `Could not read ${edge.label}: ${(err as Error).message}`)
      return
    }
    if (referenced.length === 0) return

    if (role === 'omitted') {
      warnOnce(
        `omitted:${edge.label}`,
        `${edge.label} references "${edge.parentTable}", which is excluded from the dump — those ` +
          `references will dangle. Classify "${edge.parentTable}" as transactional or reference to ` +
          `fix them.`
      )
      return
    }

    const parentSel = await ensureSubset(edge.parentTable)
    if (!parentSel) return // composite / missing PK — warned inside ensureSubset

    // Backfill addresses parent rows by PK value, so an FK onto a non-PK unique column can't be
    // resolved — the same limitation `cascadeSelection` carries, reported rather than guessed. A morph
    // edge has no `referencedColumn`: the plan takes "the id column references the target's PK" as an
    // assumption, the same one plain FKs already make here.
    if (edge.referencedColumn !== undefined && edge.referencedColumn !== parentSel.pkColumn) {
      warnOnce(
        `nonpk:${edge.label}`,
        `${edge.label} references ${edge.parentTable}.${edge.referencedColumn}, which is not that ` +
          `table's primary key (${parentSel.pkColumn}) — not backfilled.`
      )
      return
    }

    // Re-read the ids through the parent's own PK. Two reasons, and the first is a correctness
    // requirement, not an optimisation:
    //
    // 1. **Type canonicalization.** `referenced` is typed by the *child's* column, which need only be
    //    *comparable* to the parent's PK, not identical — Postgres accepts an `int8` FK onto an `int4`
    //    PK, and node-pg then hands back a string for one and a number for the other. A **morph** id
    //    column is looser still: no constraint forces it to agree with anything. Keying the selection
    //    on the child-typed value would satisfy the dump's `WHERE pk IN (…)` filter (the database
    //    coerces) while the row stream's own `ids.get(row[pkColumn])` lookup **missed** — so the row
    //    would be emitted **verbatim instead of anonymized**, with the integrity check still
    //    reporting zero orphans. Doing the comparison in SQL and taking the parent's own values back
    //    makes the keys match by construction.
    // 2. Ids with no matching parent row are dropped, so an already-broken source is reported below
    //    rather than silently counted as repaired.
    const parentIds = await adapter.getExistingIds(edge.parentTable, referenced)
    if (parentIds.length < referenced.length) {
      warnOnce(
        `source:${edge.label}`,
        `${edge.label} has ${referenced.length - parentIds.length} value(s) with no matching row in ` +
          `"${edge.parentTable}" — the source data is already broken there, so those references will ` +
          `still dangle in the dump.`
      )
    }

    const added: PkValue[] = []
    for (const id of parentIds) {
      if (parentSel.ids.has(id)) continue
      mergeKeep(parentSel.ids, id, true) // integrity-only row → anonymize it
      // No identity entry, deliberately: a row pulled *up* is its own entity, not part of the child
      // that referenced it. A user dragged in because one of their posts was kept is still their own
      // person, so their fake name must come from their own key — inheriting the child's identity
      // would make two unrelated users share a name whenever they shared a kept descendant.
      added.push(id)
    }
    if (added.length === 0) return

    report.added[edge.parentTable] = (report.added[edge.parentTable] ?? 0) + added.length
    report.addedByEdge[edge.label] = (report.addedByEdge[edge.label] ?? 0) + added.length
    // Recurse **upward only**: the rows just added need their own parents, but never their children
    // (see the "up only" note above). Their own morph parents are followed too, since the new task
    // goes through this same loop.
    queue.push({ table: edge.parentTable, ids: added })
  }

  while (queue.length > 0) {
    const { table: childTable, ids: childIds } = queue.shift()!

    for (const fk of parentEdges.get(childTable) ?? []) {
      const label = `${childTable}.${fk.column}`
      // Declared `null` policy: the user has said this reference isn't worth pulling a parent in for.
      // Skipping is the whole mechanism on this side — the writer nulls the column for rows whose
      // reference fell outside the subset, which `run.ts` sets up once the selection has settled.
      // Recorded rather than silent: an edge that stops being followed changes what's in the dump.
      if (policyOf(childTable, fk.column) === 'null') {
        if (!skippedSeen.has(label)) {
          skippedSeen.add(label)
          report.skipped.push(label)
        }
        continue
      }
      await pull({
        label,
        parentTable: fk.referencedTable,
        referencedColumn: fk.referencedColumn,
        read: () => adapter.getReferencedIds(childTable, fk.column, childIds)
      })
    }

    // Declared morph relations, resolved to a concrete target per type value. Same pass, same fixpoint
    // — a morph reference that dangles is the same defect as a dangling FK, and no constraint exists
    // to catch it, so it is strictly more important to repair here.
    for (const edge of morphEdges.get(childTable) ?? []) {
      await pull({
        label: `${childTable}.${edge.typeColumn}=${edge.typeValue}`,
        parentTable: edge.parentTable,
        read: () =>
          adapter.getReferencedIdsMorph(
            childTable,
            edge.typeColumn,
            edge.typeValue,
            edge.idColumn,
            childIds
          )
      })
    }
  }

  return report
}
