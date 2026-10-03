import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { Run } from '@shared/types'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { useConnectionsStore } from '@renderer/stores/connections'

/**
 * Run history (spec §10) for the active workspace, loaded over IPC, plus the trigger for a new
 * extract. `run()` calls the `extract:runExtract` pipeline against the workspace's source
 * connection and reloads the list when it settles (success or failure — a failed run is still
 * recorded).
 */
export const useRunsStore = defineStore('runs', () => {
  const all = ref<Run[]>([])
  const loadingWorkspaceId = ref<string | null>(null)
  const running = ref(false)
  const cancelling = ref(false)
  /** Interval watching an *adopted* run — one this renderer has no `run()` promise for. */
  let pollTimer: number | null = null
  /** A `run()` call from this renderer is in flight — it, not `syncRunning`, owns `running`. */
  let ownRunInFlight = false
  const workspace = useWorkspaceStore()
  const connections = useConnectionsStore()

  const list = computed<Run[]>(() =>
    all.value.filter((r) => r.workspaceId === workspace.currentWorkspaceId)
  )
  const loading = computed(() => loadingWorkspaceId.value !== null)

  /** First source-role connection in the workspace — what an extract reads from. */
  const sourceConnection = computed(() => connections.list.find((c) => c.role === 'source') ?? null)

  /**
   * Why the current workspace's load failed, or `null`. Shown by the view with a retry, so "none
   * configured" and "couldn't be read" never look the same.
   */
  const loadError = ref<string | null>(null)

  async function loadForWorkspace(workspaceId: string): Promise<void> {
    loadingWorkspaceId.value = workspaceId
    loadError.value = null
    try {
      const rows = await window.api.config.listRunsByWorkspace(workspaceId)
      all.value = [...all.value.filter((r) => r.workspaceId !== workspaceId), ...rows]
    } catch (err) {
      // Only the newest load reports: an older one finishing late describes a workspace that
      // is no longer on screen.
      if (loadingWorkspaceId.value === workspaceId) loadError.value = (err as Error).message
      throw err
    } finally {
      if (loadingWorkspaceId.value === workspaceId) loadingWorkspaceId.value = null
    }
  }

  /** Run an extract against the workspace's source connection, then refresh the history. */
  async function run(): Promise<Run> {
    const workspaceId = workspace.currentWorkspaceId
    if (!workspaceId) throw new Error('No workspace selected.')
    const conn = sourceConnection.value
    if (!conn) throw new Error('No source connection in this workspace.')
    running.value = true
    ownRunInFlight = true
    try {
      const result = await window.api.extract.runExtract(conn.id, workspaceId)
      return result
    } finally {
      ownRunInFlight = false
      // This call owns the run's promise, so the poll — if `syncRunning` had adopted one — has
      // nothing left to watch.
      stopPolling()
      running.value = false
      // Reload regardless of outcome — a failed run is recorded too.
      if (workspace.currentWorkspaceId === workspaceId) await loadForWorkspace(workspaceId)
    }
  }

  /**
   * Ask the in-flight run to stop. Cooperative: the pipeline notices at its next source query or
   * emitted row, so `running` stays true until `run()`'s own promise settles — which is honest,
   * because the run really is still winding down.
   *
   * Returns whether anything was signalled. Nothing running isn't an error: a run that finished
   * between the button rendering and the click is a normal race, not a failure.
   */
  async function cancel(): Promise<boolean> {
    cancelling.value = true
    try {
      return (await window.api.extract.cancelRun()).length > 0
    } finally {
      cancelling.value = false
    }
  }

  /**
   * Reconcile `running` with the main process, which is the only place that actually knows.
   *
   * Needed because `running` is set by *this* store when it starts a run — so a reload of the
   * renderer, or opening the Runs screen while a run started elsewhere is in flight, would show no
   * run in progress and offer no way to stop it.
   *
   * Adopting a run this renderer didn't start means adopting it *without a promise to await*, so it
   * also starts polling. Without that the screen sat on "Running…" forever after a reload: the run
   * finished in the main process and nothing here was listening.
   */
  async function syncRunning(): Promise<void> {
    const inFlight = (await window.api.extract.runningRunIds()).length > 0
    // The top bar's Run button starts a run as it opens the Runs screen, whose mount calls this. The
    // main process may not have registered that run yet, and "nothing running" must not overwrite it.
    if (ownRunInFlight) return
    running.value = inFlight
    if (running.value) startPolling()
  }

  /**
   * Watch an adopted run until the main process reports nothing in flight, then refresh the history.
   *
   * Polling rather than an IPC event because the main process would have to know which renderers
   * care and survive them reloading — the exact problem being solved. Four seconds is slow enough to
   * be free and fast enough that the screen settles before anyone reaches for the menu.
   */
  function startPolling(): void {
    if (pollTimer !== null) return // one watcher, however many times this is called
    pollTimer = window.setInterval(() => {
      void (async () => {
        let ids: string[]
        try {
          ids = await window.api.extract.runningRunIds()
        } catch {
          return // transient; the next tick tries again rather than declaring the run over
        }
        if (ids.length > 0) return
        stopPolling()
        running.value = false
        const workspaceId = workspace.currentWorkspaceId
        if (workspaceId) await loadForWorkspace(workspaceId)
      })()
    }, 4000)
  }

  function stopPolling(): void {
    if (pollTimer === null) return
    window.clearInterval(pollTimer)
    pollTimer = null
  }

  watch(
    () => workspace.currentWorkspaceId,
    (id) => {
      // Recorded in `loadError` for the view; nothing further to do with it here.
      if (id) loadForWorkspace(id).catch(() => {})
    },
    { immediate: true }
  )

  return {
    loadError,
    all,
    list,
    loading,
    running,
    cancelling,
    sourceConnection,
    loadForWorkspace,
    run,
    cancel,
    syncRunning
  }
})
