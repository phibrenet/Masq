import { describe, expect, it } from 'vitest'
import type { DbAdapter } from '../../src/main/adapters/types'
import {
  CancelledError,
  inFlightRunIds,
  registerRun,
  requestCancel,
  throwIfCancelled,
  unregisterRun,
  withCancellation
} from '../../src/main/extract/cancel'

/**
 * Run cancellation. The design bet is that wrapping the adapter reaches every stage — selection,
 * cascade, backfill and the dump writer all go through it — so these tests are mostly about the
 * proxy behaving like the adapter until the moment it shouldn't.
 */

function fakeAdapter(): { adapter: DbAdapter; calls: string[] } {
  const calls: string[] = []
  const adapter = {
    name: 'fake',
    getTables: async () => {
      calls.push('getTables')
      return ['users']
    },
    countRows: async () => {
      calls.push('countRows')
      return 1
    }
  } as unknown as DbAdapter
  return { adapter, calls }
}

describe('the cancellation registry', () => {
  it('signals a specific run and reports what it signalled', () => {
    const signal = registerRun('run-a')
    try {
      expect(signal.aborted).toBe(false)
      expect(requestCancel('run-a')).toEqual(['run-a'])
      expect(signal.aborted).toBe(true)
    } finally {
      unregisterRun('run-a')
    }
  })

  it('cancels every in-flight run when given no id — what the Stop button sends', () => {
    const a = registerRun('run-a')
    const b = registerRun('run-b')
    try {
      expect(requestCancel().sort()).toEqual(['run-a', 'run-b'])
      expect(a.aborted && b.aborted).toBe(true)
    } finally {
      unregisterRun('run-a')
      unregisterRun('run-b')
    }
  })

  it('reports nothing signalled rather than throwing when no run is in flight', () => {
    // Not an error: a run that finished between the button rendering and the click is a normal
    // race, and the renderer says "nothing is running" rather than showing a failure.
    expect(requestCancel()).toEqual([])
    expect(requestCancel('never-existed')).toEqual([])
  })

  it('forgets a run once unregistered, so a later cancel is a no-op', () => {
    registerRun('run-a')
    unregisterRun('run-a')

    expect(inFlightRunIds()).toEqual([])
    expect(requestCancel('run-a')).toEqual([])
  })
})

describe('withCancellation', () => {
  it('passes calls straight through while the signal is clear', async () => {
    const { adapter, calls } = fakeAdapter()
    const wrapped = withCancellation(adapter, new AbortController().signal)

    await expect(wrapped.getTables()).resolves.toEqual(['users'])
    expect(calls).toEqual(['getTables'])
  })

  it('throws before reaching the adapter once cancelled', async () => {
    const { adapter, calls } = fakeAdapter()
    const controller = new AbortController()
    const wrapped = withCancellation(adapter, controller.signal)

    controller.abort()

    expect(() => wrapped.getTables()).toThrow(CancelledError)
    // The point of checking *before* delegating: no further load is put on a source the user has
    // already asked to be left alone.
    expect(calls).toEqual([])
  })

  it('covers every method, so no stage has to opt in', async () => {
    const { adapter } = fakeAdapter()
    const controller = new AbortController()
    const wrapped = withCancellation(adapter, controller.signal)

    await wrapped.countRows('users', { now: new Date() })
    controller.abort()

    expect(() => wrapped.countRows('users', { now: new Date() })).toThrow(CancelledError)
  })

  it('sets cancellationSignal on the adapter, so chunked methods can check mid-call', () => {
    // The regression that made Stop look broken. `getRowsReferencing` and friends slice a large id
    // set into IN-chunks and run one query per chunk **inside one call** — a cascade over a few
    // hundred thousand ids issues hundreds of queries between two proxy checks. The proxy alone
    // cannot interrupt that; the signal on the target is what lets those loops check per chunk.
    const { adapter } = fakeAdapter()
    const controller = new AbortController()

    withCancellation(adapter, controller.signal)

    expect(adapter.cancellationSignal).toBe(controller.signal)
    controller.abort()
    expect(() => throwIfCancelled(adapter.cancellationSignal)).toThrow(CancelledError)
  })

  it('leaves non-function properties alone', () => {
    const { adapter } = fakeAdapter()
    const wrapped = withCancellation(adapter, new AbortController().signal) as unknown as {
      name: string
    }

    expect(wrapped.name).toBe('fake')
  })
})

describe('throwIfCancelled', () => {
  it('is a no-op without a signal, so the parameter can stay optional', () => {
    expect(() => throwIfCancelled(undefined)).not.toThrow()
  })

  it("throws once aborted — the dump writer's per-row check", () => {
    const controller = new AbortController()
    controller.abort()

    expect(() => throwIfCancelled(controller.signal)).toThrow(CancelledError)
  })
})
