import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ColumnInfo } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * Source-table discovery, held for the session. Introspected table names are a *live-source*
 * concept (not persisted config), but they must survive navigating away from the Tables screen and
 * back — the view unmounts on route change, so keeping them in a component `ref` loses them.
 *
 * Everything here is keyed by `sourceKey`, which names the **database** rather than the workspace:
 * editing the source's host, database or search path, or replacing the connection, changes the key,
 * so the next read goes back to the source instead of returning the old database's schema. A
 * response that arrives for an old key lands in a slot nothing reads any more.
 */
export const useDiscoveryStore = defineStore('discovery', () => {
  const bySource = ref<Record<string, string[]>>({})
  const discoveringWorkspaceId = ref<string | null>(null)
  /** Introspected columns cached per `${sourceKey}::${table}`. */
  const columnsByKey = ref<Record<string, ColumnInfo[]>>({})
  const connections = useConnectionsStore()
  const workspace = useWorkspaceStore()

  const columnKey = (source: string, table: string): string => `${source}::${table}`

  /** First source-role connection in the active workspace — what we introspect against. */
  const sourceConnection = computed(() => connections.list.find((c) => c.role === 'source') ?? null)

  /** Identity of the database the active source points at; `null` when there is no source. */
  const sourceKey = computed<string | null>(() => {
    const c = sourceConnection.value
    if (!c) return null
    return JSON.stringify([
      c.id,
      c.dialect,
      c.host,
      c.port,
      c.database,
      c.username,
      c.searchPath,
      c.filePath
    ])
  })

  /** Discovered table names for the active source (empty until a discovery runs). */
  const tables = computed<string[]>(() =>
    sourceKey.value ? (bySource.value[sourceKey.value] ?? []) : []
  )

  const discovering = computed(() => discoveringWorkspaceId.value !== null)

  /**
   * Introspect the workspace's source connection and cache its table names. Returns the count
   * discovered; throws if there's no source connection or the introspection fails (the caller
   * surfaces the message). The source is captured up front so a mid-flight switch can't file A's
   * tables under B.
   */
  async function discover(): Promise<number> {
    const conn = sourceConnection.value
    const source = sourceKey.value
    if (!conn || !source) throw new Error('No source connection in this workspace.')
    const workspaceId = workspace.currentWorkspaceId
    if (!workspaceId) throw new Error('No workspace selected.')
    discoveringWorkspaceId.value = workspaceId
    try {
      const found = await window.api.source.listTables(conn.id)
      bySource.value = { ...bySource.value, [source]: found }
      return found.length
    } finally {
      discoveringWorkspaceId.value = null
    }
  }

  /**
   * Introspect a single table's columns for the active source, caching the result. Returns `[]` if
   * there's no source connection rather than throwing — the caller falls back to a free-text
   * column field. A failed introspection *does* throw so the caller can surface it.
   */
  async function loadColumns(table: string): Promise<ColumnInfo[]> {
    const conn = sourceConnection.value
    const source = sourceKey.value
    if (!conn || !source) return []
    const key = columnKey(source, table)
    if (columnsByKey.value[key]) return columnsByKey.value[key]
    const cols = await window.api.source.listColumns(conn.id, table)
    columnsByKey.value = { ...columnsByKey.value, [key]: cols }
    return cols
  }

  /** Cached columns for a table in the active source (empty until `loadColumns` runs). */
  function cachedColumns(table: string): ColumnInfo[] {
    return sourceKey.value ? (columnsByKey.value[columnKey(sourceKey.value, table)] ?? []) : []
  }

  /**
   * Every table whose columns have been introspected this session for the active source, as
   * `table → column names`. What the unhandled-personal-data check reads: only metadata the app
   * already holds, never a fresh query.
   */
  const knownColumns = computed<Record<string, string[]>>(() => {
    const source = sourceKey.value
    if (!source) return {}
    const prefix = `${source}::`
    const out: Record<string, string[]> = {}
    for (const [key, cols] of Object.entries(columnsByKey.value)) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = cols.map((c) => c.name)
    }
    return out
  })

  return {
    tables,
    discovering,
    sourceConnection,
    sourceKey,
    knownColumns,
    discover,
    loadColumns,
    cachedColumns
  }
})
