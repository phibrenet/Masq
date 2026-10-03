import { randomUUID } from 'crypto'
import { readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { BrowserWindow, dialog } from 'electron'
import type { ConfigApi } from '@shared/api'
import { registerHandlers } from './ipc-guard'
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  updateWorkspace
} from './config/repositories/workspaces'
import {
  createConnection,
  deleteConnection,
  listConnectionsByWorkspace,
  updateConnection
} from './config/repositories/connections'
import {
  applyFrameworkPresets,
  deleteTableClassification,
  listTableClassificationsByWorkspace,
  setTableClassification
} from './config/repositories/table-classifications'
import {
  createSelectionRule,
  deleteSelectionRule,
  listSelectionRulesByWorkspace,
  updateSelectionRule
} from './config/repositories/selection-rules'
import {
  createFieldStrategy,
  deleteFieldStrategy,
  listFieldStrategiesByWorkspace,
  updateFieldStrategy
} from './config/repositories/field-strategies'
import {
  deleteTableLocaleSource,
  listTableLocaleSourcesByWorkspace,
  setTableLocaleSource
} from './config/repositories/table-locale-sources'
import {
  deleteTableIdentitySource,
  listTableIdentitySourcesByWorkspace,
  setTableIdentitySource
} from './config/repositories/table-identity-sources'
import {
  createMorphRelation,
  deleteMorphRelation,
  listMorphRelationsByWorkspace,
  updateMorphRelation
} from './config/repositories/morph-relations'
import {
  deleteFkBackfillPolicy,
  listFkBackfillPoliciesByWorkspace,
  setFkBackfillPolicy
} from './config/repositories/fk-backfill-policies'
import { listRunsByWorkspace } from './config/repositories/runs'
import { hasPassword, setPassword } from './config/credentials'
import {
  exportWorkspaceConfig,
  importWorkspaceConfig,
  MAX_WORKSPACE_FILE_BYTES,
  parseWorkspaceTransfer
} from './config/workspace-transfer'

/**
 * The one place the config store is reachable from the renderer. Each operation is a
 * narrow, named `ipcMain.handle` channel — the renderer gets values back, never a DB
 * handle. Channel names mirror the `ConfigApi` method names for easy tracing.
 *
 * The `ConfigApi` annotation keeps handler signatures honest against the shared contract
 * (the preload wrappers implement the same interface on the other side).
 */
const handlers: {
  [K in keyof ConfigApi]: (...args: Parameters<ConfigApi[K]>) => ReturnType<ConfigApi[K]>
} = {
  listWorkspaces: async () => listWorkspaces(),
  createWorkspace: async (input) => createWorkspace(input),
  updateWorkspace: async (id, patch) => updateWorkspace(id, patch),
  deleteWorkspace: async (id) => deleteWorkspace(id),
  exportWorkspace: async (workspaceId) => {
    const file = exportWorkspaceConfig(workspaceId)
    const content = `${JSON.stringify(file, null, 2)}\n`
    if (Buffer.byteLength(content) > MAX_WORKSPACE_FILE_BYTES)
      throw new Error('Workspace file is too large to share.')
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      defaultPath: `${file.workspace.name.replace(/[^a-z0-9_-]+/gi, '-')}.masq.json`,
      filters: [{ name: 'Masq workspace', extensions: ['json'] }]
    }
    const chosen = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (chosen.canceled || !chosen.filePath) return false
    const partial = `${chosen.filePath}.${randomUUID()}.partial`
    try {
      await writeFile(partial, content, 'utf8')
      await rename(partial, chosen.filePath)
    } finally {
      await rm(partial, { force: true })
    }
    return true
  },
  chooseWorkspaceImport: async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Masq workspace', extensions: ['json'] }]
    }
    const chosen = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (chosen.canceled || !chosen.filePaths[0]) return null
    const path = chosen.filePaths[0]
    if ((await stat(path)).size > MAX_WORKSPACE_FILE_BYTES)
      throw new Error('Workspace file is too large to import.')
    const contents = await readFile(path, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(contents)
    } catch {
      throw new Error('The selected file is not valid JSON.')
    }
    return parseWorkspaceTransfer(parsed)
  },
  importWorkspace: async (file, name) => importWorkspaceConfig(file, name),

  listConnectionsByWorkspace: async (workspaceId) => listConnectionsByWorkspace(workspaceId),
  createConnection: async (input) => createConnection(input),
  updateConnection: async (id, patch) => updateConnection(id, patch),
  deleteConnection: async (id) => deleteConnection(id),

  setPassword: async (connectionId, plaintext) => setPassword(connectionId, plaintext),
  hasPassword: async (connectionId) => hasPassword(connectionId),

  listTableClassificationsByWorkspace: async (workspaceId) =>
    listTableClassificationsByWorkspace(workspaceId),
  setTableClassification: async (input) => setTableClassification(input),
  deleteTableClassification: async (id) => deleteTableClassification(id),
  applyFrameworkPresets: async (workspaceId, frameworkId) =>
    applyFrameworkPresets(workspaceId, frameworkId),

  listSelectionRulesByWorkspace: async (workspaceId) => listSelectionRulesByWorkspace(workspaceId),
  createSelectionRule: async (input) => createSelectionRule(input),
  updateSelectionRule: async (id, patch) => updateSelectionRule(id, patch),
  deleteSelectionRule: async (id) => deleteSelectionRule(id),

  listFieldStrategiesByWorkspace: async (workspaceId) =>
    listFieldStrategiesByWorkspace(workspaceId),
  createFieldStrategy: async (input) => createFieldStrategy(input),
  updateFieldStrategy: async (id, patch) => updateFieldStrategy(id, patch),
  deleteFieldStrategy: async (id) => deleteFieldStrategy(id),

  listTableLocaleSourcesByWorkspace: async (workspaceId) =>
    listTableLocaleSourcesByWorkspace(workspaceId),
  setTableLocaleSource: async (input) => setTableLocaleSource(input),
  deleteTableLocaleSource: async (id) => deleteTableLocaleSource(id),

  listTableIdentitySourcesByWorkspace: async (workspaceId) =>
    listTableIdentitySourcesByWorkspace(workspaceId),
  setTableIdentitySource: async (input) => setTableIdentitySource(input),
  deleteTableIdentitySource: async (id) => deleteTableIdentitySource(id),

  listMorphRelationsByWorkspace: async (workspaceId) => listMorphRelationsByWorkspace(workspaceId),
  createMorphRelation: async (input) => createMorphRelation(input),
  updateMorphRelation: async (id, patch) => updateMorphRelation(id, patch),
  deleteMorphRelation: async (id) => deleteMorphRelation(id),

  listFkBackfillPoliciesByWorkspace: async (workspaceId) =>
    listFkBackfillPoliciesByWorkspace(workspaceId),
  setFkBackfillPolicy: async (input) => setFkBackfillPolicy(input),
  deleteFkBackfillPolicy: async (id) => deleteFkBackfillPolicy(id),

  listRunsByWorkspace: async (workspaceId) => listRunsByWorkspace(workspaceId)
}

export function registerConfigIpc(): void {
  registerHandlers('config', handlers)
}
