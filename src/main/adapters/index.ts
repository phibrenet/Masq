import type { Connection } from '@shared/types'
import { getConnection } from '../config/repositories/connections'
import { getPassword } from '../config/credentials'
import { createKnex } from './knex-factory'
import { MySQLAdapter } from './mysql'
import { PostgresAdapter } from './postgres'
import { SQLiteAdapter } from './sqlite'
import { parseSearchPath } from './search-path'
import type { DbAdapter } from './types'

export type { DbAdapter } from './types'

/**
 * Build the right adapter for a connection over an existing knex handle.
 *
 * The password is passed through because Postgres table DDL comes from `pg_dump`, a subprocess that
 * authenticates on its own (via `PGPASSWORD`) rather than riding the knex pool.
 */
function makeAdapter(
  connection: Connection,
  db: ReturnType<typeof createKnex>,
  password?: string
): DbAdapter {
  switch (connection.dialect) {
    case 'mysql':
      if (!connection.database) {
        throw new Error('This connection has no database name — cannot introspect.')
      }
      return new MySQLAdapter(db, connection.database)
    case 'postgres':
      if (!connection.database) {
        throw new Error('This connection has no database name — cannot introspect.')
      }
      return new PostgresAdapter(db, {
        // Same parsed path knex used for the session, so introspection scopes to the schemas the
        // queries actually resolve against.
        schemas: parseSearchPath(connection.searchPath, connection.username),
        host: connection.host,
        port: connection.port,
        database: connection.database,
        username: connection.username,
        password
      })
    case 'sqlite':
      // No database/schema argument: a SQLite connection is one file, and it's `createKnex` that
      // needs the path. The adapter introspects `main` and nothing else.
      if (!connection.filePath) {
        throw new Error('This SQLite connection has no file path — cannot introspect.')
      }
      return new SQLiteAdapter(db)
    default:
      // createKnex rejects mssql too, but keep the switch exhaustive.
      throw new Error(`The ${connection.dialect} adapter isn't built yet.`)
  }
}

/**
 * Open a short-lived adapter for a stored connection, run `fn`, and always tear the pool
 * down. Credentials are read from the OS keychain here (main process only) — the renderer
 * passes a connection *id*, never a password. Use this for one-shot ops (test, introspect);
 * longer-lived streaming for dumps will manage its own handle in the extract slices.
 */
export async function withSourceAdapter<T>(
  connectionId: string,
  fn: (adapter: DbAdapter) => Promise<T>
): Promise<T> {
  const connection = getConnection(connectionId)
  if (!connection) throw new Error('Connection not found.')

  const password = getPassword(connectionId)
  const db = createKnex(connection, password)
  try {
    return await fn(makeAdapter(connection, db, password))
  } finally {
    await db.destroy()
  }
}
