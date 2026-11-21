import { randomUUID } from 'crypto'
import type { Connection, ConnectionRole, Dialect, SshAuthMethod } from '@shared/types'
import type { ConnectionInput } from '@shared/api'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'
import { getDb } from '../db'
import { sshSecretMatches } from '@shared/ssh'

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
  ssh_enabled: number
  ssh_host: string | null
  ssh_port: number | null
  ssh_username: string | null
  ssh_auth_method: SshAuthMethod | null
  ssh_private_key_path: string | null
  ssh_host_fingerprint: string | null
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
    filePath: row.file_path ?? undefined,
    sshEnabled: row.ssh_enabled === 1,
    sshHost: row.ssh_host ?? undefined,
    sshPort: row.ssh_port ?? undefined,
    sshUsername: row.ssh_username ?? undefined,
    sshAuthMethod: row.ssh_auth_method ?? undefined,
    sshPrivateKeyPath: row.ssh_private_key_path ?? undefined,
    sshHostFingerprint: row.ssh_host_fingerprint ?? undefined
  }
}

export type { ConnectionInput } from '@shared/api'

function sshValues(
  input: ConnectionInput
): [number, string | null, number | null, string | null, SshAuthMethod | null, string | null] {
  if (!input.sshEnabled) return [0, null, null, null, null, null]
  if (input.dialect !== 'mysql' && input.dialect !== 'postgres') {
    throw new Error('SSH tunnelling is supported for MySQL and PostgreSQL only.')
  }
  const host = input.sshHost?.trim()
  const username = input.sshUsername?.trim()
  const port = input.sshPort ?? 22
  if (!host || !username) throw new Error('SSH host and username are required.')
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('SSH port must be between 1 and 65535.')
  if (!input.host?.trim() || !input.database?.trim())
    throw new Error('Database host and name are required for SSH tunnelling.')
  if (
    input.port !== undefined &&
    (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
  )
    throw new Error('Database port must be between 1 and 65535.')
  if (input.sshAuthMethod !== 'password' && input.sshAuthMethod !== 'privateKey')
    throw new Error('Choose an SSH authentication method.')
  let keyPath: string | null = null
  if (input.sshAuthMethod === 'privateKey') {
    keyPath = input.sshPrivateKeyPath?.trim() || null
    if (keyPath?.startsWith('~/') || keyPath?.startsWith('~\\'))
      keyPath = join(homedir(), keyPath.slice(2))
    if (!keyPath || !isAbsolute(keyPath))
      throw new Error('Choose an absolute path to an SSH private key.')
    if (keyPath.endsWith('.pub'))
      throw new Error('Choose the private key, not the .pub public key file.')
  }
  return [1, host, port, username, input.sshAuthMethod, keyPath]
}

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
  const ssh = sshValues(input)
  getDb()
    .prepare(
      `INSERT INTO connections
         (id, workspace_id, label, dialect, role, host, port, database, username,
          search_path, file_path, ssh_enabled, ssh_host, ssh_port, ssh_username,
          ssh_auth_method, ssh_private_key_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      input.filePath ?? null,
      ...ssh
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
  const ssh = sshValues(next)
  const endpointChanged =
    (existing.sshHost ?? null) !== ssh[1] || (existing.sshPort ?? null) !== ssh[2]
  const keepSecret = sshSecretMatches(existing, {
    sshEnabled: ssh[0] === 1,
    sshHost: ssh[1] ?? undefined,
    sshPort: ssh[2] ?? undefined,
    sshUsername: ssh[3] ?? undefined,
    sshAuthMethod: ssh[4] ?? undefined,
    sshPrivateKeyPath: ssh[5] ?? undefined
  })
  if (patch.forgetSshHostKey !== undefined && typeof patch.forgetSshHostKey !== 'boolean')
    throw new Error('Forget SSH host key must be true or false.')
  return getDb().transaction(() => {
    if (!keepSecret) getDb().prepare('DELETE FROM ssh_credentials WHERE connection_id = ?').run(id)
    getDb()
      .prepare(
        `UPDATE connections
         SET label = ?, dialect = ?, role = ?, host = ?, port = ?,
             database = ?, username = ?, search_path = ?, file_path = ?,
             ssh_enabled = ?, ssh_host = ?, ssh_port = ?, ssh_username = ?,
             ssh_auth_method = ?, ssh_private_key_path = ?, ssh_host_fingerprint = ?
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
        ...ssh,
        endpointChanged || !next.sshEnabled || patch.forgetSshHostKey
          ? null
          : (existing.sshHostFingerprint ?? null),
        id
      )
    return getConnection(id)
  })()
}

/** Called only after host verification in main, never from connection input. */
export function pinSshHostKey(id: string, host: string, port: number, fingerprint: string): void {
  const result = getDb()
    .prepare(
      `UPDATE connections SET ssh_host_fingerprint = ?
    WHERE id = ? AND ssh_enabled = 1 AND ssh_host = ? AND ssh_port = ?
    AND (ssh_host_fingerprint IS NULL OR ssh_host_fingerprint = ?)`
    )
    .run(fingerprint, id, host, port, fingerprint)
  if (result.changes !== 1)
    throw new Error('SSH settings changed while verifying the host. Test the connection again.')
}

export function forgetSshHostKey(id: string): void {
  getDb().prepare('UPDATE connections SET ssh_host_fingerprint = NULL WHERE id = ?').run(id)
}

export function deleteConnection(id: string): void {
  getDb().prepare('DELETE FROM connections WHERE id = ?').run(id)
}
