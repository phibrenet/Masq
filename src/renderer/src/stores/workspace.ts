import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { WorkspaceInput } from '@shared/api'
import type { Workspace } from '@shared/types'

/**
 * Current workspace + the list to switch between. Every other store scopes its data by
 * `currentWorkspaceId`. Data comes from the config store over IPC (`window.api.config`);
 * the shared types keep the renderer and main process in sync.
 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const workspaces = ref<Workspace[]>([])
  const currentWorkspaceId = ref<string | null>(null)
  /** Why the workspace list couldn't be read, or `null`. Shown app-wide by `App.vue`. */
  const loadError = ref<string | null>(null)

  const currentWorkspace = computed<Workspace | null>(
    () => workspaces.value.find((w) => w.id === currentWorkspaceId.value) ?? null
  )

  async function load(): Promise<void> {
    try {
      workspaces.value = await window.api.config.listWorkspaces()
      loadError.value = null
    } catch (err) {
      loadError.value = (err as Error).message
      throw err
    }
    // Keep the current selection if it still exists, otherwise fall back to the first.
    if (!workspaces.value.some((w) => w.id === currentWorkspaceId.value)) {
      currentWorkspaceId.value = workspaces.value[0]?.id ?? null
    }
  }

  function select(id: string): void {
    if (workspaces.value.some((w) => w.id === id)) {
      currentWorkspaceId.value = id
    }
  }

  /** Create a workspace and make it the active one. */
  async function create(input: WorkspaceInput): Promise<Workspace> {
    const created = await window.api.config.createWorkspace(input)
    workspaces.value = [...workspaces.value, created]
    currentWorkspaceId.value = created.id
    return created
  }

  async function update(
    id: string,
    patch: Partial<WorkspaceInput>
  ): Promise<Workspace | undefined> {
    const updated = await window.api.config.updateWorkspace(id, patch)
    if (updated) workspaces.value = workspaces.value.map((w) => (w.id === id ? updated : w))
    return updated
  }

  /** Delete a workspace (cascades to its connections/rules/etc. in the DB). Falls the
   * selection back to the first remaining workspace if the active one was removed. */
  async function remove(id: string): Promise<void> {
    await window.api.config.deleteWorkspace(id)
    workspaces.value = workspaces.value.filter((w) => w.id !== id)
    if (currentWorkspaceId.value === id) {
      currentWorkspaceId.value = workspaces.value[0]?.id ?? null
    }
  }

  return {
    workspaces,
    currentWorkspaceId,
    currentWorkspace,
    loadError,
    load,
    select,
    create,
    update,
    remove
  }
})
