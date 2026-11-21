import { createHash } from 'crypto'
import { readFile, stat } from 'fs/promises'
import { createServer, type Socket } from 'net'
import { Client, utils, type ClientChannel, type ConnectConfig } from 'ssh2'
import type { Connection } from '@shared/types'

export interface SshTunnel {
  host: '127.0.0.1'
  port: number
  /** First unexpected SSH/forwarding error, retained through teardown. */
  failure?: Error
  close(): Promise<void>
}

export type HostVerifier = (fingerprint: string, signal: AbortSignal) => Promise<boolean>

/** Opens one loopback forward used by both knex and pg_dump; never falls back to a direct route. */
export async function openSshTunnel(
  connection: Connection,
  secret: string | undefined,
  verifyHost: HostVerifier
): Promise<SshTunnel> {
  if (
    !connection.sshEnabled ||
    !connection.sshHost ||
    !connection.sshUsername ||
    (connection.dialect !== 'mysql' && connection.dialect !== 'postgres')
  ) {
    throw new Error('SSH: incomplete or unsupported tunnel configuration.')
  }
  if (!connection.host || !connection.database)
    throw new Error('SSH: database host and name are required.')
  const config: ConnectConfig = {
    host: connection.sshHost,
    port: connection.sshPort ?? 22,
    username: connection.sshUsername,
    readyTimeout: 120_000, // Includes time spent reading the first-trust dialog.
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3
  }
  if (connection.sshAuthMethod === 'password') {
    if (!secret)
      throw new Error('SSH: no password saved. Edit the connection and enter the SSH password.')
    config.password = secret
    config.authHandler = ['password']
  } else if (connection.sshAuthMethod === 'privateKey') {
    if (!connection.sshPrivateKeyPath) throw new Error('SSH: choose a private key file.')
    let key: Buffer
    try {
      const info = await stat(connection.sshPrivateKeyPath)
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('not a key file')
      key = await readFile(connection.sshPrivateKeyPath)
    } catch {
      throw new Error('SSH: cannot read the private key file. Check the path and file permissions.')
    }
    const parsed = utils.parseKey(key, secret)
    if (parsed instanceof Error) {
      if (/encrypted|passphrase|decrypt/i.test(parsed.message)) {
        throw new Error(
          'SSH: the private key needs a valid passphrase. Enter it in the connection settings.'
        )
      }
      throw new Error(
        'SSH: invalid private key. Select the private key, not its .pub public key file.'
      )
    }
    if (!parsed.isPrivateKey())
      throw new Error(
        'SSH: a public key cannot authenticate. Select the matching private key file.'
      )
    config.privateKey = key
    config.passphrase = secret
    config.authHandler = ['publickey']
  } else {
    throw new Error('SSH: choose password or private key authentication.')
  }

  const client = new Client()
  const lifetime = new AbortController()
  const sockets = new Set<Socket>()
  const channels = new Set<ClientChannel>()
  let intentionalClose = false
  let settled = false
  let rejectOpening: (error: Error) => void = () => {}
  let closePromise: Promise<void> | undefined
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    if (tunnel.failure || intentionalClose) {
      socket.destroy()
      return
    }
    const timeout = setTimeout(() => fail(new Error('SSH: database forwarding timed out.')), 30_000)
    timeout.unref()
    socket.once('close', () => clearTimeout(timeout))
    try {
      client.forwardOut(
        '127.0.0.1',
        socket.remotePort ?? 0,
        connection.host!,
        connection.port ?? (connection.dialect === 'postgres' ? 5432 : 3306),
        (error, channel) => {
          clearTimeout(timeout)
          if (error) {
            fail(new Error(`SSH: database forwarding failed (${error.message}).`))
            return
          }
          if (intentionalClose || tunnel.failure || socket.destroyed) {
            channel.destroy()
            return
          }
          channels.add(channel)
          channel.on('error', (err: Error) =>
            fail(new Error(`SSH: database channel failed (${err.message}).`))
          )
          channel.once('close', () => {
            channels.delete(channel)
            socket.destroy()
          })
          socket.once('close', () => channel.destroy())
          socket.pipe(channel).pipe(socket)
        }
      )
    } catch (error) {
      clearTimeout(timeout)
      fail(new Error(`SSH: database forwarding failed (${(error as Error).message}).`))
    }
  })
  const tunnel: SshTunnel = {
    host: '127.0.0.1',
    port: 0,
    close: () => {
      if (closePromise) return closePromise
      intentionalClose = true
      lifetime.abort()
      for (const socket of sockets) socket.destroy()
      for (const channel of channels) channel.destroy()
      client.destroy()
      closePromise = new Promise<void>((resolve) => {
        if (server.listening) server.close(() => resolve())
        else resolve()
      })
      return closePromise
    }
  }
  function fail(error: Error): void {
    if (intentionalClose || tunnel.failure) return
    tunnel.failure = error
    lifetime.abort()
    for (const socket of sockets) socket.destroy()
    for (const channel of channels) channel.destroy()
    client.destroy()
    if (server.listening) server.close()
    if (!settled) {
      settled = true
      rejectOpening(tunnel.failure)
    }
  }
  config.hostVerifier = (key: Buffer, callback: (accept: boolean) => void) => {
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
    verifyHost(fingerprint, lifetime.signal).then(
      (accepted) => {
        if (!accepted) fail(new Error('SSH: server host key was not trusted.'))
        callback(accepted && !tunnel.failure && !intentionalClose)
      },
      (error: unknown) => {
        fail(error instanceof Error ? error : new Error('SSH: host key verification failed.'))
        callback(false)
      }
    )
  }
  try {
    await new Promise<void>((resolve, reject) => {
      rejectOpening = reject
      client.on('error', (error: Error & { level?: string }) => {
        fail(
          new Error(
            error.level === 'client-authentication'
              ? 'SSH: authentication failed. Check the SSH username and password or private key.'
              : `SSH: connection failed (${error.message}).`
          )
        )
      })
      client.on('close', () =>
        fail(new Error('SSH: connection closed unexpectedly. Run the operation again.'))
      )
      server.on('error', (error) =>
        fail(new Error(`SSH: local forward failed (${error.message}).`))
      )
      client.once('ready', () => {
        if (tunnel.failure || intentionalClose) return
        server.listen(0, '127.0.0.1', () => {
          if (tunnel.failure || intentionalClose) {
            server.close()
            return
          }
          const address = server.address()
          if (!address || typeof address === 'string') {
            fail(new Error('SSH: no local forwarding port.'))
            return
          }
          tunnel.port = address.port
          settled = true
          resolve()
        })
      })
      client.connect(config)
    })
    return tunnel
  } catch (error) {
    await tunnel.close()
    throw error
  }
}
