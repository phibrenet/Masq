import { generateKeyPairSync, createHash } from 'node:crypto'
import { createConnection as connectSocket } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Server, utils, type Connection as SshClient } from 'ssh2'
import mysql from 'mysql2/promise'
import { Client as PgClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../../src/main/config/migrate'
import { getDb } from '../../src/main/config/db'
import { createWorkspace } from '../../src/main/config/repositories/workspaces'
import { createConnection, pinSshHostKey } from '../../src/main/config/repositories/connections'
import { setTableClassification } from '../../src/main/config/repositories/table-classifications'
import { createSelectionRule } from '../../src/main/config/repositories/selection-rules'
import { createFieldStrategy } from '../../src/main/config/repositories/field-strategies'
import { withSourceAdapter } from '../../src/main/adapters'
import { runExtract } from '../../src/main/extract/run'

// Explicit disposable fixture ports only. Never use saved connections or production credentials.
// The synthetic destination hostname cannot resolve locally; only the SSH fixture maps it.
vi.mock('../../src/main/config/credentials', () => ({
  getPassword: () => 'masq-fixture-db-password',
  getSshSecret: () => 'masq-fixture-ssh-secret'
}))
const mysqlPort = Number(process.env.MASQ_SSH_MYSQL_TEST_PORT)
const pgPort = Number(process.env.MASQ_SSH_POSTGRES_TEST_PORT)
const enabled = Boolean(mysqlPort && pgPort)
const fixture = { database: 'masq_ssh_fixture', password: 'masq-fixture-db-password' }

describe.skipIf(!enabled)('SSH database extract integration (disposable fixtures)', () => {
  let directory: string
  let ssh: Server
  let sshPort: number
  let fingerprint: string
  let keyPath: string
  const clients = new Set<SshClient>()
  const forwarded: Array<{ host: string; port: number }> = []

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'masq-ssh-db-'))
    process.env.MASQ_TEST_USERDATA = directory
    runMigrations()
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs1', format: 'pem' })
      .toString()
    const userKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({
        type: 'pkcs1',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'masq-fixture-ssh-secret'
      })
      .toString()
    const parsed = utils.parseKey(userKey, 'masq-fixture-ssh-secret')
    const host = utils.parseKey(key)
    if (parsed instanceof Error || host instanceof Error)
      throw new Error('SSH fixture keys failed to parse')
    fingerprint = `SHA256:${createHash('sha256').update(host.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
    keyPath = join(directory, 'test-private-key')
    writeFileSync(keyPath, userKey, { mode: 0o600 })
    ssh = new Server({ hostKeys: [key] }, (client) => {
      clients.add(client)
      client.on('error', () => {})
      client.on('close', () => clients.delete(client))
      client.on('authentication', (ctx) => {
        if (ctx.username !== 'fixture') return ctx.reject()
        if (ctx.method === 'password' && ctx.password === 'masq-fixture-ssh-secret')
          return ctx.accept()
        if (
          ctx.method === 'publickey' &&
          ctx.key.data.equals(parsed.getPublicSSH()) &&
          (!ctx.signature || parsed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)
        )
          return ctx.accept()
        ctx.reject()
      })
      client.on('ready', () =>
        client.on('tcpip', (accept, reject, info) => {
          forwarded.push({ host: info.destIP, port: info.destPort })
          if (info.destIP !== 'database.masq.invalid' || ![3306, 5432].includes(info.destPort)) {
            reject()
            return
          }
          const channel = accept()
          const remote = connectSocket({
            host: '127.0.0.1',
            port: info.destPort === 3306 ? mysqlPort : pgPort
          })
          channel.on('error', () => remote.destroy())
          remote.on('error', () => channel.destroy())
          channel.on('close', () => remote.destroy())
          remote.pipe(channel).pipe(remote)
        })
      )
    })
    ssh.listen(0, '127.0.0.1')
    await once(ssh, 'listening')
    sshPort = (ssh.address() as { port: number }).port
  })

  afterAll(async () => {
    for (const client of clients) client.end()
    if (ssh) await new Promise<void>((resolve) => ssh.close(() => resolve()))
    getDb().close()
    delete process.env.MASQ_TEST_USERDATA
    rmSync(directory, { recursive: true, force: true })
  })

  for (const dialect of ['mysql', 'postgres'] as const) {
    it(`${dialect}: tests, discovers and extracts through SSH, with real DDL and no unmasked email`, async () => {
      const port = dialect === 'mysql' ? 3306 : 5432
      // A direct route must fail. Removing tunnel code must make this test fail too.
      const direct = connectSocket({ host: 'database.masq.invalid', port })
      await expect(once(direct, 'connect')).rejects.toThrow(/ENOTFOUND|EAI_AGAIN/)
      direct.destroy()
      const admin =
        dialect === 'mysql'
          ? await mysql.createConnection({
              ...fixture,
              host: '127.0.0.1',
              port: mysqlPort,
              user: 'root',
              multipleStatements: true
            })
          : new PgClient({ ...fixture, host: '127.0.0.1', port: pgPort, user: 'postgres' })
      if (admin instanceof PgClient) await admin.connect()
      async function query(sql: string): Promise<unknown> {
        return admin instanceof PgClient
          ? (await admin.query(sql)).rows
          : (await admin.query(sql))[0]
      }
      try {
        await query('DROP TABLE IF EXISTS users')
        await query('CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL)')
        await query(
          "INSERT INTO users VALUES (1, 'synthetic-real-person@fixture.example'), (2, 'synthetic-other-person@fixture.example')"
        )
        const workspace = createWorkspace({ name: `SSH ${dialect}` })
        const connection = createConnection({
          workspaceId: workspace.id,
          label: 'SSH fixture',
          dialect,
          role: 'source',
          host: 'database.masq.invalid',
          port,
          database: fixture.database,
          username: dialect === 'mysql' ? 'root' : 'postgres',
          sshEnabled: true,
          sshHost: '127.0.0.1',
          sshPort,
          sshUsername: 'fixture',
          sshAuthMethod: dialect === 'mysql' ? 'password' : 'privateKey',
          sshPrivateKeyPath: dialect === 'postgres' ? keyPath : undefined
        })
        pinSshHostKey(connection.id, '127.0.0.1', sshPort, fingerprint)
        await withSourceAdapter(connection.id, async (adapter) => {
          await adapter.ping()
          expect(await adapter.getTables()).toContain('users')
          expect(await adapter.getCreateTableStatement('users')).toMatch(/CREATE TABLE/)
        })
        setTableClassification({
          workspaceId: workspace.id,
          tableName: 'users',
          class: 'transactional'
        })
        createSelectionRule({
          workspaceId: workspace.id,
          table: 'users',
          match: 'all',
          where: [],
          take: { kind: 'all' },
          anonymize: true
        })
        createFieldStrategy({
          workspaceId: workspace.id,
          tableName: 'users',
          columnName: 'email',
          rule: { kind: 'fake', generator: 'exampleEmail' }
        })
        const run = await runExtract(connection.id, workspace.id, directory)
        expect(run.status).toBe('completed')
        expect(run.rowCounts).toEqual({ users: 2 })
        const dump = readFileSync(run.outputFiles!.combined!, 'utf8')
        expect(dump).toContain('CREATE TABLE')
        expect(dump).toContain('INSERT INTO')
        expect(dump).not.toContain('synthetic-real-person')
        expect(dump).not.toContain('synthetic-other-person')
        expect(dump).not.toContain('masq-fixture-db-password')
        // Load into the disposable fixture after the source operation has closed.
        await query(dump)
        const rows = await query('SELECT email FROM users ORDER BY id')
        expect(rows).toHaveLength(2)
        for (const row of rows as { email: string }[])
          expect(row.email).toMatch(/@example\.(com|net|org)$/)
        expect(forwarded).toContainEqual({ host: 'database.masq.invalid', port })
        // Exercise an actual driver stream, including already-buffered rows, after transport loss.
        // Enough rows to exceed the drivers' buffers: a two-row table can finish before the
        // client receives the TCP close, even though the server has already disconnected.
        const streamRows = Array.from(
          { length: 20_000 },
          (_, i) => `(${i + 3}, 'synthetic-stream-${i}@example.com')`
        )
        await query(`INSERT INTO users VALUES ${streamRows.join(',')}`)
        let streamed = 0
        await expect(
          withSourceAdapter(connection.id, async (adapter) => {
            for await (const _row of adapter.streamRows('users')) {
              expect(_row).toHaveProperty('email')
              streamed++
              if (streamed === 1) {
                const closing = [...clients].map((client) => once(client, 'close'))
                for (const client of clients) client.end()
                await Promise.all(closing)
              }
            }
          })
        ).rejects.toThrow(/SSH:/)
        expect(streamed).toBeGreaterThan(0)
        expect(streamed).toBeLessThan(20_002)
      } finally {
        await admin.end()
      }
    }, 30_000)
  }
})
