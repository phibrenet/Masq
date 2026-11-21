import { generateKeyPairSync, createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer, type Server as NetServer, type Socket } from 'node:net'
import { once } from 'node:events'
import { Server, utils, type Connection as SshClient } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Connection } from '@shared/types'
import { openSshTunnel, type SshTunnel } from '../../src/main/adapters/ssh-tunnel'

const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString()
const userKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({
    type: 'pkcs1',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase: 'test-key-passphrase'
  })
  .toString()
const parsedUserKey = utils.parseKey(userKey, 'test-key-passphrase')
if (parsedUserKey instanceof Error) throw parsedUserKey
const fingerprint = `SHA256:${createHash('sha256')
  .update(
    (utils.parseKey(hostKey) as Exclude<ReturnType<typeof utils.parseKey>, Error>).getPublicSSH()
  )
  .digest('base64')
  .replace(/=+$/, '')}`

describe('real SSH forwarding', () => {
  let directory: string
  let echo: NetServer
  let ssh: Server
  let connection: Connection
  let tunnel: SshTunnel | undefined
  const clients = new Set<SshClient>()
  const echoSockets = new Set<Socket>()
  const forwards: Array<{ host: string; port: number }> = []

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'masq-ssh-'))
    await writeFile(join(directory, 'key'), userKey)
    await writeFile(join(directory, 'key.pub'), parsedUserKey.getPublicSSH())
    echo = createServer((socket) => {
      echoSockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => echoSockets.delete(socket))
      socket.pipe(socket)
    })
    echo.listen(0, '127.0.0.1')
    await once(echo, 'listening')
    ssh = new Server({ hostKeys: [hostKey] }, (client) => {
      clients.add(client)
      client.on('error', () => {})
      client.on('close', () => clients.delete(client))
      client.on('authentication', (ctx) => {
        if (ctx.username !== 'reader') return ctx.reject()
        if (ctx.method === 'password' && ctx.password === 'ssh-password') return ctx.accept()
        if (
          ctx.method === 'publickey' &&
          ctx.key.data.equals(parsedUserKey.getPublicSSH()) &&
          (!ctx.signature || parsedUserKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)
        )
          return ctx.accept()
        ctx.reject()
      })
      client.on('ready', () =>
        client.on('tcpip', (accept, reject, info) => {
          forwards.push({ host: info.destIP, port: info.destPort })
          if (info.destIP !== 'database.masq.invalid' || info.destPort !== 3306) {
            reject()
            return
          }
          const channel = accept()
          const remote = createConnection({
            host: '127.0.0.1',
            port: (echo.address() as { port: number }).port
          })
          remote.on('error', () => channel.destroy())
          channel.on('error', () => remote.destroy())
          channel.on('close', () => remote.destroy())
          remote.pipe(channel).pipe(remote)
        })
      )
    })
    ssh.listen(0, '127.0.0.1')
    await once(ssh, 'listening')
    connection = {
      id: 'test',
      workspaceId: 'test',
      label: 'test',
      dialect: 'mysql',
      role: 'source',
      host: 'database.masq.invalid',
      port: 3306,
      database: 'test',
      sshEnabled: true,
      sshHost: '127.0.0.1',
      sshPort: (ssh.address() as { port: number }).port,
      sshUsername: 'reader',
      sshAuthMethod: 'password'
    }
  })

  afterAll(async () => {
    await tunnel?.close()
    for (const client of clients) client.end()
    for (const socket of echoSockets) socket.destroy()
    await Promise.all([
      new Promise<void>((r) => ssh.close(() => r())),
      new Promise<void>((r) => echo.close(() => r()))
    ])
    await rm(directory, { recursive: true, force: true })
  })

  async function roundTrip(port: number): Promise<string> {
    const socket = createConnection({ host: '127.0.0.1', port })
    try {
      await once(socket, 'connect')
      socket.write('through-ssh')
      return (await once(socket, 'data'))[0].toString()
    } finally {
      socket.destroy()
    }
  }

  it('cannot reach the configured destination directly, but forwards it over authenticated SSH', async () => {
    const direct = createConnection({ host: connection.host, port: 3306 })
    await expect(once(direct, 'connect')).rejects.toThrow(/ENOTFOUND|EAI_AGAIN/)
    direct.destroy()
    tunnel = await openSshTunnel(connection, 'ssh-password', async (key) => key === fingerprint)
    expect(tunnel.host).toBe('127.0.0.1')
    expect(await roundTrip(tunnel.port)).toBe('through-ssh')
    expect(forwards).toContainEqual({ host: 'database.masq.invalid', port: 3306 })
    const port = tunnel.port
    await tunnel.close()
    await tunnel.close()
    await expect(roundTrip(port)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('authenticates with an encrypted private key and the correct passphrase', async () => {
    tunnel = await openSshTunnel(
      { ...connection, sshAuthMethod: 'privateKey', sshPrivateKeyPath: join(directory, 'key') },
      'test-key-passphrase',
      async () => true
    )
    expect(await roundTrip(tunnel.port)).toBe('through-ssh')
    await tunnel.close()
  })

  it('rejects an encrypted key without its passphrase and a public key file', async () => {
    await expect(
      openSshTunnel(
        { ...connection, sshAuthMethod: 'privateKey', sshPrivateKeyPath: join(directory, 'key') },
        undefined,
        async () => true
      )
    ).rejects.toThrow(/passphrase/)
    await expect(
      openSshTunnel(
        {
          ...connection,
          sshAuthMethod: 'privateKey',
          sshPrivateKeyPath: join(directory, 'key.pub')
        },
        undefined,
        async () => true
      )
    ).rejects.toThrow(/private key/)
  })

  it('refuses an untrusted host before attempting authentication', async () => {
    await expect(openSshTunnel(connection, 'ssh-password', async () => false)).rejects.toThrow(
      /not trusted/
    )
  })

  it('preserves a host-key mismatch error', async () => {
    await expect(
      openSshTunnel(connection, 'ssh-password', async () => {
        throw new Error('SSH host key changed')
      })
    ).rejects.toThrow(/host key changed/)
  })

  it('reports authentication failure without falling back', async () => {
    await expect(openSshTunnel(connection, 'wrong-password', async () => true)).rejects.toThrow(
      /authentication failed/
    )
  })

  it('records a refused forwarding channel as an SSH failure', async () => {
    tunnel = await openSshTunnel(
      { ...connection, host: 'refused.masq.invalid' },
      'ssh-password',
      async () => true
    )
    const socket = createConnection({ host: tunnel.host, port: tunnel.port })
    await once(socket, 'close')
    expect(tunnel.failure?.message).toMatch(/SSH: database forwarding failed/)
    await tunnel.close()
  })

  it('destroys an active forward when the SSH server disconnects', async () => {
    tunnel = await openSshTunnel(connection, 'ssh-password', async () => true)
    const socket = createConnection({ host: tunnel.host, port: tunnel.port })
    await once(socket, 'connect')
    socket.write('before-drop')
    await once(socket, 'data')
    for (const client of clients) client.end()
    await once(socket, 'close')
    expect(tunnel.failure?.message).toMatch(/SSH: connection closed unexpectedly/)
    await tunnel.close()
  })
})
