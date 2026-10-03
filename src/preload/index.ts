import { contextBridge, ipcRenderer } from 'electron'
import type { ConfigApi, ExtractApi, SourceApi, SystemApi } from '@shared/api'

/**
 * Renderer-facing API. Each method is a thin `ipcRenderer.invoke` wrapper over a
 * `config:*` channel handled in the main process (`src/main/ipc.ts`). The renderer only
 * ever sees these methods — never a DB handle.
 */
const config: ConfigApi = {
  listWorkspaces: () => ipcRenderer.invoke('config:listWorkspaces'),
  createWorkspace: (input) => ipcRenderer.invoke('config:createWorkspace', input),
  updateWorkspace: (id, patch) => ipcRenderer.invoke('config:updateWorkspace', id, patch),
  deleteWorkspace: (id) => ipcRenderer.invoke('config:deleteWorkspace', id),
  exportWorkspace: (workspaceId) => ipcRenderer.invoke('config:exportWorkspace', workspaceId),
  chooseWorkspaceImport: () => ipcRenderer.invoke('config:chooseWorkspaceImport'),
  importWorkspace: (file, name) => ipcRenderer.invoke('config:importWorkspace', file, name),

  listConnectionsByWorkspace: (workspaceId) =>
    ipcRenderer.invoke('config:listConnectionsByWorkspace', workspaceId),
  createConnection: (input) => ipcRenderer.invoke('config:createConnection', input),
  updateConnection: (id, patch) => ipcRenderer.invoke('config:updateConnection', id, patch),
  deleteConnection: (id) => ipcRenderer.invoke('config:deleteConnection', id),

  setPassword: (connectionId, plaintext) =>
    ipcRenderer.invoke('config:setPassword', connectionId, plaintext),
  hasPassword: (connectionId) => ipcRenderer.invoke('config:hasPassword', connectionId),

  listTableClassificationsByWorkspace: (workspaceId) =>
    ipcRenderer.invoke('config:listTableClassificationsByWorkspace', workspaceId),
  setTableClassification: (input) => ipcRenderer.invoke('config:setTableClassification', input),
  deleteTableClassification: (id) => ipcRenderer.invoke('config:deleteTableClassification', id),
  applyFrameworkPresets: (workspaceId, frameworkId) =>
    ipcRenderer.invoke('config:applyFrameworkPresets', workspaceId, frameworkId),

  listSelectionRulesByWorkspace: (workspaceId) =>
    ipcRenderer.invoke('config:listSelectionRulesByWorkspace', workspaceId),
  createSelectionRule: (input) => ipcRenderer.invoke('config:createSelectionRule', input),
  updateSelectionRule: (id, patch) => ipcRenderer.invoke('config:updateSelectionRule', id, patch),
  deleteSelectionRule: (id) => ipcRenderer.invoke('config:deleteSelectionRule', id),

  listFieldStrategiesByWorkspace: (workspaceId) =>
    ipcRenderer.invoke('config:listFieldStrategiesByWorkspace', workspaceId),
  createFieldStrategy: (input) => ipcRenderer.invoke('config:createFieldStrategy', input),
  updateFieldStrategy: (id, patch) => ipcRenderer.invoke('config:updateFieldStrategy', id, patch),
  deleteFieldStrategy: (id) => ipcRenderer.invoke('config:deleteFieldStrategy', id),

  listTableLocaleSourcesByWorkspace: (workspaceId) =>
    ipcRenderer.invoke('config:listTableLocaleSourcesByWorkspace', workspaceId),
  setTableLocaleSource: (input) => ipcRenderer.invoke('config:setTableLocaleSource', input),
  deleteTableLocaleSource: (id) => ipcRenderer.invoke('config:deleteTableLocaleSource', id),

  listTableIdentitySourcesByWorkspace: (workspaceId) =>
    ipcRenderer.invoke('config:listTableIdentitySourcesByWorkspace', workspaceId),
  setTableIdentitySource: (input) => ipcRenderer.invoke('config:setTableIdentitySource', input),
  deleteTableIdentitySource: (id) => ipcRenderer.invoke('config:deleteTableIdentitySource', id),

  listMorphRelationsByWorkspace: (workspaceId) =>
    ipcRenderer.invoke('config:listMorphRelationsByWorkspace', workspaceId),
  createMorphRelation: (input) => ipcRenderer.invoke('config:createMorphRelation', input),
  updateMorphRelation: (id, patch) => ipcRenderer.invoke('config:updateMorphRelation', id, patch),
  deleteMorphRelation: (id) => ipcRenderer.invoke('config:deleteMorphRelation', id),

  listFkBackfillPoliciesByWorkspace: (workspaceId) =>
    ipcRenderer.invoke('config:listFkBackfillPoliciesByWorkspace', workspaceId),
  setFkBackfillPolicy: (input) => ipcRenderer.invoke('config:setFkBackfillPolicy', input),
  deleteFkBackfillPolicy: (id) => ipcRenderer.invoke('config:deleteFkBackfillPolicy', id),

  listRunsByWorkspace: (workspaceId) =>
    ipcRenderer.invoke('config:listRunsByWorkspace', workspaceId)
}

const source: SourceApi = {
  testConnection: (connectionId) => ipcRenderer.invoke('source:testConnection', connectionId),
  listTables: (connectionId) => ipcRenderer.invoke('source:listTables', connectionId),
  listColumns: (connectionId, table) =>
    ipcRenderer.invoke('source:listColumns', connectionId, table),
  listForeignKeys: (connectionId) => ipcRenderer.invoke('source:listForeignKeys', connectionId),
  previewSelectionRule: (connectionId, rule) =>
    ipcRenderer.invoke('source:previewSelectionRule', connectionId, rule),
  detectMorphCandidates: (connectionId) =>
    ipcRenderer.invoke('source:detectMorphCandidates', connectionId),
  discoverJsonPaths: (connectionId, table, column) =>
    ipcRenderer.invoke('source:discoverJsonPaths', connectionId, table, column)
}

const extract: ExtractApi = {
  runExtract: (connectionId, workspaceId) =>
    ipcRenderer.invoke('extract:runExtract', connectionId, workspaceId),
  cancelRun: (runId) => ipcRenderer.invoke('extract:cancelRun', runId),
  runningRunIds: () => ipcRenderer.invoke('extract:runningRunIds'),
  dumpDirectory: (workspaceId) => ipcRenderer.invoke('extract:dumpDirectory', workspaceId)
}

const system: SystemApi = {
  copyText: (text) => ipcRenderer.invoke('system:copyText', text),
  openPath: (path) => ipcRenderer.invoke('system:openPath', path),
  showItemInFolder: (path) => ipcRenderer.invoke('system:showItemInFolder', path),
  chooseDirectory: (current) => ipcRenderer.invoke('system:chooseDirectory', current),
  resolveDirectory: (input) => ipcRenderer.invoke('system:resolveDirectory', input),
  setTitleBarTheme: (dark) => ipcRenderer.invoke('system:setTitleBarTheme', dark)
}

// The renderer lays out its top bar around the native window controls, which sit on the left on
// macOS and the right elsewhere. The platform string is all it gets of `process`.
const api = { config, source, extract, system, platform: process.platform }

// Only the app's own typed API crosses the bridge — no generic IPC or `process` access. Context
// isolation is always on (Electron's default, never turned off in `createWindow`), so there is no
// non-isolated fallback to maintain.
contextBridge.exposeInMainWorld('api', api)
