/**
 * The config-store API surface exposed to the renderer as `window.api.config`.
 *
 * This is the single contract shared by the preload bridge (which implements it as
 * `ipcRenderer.invoke` wrappers) and the renderer (which consumes it). Everything it
 * accepts and returns is a `@shared/types` shape, so views bind to one contract.
 *
 * The renderer never receives a DB handle; it only calls these methods.
 */
import type {
  ColumnInfo,
  Connection,
  ConnectionTestResult,
  FieldStrategy,
  FkBackfillPolicy,
  ForeignKeyEdge,
  JsonPathSample,
  MorphCandidate,
  MorphRelation,
  Run,
  SelectionRule,
  SelectionRulePreview,
  FrameworkId,
  PresetApplyResult,
  TableClassification,
  TableIdentitySource,
  TableLocaleSource,
  Workspace,
  WorkspaceTransfer
} from './types'

/** Create/update payloads: everything but the generated `id`. */
export type WorkspaceInput = Pick<Workspace, 'name'> &
  Partial<Pick<Workspace, 'dumpOutputMode' | 'dumpOutputDir' | 'dropExistingTables'>> & {
    /** `null` clears it back to "no framework" — distinct from omitting the key, which keeps it. */
    framework?: FrameworkId | null
  }
export type ConnectionInput = Omit<Connection, 'id'>
/** `source` is optional: omitting it records a hand edit, which is what the UI always does. */
export type TableClassificationInput = Omit<TableClassification, 'id' | 'source'> &
  Partial<Pick<TableClassification, 'source'>>
export type SelectionRuleInput = Omit<SelectionRule, 'id'>
export type FieldStrategyInput = Omit<FieldStrategy, 'id'>
export type TableLocaleSourceInput = Omit<TableLocaleSource, 'id'>
export type TableIdentitySourceInput = Omit<TableIdentitySource, 'id'>
export type MorphRelationInput = Omit<MorphRelation, 'id'>
export type FkBackfillPolicyInput = Omit<FkBackfillPolicy, 'id'>

export interface ConfigApi {
  listWorkspaces(): Promise<Workspace[]>
  createWorkspace(input: WorkspaceInput): Promise<Workspace>
  updateWorkspace(id: string, patch: Partial<WorkspaceInput>): Promise<Workspace | undefined>
  deleteWorkspace(id: string): Promise<void>
  /** Save the active workspace's portable configuration, or return false if the dialog is closed. */
  exportWorkspace(workspaceId: string): Promise<boolean>
  /** Choose and validate a portable file before showing the import preview. */
  chooseWorkspaceImport(): Promise<WorkspaceTransfer | null>
  /** Import a validated file into a new workspace; validation also runs on this IPC boundary. */
  importWorkspace(file: WorkspaceTransfer, name: string): Promise<Workspace>

  listConnectionsByWorkspace(workspaceId: string): Promise<Connection[]>
  createConnection(input: ConnectionInput): Promise<Connection>
  updateConnection(id: string, patch: Partial<ConnectionInput>): Promise<Connection | undefined>
  deleteConnection(id: string): Promise<void>

  /** Password handling — plaintext crosses IPC once, then lives only as a keychain blob. */
  setPassword(connectionId: string, plaintext: string): Promise<void>
  hasPassword(connectionId: string): Promise<boolean>

  listTableClassificationsByWorkspace(workspaceId: string): Promise<TableClassification[]>
  /** Upsert on (workspaceId, tableName): sets/replaces a table's class. */
  setTableClassification(input: TableClassificationInput): Promise<TableClassification>
  deleteTableClassification(id: string): Promise<void>
  /**
   * Apply a framework's table presets to a workspace, refreshing rows a previous run of the same
   * presets wrote and never overwriting a hand-set classification.
   */
  applyFrameworkPresets(workspaceId: string, frameworkId: FrameworkId): Promise<PresetApplyResult>

  /** Row-selection rules (spec §6). A table may carry several, so this is plain CRUD by id. */
  listSelectionRulesByWorkspace(workspaceId: string): Promise<SelectionRule[]>
  createSelectionRule(input: SelectionRuleInput): Promise<SelectionRule>
  updateSelectionRule(
    id: string,
    patch: Partial<SelectionRuleInput>
  ): Promise<SelectionRule | undefined>
  deleteSelectionRule(id: string): Promise<void>

  /** Field-level anonymization strategies (spec §8), one per (workspace, table, column). */
  listFieldStrategiesByWorkspace(workspaceId: string): Promise<FieldStrategy[]>
  /** Create-or-replace a column's strategy (upsert on the unique key). */
  createFieldStrategy(input: FieldStrategyInput): Promise<FieldStrategy>
  updateFieldStrategy(
    id: string,
    patch: Partial<FieldStrategyInput>
  ): Promise<FieldStrategy | undefined>
  deleteFieldStrategy(id: string): Promise<void>

  /** Data-driven faker-locale source column (spec §8), one per (workspace, table). */
  listTableLocaleSourcesByWorkspace(workspaceId: string): Promise<TableLocaleSource[]>
  /** Upsert on (workspaceId, tableName): set/replace a table's country column (and optional path). */
  setTableLocaleSource(input: TableLocaleSourceInput): Promise<TableLocaleSource>
  deleteTableLocaleSource(id: string): Promise<void>

  /**
   * Declared identity sources (migration 008), one per (workspace, table): which entity a table's
   * rows belong to, overriding what the cascade graph would infer.
   */
  listTableIdentitySourcesByWorkspace(workspaceId: string): Promise<TableIdentitySource[]>
  /** Upsert on (workspaceId, tableName): set/replace a table's identity source. */
  setTableIdentitySource(input: TableIdentitySourceInput): Promise<TableIdentitySource>
  deleteTableIdentitySource(id: string): Promise<void>

  /**
   * Declared polymorphic relations + their type maps (docs/polymorphic-cascade.md). Create upserts on
   * (workspace, table, typeColumn) so confirming a detected candidate re-declares rather than fails.
   */
  listMorphRelationsByWorkspace(workspaceId: string): Promise<MorphRelation[]>
  createMorphRelation(input: MorphRelationInput): Promise<MorphRelation>
  updateMorphRelation(
    id: string,
    patch: Partial<MorphRelationInput>
  ): Promise<MorphRelation | undefined>
  deleteMorphRelation(id: string): Promise<void>

  /**
   * Per-edge parent-backfill policies (migration 009), one per (workspace, table, column). Only
   * declared *exceptions* are stored — an edge with no policy is followed, as it always was. Set
   * upserts; deleting resets the edge to the default rather than storing `follow`.
   */
  listFkBackfillPoliciesByWorkspace(workspaceId: string): Promise<FkBackfillPolicy[]>
  setFkBackfillPolicy(input: FkBackfillPolicyInput): Promise<FkBackfillPolicy>
  deleteFkBackfillPolicy(id: string): Promise<void>

  /** Run history (spec §10), newest first. */
  listRunsByWorkspace(workspaceId: string): Promise<Run[]>
}

/**
 * Operations against a live *source* database (via the dialect adapters), as opposed to
 * the app's own config store. Kept separate from `ConfigApi` because these hit external
 * DBs — they're slower, can fail on network/auth, and read credentials from the keychain.
 * The renderer passes a connection *id*; the password never crosses IPC in this direction.
 */
export interface SourceApi {
  /** Health check: connect, authenticate, and count tables. Failure is data, not a throw. */
  testConnection(connectionId: string): Promise<ConnectionTestResult>
  /** Introspect the source and return its base-table names. */
  listTables(connectionId: string): Promise<string[]>
  /** Introspect a single table's columns (name, type, nullability, PK flag). */
  listColumns(connectionId: string, table: string): Promise<ColumnInfo[]>
  /**
   * Every foreign-key edge in the source, each with its child column's nullability — what the
   * backfill-policy screen lists. Nullability is resolved here (one `getColumns` per child table)
   * rather than by the renderer, so the screen costs one call instead of one per table.
   */
  listForeignKeys(connectionId: string): Promise<ForeignKeyEdge[]>
  /**
   * Propose morph relations found by introspection (`X_type` + `X_id` pairs), each with the type
   * values present in the data and a best-guess target table. Read-only — declaring is a separate
   * `config:createMorphRelation` call.
   */
  detectMorphCandidates(connectionId: string): Promise<MorphCandidate[]>
  /**
   * Sample a JSON column and report the paths inside it, for the template builder. Returns shape
   * only — no sampled values cross IPC, since the source is production data.
   */
  discoverJsonPaths(connectionId: string, table: string, column: string): Promise<JsonPathSample>
  /**
   * Count the rows a selection rule matches, without saving it (docs/selection-rules-v2.md).
   *
   * Read-only, and cheap for a fully-pushable rule (one `COUNT(*)`). A rule containing a `matches`
   * condition costs a filtered read instead, since a regex can only be decided in Node — the same
   * cost the extract itself would pay.
   */
  previewSelectionRule(
    connectionId: string,
    rule: Omit<SelectionRule, 'id' | 'workspaceId'>
  ): Promise<SelectionRulePreview>
}

/**
 * Running an extract: subset + anonymize a source and write dump file(s). Separate from `SourceApi`
 * because a run spans the whole pipeline (config store + source DB + filesystem), not a single
 * source query. Returns the finished `Run` record (status + row counts + output paths).
 */
export interface ExtractApi {
  runExtract(connectionId: string, workspaceId: string): Promise<Run>
  /**
   * Ask a run to stop — the one in flight when `runId` is omitted. Resolves with the ids actually
   * signalled, which is empty when nothing was running (a run that finished a moment ago is not a
   * failure to cancel).
   *
   * Cancellation is cooperative: the pipeline stops at its next source query or emitted row, so a
   * cancel issued during one long query waits for that query to return. The run is recorded as
   * failed with a "cancelled" message and no dump is written.
   */
  cancelRun(runId?: string): Promise<string[]>
  /** Ids of runs currently in flight — what the Runs screen polls to decide whether to offer Stop. */
  runningRunIds(): Promise<string[]>
  /**
   * The folder a workspace's dumps are written to, with the default already applied. Omit the id for
   * the default itself, which is what a not-yet-created workspace shows as its placeholder.
   *
   * Resolved in the main process rather than composed in the renderer, so "blank means default"
   * is decided in exactly one place — the same helper the pipeline itself uses to pick the folder.
   */
  dumpDirectory(workspaceId?: string): Promise<string>
}

/**
 * The desktop shell: clipboard, file manager, native pickers. Nothing here touches a database,
 * which is why it isn't folded into one of the three data APIs above.
 */
export interface SystemApi {
  /** Copy text to the OS clipboard. */
  copyText(text: string): Promise<void>
  /**
   * Open a **folder** in Finder / File Explorer / the Linux equivalent. Resolves to `''` on success
   * or a human-readable reason otherwise (missing folder, not a folder) — failure is data here,
   * since "the dumps folder doesn't exist yet" is an ordinary thing to click into.
   */
  openPath(path: string): Promise<string>
  /** Reveal a file in the OS file manager, selecting it. Never opens or runs it. */
  showItemInFolder(path: string): Promise<void>
  /** Native folder picker seeded at `current`. Resolves to the chosen path, or null if dismissed. */
  chooseDirectory(current?: string): Promise<string | null>
  /**
   * Turn typed folder text into the absolute path that would actually be stored, or say why it
   * can't be one. Blank returns neither — that's "use the default", not a problem.
   *
   * Exists so the form can show what it will store *before* saving (`~/Desktop` becoming a real
   * path) and reject a relative one inline. The check itself belongs in the main process: it needs
   * the home directory and the platform's own idea of what "absolute" means, and the workspace
   * repository enforces the identical rule on write.
   */
  resolveDirectory(input: string): Promise<{ path?: string; problem?: string }>
  /** Match the native window controls (Windows/Linux overlay) to the app's light or dark theme. */
  setTitleBarTheme(dark: boolean): Promise<void>
}
