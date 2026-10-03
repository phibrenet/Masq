import { randomUUID } from 'crypto'
import type { MorphRelation, MorphTypeMapping } from '@shared/types'
import { getDb } from '../db'

/**
 * Declared polymorphic (morph) relations + their type→table maps (docs/polymorphic-cascade.md).
 *
 * A relation and its map are read and written as **one aggregate**: a relation with no mappings
 * resolves to no targets, so the two are never usefully edited apart, and the builder UI saves them
 * together. Saving replaces the whole map rather than diffing it — the map is small (one row per
 * distinct type value) and a wholesale replace can't leave a stale mapping behind.
 *
 * `createMorphRelation` upserts on `(workspace, table, typeColumn)`, matching the field-strategies
 * repo: the builder UI's flow is "confirm this detected candidate", which should re-declare rather
 * than fail if the relation already exists. `updateMorphRelation` edits by id.
 */

interface MorphRelationRow {
  id: string
  workspace_id: string
  table_name: string
  type_column: string
  id_column: string
  cascade_down: number
  backfill_up: number
}

interface MorphTypeMapRow {
  type_value: string
  target_table: string
}

export type MorphRelationInput = Omit<MorphRelation, 'id'>

function readTypeMap(relationId: string): MorphTypeMapping[] {
  return (
    getDb()
      .prepare(
        'SELECT type_value, target_table FROM morph_type_map WHERE morph_relation_id = ? ORDER BY type_value'
      )
      .all(relationId) as MorphTypeMapRow[]
  ).map((r) => ({ typeValue: r.type_value, targetTable: r.target_table }))
}

function toMorphRelation(row: MorphRelationRow): MorphRelation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tableName: row.table_name,
    typeColumn: row.type_column,
    idColumn: row.id_column,
    cascadeDown: row.cascade_down === 1,
    backfillUp: row.backfill_up === 1,
    typeMap: readTypeMap(row.id)
  }
}

/** Replace a relation's whole type map. Caller supplies the transaction. */
function writeTypeMap(relationId: string, typeMap: MorphTypeMapping[]): void {
  const db = getDb()
  db.prepare('DELETE FROM morph_type_map WHERE morph_relation_id = ?').run(relationId)
  const insert = db.prepare(
    'INSERT INTO morph_type_map (id, morph_relation_id, type_value, target_table) VALUES (?, ?, ?, ?)'
  )
  for (const m of typeMap) {
    // Skip blanks rather than persisting a mapping that resolves to nothing — the builder UI leaves
    // a row's target empty when the user hasn't chosen one yet.
    if (!m.typeValue || !m.targetTable) continue
    insert.run(randomUUID(), relationId, m.typeValue, m.targetTable)
  }
}

export function listMorphRelationsByWorkspace(workspaceId: string): MorphRelation[] {
  return (
    getDb()
      .prepare(
        'SELECT * FROM morph_relations WHERE workspace_id = ? ORDER BY table_name, type_column'
      )
      .all(workspaceId) as MorphRelationRow[]
  ).map(toMorphRelation)
}

export function getMorphRelation(id: string): MorphRelation | undefined {
  const row = getDb().prepare('SELECT * FROM morph_relations WHERE id = ?').get(id) as
    MorphRelationRow | undefined
  return row ? toMorphRelation(row) : undefined
}

/** Declare a relation, replacing any existing declaration for the same (workspace, table, column). */
export function createMorphRelation(input: MorphRelationInput): MorphRelation {
  const db = getDb()
  const id = db.transaction(() => {
    db.prepare(
      `INSERT INTO morph_relations
         (id, workspace_id, table_name, type_column, id_column, cascade_down, backfill_up)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, table_name, type_column) DO UPDATE SET
         id_column    = excluded.id_column,
         cascade_down = excluded.cascade_down,
         backfill_up  = excluded.backfill_up`
    ).run(
      randomUUID(),
      input.workspaceId,
      input.tableName,
      input.typeColumn,
      input.idColumn,
      input.cascadeDown ? 1 : 0,
      input.backfillUp ? 1 : 0
    )
    // Re-read the id: on conflict the generated one above was discarded and the existing row kept.
    const { id: rowId } = db
      .prepare(
        'SELECT id FROM morph_relations WHERE workspace_id = ? AND table_name = ? AND type_column = ?'
      )
      .get(input.workspaceId, input.tableName, input.typeColumn) as { id: string }
    writeTypeMap(rowId, input.typeMap)
    return rowId
  })()
  return getMorphRelation(id)!
}

export function updateMorphRelation(
  id: string,
  patch: Partial<MorphRelationInput>
): MorphRelation | undefined {
  const db = getDb()
  const existing = getMorphRelation(id)
  if (!existing) return undefined

  db.transaction(() => {
    const next = { ...existing, ...patch }
    db.prepare(
      `UPDATE morph_relations
          SET table_name = ?, type_column = ?, id_column = ?, cascade_down = ?, backfill_up = ?
        WHERE id = ?`
    ).run(
      next.tableName,
      next.typeColumn,
      next.idColumn,
      next.cascadeDown ? 1 : 0,
      next.backfillUp ? 1 : 0,
      id
    )
    // Only rewrite the map when the patch actually carries one, so a toggle-only update (the common
    // case from the list view) leaves the mappings untouched.
    if (patch.typeMap) writeTypeMap(id, patch.typeMap)
  })()

  return getMorphRelation(id)
}

/** Deleting a relation drops its mappings too (`ON DELETE CASCADE`, with `foreign_keys=ON`). */
export function deleteMorphRelation(id: string): void {
  getDb().prepare('DELETE FROM morph_relations WHERE id = ?').run(id)
}
