import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { BackfillPolicyKind, FkBackfillPolicy, ForeignKeyEdge } from '@shared/types'
import { useDiscoveryStore } from '@renderer/stores/discovery'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * Per-edge parent-backfill policies for the active workspace (migration 009), plus the source's
 * foreign-key graph the screen lists them against.
 *
 * Two kinds of state, on the same split as the morph store: **policies** are persisted config, while
 * **edges** are a live-source concept cached in memory per workspace for the session. Keeping the
 * edges here rather than in the view means they survive navigating away and back — the graph is one
 * introspection call, but on a real schema it's ~90 edges across ~40 tables and re-reading it on
 * every visit is a pointless round trip.
 *
 * The store presents `follow` as the absence of a row, which is what the config table means. Setting
 * an edge back to `follow` therefore *deletes* rather than storing the default, so the table stays a
 * short list of deliberate exceptions instead of a mirror of the schema.
 */
export const useBackfillPoliciesStore = defineStore('backfillPolicies', () => {
  const all = ref<FkBackfillPolicy[]>([])
  const loadingWorkspaceId = ref<string | null>(null)
  /** Keyed by `discovery.sourceKey`, so edges from a database the source no longer points at go. */
  const edgesBySource = ref<Record<string, ForeignKeyEdge[]>>({})
  const loadingEdgesWorkspaceId = ref<string | null>(null)
  const workspace = useWorkspaceStore()
  const discovery = useDiscoveryStore()

  const list = computed<FkBackfillPolicy[]>(() =>
    all.value.filter((p) => p.workspaceId === workspace.currentWorkspaceId)
  )

  const loading = computed(() => loadingWorkspaceId.value !== null)
  const loadingEdges = computed(() => loadingEdgesWorkspaceId.value !== null)

  /** Introspected FK edges for the active source (empty until `loadEdges` runs). */
  const edges = computed<ForeignKeyEdge[]>(() => {
    const source = discovery.sourceKey
    return source ? (edgesBySource.value[source] ?? []) : []
  })

  /**
   * Whether the links have been read from the active source this session — true even when the read
   * found none, which is a finished answer ("this schema has no foreign keys"), not a missing one.
   */
  const edgesLoaded = computed(() => {
    const source = discovery.sourceKey
    return !!source && source in edgesBySource.value
  })

  const edgeKey = (table: string, column: string): string => `${table}.${column}`

  const byEdge = computed(
    () => new Map(list.value.map((p) => [edgeKey(p.tableName, p.columnName), p]))
  )

  /** The stored policy for an edge, or undefined when it takes the default. */
  function policyRecordFor(table: string, column: string): FkBackfillPolicy | undefined {
    return byEdge.value.get(edgeKey(table, column))
  }

  /** The effective policy for an edge — `follow` unless an exception says otherwise. */
  function policyFor(table: string, column: string): BackfillPolicyKind {
    return policyRecordFor(table, column)?.policy ?? 'follow'
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
      const rows = await window.api.config.listFkBackfillPoliciesByWorkspace(workspaceId)
      all.value = [...all.value.filter((p) => p.workspaceId !== workspaceId), ...rows]
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
   * Introspect the source's foreign-key graph and cache it. Returns how many edges were found;
   * throws if there's no source connection or introspection fails, for the caller to surface. The
   * source is captured up front so a mid-flight switch can't file A's edges under B.
   */
  async function loadEdges(): Promise<number> {
    const workspaceId = workspace.currentWorkspaceId
    if (!workspaceId) throw new Error('No workspace selected.')
    const connection = discovery.sourceConnection
    const source = discovery.sourceKey
    if (!connection || !source) throw new Error('This workspace has no source connection.')

    loadingEdgesWorkspaceId.value = workspaceId
    try {
      const found = await window.api.source.listForeignKeys(connection.id)
      edgesBySource.value = { ...edgesBySource.value, [source]: found }
      return found.length
    } finally {
      loadingEdgesWorkspaceId.value = null
    }
  }

  /**
   * Set an edge's policy. `follow` is stored as *no row*, so choosing it removes any exception —
   * which keeps "what has this workspace deliberately changed" answerable by listing the table.
   */
  async function setPolicy(
    tableName: string,
    columnName: string,
    policy: BackfillPolicyKind
  ): Promise<void> {
    const workspaceId = workspace.currentWorkspaceId
    if (!workspaceId) throw new Error('No workspace selected.')
    const existing = policyRecordFor(tableName, columnName)

    if (policy === 'follow') {
      if (!existing) return
      await window.api.config.deleteFkBackfillPolicy(existing.id)
      all.value = all.value.filter((p) => p.id !== existing.id)
      return
    }

    const saved = await window.api.config.setFkBackfillPolicy({
      workspaceId,
      tableName,
      columnName,
      policy
    })
    // Upsert semantics: key the merge on id, since the save may have replaced an existing row.
    const idx = all.value.findIndex((p) => p.id === saved.id)
    all.value =
      idx >= 0 ? all.value.map((p) => (p.id === saved.id ? saved : p)) : [...all.value, saved]
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
    edges,
    edgesLoaded,
    loading,
    loadingEdges,
    policyFor,
    policyRecordFor,
    loadForWorkspace,
    loadEdges,
    setPolicy
  }
})
