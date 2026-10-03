import { randomUUID } from 'crypto'
import type { DumpOutputMode, FrameworkId, Workspace } from '@shared/types'
import { isFrameworkId } from '@shared/frameworks'
import { normalizeDumpDir } from '../../dump-dir'
import { getDb } from '../db'

/**
 * Workspace CRUD. This is the snake_case↔camelCase boundary (see the note in
 * `src/shared/types.ts`): rows are stored snake_case, the API speaks camelCase.
 */

interface WorkspaceRow {
  id: string
  name: string
  dump_output_mode: DumpOutputMode
  dump_output_dir: string | null
  drop_existing_tables: number
  framework: string | null
  created_at: string
  updated_at: string
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    dumpOutputMode: row.dump_output_mode,
    // Blank reads the same as unset — a cleared text field shouldn't mean "write dumps to `''`".
    dumpOutputDir: row.dump_output_dir?.trim() || undefined,
    // SQLite has no boolean storage class — the column is the 0/1 integer migration 012 defines.
    dropExistingTables: row.drop_existing_tables !== 0,
    // Read defensively rather than cast: the column carries no CHECK (the catalogue grows in code,
    // see migration 015), so an id from a newer build reads back as "no framework" instead of
    // becoming an invalid `FrameworkId` that nothing downstream can resolve.
    framework: isFrameworkId(row.framework) ? row.framework : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface WorkspaceInput {
  name: string
  dumpOutputMode?: DumpOutputMode
  /** Absent or blank = the default (`<userData>/dumps`), resolved per run by `dumpDirectoryFor`. */
  dumpOutputDir?: string
  /** Absent = on, matching migration 012's column default. */
  dropExistingTables?: boolean
  /** Absent or null = no framework. Rejected if it isn't one the catalogue knows. */
  framework?: FrameworkId | null
}

/**
 * What actually goes in the column: an **absolute** path, or NULL for "use the default".
 *
 * Normalised on the way in rather than on the way out, so the store only ever holds paths that mean
 * the same thing wherever the app is launched from. A relative path or an unexpandable `~` is
 * rejected here rather than quietly resolved — `dumps` would land against the packaged app's working
 * directory, which is neither predictable nor necessarily writable. The throw surfaces in the
 * workspace form's save handler.
 */
/**
 * The framework id as it goes in the column, or NULL. Validated here because the column has no
 * CHECK — see migration 015 for why it deliberately hasn't.
 */
function storedFramework(value: FrameworkId | null | undefined): string | null {
  if (value === null || value === undefined || value === ('' as string)) return null
  if (!isFrameworkId(value)) throw new Error(`Unknown framework: ${value}`)
  return value
}

function storedDir(value: string | undefined): string | null {
  const { path, problem } = normalizeDumpDir(value)
  if (problem) throw new Error(problem)
  return path ?? null
}

export function listWorkspaces(): Workspace[] {
  return (getDb().prepare('SELECT * FROM workspaces ORDER BY name').all() as WorkspaceRow[]).map(
    toWorkspace
  )
}

export function createWorkspace(input: WorkspaceInput): Workspace {
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO workspaces
         (id, name, dump_output_mode, dump_output_dir, drop_existing_tables, framework)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.name,
      input.dumpOutputMode ?? 'combined',
      storedDir(input.dumpOutputDir),
      (input.dropExistingTables ?? true) ? 1 : 0,
      storedFramework(input.framework)
    )
  return getWorkspace(id)!
}

export function updateWorkspace(id: string, patch: Partial<WorkspaceInput>): Workspace | undefined {
  const existing = getWorkspace(id)
  if (!existing) return undefined
  getDb()
    .prepare(
      `UPDATE workspaces
         SET name = ?,
             dump_output_mode = ?,
             dump_output_dir = ?,
             drop_existing_tables = ?,
             framework = ?,
             updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(
      patch.name ?? existing.name,
      patch.dumpOutputMode ?? existing.dumpOutputMode,
      // `'dumpOutputDir' in patch` rather than `??`: clearing the folder is a legitimate edit, and
      // `patch.dumpOutputDir ?? existing…` would silently refuse it by falling back to the old value.
      storedDir('dumpOutputDir' in patch ? patch.dumpOutputDir : existing.dumpOutputDir),
      (patch.dropExistingTables ?? existing.dropExistingTables) ? 1 : 0,
      // `in patch` like the dump folder above: clearing the framework back to "none" is a real
      // edit, and `??` would refuse it by falling back to the stored value.
      storedFramework('framework' in patch ? patch.framework : existing.framework),
      id
    )
  return getWorkspace(id)
}

export function deleteWorkspace(id: string): void {
  getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(id)
}

export function getWorkspace(id: string): Workspace | undefined {
  const row = getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
    WorkspaceRow | undefined
  return row ? toWorkspace(row) : undefined
}
