import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { SelectionRule } from '@shared/types'
import type { SelectionRuleInput } from '@shared/api'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * Row-selection rules (spec §6) for the active workspace, loaded over IPC. Same shape as the
 * connections store: `all` caches loaded workspaces, `list` is the current-workspace slice.
 * Unlike table classifications, a table may carry several rules, so this is plain CRUD by id
 * (create/update/remove) rather than upsert-on-unique.
 */
export const useSelectionRulesStore = defineStore('selectionRules', () => {
  const all = ref<SelectionRule[]>([])
  const loadingWorkspaceId = ref<string | null>(null)
  const workspace = useWorkspaceStore()

  const list = computed<SelectionRule[]>(() =>
    all.value.filter((r) => r.workspaceId === workspace.currentWorkspaceId)
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
      const rows = await window.api.config.listSelectionRulesByWorkspace(workspaceId)
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

  /** Create a rule in the current workspace and merge the saved row into `all`. */
  async function create(input: Omit<SelectionRuleInput, 'workspaceId'>): Promise<SelectionRule> {
    const workspaceId = workspace.currentWorkspaceId
    if (!workspaceId) throw new Error('No workspace selected.')
    const saved = await window.api.config.createSelectionRule({ ...input, workspaceId })
    all.value = [...all.value, saved]
    return saved
  }

  async function update(
    id: string,
    patch: Partial<SelectionRuleInput>
  ): Promise<SelectionRule | undefined> {
    const saved = await window.api.config.updateSelectionRule(id, patch)
    if (saved) all.value = all.value.map((r) => (r.id === id ? saved : r))
    return saved
  }

  async function remove(id: string): Promise<void> {
    await window.api.config.deleteSelectionRule(id)
    all.value = all.value.filter((r) => r.id !== id)
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
