import type { Database } from 'better-sqlite3'
import { getDb } from './db'

/**
 * Numbered-file migration runner (spec §10). Migration `.sql` files live in `migrations/`
 * as git-tracked source; Vite's `import.meta.glob` bundles their contents into the main
 * build (`?raw`) so we don't have to ship or locate loose `.sql` files at runtime. Each
 * unapplied migration runs in a transaction; the runner is idempotent on every app start.
 */
const modules = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

interface Migration {
  version: number
  name: string
  sql: string
}

function loadMigrations(): Migration[] {
  return Object.entries(modules)
    .map(([path, sql]) => {
      const name = path.split('/').pop() ?? path
      const match = name.match(/^(\d+)/)
      if (!match) throw new Error(`Migration file has no numeric prefix: ${name}`)
      return { version: Number(match[1]), name, sql }
    })
    .sort((a, b) => a.version - b.version)
}

export function runMigrations(database: Database = getDb()): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  )

  const applied = new Set(
    database
      .prepare('SELECT version FROM _migrations')
      .all()
      .map((row) => (row as { version: number }).version)
  )

  for (const migration of loadMigrations()) {
    if (applied.has(migration.version)) continue
    const apply = database.transaction(() => {
      database.exec(migration.sql)
      database.prepare('INSERT INTO _migrations (version) VALUES (?)').run(migration.version)
    })
    apply()
    console.log(`[config] applied migration ${migration.name}`)
  }
}
