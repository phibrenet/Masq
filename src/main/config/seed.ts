import { getDb } from './db'
import { createWorkspace } from './repositories/workspaces'
import { createConnection } from './repositories/connections'

/**
 * First-run seed: two example workspaces + their connections, so the app opens with
 * something to look at before any real connection is configured. Mirrors the content the
 * renderer mock used to provide. Runs only when `workspaces` is empty, so it never
 * duplicates on restart. Nothing here is project-specific — it's just demo content.
 */
export function seedIfEmpty(): void {
  const count = (getDb().prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n
  if (count > 0) return

  const demo = createWorkspace({ name: 'Example Shop', dumpOutputMode: 'split' })
  createConnection({
    workspaceId: demo.id,
    label: 'Production (read replica)',
    dialect: 'mysql',
    role: 'source',
    host: 'replica.shop.example.com',
    port: 3306,
    database: 'example',
    username: 'subsetter_ro'
  })
  createConnection({
    workspaceId: demo.id,
    label: 'Staging',
    dialect: 'mysql',
    role: 'source',
    host: 'staging.shop.example.com',
    port: 3306,
    database: 'example_staging',
    username: 'subsetter_ro'
  })

  const shop = createWorkspace({ name: 'Corner Shop', dumpOutputMode: 'combined' })
  createConnection({
    workspaceId: shop.id,
    label: 'Production',
    dialect: 'postgres',
    role: 'source',
    host: 'db.cornershop.example.com',
    port: 5432,
    database: 'shop',
    username: 'readonly'
  })
  createConnection({
    workspaceId: shop.id,
    label: 'Local snapshot',
    dialect: 'sqlite',
    role: 'source',
    filePath: '/path/to/masq-demo/snapshot.sqlite'
  })

  console.log('[config] seeded example workspaces')
}
