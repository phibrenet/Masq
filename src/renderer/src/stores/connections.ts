import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { ConnectionInput } from '@shared/api'
import type { Connection } from '@shared/types'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { useConnectionTestsStore } from '@renderer/stores/connectionTests'

/**
 * Connections for the active workspace, loaded from the config store over IPC. `all`
 * caches whatever workspaces have been loaded; `list` is the current-workspace slice the
 * UI binds to. Switching workspace triggers a lazy load via the watcher below.
 */
export const useConnectionsStore = defineStore('connections', () => {
  const all = ref<Connection[]>([])
  const loadingWorkspaceId = ref<string | null>(null)
  const workspace = useWorkspaceStore()
  const tests = useConnectionTestsStore()

  const list = computed<Connection[]>(() =>
    all.value.filter((c) => c.workspaceId === workspace.currentWorkspaceId)
  )

  const loading = computed(() => loadingWorkspaceId.value !== null)

  /**
   * Why the current workspace's load failed, or `null`. Shown by the view with a retry, so "none
   * configured" and "couldn't be read" never look the same.
   */
  const loadError = ref<string | null>(null)

  async function loadForWorkspace(workspaceId: string): Promise<void> {
    loadingWorkspaceId.value = workspaceId
    loadError.value = null
    try {
      const rows = await window.api.config.listConnectionsByWorkspace(workspaceId)
      // Replace this workspace's slice, leaving other cached workspaces intact.
      all.value = [...all.value.filter((c) => c.workspaceId !== workspaceId), ...rows]
    } catch (err) {
      // Only the newest load reports: an older one finishing late describes a workspace that
      // is no longer on screen.
      if (loadingWorkspaceId.value === workspaceId) loadError.value = (err as Error).message
      throw err
    } finally {
      if (loadingWorkspaceId.value === workspaceId) loadingWorkspaceId.value = null
    }
  }

  /**
   * Persist a new connection, then (if given) store its password in the keychain. The
   * created row is merged into `all` so the current-workspace `list` updates without a
   * refetch. Password is sent once, separately — it never lives on the `Connection`.
   */
  async function create(input: ConnectionInput, password?: string): Promise<Connection> {
    const created = await window.api.config.createConnection(input)
    if (password) {
      try {
        await window.api.config.setPassword(created.id, password)
      } catch (err) {
        // The row must exist before its credential (FK), so we can't store the password
        // first here. If the keychain write fails, roll the orphaned row back so a failed
        // save leaves no half-created connection behind.
        await window.api.config.deleteConnection(created.id).catch(() => {})
        throw err
      }
    }
    all.value = [...all.value, created]
    return created
  }

  /**
   * Persist changes to an existing connection. If a non-empty password is given, replace its
   * keychain entry *first*: that's the step that can realistically fail (keychain may be
   * unavailable), so doing it before the row write means a failure leaves nothing half-applied
   * — no case where the DB holds the new host/user with the old password while the UI reports
   * failure. An empty/undefined password leaves the stored one intact. The updated row is
   * merged back into `all` so `list` reflects it without a refetch.
   */
  async function update(
    id: string,
    patch: Partial<ConnectionInput>,
    password?: string
  ): Promise<Connection | undefined> {
    // Up front, even if the save then fails: the password step may already have changed what a
    // test would find, and "Not tested" is the honest state either way.
    tests.forget(id)
    if (password) await window.api.config.setPassword(id, password)
    const updated = await window.api.config.updateConnection(id, patch)
    if (updated) all.value = all.value.map((c) => (c.id === id ? updated : c))
    return updated
  }

  async function remove(id: string): Promise<void> {
    await window.api.config.deleteConnection(id)
    all.value = all.value.filter((c) => c.id !== id)
    tests.forget(id)
  }

  // Auto-load whenever the active workspace changes (including the initial selection,
  // which resolves once the workspace store's load() completes).
  watch(
    () => workspace.currentWorkspaceId,
    (id) => {
      // Recorded in `loadError` for the view; nothing further to do with it here.
      if (id) loadForWorkspace(id).catch(() => {})
    },
    { immediate: true }
  )

  return { loadError, all, list, loading, loadForWorkspace, create, update, remove }
})
