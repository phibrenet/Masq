import type { MorphRelation } from '@shared/types'
import type { DbAdapter } from '../adapters'
import { filterAddressable } from './pk'
import { CancelledError } from './cancel'

/**
 * Polymorphic relations as cascade edges (docs/polymorphic-cascade.md).
 *
 * The whole design rests on one reframing: **a morph relation is a foreign key whose parent table is
 * chosen per row by a sibling column.** Once a declared relation is expanded against its type map,
 * each `(type value → target table)` pair becomes an ordinary parent→child edge that differs from an
 * FK edge only by carrying an extra `AND type_column = ?` predicate. That is why cascade needs a
 * second edge *kind* rather than a second traversal.
 */

/**
 * One resolved morph edge: rows of `childTable` whose `typeColumn` equals `typeValue` reference
 * `parentTable` by `idColumn`. Named parent/child to match the FK edges it sits alongside — the
 * direction is the direction rows get pulled.
 */
export interface MorphEdge {
  parentTable: string
  childTable: string
  typeColumn: string
  typeValue: string
  idColumn: string
}

/**
 * Expand declared relations into concrete edges for one direction.
 *
 * `direction` selects on the relation's own opt-in flag, which is the whole point of having two:
 * `down` (a kept entity pulls the rows it owns — changes the dump's size) and `up` (a kept row's
 * target must also be kept — integrity) are enabled independently per relation. A relation with the
 * flag off contributes nothing, and one with no mappings resolves to no edges.
 */
export function morphEdgesFor(relations: MorphRelation[], direction: 'down' | 'up'): MorphEdge[] {
  const edges: MorphEdge[] = []
  for (const relation of relations) {
    if (direction === 'down' ? !relation.cascadeDown : !relation.backfillUp) continue
    for (const mapping of relation.typeMap) {
      if (!mapping.typeValue || !mapping.targetTable) continue
      edges.push({
        parentTable: mapping.targetTable,
        childTable: relation.tableName,
        typeColumn: relation.typeColumn,
        typeValue: mapping.typeValue,
        idColumn: relation.idColumn
      })
    }
  }
  return edges
}

/**
 * Drop edges whose child table can't be addressed by a single-column primary key, reporting each.
 *
 * This is a pre-flight rather than a guard inside the cascade because morph relations are **declared
 * by hand**, so a user can point one at a table the engine can't subset — and unlike an FK edge, that
 * choice arrives from config rather than from the schema. Composite-PK morph tables are entirely
 * normal: Laravel/Spatie's `model_has_roles` and `model_has_permissions` are morph-shaped with a
 * three-column PK, and both get suggested by detection. Without this filter, declaring one and
 * ticking "down" would throw out of `cascadeSelection` and fail the whole extract instead of warning
 * and continuing.
 *
 * Consistent with `backfillSelection`'s stance on unrepairable edges: Masq flags, the user resolves.
 */
export async function filterAddressableMorphEdges(
  adapter: DbAdapter,
  edges: MorphEdge[]
): Promise<{ edges: MorphEdge[]; warnings: string[] }> {
  const { items, warnings } = await filterAddressable(adapter, edges, (edge) => ({
    table: edge.childTable,
    label: `${edge.childTable}.${edge.typeColumn}`
  }))
  return { edges: items, warnings }
}

/** Cap matching `morph-detect`'s: a genuine morph type column holds a handful of values. */
const MAX_TYPE_VALUES = 50

/**
 * Type values present in the data that a declared relation has no mapping for.
 *
 * The plan is explicit that an unmapped value must be **logged and skipped, never silently
 * dropped** — silence here looks identical to "that entity had no rows", which is exactly the
 * failure mode morph support exists to remove. Checked at extract time rather than trusted from the
 * config screen, because the source can start writing a new value at any point after a relation was
 * declared and nothing revalidates in between.
 *
 * Only relations that actually do something are checked; a relation with both flags off can't
 * contribute a dangling reference, so warning about it would be noise.
 */
export async function findUnmappedTypeValues(
  adapter: DbAdapter,
  relations: MorphRelation[]
): Promise<string[]> {
  const warnings: string[] = []
  for (const relation of relations) {
    if (!relation.cascadeDown && !relation.backfillUp) continue
    const mapped = new Set(relation.typeMap.map((m) => m.typeValue))
    let present: unknown[]
    try {
      present = await adapter.getDistinctValues(
        relation.tableName,
        relation.typeColumn,
        MAX_TYPE_VALUES
      )
    } catch (err) {
      if (err instanceof CancelledError) throw err
      // A declared relation naming a table or column that no longer exists shouldn't kill the run —
      // report it and carry on, same as the unrepairable edges in `backfillSelection`.
      warnings.push(
        `Could not read ${relation.tableName}.${relation.typeColumn}: ${(err as Error).message}`
      )
      continue
    }
    const missing = present.map((v) => String(v)).filter((v) => v && !mapped.has(v))
    if (missing.length > 0) {
      warnings.push(
        `${relation.tableName}.${relation.typeColumn} holds ${missing.length} unmapped type ` +
          `value(s) — those references are skipped: ${missing.join(', ')}`
      )
    }
  }
  return warnings
}
