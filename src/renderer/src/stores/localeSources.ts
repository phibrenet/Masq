import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { TableLocaleSource } from '@shared/types'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * Data-driven faker-locale sources (spec §8) for the active workspace, loaded over IPC. One per
 * (workspace, table): the column whose value gives a row's country, plus an optional dot path
 * *inside* that column's JSON for schemas that keep the country in a blob (migration 007).
 * `setSource` upserts on that key; clearing a table's source deletes the row.
 */
export const useLocaleSourcesStore = defineStore('localeSources', () => {
  const all = ref<TableLocaleSource[]>([])
  const loadingWorkspaceId = ref<string | null>(null)
  const workspace = useWorkspaceStore()

  const list = computed<TableLocaleSource[]>(() =>
    all.value.filter((s) => s.workspaceId === workspace.currentWorkspaceId)
  )

  /** Country column configured for a table in the current workspace, or null. */
  function columnFor(tableName: string): string | null {
    return list.value.find((s) => s.tableName === tableName)?.countryColumn ?? null
  }

  /** Dot path within that column's JSON, or null when the column's own value is the country. */
  function pathFor(tableName: string): string | null {
    return list.value.find((s) => s.tableName === tableName)?.countryPath ?? null
  }

  function sourceFor(tableName: string): TableLocaleSource | undefined {
    return list.value.find((s) => s.tableName === tableName)
  }

  /**
   * Why the current workspace's load failed, or `null`. Shown by the view with a retry, so "none
   * configured" and "couldn't be read" never look the same.
   */
  const loadError = ref<string | null>(null)

  async function loadForWorkspace(workspaceId: string): Promise<void> {
    loadingWorkspaceId.value = workspaceId
    loadError.value = null
    try {
      const rows = await window.api.config.listTableLocaleSourcesByWorkspace(workspaceId)
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

  /**
   * Set/replace a table's country source (upsert). `countryPath` is optional: omit it and the
   * column's own value is the country, which is how every source behaved before migration 007.
   */
  async function setSource(
    tableName: string,
    countryColumn: string,
    countryPath?: string | null
  ): Promise<void> {
    const workspaceId = workspace.currentWorkspaceId
    if (!workspaceId) return
    const saved = await window.api.config.setTableLocaleSource({
      workspaceId,
      tableName,
      countryColumn,
      countryPath: countryPath?.trim() || undefined
    })
    const idx = all.value.findIndex(
      (s) => s.workspaceId === saved.workspaceId && s.tableName === saved.tableName
    )
    all.value = idx >= 0 ? all.value.map((s, i) => (i === idx ? saved : s)) : [...all.value, saved]
  }

  /** Clear a table's country column (deletes the row). */
  async function clearFor(tableName: string): Promise<void> {
    const existing = sourceFor(tableName)
    if (!existing) return
    await window.api.config.deleteTableLocaleSource(existing.id)
    all.value = all.value.filter((s) => s.id !== existing.id)
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
    columnFor,
    pathFor,
    sourceFor,
    loadForWorkspace,
    setSource,
    clearFor
  }
})
