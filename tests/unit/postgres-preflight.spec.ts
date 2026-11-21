import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Knex } from 'knex'
import { PostgresAdapter } from '../../src/main/adapters/postgres'

const mocks = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }) }
})

beforeEach(() => vi.resetAllMocks())

function fixture(serverVersion = '18.7 (Ubuntu 18.7-1.pgdg24.04+5)'): {
  raw: ReturnType<typeof vi.fn>
  adapter: PostgresAdapter
} {
  const raw = vi.fn().mockResolvedValue({ rows: [{ server_version: serverVersion }] })
  const db = { raw } as unknown as Knex
  return { raw, adapter: new PostgresAdapter(db, { schemas: ['public'], database: 'fixture' }) }
}

describe('Postgres pg_dump version preflight', () => {
  it('reads the actual SHOW column and rejects client 16 against server 18 before dumping any table', async () => {
    mocks.exec.mockResolvedValue({
      stdout: 'pg_dump (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)',
      stderr: ''
    })
    const { raw, adapter } = fixture()
    await expect(adapter.getCreateTableStatement('users')).rejects.toThrow(
      /pg_dump 16 is older.*PostgreSQL 18.*Install PostgreSQL client tools 18 or newer/
    )
    await expect(adapter.getCreateTableStatement('orders')).rejects.toThrow(/pg_dump 16 is older/)
    expect(raw).toHaveBeenCalledExactlyOnceWith('SHOW server_version')
    expect(mocks.exec).toHaveBeenCalledExactlyOnceWith('pg_dump', ['--version'])
  })

  it('accepts a matching or newer client and proceeds to table schema resolution', async () => {
    for (const client of ['18.7', '19.1']) {
      mocks.exec.mockResolvedValue({ stdout: `pg_dump (PostgreSQL) ${client}`, stderr: '' })
      const { raw, adapter } = fixture()
      // Make the next schema lookup fail distinctly: reaching it proves version validation passed.
      raw.mockResolvedValueOnce({ rows: [{ server_version: '18.7' }] })
      raw.mockRejectedValueOnce(new Error('reached schema lookup'))
      await expect(adapter.getCreateTableStatement('users')).rejects.toThrow(
        'reached schema lookup'
      )
    }
  })

  it('reports a missing local client without querying the server', async () => {
    mocks.exec.mockRejectedValue(new Error('ENOENT'))
    const { raw, adapter } = fixture()
    await expect(adapter.getCreateTableStatement('users')).rejects.toThrow(/pg_dump was not found/)
    expect(raw).not.toHaveBeenCalled()
  })
})
