import type { SourceApi } from '@shared/api'
import { registerHandlers } from './ipc-guard'
import { withSourceAdapter } from './adapters'
import { detectMorphCandidates } from './adapters/morph-detect'
import { discoverJsonPaths } from './adapters/json-paths'
import { previewRule } from './extract/preview'

/**
 * IPC surface for live *source* databases (spec §4 adapters), separate from the config
 * store's `config:*` channels. Channel names mirror `SourceApi` for easy tracing. Handlers
 * take a connection *id* and read credentials from the keychain in the main process — the
 * password never travels over IPC from the renderer.
 */
const handlers: {
  [K in keyof SourceApi]: (...args: Parameters<SourceApi[K]>) => ReturnType<SourceApi[K]>
} = {
  // Failure is an expected outcome of a health check, so return it as data rather than
  // letting the error propagate as a rejected IPC call.
  testConnection: async (connectionId) => {
    try {
      const tableCount = await withSourceAdapter(connectionId, async (adapter) => {
        await adapter.ping()
        return (await adapter.getTables()).length
      })
      return { ok: true, tableCount }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
  listTables: async (connectionId) =>
    withSourceAdapter(connectionId, (adapter) => adapter.getTables()),
  listColumns: async (connectionId, table) =>
    withSourceAdapter(connectionId, (adapter) => adapter.getColumns(table)),
  // Nullability is joined on here rather than left to the renderer: the policy screen needs it for
  // every edge at once (a real schema has ~90), and one `getColumns` per *distinct child table* is
  // far cheaper than the renderer asking per edge. Columns are read once per table, not per edge.
  listForeignKeys: async (connectionId) =>
    withSourceAdapter(connectionId, async (adapter) => {
      const foreignKeys = await adapter.getForeignKeys()
      const nullableByTable = new Map<string, Map<string, boolean>>()
      for (const table of new Set(foreignKeys.map((fk) => fk.table))) {
        const columns = await adapter.getColumns(table)
        nullableByTable.set(table, new Map(columns.map((c) => [c.name, c.nullable])))
      }
      return foreignKeys.map((fk) => ({
        ...fk,
        // Unknown → treat as NOT NULL. The screen uses this to decide whether `null` is offerable,
        // and offering it for a column that turns out to be NOT NULL produces a dump that won't
        // load — so an absent answer must fail closed.
        nullable: nullableByTable.get(fk.table)?.get(fk.column) ?? false
      }))
    }),
  detectMorphCandidates: async (connectionId) =>
    withSourceAdapter(connectionId, (adapter) => detectMorphCandidates(adapter)),
  discoverJsonPaths: async (connectionId, table, column) =>
    withSourceAdapter(connectionId, (adapter) => discoverJsonPaths(adapter, table, column)),
  previewSelectionRule: async (connectionId, rule) =>
    withSourceAdapter(connectionId, (adapter) => previewRule(adapter, rule))
}

export function registerSourceIpc(): void {
  registerHandlers('source', handlers)
}
