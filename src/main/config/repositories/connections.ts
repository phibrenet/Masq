import { randomUUID } from 'crypto'
import type { Connection, ConnectionRole, Dialect } from '@shared/types'
import { getDb } from '../db'

/**
 * Connection CRUD. Passwords live in the `credentials` table (via safeStorage), never
 * here — see `../credentials.ts`. Deleting a connection cascades to its credential row
 * through the FK. Server-based dialects use host/port/database/username; file-based
 * (sqlite) uses file_path — nullable columns round-trip as `undefined`, not `null`.
 */

interface ConnectionRow {
  id: string
  workspace_id: string
  label: string
  dialect: Dialect
  role: ConnectionRole
  host: string | null
  port: number | null
  database: string | null
  username: string | null
  search_path: string | null
  file_path: string | null
}

function toConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    label: row.label,
    dialect: row.dialect,
    role: row.role,
    host: row.host ?? undefined,
    port: row.port ?? undefined,
    database: row.database ?? undefined,
    username: row.username ?? undefined,
    searchPath: row.search_path ?? undefined,
    filePath: row.file_path ?? undefined
  }
}

export type ConnectionInput = Omit<Connection, 'id'>

export function listConnectionsByWorkspace(workspaceId: string): Connection[] {
  return (
    getDb()
      .prepare('SELECT * FROM connections WHERE workspace_id = ? ORDER BY label')
      .all(workspaceId) as ConnectionRow[]
  ).map(toConnection)
}

export function getConnection(id: string): Connection | undefined {
  const row = getDb().prepare('SELECT * FROM connections WHERE id = ?').get(id) as
    ConnectionRow | undefined
  return row ? toConnection(row) : undefined
}

export function createConnection(input: ConnectionInput): Connection {
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO connections
         (id, workspace_id, label, dialect, role, host, port, database, username,
          search_path, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.workspaceId,
      input.label,
      input.dialect,
      input.role,
      input.host ?? null,
      input.port ?? null,
      input.database ?? null,
      input.username ?? null,
      input.searchPath ?? null,
      input.filePath ?? null
    )
  return getConnection(id)!
}

export function updateConnection(
  id: string,
  patch: Partial<ConnectionInput>
): Connection | undefined {
  const existing = getConnection(id)
  if (!existing) return undefined
  const next = { ...existing, ...patch }
  getDb()
    .prepare(
      `UPDATE connections
         SET label = ?, dialect = ?, role = ?, host = ?, port = ?,
             database = ?, username = ?, search_path = ?, file_path = ?
       WHERE id = ?`
    )
    .run(
      next.label,
      next.dialect,
      next.role,
      next.host ?? null,
      next.port ?? null,
      next.database ?? null,
      next.username ?? null,
      next.searchPath ?? null,
      next.filePath ?? null,
      id
    )
  return getConnection(id)
}

export function deleteConnection(id: string): void {
  getDb().prepare('DELETE FROM connections WHERE id = ?').run(id)
}
