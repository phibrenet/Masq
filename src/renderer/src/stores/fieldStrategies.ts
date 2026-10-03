import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { FieldStrategy } from '@shared/types'
import type { FieldStrategyInput } from '@shared/api'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * Field-level anonymization strategies (spec §8) for the active workspace, loaded over IPC.
 * Same shape as the other config stores: `all` caches loaded workspaces, `list` is the
 * current-workspace slice. A strategy is unique per (workspace, table, column); `create`
 * upserts on that key (create-or-replace a column's strategy), `update` edits by id.
 */
export const useFieldStrategiesStore = defineStore('fieldStrategies', () => {
  const all = ref<FieldStrategy[]>([])
  const loadingWorkspaceId = ref<string | null>(null)
  const workspace = useWorkspaceStore()

  const list = computed<FieldStrategy[]>(() =>
    all.value.filter((s) => s.workspaceId === workspace.currentWorkspaceId)
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
      const rows = await window.api.config.listFieldStrategiesByWorkspace(workspaceId)
      all.value = [...all.value.filter((s) => s.workspaceId !== workspaceId), ...rows]
    } catch (err) {
      // Only the newest load reports: an older one finishing late describes a workspace that
      // is no longer on screen.
      if (loadingWorkspaceId.value === workspaceId) loadError.value = (err as Error).message
      throw err
    } finally {
      if (loadingWorkspaceId.value === workspaceId) loadingWorkspaceId.value = null
    }
  }

  /** Create-or-replace a column's strategy in the current workspace; merge the saved row in. */
  async function create(input: Omit<FieldStrategyInput, 'workspaceId'>): Promise<FieldStrategy> {
    const workspaceId = workspace.currentWorkspaceId
    if (!workspaceId) throw new Error('No workspace selected.')
    const saved = await window.api.config.createFieldStrategy({ ...input, workspaceId })
    // Upsert semantics: the saved row may replace an existing (table, column) entry, so key the
    // local merge on id and also drop any prior row for the same column.
    const idx = all.value.findIndex((s) => s.id === saved.id)
    all.value =
      idx >= 0 ? all.value.map((s) => (s.id === saved.id ? saved : s)) : [...all.value, saved]
    return saved
  }

  async function update(
    id: string,
    patch: Partial<FieldStrategyInput>
  ): Promise<FieldStrategy | undefined> {
    const saved = await window.api.config.updateFieldStrategy(id, patch)
    if (saved) all.value = all.value.map((s) => (s.id === id ? saved : s))
    return saved
  }

  async function remove(id: string): Promise<void> {
    await window.api.config.deleteFieldStrategy(id)
    all.value = all.value.filter((s) => s.id !== id)
  }

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
