import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { getDb } from '../../src/main/config/db'
import { runMigrations } from '../../src/main/config/migrate'
import { createWorkspace } from '../../src/main/config/repositories/workspaces'
import { createConnection } from '../../src/main/config/repositories/connections'
import { listRunsByWorkspace } from '../../src/main/config/repositories/runs'
import { runExtract } from '../../src/main/extract/run'

vi.mock('../../src/main/adapters', () => ({
  withSourceAdapter: async () => {
    throw new Error('SSH: connection closed unexpectedly')
  }
}))
const directory = mkdtempSync(join(tmpdir(), 'masq-ssh-run-'))
process.env.MASQ_TEST_USERDATA = directory
beforeAll(() => runMigrations())
afterAll(() => {
  getDb().close()
  delete process.env.MASQ_TEST_USERDATA
  rmSync(directory, { recursive: true, force: true })
})
it('persists SSH errors as warnings on the failed run in the default test suite', async () => {
  const workspace = createWorkspace({ name: 'SSH failure' })
  const c = createConnection({
    workspaceId: workspace.id,
    label: 'Synthetic source',
    dialect: 'mysql',
    role: 'source',
    host: 'db.masq.invalid',
    database: 'fixture'
  })
  await expect(runExtract(c.id, workspace.id, directory)).rejects.toThrow(/SSH: connection closed/)
  const [run] = listRunsByWorkspace(workspace.id)
  expect(run.status).toBe('failed')
  expect(run.warnings).toContain('SSH: connection closed unexpectedly')
  expect(run.errorMessage).toBe('SSH: connection closed unexpectedly')
  expect(run.outputFiles).toBeUndefined()
})
