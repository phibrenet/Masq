import { describe, expect, it } from 'vitest'
import { sshSecretMatches, type SshSettings } from '../../src/shared/ssh'

const key: SshSettings = {
  sshEnabled: true,
  sshHost: 'old.example.com',
  sshPort: 22,
  sshUsername: 'reader',
  sshAuthMethod: 'privateKey',
  sshPrivateKeyPath: '/keys/id'
}
describe('saved SSH secret policy used by the renderer and main', () => {
  it('keeps a local key passphrase when the server or user changes', () => {
    expect(
      sshSecretMatches(key, {
        ...key,
        sshHost: 'new.example.com',
        sshPort: 2222,
        sshUsername: 'other'
      })
    ).toBe(true)
  })
  it('requires a new passphrase for another key or authentication method', () => {
    expect(sshSecretMatches(key, { ...key, sshPrivateKeyPath: '/keys/other' })).toBe(false)
    expect(sshSecretMatches(key, { ...key, sshAuthMethod: 'password' })).toBe(false)
    expect(sshSecretMatches(key, { ...key, sshEnabled: false })).toBe(false)
  })
  it('keeps a password only for the same SSH endpoint and user', () => {
    const password = { ...key, sshAuthMethod: 'password' as const }
    expect(sshSecretMatches(password, { ...password })).toBe(true)
    for (const patch of [
      { sshHost: 'new.example.com' },
      { sshPort: 2222 },
      { sshUsername: 'other' },
      { sshAuthMethod: 'privateKey' as const }
    ]) {
      expect(sshSecretMatches(password, { ...password, ...patch })).toBe(false)
    }
  })
})
