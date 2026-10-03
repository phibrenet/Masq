import type { ForeignKeyRef } from '@shared/types'
import type { DbAdapter } from '../adapters'
import type { MorphEdge } from './morph'
import { primaryKeyColumn } from './pk'
import { mergeIdentity, mergeKeep, ownIdentity, type PkValue, type TableSelection } from './types'

/**
 * Downward cascade (spec §7): propagate kept rows and their anonymize flag **parent → child**
 * through the foreign-key graph (`users → orders → payments`), preserve-wins at every level. Mutates
 * and returns the same `selection` map the resolver seeded.
 *
 * Two edge kinds share the traversal: declared **foreign keys**, and resolved **polymorphic edges**
 * (docs/polymorphic-cascade.md), which are FK edges whose parent table was chosen per row by a
 * sibling `*_type` column. They differ only in the query that finds matches, so they run in the same
 * worklist with the same merge — see `morphEdges`.
 *
 * Model: rules seed **root** rows; cascade fills their descendants. This pass is downward only —
 * a row kept here can still have a *dangling* FK, because a child is kept when any **one** of its
 * parents is (a pivot row pulled in via parent A leaves its reference to parent B unsatisfied).
 * Repairing that is `backfillSelection`'s job, which runs after this and walks child → parent;
 * `executePipeline` always runs the two together, so don't call this one alone and expect a
 * referentially complete subset.
 *
 * Assumes each FK references its parent's primary key (`fk.referencedColumn` = parent PK) — the
 * common case — since kept parents are addressed by PK value. FKs onto a non-PK unique column
 * aren't resolved yet.
 *
 * @param isCascadeTarget true for tables cascade may add rows to — i.e. `transactional`. Excluded
 *   tables are skipped entirely; reference tables are copied whole elsewhere, so never subset here.
 * @param morphEdgeList resolved down-direction morph edges (`morphEdgesFor(relations, 'down')`).
 *   Defaults to none, so a caller that doesn't know about morphs behaves exactly as before —
 *   undeclared morphs stay invisible, which is the plan's opt-in guarantee.
 */
export async function cascadeSelection(
  adapter: DbAdapter,
  selection: Map<string, TableSelection>,
  foreignKeys: ForeignKeyRef[],
  isCascadeTarget: (table: string) => boolean,
  morphEdgeList: MorphEdge[] = []
): Promise<Map<string, TableSelection>> {
  // Index both edge kinds by the parent table they point at, so expanding a parent finds its
  // children in one lookup each.
  const childEdges = new Map<string, ForeignKeyRef[]>()
  for (const fk of foreignKeys) {
    const arr = childEdges.get(fk.referencedTable) ?? []
    arr.push(fk)
    childEdges.set(fk.referencedTable, arr)
  }

  const morphEdges = new Map<string, MorphEdge[]>()
  for (const edge of morphEdgeList) {
    const arr = morphEdges.get(edge.parentTable) ?? []
    arr.push(edge)
    morphEdges.set(edge.parentTable, arr)
  }

  async function ensure(table: string): Promise<TableSelection> {
    let sel = selection.get(table)
    if (!sel) {
      sel = {
        table,
        pkColumn: await primaryKeyColumn(adapter, table),
        ids: new Map(),
        identities: new Map(),
        keepAll: false
      }
      selection.set(table, sel)
    }
    return sel
  }

  // Worklist of parent ids whose children still need expanding. Seed with everything selected.
  const queue: { table: string; ids: PkValue[] }[] = []
  for (const sel of selection.values()) {
    if (sel.ids.size > 0) queue.push({ table: sel.table, ids: [...sel.ids.keys()] })
  }

  while (queue.length > 0) {
    const { table: parentTable, ids: parentIds } = queue.shift()!
    const parentSel = selection.get(parentTable)
    if (!parentSel || parentIds.length === 0) continue

    // `getRowsReferencing` reports each match's parent id **as the child's FK column types it**,
    // which needn't match how the parent's PK is typed: an FK only has to be *comparable* to the key
    // it references, so an `int8` FK onto an `int4` PK is legal and node-pg then returns one as a
    // string and the other as a number. Looking that value up directly in `parentSel.ids` (keyed by
    // parent PK values) would silently miss and the child would never be cascaded. Every returned
    // value equals one of the ids we asked about, so canonical string form recovers the real key.
    const requestedByKey = new Map(parentIds.map((id) => [String(id), id]))

    /**
     * Merge matched child rows into the selection and re-enqueue whatever changed. Shared by the FK
     * and morph paths, which differ only in *how* the matches were found — once you have
     * `(childId, parentId)` pairs, keeping them is identical work.
     */
    const absorb = async (
      childTable: string,
      pairs: { childId: PkValue; parentId: PkValue }[]
    ): Promise<void> => {
      if (pairs.length === 0) return
      const childSel = await ensure(childTable)
      // Rows that were newly kept or whose flag dropped to preserve — their descendants must be
      // (re-)visited. Flags only ever move true→false, so each row re-enqueues at most once.
      const affected: PkValue[] = []
      for (const { childId, parentId } of pairs) {
        const parentKey = requestedByKey.get(String(parentId))
        if (parentKey === undefined) continue // not one of the ids we asked about
        const parentFlag = parentSel.ids.get(parentKey)
        if (parentFlag === undefined) continue // parent isn't actually kept
        const before = childSel.ids.get(childId)
        mergeKeep(childSel.ids, childId, parentFlag)
        // Carry the entity identity down with the row (spec §7). The parent's *own* identity is
        // used when it has one, so the root entity propagates the whole length of a chain
        // (`users → orders → payments` gives the payment `users:42`, not `orders:7`) rather than
        // being rewritten at each hop. A parent with no entry is its own entity.
        const inherited = parentSel.identities.get(parentKey) ?? ownIdentity(parentTable, parentKey)
        // **A row is never a different row of its own table.** A self-referential FK
        // (`users.manager_id → users`) otherwise hands a subordinate their *manager's* identity, so
        // the subordinate's own `users.email` came out as the manager's fake email while anything
        // keyed on the subordinate — a declared `comments.user_id → users`, say — used theirs. Caught
        // by the app e2e as 21 of 25 comment/author email pairs disagreeing.
        //
        // Skipping leaves no entry, which means "this row is its own entity" — the right answer for
        // every self-reference: a subordinate is still their own person, a reply is its own comment,
        // a replacement order is its own order. Matched on the identity's table prefix rather than
        // `parentTable === childTable` so a transitive cycle back into the same table is covered too;
        // a false positive would only ever mean "be your own entity", which is the safe default.
        if (!inherited.startsWith(`${childTable}:`)) {
          mergeIdentity(childSel.identities, childId, inherited)
        }
        if (before === undefined || before !== childSel.ids.get(childId)) affected.push(childId)
      }
      if (affected.length > 0) queue.push({ table: childTable, ids: affected })
    }

    for (const fk of childEdges.get(parentTable) ?? []) {
      if (!isCascadeTarget(fk.table)) continue // skip excluded / reference children
      await absorb(fk.table, await adapter.getRowsReferencing(fk.table, fk.column, parentIds))
    }

    // Morph edges are traversed in exactly the same breath as FK edges — same worklist, same
    // preserve-wins merge, same re-enqueue — because a resolved morph edge *is* an FK edge with one
    // extra predicate. A kept entity therefore pulls its owned morph rows, and those rows' own
    // children follow, with no special-casing downstream.
    for (const edge of morphEdges.get(parentTable) ?? []) {
      if (!isCascadeTarget(edge.childTable)) continue
      await absorb(
        edge.childTable,
        await adapter.getRowsReferencingMorph(
          edge.childTable,
          edge.typeColumn,
          edge.typeValue,
          edge.idColumn,
          parentIds
        )
      )
    }
  }

  return selection
}
