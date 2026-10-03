import { randomUUID } from 'crypto'
import type { Run, RunOutputFiles, RunStatus } from '@shared/types'
import { getDb } from '../db'

/**
 * Run-history CRUD (spec §10). A run row is created `running` when an extract starts and moved to
 * `completed`/`failed` when it ends; `row_counts` and `output_files` are JSON blobs. `started_at`
 * uses the DB default; `finished_at` is stamped by the DB on completion so timestamps are the
 * store's, not the renderer's.
 */

interface RunRow {
  id: string
  workspace_id: string
  started_at: string
  finished_at: string | null
  status: RunStatus
  row_counts: string | null
  output_files: string | null
  error_message: string | null
  warnings: string | null
}

function parseJson<T>(json: string | null): T | undefined {
  if (json == null) return undefined
  try {
    return JSON.parse(json) as T
  } catch {
    return undefined
  }
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    status: row.status,
    rowCounts: parseJson<Record<string, number>>(row.row_counts),
    outputFiles: parseJson<RunOutputFiles>(row.output_files),
    errorMessage: row.error_message ?? undefined,
    warnings: parseJson<string[]>(row.warnings)
  }
}

export function listRunsByWorkspace(workspaceId: string): Run[] {
  return (
    getDb()
      .prepare('SELECT * FROM runs WHERE workspace_id = ? ORDER BY started_at DESC')
      .all(workspaceId) as RunRow[]
  ).map(toRun)
}

export function getRun(id: string): Run | undefined {
  const row = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
  return row ? toRun(row) : undefined
}

/** Start a run: inserts a `running` row and returns it. */
export function createRun(workspaceId: string): Run {
  const id = randomUUID()
  getDb()
    .prepare(`INSERT INTO runs (id, workspace_id, status) VALUES (?, ?, 'running')`)
    .run(id, workspaceId)
  return getRun(id)!
}

/**
 * Mark a run completed with its per-table row counts, output file paths, and any warnings.
 *
 * An empty warning list is stored as NULL rather than `[]`, so "this run had nothing to report" and
 * "this run predates the warnings column" read identically to the renderer — which is correct, since
 * neither has anything to show.
 */
export function completeRun(
  id: string,
  rowCounts: Record<string, number>,
  outputFiles: RunOutputFiles,
  warnings: string[] = []
): Run | undefined {
  getDb()
    .prepare(
      `UPDATE runs
         SET status = 'completed', finished_at = datetime('now'),
             row_counts = ?, output_files = ?, warnings = ?
       WHERE id = ?`
    )
    .run(
      JSON.stringify(rowCounts),
      JSON.stringify(outputFiles),
      warnings.length > 0 ? JSON.stringify(warnings) : null,
      id
    )
  return getRun(id)
}

/**
 * Mark a run failed with an error message, keeping any warnings collected before it failed. Those are
 * often the most useful thing about a failed run: the pipeline usually warns about the shape of the
 * data several stages before whatever finally threw.
 */
export function failRun(
  id: string,
  errorMessage: string,
  warnings: string[] = []
): Run | undefined {
  getDb()
    .prepare(
      `UPDATE runs
         SET status = 'failed', finished_at = datetime('now'), error_message = ?, warnings = ?
       WHERE id = ?`
    )
    .run(errorMessage, warnings.length > 0 ? JSON.stringify(warnings) : null, id)
  return getRun(id)
}

/**
 * Close out runs left `running` by a previous session, called once at app start.
 *
 * A run only leaves that status when its pipeline finishes, so a crash — or quitting the app to
 * stop a long extract, which until cancellation existed was the only way — stranded the row
 * forever. The renderer would then offer to cancel a run that no longer exists, and the history
 * would show a run that never ended.
 *
 * Safe because **one process owns the config store**: nothing else can be mid-run when this
 * executes, so any `running` row is by definition orphaned. Returns how many were closed.
 */
export function markInterruptedRuns(): number {
  return getDb()
    .prepare(
      `UPDATE runs
         SET status = 'failed', finished_at = datetime('now'),
             error_message = 'Interrupted — the app closed while this run was in progress.'
       WHERE status = 'running'`
    )
    .run().changes
}
