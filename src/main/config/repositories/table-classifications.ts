import { randomUUID } from 'crypto'
import type {
  ClassificationSource,
  FrameworkId,
  PresetApplyResult,
  TableClass,
  TableClassification
} from '@shared/types'
import { frameworkById, presetEntries } from '@shared/frameworks'
import { getDb } from '../db'

/**
 * Table-classification CRUD (spec §5). A classification is unique per (workspace, table);
 * `setTableClassification` upserts against that constraint so re-classifying a table
 * replaces its class rather than erroring. Unclassified tables default to `transactional`
 * at pipeline time — the absence of a row *is* the default, so there's no "clear to
 * default" beyond deleting the row.
 */

interface TableClassificationRow {
  id: string
  workspace_id: string
  table_name: string
  class: TableClass
  source: string
}

function toTableClassification(row: TableClassificationRow): TableClassification {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tableName: row.table_name,
    class: row.class,
    // Anything unrecognised reads as `manual`, which is the conservative answer: it means
    // "a re-apply must not touch this row". The column carries no CHECK — see migration 015.
    source: isClassificationSource(row.source) ? row.source : 'manual'
  }
}

function isClassificationSource(value: string): value is ClassificationSource {
  return (
    value === 'manual' ||
    (value.startsWith('preset:') && !!frameworkById(value.slice(7) as FrameworkId))
  )
}

/** `source` defaults to `manual`: anything written through the ordinary CRUD path is a hand edit. */
export type TableClassificationInput = Omit<TableClassification, 'id' | 'source'> &
  Partial<Pick<TableClassification, 'source'>>

export function listTableClassificationsByWorkspace(workspaceId: string): TableClassification[] {
  return (
    getDb()
      .prepare('SELECT * FROM table_classifications WHERE workspace_id = ? ORDER BY table_name')
      .all(workspaceId) as TableClassificationRow[]
  ).map(toTableClassification)
}

export function setTableClassification(input: TableClassificationInput): TableClassification {
  getDb()
    .prepare(
      `INSERT INTO table_classifications (id, workspace_id, table_name, class, source)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, table_name)
         DO UPDATE SET class = excluded.class, source = excluded.source`
    )
    .run(randomUUID(), input.workspaceId, input.tableName, input.class, input.source ?? 'manual')
  const row = getDb()
    .prepare('SELECT * FROM table_classifications WHERE workspace_id = ? AND table_name = ?')
    .get(input.workspaceId, input.tableName) as TableClassificationRow
  return toTableClassification(row)
}

export function deleteTableClassification(id: string): void {
  getDb().prepare('DELETE FROM table_classifications WHERE id = ?').run(id)
}

/**
 * Apply a framework's table presets to a workspace, as a **repair** rather than a one-shot seed.
 *
 * Three cases per table the catalogue names:
 * - no classification yet → written, tagged `preset:<framework>`
 * - classified by a previous run of this framework's presets → refreshed to the catalogue's
 *   current answer, so a table added to the list later reaches workspaces that already ran it
 * - classified by hand (`source: 'manual'`), or by a *different* framework's presets → left
 *   untouched and reported, because overwriting a deliberate choice is the one thing this must
 *   never do
 *
 * One transaction: a half-applied preset set would leave a workspace in a state no one chose, and
 * the caller has no way to tell how far it got.
 */
export function applyFrameworkPresets(
  workspaceId: string,
  frameworkId: FrameworkId
): PresetApplyResult {
  const framework = frameworkById(frameworkId)
  if (!framework) throw new Error(`Unknown framework: ${frameworkId}`)
  const source: ClassificationSource = `preset:${frameworkId}`

  return getDb().transaction((): PresetApplyResult => {
    const existing = new Map(
      listTableClassificationsByWorkspace(workspaceId).map((c) => [c.tableName, c])
    )
    const result: PresetApplyResult = { added: 0, refreshed: 0, skippedManual: [] }

    for (const entry of presetEntries(framework)) {
      const current = existing.get(entry.tableName)
      if (!current) {
        setTableClassification({ workspaceId, ...entry, source })
        result.added++
        continue
      }
      if (current.source !== source) {
        result.skippedManual.push(entry.tableName)
        continue
      }
      if (current.class !== entry.class) {
        setTableClassification({ workspaceId, ...entry, source })
        result.refreshed++
      }
    }

    return result
  })()
}
