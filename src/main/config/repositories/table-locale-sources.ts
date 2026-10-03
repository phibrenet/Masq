import { randomUUID } from 'crypto'
import type { TableLocaleSource } from '@shared/types'
import { getDb } from '../db'

/**
 * Data-driven faker-locale sources (spec §8): one per (workspace, table), naming the column
 * whose value gives a row's country — optionally a dot path *within* that column's JSON, for schemas
 * that keep the country inside a blob (migration 007). `setTableLocaleSource` upserts on the unique
 * constraint so re-pointing a table's country column replaces rather than errors; clearing it is a
 * delete.
 */

interface TableLocaleSourceRow {
  id: string
  workspace_id: string
  table_name: string
  country_column: string
  country_path: string | null
}

function toTableLocaleSource(row: TableLocaleSourceRow): TableLocaleSource {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tableName: row.table_name,
    countryColumn: row.country_column,
    countryPath: row.country_path ?? undefined
  }
}

export type TableLocaleSourceInput = Omit<TableLocaleSource, 'id'>

export function listTableLocaleSourcesByWorkspace(workspaceId: string): TableLocaleSource[] {
  return (
    getDb()
      .prepare('SELECT * FROM table_locale_sources WHERE workspace_id = ? ORDER BY table_name')
      .all(workspaceId) as TableLocaleSourceRow[]
  ).map(toTableLocaleSource)
}

export function setTableLocaleSource(input: TableLocaleSourceInput): TableLocaleSource {
  getDb()
    .prepare(
      `INSERT INTO table_locale_sources (id, workspace_id, table_name, country_column, country_path)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, table_name)
         DO UPDATE SET country_column = excluded.country_column,
                       country_path   = excluded.country_path`
    )
    .run(
      randomUUID(),
      input.workspaceId,
      input.tableName,
      input.countryColumn,
      // Blank normalizes to NULL so "no path" has one representation in the store, not two.
      input.countryPath?.trim() || null
    )
  const row = getDb()
    .prepare('SELECT * FROM table_locale_sources WHERE workspace_id = ? AND table_name = ?')
    .get(input.workspaceId, input.tableName) as TableLocaleSourceRow
  return toTableLocaleSource(row)
}

export function deleteTableLocaleSource(id: string): void {
  getDb().prepare('DELETE FROM table_locale_sources WHERE id = ?').run(id)
}
