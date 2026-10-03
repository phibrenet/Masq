import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import electron from 'electron'

const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

const result = spawnSync(electron, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})

process.exit(result.status ?? 1)
