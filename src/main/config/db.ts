import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'

/**
 * The app's own settings store — a single SQLite file in `userData`, separate from any
 * source/target database (spec §10). One shared file for all workspaces; `workspace_id`
 * is the partition. The raw handle never leaves the main process — the renderer reaches
 * this only through the narrow IPC surface in `src/main/ipc.ts`.
 */
let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  const file = join(app.getPath('userData'), 'config.sqlite3')
  db = new Database(file)
  // Enforce the ON DELETE CASCADE foreign keys (off by default in SQLite) and use WAL
  // for better concurrency/durability of the config file.
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}
