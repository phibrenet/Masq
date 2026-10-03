import { randomUUID } from 'crypto'
import { OBFUSCATE_MIN_COUNT } from '@shared/types'
import type {
  FakeGenerator,
  FieldStrategy,
  FieldStrategyKind,
  FieldStrategyRule,
  TemplateBinding
} from '@shared/types'
import { getDb } from '../db'

/**
 * Field-strategy CRUD (spec §8): a per-(workspace, table, column) anonymization rule. The
 * domain shape carries a discriminated `rule` union (preserve/redact/fake/jitter/template/
 * obfuscate); the table stores it flat as `kind` + the kind-specific columns. `createFieldStrategy`
 * upserts on the `UNIQUE(workspace, table, column)` constraint so re-setting a column's strategy
 * replaces it rather than erroring; `updateFieldStrategy` edits an existing row by id.
 */

interface FieldStrategyRow {
  id: string
  workspace_id: string
  table_name: string
  column_name: string
  kind: FieldStrategyKind
  generator: FakeGenerator | null
  jitter_percent: number | null
  template_json: string | null
  obfuscate_side: string | null
  obfuscate_count: number | null
}

/**
 * Parse the stored bindings, tolerating anything malformed by yielding none.
 *
 * A template with zero bindings is inert (the overlay does nothing), which is the right failure mode
 * for corrupt config: the column is preserved rather than the run dying or — far worse — the column
 * being silently emptied.
 */
function parseBindings(json: string | null): TemplateBinding[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    // A `redact`/`remove` binding carries no generator, so a generator is required only for `fake`
    // (which is also what an `action`-less legacy binding is).
    return parsed.filter(
      (b): b is TemplateBinding =>
        !!b &&
        typeof b.path === 'string' &&
        !!b.path &&
        (b.action === 'redact' || b.action === 'remove' || typeof b.generator === 'string')
    )
  } catch {
    return []
  }
}

/** Reassemble the discriminated union from the flat columns. */
function toRule(row: FieldStrategyRow): FieldStrategyRule {
  switch (row.kind) {
    case 'fake':
      return { kind: 'fake', generator: (row.generator ?? 'fullName') as FakeGenerator }
    case 'jitter':
      return { kind: 'jitter', percent: row.jitter_percent ?? 0 }
    case 'obfuscate':
      return {
        kind: 'obfuscate',
        // Read leniently, like the template bindings above: a row that predates the columns, or one
        // hand-edited to something unreadable, falls back to the safest reading rather than
        // throwing — `last` and the minimum hide more, never less.
        side: row.obfuscate_side === 'first' ? 'first' : 'last',
        count: Math.max(OBFUSCATE_MIN_COUNT, Math.trunc(row.obfuscate_count ?? 0))
      }
    case 'template':
      return { kind: 'template', bindings: parseBindings(row.template_json) }
    case 'redact':
      return { kind: 'redact' }
    default:
      return { kind: 'preserve' }
  }
}

function toFieldStrategy(row: FieldStrategyRow): FieldStrategy {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tableName: row.table_name,
    columnName: row.column_name,
    rule: toRule(row)
  }
}

/** Flatten a rule union to its persisted columns — only the kind-relevant ones are set. */
function toColumns(rule: FieldStrategyRule): {
  kind: FieldStrategyKind
  generator: FakeGenerator | null
  jitter_percent: number | null
  template_json: string | null
  obfuscate_side: string | null
  obfuscate_count: number | null
} {
  return {
    kind: rule.kind,
    generator: rule.kind === 'fake' ? rule.generator : null,
    jitter_percent: rule.kind === 'jitter' ? rule.percent : null,
    obfuscate_side: rule.kind === 'obfuscate' ? rule.side : null,
    // The `OBFUSCATE_MIN_COUNT` floor lives here rather than in a CHECK constraint so that the
    // form, an imported workspace file and any future caller all get the same answer — this is the
    // one path every write passes through. Rounded too: a fractional count would slice nothing
    // predictable.
    obfuscate_count:
      rule.kind === 'obfuscate' ? Math.max(OBFUSCATE_MIN_COUNT, Math.trunc(rule.count)) : null,
    // Blank paths are dropped rather than stored: the builder UI shows a row per discovered path, and
    // an unbound one must not persist as a binding that resolves to nothing.
    template_json:
      rule.kind === 'template'
        ? JSON.stringify(
            rule.bindings.filter(
              (b) =>
                b.path.trim() && (b.action === 'redact' || b.action === 'remove' || b.generator)
            )
          )
        : null
  }
}

export type FieldStrategyInput = Omit<FieldStrategy, 'id'>

export function listFieldStrategiesByWorkspace(workspaceId: string): FieldStrategy[] {
  return (
    getDb()
      .prepare(
        'SELECT * FROM field_strategies WHERE workspace_id = ? ORDER BY table_name, column_name'
      )
      .all(workspaceId) as FieldStrategyRow[]
  ).map(toFieldStrategy)
}

export function getFieldStrategy(id: string): FieldStrategy | undefined {
  const row = getDb().prepare('SELECT * FROM field_strategies WHERE id = ?').get(id) as
    FieldStrategyRow | undefined
  return row ? toFieldStrategy(row) : undefined
}

/** Create-or-replace a column's strategy (upsert on the unique key). */
export function createFieldStrategy(input: FieldStrategyInput): FieldStrategy {
  const cols = toColumns(input.rule)
  getDb()
    .prepare(
      `INSERT INTO field_strategies
         (id, workspace_id, table_name, column_name, kind, generator, jitter_percent, template_json,
          obfuscate_side, obfuscate_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, table_name, column_name)
         DO UPDATE SET kind = excluded.kind,
                       generator = excluded.generator,
                       jitter_percent = excluded.jitter_percent,
                       template_json = excluded.template_json,
                       obfuscate_side = excluded.obfuscate_side,
                       obfuscate_count = excluded.obfuscate_count`
    )
    .run(
      randomUUID(),
      input.workspaceId,
      input.tableName,
      input.columnName,
      cols.kind,
      cols.generator,
      cols.jitter_percent,
      cols.template_json,
      cols.obfuscate_side,
      cols.obfuscate_count
    )
  const row = getDb()
    .prepare(
      'SELECT * FROM field_strategies WHERE workspace_id = ? AND table_name = ? AND column_name = ?'
    )
    .get(input.workspaceId, input.tableName, input.columnName) as FieldStrategyRow
  return toFieldStrategy(row)
}

export function updateFieldStrategy(
  id: string,
  patch: Partial<FieldStrategyInput>
): FieldStrategy | undefined {
  const existing = getFieldStrategy(id)
  if (!existing) return undefined
  const next = { ...existing, ...patch }
  const cols = toColumns(next.rule)
  getDb()
    .prepare(
      `UPDATE field_strategies
         SET table_name = ?, column_name = ?, kind = ?, generator = ?, jitter_percent = ?,
             template_json = ?, obfuscate_side = ?, obfuscate_count = ?
       WHERE id = ?`
    )
    .run(
      next.tableName,
      next.columnName,
      cols.kind,
      cols.generator,
      cols.jitter_percent,
      cols.template_json,
      cols.obfuscate_side,
      cols.obfuscate_count,
      id
    )
  return getFieldStrategy(id)
}

export function deleteFieldStrategy(id: string): void {
  getDb().prepare('DELETE FROM field_strategies WHERE id = ?').run(id)
}
