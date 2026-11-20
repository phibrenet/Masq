import type { ColumnInfo, Condition, ConditionOp, DurationUnit } from '@shared/types'
import { columnFamily, isNegativeOp, valueKindOf, type ColumnFamily } from './conditions'

/**
 * A condition mid-edit, shared by every form that edits a condition list (selection rules, and a
 * field strategy's exception). Kept flatter than the persisted `Condition` so each input binds to
 * its own field — the value is a string, a list, or an (n, unit) pair depending on the operator, and
 * switching operators shouldn't discard what the others held.
 */
export interface DraftCondition {
  column: string
  op: ConditionOp
  text: string
  listText: string
  n: number | null
  unit: DurationUnit
  includeNulls: boolean
}

export function blankCondition(): DraftCondition {
  return {
    column: '',
    op: 'contains',
    text: '',
    listText: '',
    n: 90,
    unit: 'day',
    // Matches the engine's default: a negative operator matches NULLs unless told otherwise.
    includeNulls: true
  }
}

export function toDraft(c: Condition): DraftCondition {
  const duration = (c.value ?? {}) as { n?: number; unit?: DurationUnit }
  const isDuration = c.op === 'withinLast' || c.op === 'olderThan'
  return {
    column: c.column ?? '',
    op: c.op,
    text: isDuration || Array.isArray(c.value) ? '' : String(c.value ?? ''),
    listText: Array.isArray(c.value) ? c.value.join('\n') : '',
    n: isDuration ? (duration.n ?? 90) : 90,
    unit: isDuration ? (duration.unit ?? 'day') : 'day',
    includeNulls: c.includeNulls !== false
  }
}

/** Unknown column (discovery hasn't run, or a typed name) falls back to the text operators. */
export function familyOf(columns: ColumnInfo[], name: string): ColumnFamily {
  const info = columns.find((c) => c.name === name)
  return info ? columnFamily(info.dataType) : 'text'
}

/**
 * Split a textarea into `in`/`notIn` values: one per line or comma-separated.
 *
 * Kept as the text typed, exactly as a scalar value is. Converting numeric-looking items changed
 * them: the text id `00123` became `123`, and `9007199254740993` rounded to `…992`. The database
 * compares a quoted number against a numeric column correctly, so nothing needs the conversion.
 */
export function parsedList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
}

export function toCondition(c: DraftCondition, columns: ColumnInfo[]): Condition {
  const kind = valueKindOf(c.op, familyOf(columns, c.column))
  const base: Condition = { column: c.column.trim() || null, op: c.op }
  if (isNegativeOp(c.op)) base.includeNulls = c.includeNulls
  if (kind === 'none') return base
  if (kind === 'duration') return { ...base, value: { n: c.n ?? 0, unit: c.unit } }
  if (kind === 'list') return { ...base, value: parsedList(c.listText) }
  return { ...base, value: c.text }
}

/** Compile-check every regex, so a bad pattern fails on save and not mid-extract. */
export function invalidRegex(conditions: DraftCondition[]): string | null {
  for (const c of conditions) {
    if (c.op !== 'matches') continue
    try {
      new RegExp(c.text)
    } catch (err) {
      return `Invalid regex for ${c.column || 'column'}: ${(err as Error).message}`
    }
  }
  return null
}
