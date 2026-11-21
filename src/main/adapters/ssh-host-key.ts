import { BrowserWindow, dialog } from 'electron'
import type { Connection } from '@shared/types'
import { getConnection, pinSshHostKey } from '../config/repositories/connections'

const pending = new Map<string, Promise<boolean>>()

/** Trust must be granted in main's native UI, never by a renderer-supplied fingerprint. */
export async function verifySshHostKey(
  connection: Connection,
  fingerprint: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return false
  const current = getConnection(connection.id)
  if (
    !current ||
    !current.sshEnabled ||
    current.sshHost !== connection.sshHost ||
    current.sshPort !== connection.sshPort
  ) {
    throw new Error('SSH settings changed. Test the connection again.')
  }
  if (current.sshHostFingerprint) {
    if (current.sshHostFingerprint !== fingerprint) {
      throw new Error(
        `SSH host key changed for ${connection.sshHost}:${connection.sshPort}. Expected ${current.sshHostFingerprint}; received ${fingerprint}. Verify the change with the server administrator before forgetting the saved key.`
      )
    }
    return true
  }
  const key = JSON.stringify([connection.id, connection.sshHost, connection.sshPort, fingerprint])
  const existing = pending.get(key)
  const prompt =
    existing ??
    (async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options = {
        type: 'warning' as const,
        title: 'Trust SSH server?',
        message: `First connection to ${connection.sshHost}:${connection.sshPort}`,
        detail: `Server host key fingerprint:\n${fingerprint}\n\nCompare this with a fingerprint provided by your server administrator before trusting it. Masq will remember this key and refuse a changed key.`,
        buttons: ['Cancel', 'Trust and remember'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }
      const result = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options)
      return result.response === 1
    })()
  pending.set(key, prompt)
  try {
    const accepted = await prompt
    if (!accepted || signal?.aborted) return false
    pinSshHostKey(connection.id, connection.sshHost!, connection.sshPort ?? 22, fingerprint)
    return true
  } finally {
    if (pending.get(key) === prompt) pending.delete(key)
  }
}
