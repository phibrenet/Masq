import type { Connection } from './types'

export type SshSettings = Pick<
  Connection,
  'sshEnabled' | 'sshHost' | 'sshPort' | 'sshUsername' | 'sshAuthMethod' | 'sshPrivateKeyPath'
>

/** Passwords authenticate remotely; a passphrase only unlocks the same local key file. */
export function sshSecretMatches(
  saved: SshSettings | null | undefined,
  draft: SshSettings
): boolean {
  if (!saved?.sshEnabled || !draft.sshEnabled || saved.sshAuthMethod !== draft.sshAuthMethod)
    return false
  if (draft.sshAuthMethod === 'privateKey') {
    return Boolean(saved.sshPrivateKeyPath && saved.sshPrivateKeyPath === draft.sshPrivateKeyPath)
  }
  return (
    draft.sshAuthMethod === 'password' &&
    saved.sshHost === draft.sshHost &&
    (saved.sshPort ?? 22) === (draft.sshPort ?? 22) &&
    saved.sshUsername === draft.sshUsername
  )
}
