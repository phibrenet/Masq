import { safeStorage } from 'electron'
import { getDb } from './db'

/**
 * DB passwords go through Electron `safeStorage` (OS keychain) and only the encrypted
 * blob is stored, keyed by connection_id (spec §11). The config SQLite file never holds
 * a plaintext secret. If OS-level encryption isn't available we refuse rather than
 * silently degrade to plaintext.
 */

function assertAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS credential encryption is unavailable — refusing to store the password in plaintext.'
    )
  }
}

/**
 * On Linux, "available" can mean the `basic_text` backend: no secret store was found, so Electron
 * encrypts with a fixed key built into Chromium. That is obfuscation, not protection, so a new
 * password is refused there. Reading one stored earlier still works, so nothing already saved breaks.
 */
function assertProtected(): void {
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    throw new Error(
      'No OS keyring was found (GNOME Keyring or KWallet), so the password could only be stored ' +
        'with a fixed key — refusing to save it. Install or unlock a keyring and try again.'
    )
  }
}

export function setPassword(connectionId: string, plaintext: string): void {
  assertAvailable()
  assertProtected()
  const encrypted = safeStorage.encryptString(plaintext)
  getDb()
    .prepare(
      `INSERT INTO credentials (connection_id, encrypted_password) VALUES (?, ?)
       ON CONFLICT (connection_id) DO UPDATE SET encrypted_password = excluded.encrypted_password`
    )
    .run(connectionId, encrypted)
}

export function getPassword(connectionId: string): string | undefined {
  const row = getDb()
    .prepare('SELECT encrypted_password FROM credentials WHERE connection_id = ?')
    .get(connectionId) as { encrypted_password: Buffer } | undefined
  if (!row) return undefined
  assertAvailable()
  return safeStorage.decryptString(row.encrypted_password)
}

export function hasPassword(connectionId: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM credentials WHERE connection_id = ?').get(connectionId)
  return row !== undefined
}
