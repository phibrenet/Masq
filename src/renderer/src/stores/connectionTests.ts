import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * The last connection test per connection, held for the session only. Test results aren't part of
 * the config store (a test says something about *now*, not about the connection), so this keeps them
 * across screen changes for the Connections cards and the sidebar status without persisting anything.
 */
export interface ConnectionTestState {
  ok: boolean
  /** Round trip as the renderer saw it, IPC included. */
  ms: number
  testedAt: number
  tableCount?: number
  error?: string
}

export const useConnectionTestsStore = defineStore('connectionTests', () => {
  const results = ref<Record<string, ConnectionTestState>>({})
  const testing = ref<Set<string>>(new Set())
  /**
   * Bumped by `forget`. An edit keeps the connection's id but can change everything a test
   * describes (host, database, user, password), so a test that was in flight across an edit
   * describes the old endpoint and must not land.
   */
  const generation = new Map<string, number>()

  /** Run a test and record the outcome. Resolves to the recorded state. */
  async function test(connectionId: string): Promise<ConnectionTestState> {
    testing.value = new Set(testing.value).add(connectionId)
    const startedGeneration = generation.get(connectionId) ?? 0
    const started = performance.now()
    try {
      const result = await window.api.source.testConnection(connectionId)
      const state: ConnectionTestState = {
        ok: result.ok,
        ms: Math.round(performance.now() - started),
        testedAt: Date.now(),
        tableCount: result.tableCount,
        error: result.error
      }
      if ((generation.get(connectionId) ?? 0) === startedGeneration) {
        results.value = { ...results.value, [connectionId]: state }
      }
      return state
    } finally {
      const next = new Set(testing.value)
      next.delete(connectionId)
      testing.value = next
    }
  }

  /**
   * Drop a connection's result — called whenever it's edited or deleted, so the card and the sidebar
   * never present a test of the previous configuration as a test of this one. A password change is
   * invisible to the renderer, so clearing on every edit is the only reliable signal.
   */
  function forget(connectionId: string): void {
    generation.set(connectionId, (generation.get(connectionId) ?? 0) + 1)
    if (!(connectionId in results.value)) return
    const next = { ...results.value }
    delete next[connectionId]
    results.value = next
  }

  return { results, testing, test, forget }
})
