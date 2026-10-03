import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { MorphCandidate, MorphCandidateValue, MorphRelation } from '@shared/types'
import type { MorphRelationInput } from '@shared/api'
import { useDiscoveryStore } from '@renderer/stores/discovery'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * Declared polymorphic relations for the active workspace (docs/polymorphic-cascade.md), loaded over
 * IPC. Same shape as the other config stores — `all` caches loaded workspaces, `list` is the
 * current-workspace slice — plus one extra concern: **detected candidates**.
 *
 * Candidates are a live-source concept, not persisted config (the same reasoning as the discovery
 * store): they're introspected suggestions, so they live in memory per workspace for the session and
 * reset on restart. Keeping them here rather than in the view means they survive navigating away from
 * the Morphs screen and back, which matters because detection is the slow part (a column scan plus a
 * DISTINCT per candidate).
 */
export const useMorphRelationsStore = defineStore('morphRelations', () => {
  const all = ref<MorphRelation[]>([])
  const loadingWorkspaceId = ref<string | null>(null)
  /** Keyed by `discovery.sourceKey`: suggestions describe a database, not a workspace. */
  const candidatesBySource = ref<Record<string, MorphCandidate[]>>({})
  const detectingWorkspaceId = ref<string | null>(null)
  const workspace = useWorkspaceStore()
  const discovery = useDiscoveryStore()

  const list = computed<MorphRelation[]>(() =>
    all.value.filter((r) => r.workspaceId === workspace.currentWorkspaceId)
  )

  const loading = computed(() => loadingWorkspaceId.value !== null)
  const detecting = computed(() => detectingWorkspaceId.value !== null)

  /** Detected candidates for the active source (empty until a detection runs). */
  const candidates = computed<MorphCandidate[]>(() => {
    const source = discovery.sourceKey
    return source ? (candidatesBySource.value[source] ?? []) : []
  })

  /** Whether a detection has run against the active source this session (even one finding nothing). */
  const detected = computed(() => {
    const source = discovery.sourceKey
    return !!source && source in candidatesBySource.value
  })

  /** Key identifying a relation independently of its id — what "already declared" means. */
  const relationKey = (tableName: string, typeColumn: string): string =>
    `${tableName}.${typeColumn}`

  const declaredKeys = computed(
    () => new Set(list.value.map((r) => relationKey(r.tableName, r.typeColumn)))
  )

  /** Candidates the workspace hasn't declared yet — the "suggestions" half of the screen. */
  const undeclaredCandidates = computed(() =>
    candidates.value.filter((c) => !declaredKeys.value.has(relationKey(c.tableName, c.typeColumn)))
  )

  const candidateByKey = computed(
    () => new Map(candidates.value.map((c) => [relationKey(c.tableName, c.typeColumn), c]))
  )

  function candidateFor(tableName: string, typeColumn: string): MorphCandidate | undefined {
    return candidateByKey.value.get(relationKey(tableName, typeColumn))
  }

  /**
   * Type values detection found in the data that a **declared** relation has no mapping for.
   *
   * This is the config-drift case, and it has teeth: the source can start writing a new type value
   * long after the relation was declared, and an unmapped value makes the engine log-and-skip that
   * edge — so a morph reference dangles while everything looks configured. Declared relations are
   * filtered out of `undeclaredCandidates`, so without this the new value would never surface
   * anywhere in the UI.
   *
   * Empty unless a detection has run this session (candidates are session state, not config).
   */
  function unmappedValuesFor(relation: MorphRelation): MorphCandidateValue[] {
    const candidate = candidateFor(relation.tableName, relation.typeColumn)
    if (!candidate) return []
    const mapped = new Set(relation.typeMap.map((m) => m.typeValue))
    return candidate.typeValues.filter((v) => !mapped.has(v.typeValue))
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
      const rows = await window.api.config.listMorphRelationsByWorkspace(workspaceId)
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

  /**
   * Introspect the source for `*_type`/`*_id` pairs and cache the suggestions. Returns how many were
   * found. Throws if there's no source connection or introspection fails — the caller surfaces it.
   * The workspace is captured up front so a mid-flight switch can't file results under the wrong one.
   */
  async function detect(): Promise<number> {
    const workspaceId = workspace.currentWorkspaceId
    if (!workspaceId) throw new Error('No workspace selected.')
    const connection = discovery.sourceConnection
    const source = discovery.sourceKey
    if (!connection || !source) throw new Error('This workspace has no source connection.')

    detectingWorkspaceId.value = workspaceId
    try {
      // Top up the table cache in the same gesture when it's cold. The type→table dropdowns read
      // their options from the discovery store, which until now only the Tables screen ever filled —
      // so on a fresh session every unresolved guess had to be typed by hand against an empty list.
      // Detection is already an explicit "go read the source" action, so this adds no surprise
      // queries. Run concurrently (independent query, no extra wall-clock) and swallow its failure:
      // detection is the operation the user asked for, and the selects still accept free text.
      const [found] = await Promise.all([
        window.api.source.detectMorphCandidates(connection.id),
        discovery.tables.length === 0 ? discovery.discover().catch(() => 0) : Promise.resolve(0)
      ])
      candidatesBySource.value = { ...candidatesBySource.value, [source]: found }
      return found.length
    } finally {
      detectingWorkspaceId.value = null
    }
  }

  /** Declare a relation (upserts on table + type column); merge the saved row into the cache. */
  async function create(input: Omit<MorphRelationInput, 'workspaceId'>): Promise<MorphRelation> {
    const workspaceId = workspace.currentWorkspaceId
    if (!workspaceId) throw new Error('No workspace selected.')
    const saved = await window.api.config.createMorphRelation({ ...input, workspaceId })
    // Upsert semantics: key the merge on id, since the save may have replaced an existing row.
    const idx = all.value.findIndex((r) => r.id === saved.id)
    all.value =
      idx >= 0 ? all.value.map((r) => (r.id === saved.id ? saved : r)) : [...all.value, saved]
    return saved
  }

  async function update(
    id: string,
    patch: Partial<MorphRelationInput>
  ): Promise<MorphRelation | undefined> {
    const saved = await window.api.config.updateMorphRelation(id, patch)
    if (saved) all.value = all.value.map((r) => (r.id === id ? saved : r))
    return saved
  }

  async function remove(id: string): Promise<void> {
    await window.api.config.deleteMorphRelation(id)
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

  return {
    loadError,
    all,
    list,
    loading,
    candidates,
    detected,
    undeclaredCandidates,
    candidateFor,
    unmappedValuesFor,
    detecting,
    loadForWorkspace,
    detect,
    create,
    update,
    remove
  }
})
