import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Connection } from '@shared/types'
import { verifySshHostKey } from '../../src/main/adapters/ssh-host-key'

const mocks = vi.hoisted(() => ({
  current: undefined as Connection | undefined,
  pin: vi.fn(),
  prompt: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] },
  dialog: { showMessageBox: mocks.prompt }
}))
vi.mock('../../src/main/config/repositories/connections', () => ({
  getConnection: () => mocks.current,
  pinSshHostKey: mocks.pin
}))
const connection: Connection = {
  id: 'c',
  workspaceId: 'w',
  label: 'SSH',
  dialect: 'mysql',
  role: 'source',
  sshEnabled: true,
  sshHost: 'bastion.example.com',
  sshPort: 22
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.current = { ...connection }
})
describe('SSH host trust', () => {
  it('pins a first host key only after explicit native-dialog acceptance', async () => {
    mocks.prompt.mockResolvedValue({ response: 1 })
    expect(await verifySshHostKey(connection, 'SHA256:first')).toBe(true)
    expect(mocks.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultId: 0,
        cancelId: 0,
        detail: expect.stringContaining('SHA256:first')
      })
    )
    expect(mocks.pin).toHaveBeenCalledWith('c', 'bastion.example.com', 22, 'SHA256:first')
  })
  it('cancels without saving a key', async () => {
    mocks.prompt.mockResolvedValue({ response: 0 })
    expect(await verifySshHostKey(connection, 'SHA256:first')).toBe(false)
    expect(mocks.pin).not.toHaveBeenCalled()
  })
  it('accepts a matching pin without prompting and rejects mismatches without an override prompt', async () => {
    mocks.current!.sshHostFingerprint = 'SHA256:first'
    expect(await verifySshHostKey(connection, 'SHA256:first')).toBe(true)
    await expect(verifySshHostKey(connection, 'SHA256:other')).rejects.toThrow(
      /Expected SHA256:first; received SHA256:other/
    )
    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(mocks.pin).not.toHaveBeenCalled()
  })
  it('does not trust a stale connection endpoint', async () => {
    mocks.current!.sshHost = 'another.example.com'
    await expect(verifySshHostKey(connection, 'SHA256:first')).rejects.toThrow(/settings changed/)
    expect(mocks.prompt).not.toHaveBeenCalled()
  })
  it('shares a pending first-trust prompt for concurrent operations', async () => {
    let accept!: (result: { response: number }) => void
    mocks.prompt.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve
      })
    )
    const a = verifySshHostKey(connection, 'SHA256:first')
    const b = verifySshHostKey(connection, 'SHA256:first')
    expect(mocks.prompt).toHaveBeenCalledTimes(1)
    accept({ response: 1 })
    expect(await Promise.all([a, b])).toEqual([true, true])
    expect(mocks.pin).toHaveBeenCalledTimes(2)
  })
  it('does not pin a host key if the operation expires while the trust dialog is open', async () => {
    let accept!: (result: { response: number }) => void
    mocks.prompt.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve
      })
    )
    const lifetime = new AbortController()
    const decision = verifySshHostKey(connection, 'SHA256:first', lifetime.signal)
    lifetime.abort()
    accept({ response: 1 })
    expect(await decision).toBe(false)
    expect(mocks.pin).not.toHaveBeenCalled()
  })
  it('allows a live concurrent operation to trust even when the first one expired', async () => {
    let accept!: (result: { response: number }) => void
    mocks.prompt.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve
      })
    )
    const lifetime = new AbortController()
    const expired = verifySshHostKey(connection, 'SHA256:first', lifetime.signal)
    const live = verifySshHostKey(connection, 'SHA256:first', new AbortController().signal)
    lifetime.abort()
    accept({ response: 1 })
    expect(await Promise.all([expired, live])).toEqual([false, true])
    expect(mocks.pin).toHaveBeenCalledTimes(1)
  })
})
