import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { FrameworkId, PresetApplyResult, TableClass, TableClassification } from '@shared/types'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * Table classifications (spec §5) for the active workspace, loaded over IPC. Same shape as
 * the connections store: `all` caches loaded workspaces, `list` is the current-workspace
 * slice. A classification is unique per (workspace, table); `setClass` upserts.
 *
 * Until the MySQL adapter lands (step 3), the table list is populated manually or via the
 * framework presets — introspection will later feed real names into this same store.
 */
export const useTableClassificationsStore = defineStore('tableClassifications', () => {
  const all = ref<TableClassification[]>([])
  const loadingWorkspaceId = ref<string | null>(null)
  const workspace = useWorkspaceStore()

  const list = computed<TableClassification[]>(() =>
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
      const rows = await window.api.config.listTableClassificationsByWorkspace(workspaceId)
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
   * Upsert a table's class for an explicit workspace and merge the row back into `all`.
   * The workspace id is passed in (not read from the store mid-write) so a workspace switch
   * during a batch or an in-flight call can't misroute the write. Merge is keyed by
   * (workspaceId, tableName), so writing to a non-current workspace's slice is safe.
   */
  async function setClassFor(
    workspaceId: string,
    tableName: string,
    klass: TableClass
  ): Promise<void> {
    const saved = await window.api.config.setTableClassification({
      workspaceId,
      tableName,
      class: klass
    })
    const idx = all.value.findIndex(
      (c) => c.workspaceId === saved.workspaceId && c.tableName === saved.tableName
    )
    all.value = idx >= 0 ? all.value.map((c, i) => (i === idx ? saved : c)) : [...all.value, saved]
  }

  /** Upsert a table's class in the current workspace. */
  async function setClass(tableName: string, klass: TableClass): Promise<void> {
    const workspaceId = workspace.currentWorkspaceId
    if (!workspaceId) return
    await setClassFor(workspaceId, tableName, klass)
  }

  async function remove(id: string): Promise<void> {
    await window.api.config.deleteTableClassification(id)
    all.value = all.value.filter((c) => c.id !== id)
  }

  /**
   * Apply a framework's table presets to the active workspace and reload, since the operation is a
   * single transaction in main and can touch many rows. Main owns the refresh-vs-skip decision —
   * it is the only side that can read and write the rows atomically.
   */
  async function applyFrameworkPresets(frameworkId: FrameworkId): Promise<PresetApplyResult> {
    const workspaceId = workspace.currentWorkspaceId
    if (!workspaceId) return { added: 0, refreshed: 0, skippedManual: [] }
    const result = await window.api.config.applyFrameworkPresets(workspaceId, frameworkId)
    await loadForWorkspace(workspaceId)
    return result
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
    loadForWorkspace,
    setClass,
    remove,
    applyFrameworkPresets
  }
})
