import {
  DURATION_UNIT_VALUES,
  NEGATIVE_OPS,
  type Condition,
  type ConditionOp,
  type DurationUnit,
  type SelectionRule
} from '@shared/types'

/**
 * The renderer's half of the condition vocabulary (docs/selection-rules-v2.md): which operators a
 * column can take, what to call them, and how to render a saved rule as a sentence.
 *
 * Deliberately separate from `src/main/extract/conditions.ts`, which decides what a condition
 * *means*. This module only decides what it *looks like* — no SQL, no evaluation, so the two can't
 * drift into disagreeing about semantics.
 */

/** How much of the operator list a column can sensibly take, guessed from its dialect-native type. */
export type ColumnFamily = 'text' | 'number' | 'date' | 'bool'

/**
 * Classify a column from `ColumnInfo.dataType` — `varchar(255)`, `bigint unsigned`, `timestamptz`.
 *
 * A guess, not a contract: the operator list narrows to what makes sense, and the column select
 * still accepts a typed name when discovery hasn't run. Getting it wrong costs a missing operator,
 * never a wrong query. Order matters — `timestamp` contains `time`, and `interval` contains `int`.
 */
export function columnFamily(dataType: string): ColumnFamily {
  const t = (dataType ?? '').toLowerCase()
  if (/bool|^bit/.test(t)) return 'bool'
  if (/date|time|year/.test(t)) return 'date'
  if (/int|dec|numeric|float|double|real|money|serial/.test(t)) return 'number'
  return 'text'
}

/** What input a given operator needs — `none` renders no value field at all. */
export type ValueKind = 'text' | 'list' | 'duration' | 'none'

export interface OperatorSpec {
  op: ConditionOp
  label: string
  valueKind: ValueKind
  families: ColumnFamily[]
}

/**
 * Every operator, with the column families it's offered for. This is what stops the builder feeling
 * like a generic query tool: a date column offers "in the last N days" and never "contains".
 */
export const OPERATORS: OperatorSpec[] = [
  { op: 'contains', label: 'contains', valueKind: 'text', families: ['text'] },
  { op: 'notContains', label: 'does not contain', valueKind: 'text', families: ['text'] },
  { op: 'startsWith', label: 'starts with', valueKind: 'text', families: ['text'] },
  { op: 'endsWith', label: 'ends with', valueKind: 'text', families: ['text'] },
  { op: 'matches', label: 'matches regex', valueKind: 'text', families: ['text'] },
  { op: 'eq', label: 'is', valueKind: 'text', families: ['text', 'number', 'bool'] },
  { op: 'neq', label: 'is not', valueKind: 'text', families: ['text', 'number', 'bool'] },
  { op: 'gt', label: 'is greater than', valueKind: 'text', families: ['number'] },
  { op: 'gte', label: 'is at least', valueKind: 'text', families: ['number'] },
  { op: 'lt', label: 'is less than', valueKind: 'text', families: ['number'] },
  { op: 'lte', label: 'is at most', valueKind: 'text', families: ['number'] },
  { op: 'withinLast', label: 'is in the last', valueKind: 'duration', families: ['date'] },
  { op: 'olderThan', label: 'is older than', valueKind: 'duration', families: ['date'] },
  { op: 'gt', label: 'is after', valueKind: 'text', families: ['date'] },
  { op: 'lt', label: 'is before', valueKind: 'text', families: ['date'] },
  { op: 'in', label: 'is one of', valueKind: 'list', families: ['text', 'number'] },
  { op: 'notIn', label: 'is not one of', valueKind: 'list', families: ['text', 'number'] },
  {
    op: 'isNull',
    label: 'is empty',
    valueKind: 'none',
    families: ['text', 'number', 'date', 'bool']
  },
  {
    op: 'notNull',
    label: 'is not empty',
    valueKind: 'none',
    families: ['text', 'number', 'date', 'bool']
  }
]

/**
 * Operators that widen to also match NULL, where the choice is worth surfacing.
 *
 * See `Condition.includeNulls`: the *engine* defaults these to include NULLs because the alternative
 * silently drops rows nobody meant to drop. The UI shows the checkbox so the default is visible
 * rather than merely correct.
 */
export function isNegativeOp(op: ConditionOp): boolean {
  return NEGATIVE_OPS.some((negative) => negative === op)
}

/** Operators offered for a column family, in `OPERATORS` order. */
export function operatorsFor(family: ColumnFamily): OperatorSpec[] {
  return OPERATORS.filter((o) => o.families.includes(family))
}

export function valueKindOf(op: ConditionOp, family: ColumnFamily): ValueKind {
  return OPERATORS.find((o) => o.op === op && o.families.includes(family))?.valueKind ?? 'text'
}

export function operatorLabel(op: ConditionOp, family: ColumnFamily): string {
  const exact = OPERATORS.find((o) => o.op === op && o.families.includes(family))
  return exact?.label ?? OPERATORS.find((o) => o.op === op)?.label ?? op
}

export const DURATION_UNITS: { label: string; value: DurationUnit }[] = DURATION_UNIT_VALUES.map(
  (value) => ({ label: `${value}s`, value })
)

// ─── Rendering a saved rule ───────────────────────────────────────────────────

function describeValue(c: Condition): string {
  const kind = valueKindOf(c.op, 'text')
  if (kind === 'none') return ''
  if (kind === 'duration') {
    const d = c.value as { n?: number; unit?: DurationUnit } | undefined
    const unit = DURATION_UNITS.find((u) => u.value === d?.unit)?.label ?? d?.unit ?? ''
    return ` ${d?.n ?? '?'} ${unit}`
  }
  if (kind === 'list') {
    const items = Array.isArray(c.value) ? c.value : []
    const shown = items.slice(0, 3).join(', ')
    return items.length > 3 ? ` ${shown} (+${items.length - 3} more)` : ` ${shown}`
  }
  return ` "${String(c.value ?? '')}"`
}

/** One condition as a phrase: `email does not contain "@example.com"`. */
export function describeCondition(c: Condition): string {
  const column = c.column ?? 'primary key'
  const label = operatorLabel(c.op, 'text')
  const suffix = isNegativeOp(c.op) && c.includeNulls === false ? ' (excluding empty)' : ''
  return `${column} ${label}${describeValue(c)}${suffix}`
}

/** The take, phrased as the subject of the sentence. */
export function describeTake(rule: SelectionRule): string {
  const take = rule.take
  if (take.kind === 'sample') return `Random ${take.count} rows`
  if (take.kind === 'top') {
    return `${take.dir === 'desc' ? 'Newest' : 'Oldest'} ${take.count} by ${take.orderBy}`
  }
  // A flag-only rule reads better led by what it *does*, since it adds nothing.
  if (take.kind === 'none') {
    return `${rule.anonymize ? 'Anonymize' : 'Preserve'} (adds no rows)`
  }
  return 'All rows'
}

/**
 * A rule as one readable line — what the Rules screen shows instead of a strategy name.
 * `Random 20 rows where email does not contain "@example.com" and created_at is in the last 90 days`
 */
export function describeRule(rule: SelectionRule): string {
  const take = describeTake(rule)
  const raw = rule.rawWhere?.trim()
  if (raw) return `${take} where ${raw}`
  if (rule.where.length === 0) return take
  const joiner = rule.match === 'any' ? ' or ' : ' and '
  return `${take} where ${rule.where.map(describeCondition).join(joiner)}`
}
