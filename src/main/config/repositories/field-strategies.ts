import { randomUUID } from 'crypto'
import { CONDITION_OPS, FAKE_GENERATORS, OBFUSCATE_MIN_COUNT } from '@shared/types'
import type {
  Condition,
  ExceptionRule,
  FakeGenerator,
  FieldStrategy,
  FieldStrategyException,
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
  obfuscate_delimiter: string | null
  exception_json: string | null
}

/**
 * Sentinel values the field-strategy form once saved as a binding's `generator` when the user chose
 * "Redact" or "Remove" for a JSON path, instead of setting `action`. The engine treats an unknown
 * generator as nothing to do, so those paths kept their real values. Read back as the action the
 * user picked, so configs saved before the fix behave as they were meant to.
 */
const LEGACY_ACTION_SENTINELS: Record<string, 'redact' | 'remove'> = {
  __redact__: 'redact',
  __remove__: 'remove'
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
    const repaired = parsed.map((b) =>
      b && typeof b.generator === 'string' && b.generator in LEGACY_ACTION_SENTINELS
        ? { path: b.path, action: LEGACY_ACTION_SENTINELS[b.generator] }
        : b
    )
    // A `redact`/`remove` binding carries no generator, so a generator is required only for `fake`
    // (which is also what an `action`-less legacy binding is).
    return repaired.filter(
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
      // A missing delimiter reads as '' — the engine then finds no delimiter and scrambles the whole
      // value, which hides more, never less.
      if (row.obfuscate_side === 'before')
        return { kind: 'obfuscate', side: 'before', delimiter: row.obfuscate_delimiter ?? '' }
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

const OPS = new Set<string>(CONDITION_OPS)
const GENERATOR_NAMES = new Set<string>(FAKE_GENERATORS)

function isCondition(c: unknown): c is Condition {
  if (!c || typeof c !== 'object') return false
  const { column, op } = c as Record<string, unknown>
  return (typeof column === 'string' || column === null) && OPS.has(op as string)
}

/** Rebuild an exception's rule from its JSON, or `undefined` when it isn't one this app can run. */
function exceptionRuleFrom(value: unknown): ExceptionRule | undefined {
  if (!value || typeof value !== 'object') return undefined
  const r = value as Record<string, unknown>
  switch (r.kind) {
    case 'preserve':
      return { kind: 'preserve' }
    case 'redact':
      return { kind: 'redact' }
    case 'fake':
      return GENERATOR_NAMES.has(r.generator as string)
        ? { kind: 'fake', generator: r.generator as FakeGenerator }
        : undefined
    case 'jitter':
      return typeof r.percent === 'number' ? { kind: 'jitter', percent: r.percent } : undefined
    case 'obfuscate':
      if (r.side === 'before')
        return typeof r.delimiter === 'string'
          ? { kind: 'obfuscate', side: 'before', delimiter: r.delimiter }
          : undefined
      if ((r.side === 'first' || r.side === 'last') && typeof r.count === 'number')
        return {
          kind: 'obfuscate',
          side: r.side,
          count: Math.max(OBFUSCATE_MIN_COUNT, Math.trunc(r.count))
        }
      return undefined
    default:
      return undefined
  }
}

/**
 * Read `exception_json`. Anything it can't read is reported rather than dropped: dropping the
 * exception would hand its rows to the main rule, which may be the weaker of the two.
 */
function parseException(json: string | null): {
  exception?: FieldStrategyException
  problem?: string
} {
  if (!json) return {}
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(json)
  } catch {
    return { problem: 'its exception is not valid JSON' }
  }
  const conditions = parsed?.conditions
  if (!Array.isArray(conditions) || conditions.length === 0 || !conditions.every(isCondition))
    return { problem: "its exception's conditions could not be read" }
  if (parsed.match !== 'all' && parsed.match !== 'any')
    return { problem: "its exception's match mode could not be read" }
  const rule = exceptionRuleFrom(parsed.rule)
  if (!rule) return { problem: "its exception's rule could not be read" }
  return { exception: { match: parsed.match, conditions, rule } }
}

/**
 * The exception as stored, or NULL for none. One with no conditions is dropped rather than stored:
 * it would match every row and quietly replace the main rule. The obfuscate floor is applied here
 * for the same reason as on the main rule.
 */
function exceptionJson(exception: FieldStrategyException | null | undefined): string | null {
  if (!exception || exception.conditions.length === 0) return null
  const rule = exception.rule as FieldStrategyRule
  if (rule.kind === 'template') throw new Error("An exception can't use a template strategy.")
  const stored =
    rule.kind === 'obfuscate' && rule.side !== 'before'
      ? { ...rule, count: Math.max(OBFUSCATE_MIN_COUNT, Math.trunc(rule.count)) }
      : rule
  return JSON.stringify({
    match: exception.match === 'any' ? 'any' : 'all',
    conditions: exception.conditions,
    rule: stored
  })
}

function toFieldStrategy(row: FieldStrategyRow): FieldStrategy {
  const { exception, problem } = parseException(row.exception_json)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tableName: row.table_name,
    columnName: row.column_name,
    rule: toRule(row),
    ...(exception ? { exception } : {}),
    ...(problem ? { invalid: problem } : {})
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
  obfuscate_delimiter: string | null
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
    // `before` stores a delimiter instead of a count; the minimum doesn't apply to it.
    obfuscate_count:
      rule.kind === 'obfuscate' && rule.side !== 'before'
        ? Math.max(OBFUSCATE_MIN_COUNT, Math.trunc(rule.count))
        : null,
    obfuscate_delimiter:
      rule.kind === 'obfuscate' && rule.side === 'before' ? rule.delimiter : null,
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

/**
 * Create/update payload. `invalid` is the store's own report, never accepted from a caller.
 * `exception: null` clears it explicitly; on an update, leaving the key out keeps the current one.
 */
export type FieldStrategyInput = Omit<FieldStrategy, 'id' | 'invalid' | 'exception'> & {
  exception?: FieldStrategyException | null
}

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
          obfuscate_side, obfuscate_count, obfuscate_delimiter, exception_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, table_name, column_name)
         DO UPDATE SET kind = excluded.kind,
                       generator = excluded.generator,
                       jitter_percent = excluded.jitter_percent,
                       template_json = excluded.template_json,
                       obfuscate_side = excluded.obfuscate_side,
                       obfuscate_count = excluded.obfuscate_count,
                       obfuscate_delimiter = excluded.obfuscate_delimiter,
                       exception_json = excluded.exception_json`
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
      cols.obfuscate_count,
      cols.obfuscate_delimiter,
      exceptionJson(input.exception)
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
  // The exception is written only when the patch names it. Otherwise the stored JSON is left exactly
  // as it is, so an edit that doesn't touch it can't silently drop one the store couldn't read.
  const setsException = Object.hasOwn(patch, 'exception')
  getDb()
    .prepare(
      `UPDATE field_strategies
         SET table_name = ?, column_name = ?, kind = ?, generator = ?, jitter_percent = ?,
             template_json = ?, obfuscate_side = ?, obfuscate_count = ?, obfuscate_delimiter = ?
             ${setsException ? ', exception_json = ?' : ''}
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
      cols.obfuscate_delimiter,
      ...(setsException ? [exceptionJson(patch.exception)] : []),
      id
    )
  return getFieldStrategy(id)
}

export function deleteFieldStrategy(id: string): void {
  getDb().prepare('DELETE FROM field_strategies WHERE id = ?').run(id)
}
