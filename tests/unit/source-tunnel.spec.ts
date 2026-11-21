import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Connection } from '@shared/types'
import { withSourceAdapter } from '../../src/main/adapters'

const mocks = vi.hoisted(() => ({
  connection: undefined as Connection | undefined,
  createKnex: vi.fn(),
  destroy: vi.fn(),
  close: vi.fn(),
  open: vi.fn(),
  postgres: vi.fn(),
  failure: undefined as Error | undefined,
  order: [] as string[]
}))
vi.mock('../../src/main/config/repositories/connections', () => ({
  getConnection: () => mocks.connection
}))
vi.mock('../../src/main/config/credentials', () => ({
  getPassword: () => 'db-secret',
  getSshSecret: () => 'ssh-secret'
}))
vi.mock('../../src/main/adapters/knex-factory', () => ({ createKnex: mocks.createKnex }))
vi.mock('../../src/main/adapters/ssh-tunnel', () => ({ openSshTunnel: mocks.open }))
vi.mock('../../src/main/adapters/ssh-host-key', () => ({ verifySshHostKey: vi.fn() }))
vi.mock('../../src/main/adapters/postgres', () => ({
  PostgresAdapter: class {
    constructor(...args: unknown[]) {
      mocks.postgres(...args)
    }
    async *streamRows(): AsyncGenerator<Record<string, unknown>> {
      yield { id: 1, email: 'buffered-sensitive-email' }
      mocks.failure = new Error('SSH: connection closed unexpectedly')
      yield { id: 2, email: 'buffered-sensitive-email-2' }
    }
  }
}))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.order = []
  mocks.failure = undefined
  mocks.connection = {
    id: 'c',
    workspaceId: 'w',
    label: 'PG source',
    dialect: 'postgres',
    role: 'source',
    host: 'private-db.masq.invalid',
    port: 5432,
    database: 'fixture',
    username: 'reader',
    searchPath: 'tenant, public',
    sshEnabled: true,
    sshHost: 'bastion.example.com',
    sshPort: 22,
    sshUsername: 'ssh-reader',
    sshAuthMethod: 'password'
  }
  mocks.destroy.mockImplementation(async () => {
    mocks.order.push('pool')
  })
  mocks.close.mockImplementation(async () => {
    mocks.order.push('tunnel')
  })
  mocks.createKnex.mockReturnValue({ destroy: mocks.destroy })
  mocks.open.mockResolvedValue({
    host: '127.0.0.1',
    port: 49123,
    close: mocks.close,
    get failure() {
      return mocks.failure
    }
  })
})

describe('source adapter tunnel lifecycle', () => {
  it('routes knex and Postgres pg_dump configuration through the same local endpoint', async () => {
    expect(await withSourceAdapter('c', async () => 'done')).toBe('done')
    expect(mocks.createKnex).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1', port: 49123 }),
      'db-secret'
    )
    expect(mocks.postgres).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        host: '127.0.0.1',
        port: 49123,
        password: 'db-secret',
        schemas: ['tenant', 'public']
      })
    )
    expect(mocks.order).toEqual(['pool', 'tunnel'])
  })
  it('keeps direct connections working without opening a tunnel', async () => {
    mocks.connection!.sshEnabled = false
    await withSourceAdapter('c', async () => undefined)
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.createKnex).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'private-db.masq.invalid', port: 5432 }),
      'db-secret'
    )
    expect(mocks.close).not.toHaveBeenCalled()
  })
  it('never opens a direct pool if SSH authentication fails', async () => {
    mocks.open.mockRejectedValue(new Error('SSH: authentication failed'))
    await expect(withSourceAdapter('c', async () => undefined)).rejects.toThrow(/SSH/)
    expect(mocks.createKnex).not.toHaveBeenCalled()
  })
  it('closes the tunnel even when constructing the pool or adapter fails', async () => {
    mocks.createKnex.mockImplementation(() => {
      throw new Error('pool error')
    })
    await expect(withSourceAdapter('c', async () => undefined)).rejects.toThrow('pool error')
    expect(mocks.close).toHaveBeenCalledTimes(1)
    mocks.createKnex.mockReturnValue({ destroy: mocks.destroy })
    mocks.connection!.database = undefined
    await expect(withSourceAdapter('c', async () => undefined)).rejects.toThrow(/database name/)
    expect(mocks.order).toEqual(['tunnel', 'pool', 'tunnel'])
  })
  it('closes the tunnel even if pool destruction fails', async () => {
    mocks.destroy.mockRejectedValue(new Error('destroy error'))
    await expect(withSourceAdapter('c', async () => undefined)).rejects.toThrow('destroy error')
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })
  it('reports the SSH failure when a dropped tunnel makes the database operation fail', async () => {
    await expect(
      withSourceAdapter('c', async () => {
        mocks.failure = new Error('SSH: connection closed unexpectedly')
        throw new Error('ECONNRESET')
      })
    ).rejects.toThrow(/SSH: connection closed/)
    expect(mocks.order).toEqual(['pool', 'tunnel'])
  })
  it('rejects a buffered row stream after SSH drops instead of treating it as a complete dump', async () => {
    const seen: unknown[] = []
    await expect(
      withSourceAdapter('c', async (adapter) => {
        for await (const row of adapter.streamRows('users')) seen.push(row)
      })
    ).rejects.toThrow(/SSH: connection closed/)
    expect(seen).toHaveLength(1)
    expect(mocks.order).toEqual(['pool', 'tunnel'])
  })
})
