import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { TableIdentitySource } from '@shared/types'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * Declared identity sources (migration 008) for the active workspace, loaded over IPC. One per
 * (workspace, table): the column holding the owning entity's id, and the table that entity lives in.
 *
 * This is what makes a table's fake values follow the *right* person when the FK graph can't tell:
 * cross-table identity otherwise flows down every cascade edge, so `comments` inherits the identity of
 * the post's author rather than the commenter's. Declaring `comments.user_id → users` overrides it.
 *
 * Mirrors `localeSources` deliberately — both are per-table "where does this value come from" hints,
 * so they read and behave the same way.
 */
export const useIdentitySourcesStore = defineStore('identitySources', () => {
  const all = ref<TableIdentitySource[]>([])
  const loadingWorkspaceId = ref<string | null>(null)
  const workspace = useWorkspaceStore()

  const list = computed<TableIdentitySource[]>(() =>
    all.value.filter((s) => s.workspaceId === workspace.currentWorkspaceId)
  )

  function sourceFor(tableName: string): TableIdentitySource | undefined {
    return list.value.find((s) => s.tableName === tableName)
  }

  /** The declared identity column for a table, or null. */
  function columnFor(tableName: string): string | null {
    return sourceFor(tableName)?.identityColumn ?? null
  }

  /** The table the declared entity lives in, or null. */
  function tableFor(tableName: string): string | null {
    return sourceFor(tableName)?.identityTable ?? null
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
      const rows = await window.api.config.listTableIdentitySourcesByWorkspace(workspaceId)
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
   * Set/replace a table's identity source (upsert). Both halves are required — an id alone can't name
   * an entity — so the caller only invokes this once it has a column *and* a table.
   */
  async function setSource(
    tableName: string,
    identityColumn: string,
    identityTable: string
  ): Promise<void> {
    const workspaceId = workspace.currentWorkspaceId
    if (!workspaceId) return
    const saved = await window.api.config.setTableIdentitySource({
      workspaceId,
      tableName,
      identityColumn,
      identityTable
    })
    const idx = all.value.findIndex(
      (s) => s.workspaceId === saved.workspaceId && s.tableName === saved.tableName
    )
    all.value = idx >= 0 ? all.value.map((s, i) => (i === idx ? saved : s)) : [...all.value, saved]
  }

  /** Clear a table's identity source, so the cascade's inference applies again. */
  async function clearFor(tableName: string): Promise<void> {
    const existing = sourceFor(tableName)
    if (!existing) return
    await window.api.config.deleteTableIdentitySource(existing.id)
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
    tableFor,
    sourceFor,
    loadForWorkspace,
    setSource,
    clearFor
  }
})
