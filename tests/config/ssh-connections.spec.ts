import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getDb } from '../../src/main/config/db'
import { runMigrations } from '../../src/main/config/migrate'
import { createWorkspace, deleteWorkspace } from '../../src/main/config/repositories/workspaces'
import {
  createConnection,
  updateConnection,
  getConnection,
  deleteConnection,
  pinSshHostKey,
  forgetSshHostKey
} from '../../src/main/config/repositories/connections'
import {
  createConnectionWithSecrets,
  updateConnectionWithSecrets
} from '../../src/main/config/connection-service'
import {
  getPassword,
  getSshSecret,
  hasPassword,
  hasSshSecret
} from '../../src/main/config/credentials'
import type { ConnectionInput } from '@shared/api'

const storage = vi.hoisted(() => ({ available: true, backend: 'gnome_libsecret' }))
vi.mock('electron', async (importOriginal) => {
  const { app } = await importOriginal<typeof import('../support/electron-shim')>()
  const { createCipheriv, createDecipheriv, randomBytes } = await import('node:crypto')
  const key = randomBytes(32)
  return {
    app,
    safeStorage: {
      isEncryptionAvailable: () => storage.available,
      getSelectedStorageBackend: () => storage.backend,
      encryptString: (text: string) => {
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
      },
      decryptString: (data: Buffer) => {
        const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
        decipher.setAuthTag(data.subarray(12, 28))
        return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(
          'utf8'
        )
      }
    }
  }
})

const directory = mkdtempSync(join(tmpdir(), 'masq-ssh-store-'))
process.env.MASQ_TEST_USERDATA = directory
beforeAll(() => runMigrations())
afterAll(() => {
  getDb().close()
  delete process.env.MASQ_TEST_USERDATA
  rmSync(directory, { recursive: true, force: true })
})
function input(): ConnectionInput {
  return {
    workspaceId: createWorkspace({ name: 'SSH fixture' }).id,
    label: 'SSH source',
    dialect: 'postgres',
    role: 'source',
    host: 'db.internal',
    port: 5432,
    database: 'fixture',
    username: 'db-reader',
    searchPath: 'tenant, public',
    sshEnabled: true,
    sshHost: 'bastion.example.com',
    sshUsername: 'ssh-reader',
    sshAuthMethod: 'password'
  }
}

describe('SSH connection persistence', () => {
  it('defaults the port, stores both secrets separately, and excludes secrets from connection values', () => {
    const c = createConnectionWithSecrets(input(), {
      password: 'database-password',
      sshSecret: 'ssh-password'
    })
    expect(c).toMatchObject({
      sshEnabled: true,
      sshPort: 22,
      sshAuthMethod: 'password',
      searchPath: 'tenant, public'
    })
    expect(getPassword(c.id)).toBe('database-password')
    expect(getSshSecret(c.id)).toBe('ssh-password')
    expect(JSON.stringify(c)).not.toContain('database-password')
    expect(JSON.stringify(c)).not.toContain('ssh-password')
  })

  it('supports SSH-only credentials without inventing a database password', () => {
    const c = createConnectionWithSecrets(input(), { sshSecret: 'ssh-only-secret' })
    expect(hasPassword(c.id)).toBe(false)
    expect(getPassword(c.id)).toBeUndefined()
    expect(hasSshSecret(c.id)).toBe(true)
    const row = getDb()
      .prepare('SELECT encrypted_secret FROM ssh_credentials WHERE connection_id = ?')
      .get(c.id) as { encrypted_secret: Buffer }
    expect(row.encrypted_secret.toString()).not.toContain('ssh-only-secret')
  })

  it('preserves trust and secrets on a rename, resets trust on endpoint change and clears secrets on identity change', () => {
    const c = createConnectionWithSecrets(input(), {
      password: 'db-secret',
      sshSecret: 'ssh-secret'
    })
    pinSshHostKey(c.id, c.sshHost!, 22, 'SHA256:test')
    const renamed = updateConnectionWithSecrets(c.id, { label: 'Renamed' })!
    expect(renamed.sshHostFingerprint).toBe('SHA256:test')
    expect(getSshSecret(c.id)).toBe('ssh-secret')
    const authChanged = updateConnectionWithSecrets(c.id, { sshUsername: 'another-user' })!
    expect(authChanged.sshHostFingerprint).toBe('SHA256:test')
    expect(hasSshSecret(c.id)).toBe(false)
    expect(getPassword(c.id)).toBe('db-secret')
    expect(
      updateConnection(c.id, { sshHost: 'new-bastion.example.com' })!.sshHostFingerprint
    ).toBeUndefined()
  })

  it('switches auth methods without reusing the old password as a key passphrase', () => {
    const c = createConnectionWithSecrets(input(), { sshSecret: 'password' })
    const updated = updateConnectionWithSecrets(
      c.id,
      { sshAuthMethod: 'privateKey', sshPrivateKeyPath: join(tmpdir(), 'test-key') },
      { sshSecret: 'key-passphrase' }
    )!
    expect(updated.sshPrivateKeyPath).toBe(join(tmpdir(), 'test-key'))
    expect(getSshSecret(c.id)).toBe('key-passphrase')
    updateConnectionWithSecrets(c.id, {}, { sshSecret: '' })
    expect(hasSshSecret(c.id)).toBe(false)
  })

  it('preserves a local key passphrase across SSH endpoint/user changes but clears it on key changes', () => {
    const c = createConnectionWithSecrets(
      { ...input(), sshAuthMethod: 'privateKey', sshPrivateKeyPath: join(tmpdir(), 'same-key') },
      { sshSecret: 'key-passphrase' }
    )
    pinSshHostKey(c.id, c.sshHost!, 22, 'SHA256:old')
    const changed = updateConnectionWithSecrets(c.id, {
      sshHost: 'new.example.com',
      sshPort: 2222,
      sshUsername: 'other'
    })!
    expect(changed.sshHostFingerprint).toBeUndefined()
    expect(getSshSecret(c.id)).toBe('key-passphrase')
    updateConnection(c.id, { sshPrivateKeyPath: join(tmpdir(), 'different-key') })
    expect(getSshSecret(c.id)).toBeUndefined()
  })

  it('forgets trust only in a successful settings save and rolls it back on credential failure', () => {
    const c = createConnectionWithSecrets(input(), { sshSecret: 'original' })
    pinSshHostKey(c.id, c.sshHost!, 22, 'SHA256:original')
    storage.available = false
    try {
      expect(() =>
        updateConnectionWithSecrets(c.id, { forgetSshHostKey: true }, { sshSecret: 'replacement' })
      ).toThrow(/unavailable/)
    } finally {
      storage.available = true
    }
    expect(getConnection(c.id)?.sshHostFingerprint).toBe('SHA256:original')
    expect(
      updateConnectionWithSecrets(c.id, { forgetSshHostKey: true })!.sshHostFingerprint
    ).toBeUndefined()
  })

  it('rolls back connection settings and both secrets when keyring encryption fails', () => {
    const c = createConnectionWithSecrets(input(), {
      password: 'original-db',
      sshSecret: 'original-ssh'
    })
    storage.available = false
    try {
      expect(() =>
        updateConnectionWithSecrets(
          c.id,
          { label: 'Changed', sshHost: 'other.example.com' },
          { password: 'new-db', sshSecret: 'new-ssh' }
        )
      ).toThrow(/unavailable/)
      const createInput = input()
      expect(() => createConnectionWithSecrets(createInput, { sshSecret: 'new-secret' })).toThrow(
        /unavailable/
      )
      expect(
        getDb()
          .prepare('SELECT COUNT(*) AS n FROM connections WHERE workspace_id = ?')
          .get(createInput.workspaceId)
      ).toEqual({ n: 0 })
    } finally {
      storage.available = true
    }
    expect(getConnection(c.id)?.label).toBe(c.label)
    expect(getConnection(c.id)?.sshHost).toBe(c.sshHost)
    expect(getPassword(c.id)).toBe('original-db')
    expect(getSshSecret(c.id)).toBe('original-ssh')
  })

  it('refuses the Linux basic_text keyring for SSH secrets', () => {
    if (process.platform !== 'linux') return
    storage.backend = 'basic_text'
    try {
      expect(() => createConnectionWithSecrets(input(), { sshSecret: 'secret' })).toThrow(
        /fixed key/
      )
    } finally {
      storage.backend = 'gnome_libsecret'
    }
  })

  it('clears tunnel trust/secrets when disabled and cascades credentials on delete', () => {
    const c = createConnectionWithSecrets(input(), { sshSecret: 'secret' })
    pinSshHostKey(c.id, c.sshHost!, 22, 'SHA256:test')
    const disabled = updateConnection(c.id, { sshEnabled: false })!
    expect(disabled.sshHostFingerprint).toBeUndefined()
    expect(disabled.sshHost).toBeUndefined()
    expect(hasSshSecret(c.id)).toBe(false)
    const another = createConnectionWithSecrets(input(), { sshSecret: 'secret' })
    deleteConnection(another.id)
    expect(hasSshSecret(another.id)).toBe(false)
    const third = createConnectionWithSecrets(input(), { sshSecret: 'secret' })
    deleteWorkspace(third.workspaceId)
    expect(hasSshSecret(third.id)).toBe(false)
  })

  it('only pins the current endpoint and requires forgetting trust before changing a fingerprint', () => {
    const c = createConnection(input())
    expect(() => pinSshHostKey(c.id, 'other-host', 22, 'SHA256:wrong')).toThrow(/changed/)
    pinSshHostKey(c.id, c.sshHost!, 22, 'SHA256:first')
    expect(() => pinSshHostKey(c.id, c.sshHost!, 22, 'SHA256:second')).toThrow(/changed/)
    forgetSshHostKey(c.id)
    pinSshHostKey(c.id, c.sshHost!, 22, 'SHA256:second')
    expect(getConnection(c.id)?.sshHostFingerprint).toBe('SHA256:second')
  })

  it('ignores renderer-supplied fingerprints on create and update', () => {
    const c = createConnection({ ...input(), ...{ sshHostFingerprint: 'SHA256:forged' } })
    expect(c.sshHostFingerprint).toBeUndefined()
    pinSshHostKey(c.id, c.sshHost!, 22, 'SHA256:trusted')
    const updated = updateConnection(c.id, {
      label: 'Renamed',
      ...{ sshHostFingerprint: 'SHA256:forged' }
    })!
    expect(updated.sshHostFingerprint).toBe('SHA256:trusted')
  })

  it('validates SSH settings in main, including rejecting SQLite, relative paths and .pub files', () => {
    expect(() => createConnection({ ...input(), dialect: 'sqlite' })).toThrow(
      /MySQL and PostgreSQL/
    )
    expect(() => createConnection({ ...input(), sshPort: 0 })).toThrow(/port/)
    expect(() =>
      createConnection({
        ...input(),
        sshAuthMethod: 'privateKey',
        sshPrivateKeyPath: 'relative-key'
      })
    ).toThrow(/absolute/)
    expect(() =>
      createConnection({
        ...input(),
        sshAuthMethod: 'privateKey',
        sshPrivateKeyPath: join(tmpdir(), 'key.pub')
      })
    ).toThrow(/public key/)
  })
})
