import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { ConnectionInput, ConnectionSecrets } from '@shared/api'
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
   * Main saves settings and encrypted credentials atomically. Secrets are write-only arguments,
   * never properties on the returned Connection or this store's cached values.
   */
  async function create(input: ConnectionInput, secrets?: ConnectionSecrets): Promise<Connection> {
    const created = await window.api.config.createConnection(input, secrets)
    all.value = [...all.value, created]
    return created
  }

  /**
   * Main updates settings and credentials in one transaction. Omitted secrets are preserved
   * unless the SSH identity changes; an explicit empty string clears a stored secret.
   */
  async function update(
    id: string,
    patch: Partial<ConnectionInput>,
    secrets?: ConnectionSecrets
  ): Promise<Connection | undefined> {
    // Up front, even if the save then fails: the password step may already have changed what a
    // test would find, and "Not tested" is the honest state either way.
    tests.forget(id)
    const updated = await window.api.config.updateConnection(id, patch, secrets)
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
