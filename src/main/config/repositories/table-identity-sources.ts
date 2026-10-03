import { randomUUID } from 'crypto'
import type { TableIdentitySource } from '@shared/types'
import { getDb } from '../db'

/**
 * Declared identity sources (migration 008): one per (workspace, table), naming the column that holds
 * the owning entity's id and the table that entity lives in. Overrides the identity the cascade would
 * have propagated, which follows the FK graph and so can't tell an ownership edge from an incidental
 * one — see the migration for the full reasoning.
 *
 * `setTableIdentitySource` upserts on the unique constraint, so re-pointing a table replaces rather
 * than errors; clearing it is a delete. Mirrors `table-locale-sources` deliberately — same shape of
 * per-table hint, so the two read the same way.
 */

interface TableIdentitySourceRow {
  id: string
  workspace_id: string
  table_name: string
  identity_column: string
  identity_table: string
}

function toTableIdentitySource(row: TableIdentitySourceRow): TableIdentitySource {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tableName: row.table_name,
    identityColumn: row.identity_column,
    identityTable: row.identity_table
  }
}

export type TableIdentitySourceInput = Omit<TableIdentitySource, 'id'>

export function listTableIdentitySourcesByWorkspace(workspaceId: string): TableIdentitySource[] {
  return (
    getDb()
      .prepare('SELECT * FROM table_identity_sources WHERE workspace_id = ? ORDER BY table_name')
      .all(workspaceId) as TableIdentitySourceRow[]
  ).map(toTableIdentitySource)
}

export function setTableIdentitySource(input: TableIdentitySourceInput): TableIdentitySource {
  const column = input.identityColumn.trim()
  const table = input.identityTable.trim()
  // Both halves are required to resolve an identity (`users` + `42` → `users:42`), so a half-declared
  // source is rejected here rather than silently ignored at dump time.
  if (!column || !table) {
    throw new Error('An identity source needs both a column and the table the entity lives in.')
  }
  getDb()
    .prepare(
      `INSERT INTO table_identity_sources
         (id, workspace_id, table_name, identity_column, identity_table)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, table_name)
         DO UPDATE SET identity_column = excluded.identity_column,
                       identity_table  = excluded.identity_table`
    )
    .run(randomUUID(), input.workspaceId, input.tableName, column, table)
  const row = getDb()
    .prepare('SELECT * FROM table_identity_sources WHERE workspace_id = ? AND table_name = ?')
    .get(input.workspaceId, input.tableName) as TableIdentitySourceRow
  return toTableIdentitySource(row)
}

export function deleteTableIdentitySource(id: string): void {
  getDb().prepare('DELETE FROM table_identity_sources WHERE id = ?').run(id)
}
