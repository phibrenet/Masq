import { randomUUID } from 'crypto'
import {
  CONDITION_OPS,
  type Condition,
  type MatchMode,
  type SelectionRule,
  type Take
} from '@shared/types'
import { getDb } from '../db'

/**
 * Selection-rule CRUD (spec §6, v2 — docs/selection-rules-v2.md). Unlike table classifications, a
 * table can carry *several* rules ("20 recent non-staff users" plus "keep all @example.com
 * staff"), so this is plain create/update/delete keyed by id — no upsert-on-unique.
 *
 * Boundary conversions: `anonymize` is a 0/1 INTEGER in SQLite ↔ boolean in the domain; `where` and
 * `take` are JSON strings ↔ structured values. Because SQLite CHECK can't validate a JSON payload
 * (see migration 010's note on why these are columns rather than a child table), **this module is
 * where shape validation lives** — a malformed row degrades to a safe default rather than crashing
 * the app or, worse, silently selecting the wrong rows.
 */

interface SelectionRuleRow {
  id: string
  workspace_id: string
  table_name: string
  match_mode: MatchMode
  conditions_json: string
  take_json: string
  raw_where: string | null
  anonymize: number
}

/** Every operator the compiler knows — the guard that keeps a hand-edited config out of the engine. */
const OPS = new Set<string>(CONDITION_OPS)

/**
 * Parse `conditions_json` leniently, **reporting** anything it had to drop.
 *
 * Reading leniently is right — a damaged rule must still open on the Rules screen, the one place it
 * can be repaired, and a throw here would make that screen unopenable. Reading leniently and staying
 * *quiet* about it is not: every repair this makes **widens** the rule, and a widened
 * `anonymize: false` rule means an entire table dumped with real data. So the damage is recorded and
 * `planRule` refuses to run the rule. See `SelectionRule.invalid`.
 */
function parseConditions(json: string): { conditions: Condition[]; problem?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { conditions: [], problem: 'its conditions are not valid JSON' }
  }
  if (!Array.isArray(parsed)) return { conditions: [], problem: 'its conditions are not a list' }

  const conditions = parsed.filter(
    (c): c is Condition =>
      !!c &&
      typeof c === 'object' &&
      (typeof c.column === 'string' || c.column === null) &&
      OPS.has(c.op)
  )
  if (conditions.length === parsed.length) return { conditions }
  const dropped = parsed.length - conditions.length
  return {
    conditions,
    problem: `${dropped} of its ${parsed.length} condition(s) could not be read (unknown operator, or missing column)`
  }
}

/** Parse `take_json`, reporting an unrecognised one rather than quietly widening it to `all`. */
function parseTake(json: string): { take: Take; problem?: string } {
  try {
    const t = JSON.parse(json)
    if (t?.kind === 'all') return { take: { kind: 'all' } }
    if (t?.kind === 'none') return { take: { kind: 'none' } }
    if (t?.kind === 'sample' && typeof t.count === 'number') {
      return { take: { kind: 'sample', count: t.count } }
    }
    if (t?.kind === 'top' && typeof t.count === 'number' && typeof t.orderBy === 'string') {
      return {
        take: {
          kind: 'top',
          count: t.count,
          orderBy: t.orderBy,
          dir: t.dir === 'asc' ? 'asc' : 'desc'
        }
      }
    }
  } catch {
    // fall through to the same report as an unrecognised shape
  }
  // `all` is the widest possible take, so falling back to it silently is exactly the failure this
  // guards against — the rule opens showing "All rows" but will not run until it's saved.
  return { take: { kind: 'all' }, problem: 'its row limit could not be read' }
}

function toSelectionRule(row: SelectionRuleRow): SelectionRule {
  const conditions = parseConditions(row.conditions_json)
  const take = parseTake(row.take_json)
  // A rule with a raw predicate stores no conditions, so an empty `[]` there is normal rather than
  // damage — don't report the condition problem for one.
  const problems = [row.raw_where ? undefined : conditions.problem, take.problem].filter(Boolean)

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    table: row.table_name,
    match: row.match_mode === 'any' ? 'any' : 'all',
    where: conditions.conditions,
    take: take.take,
    rawWhere: row.raw_where ?? undefined,
    anonymize: row.anonymize === 1,
    invalid: problems.length > 0 ? problems.join('; ') : undefined
  }
}

/**
 * Create/update payload. `invalid` is omitted: it describes what the *store* could not read back, so
 * accepting it from a caller would let a rule be written already-broken. Saving always rewrites the
 * JSON from the parsed model, which is what clears the flag.
 */
export type SelectionRuleInput = Omit<SelectionRule, 'id' | 'invalid'>

export function listSelectionRulesByWorkspace(workspaceId: string): SelectionRule[] {
  return (
    getDb()
      .prepare('SELECT * FROM selection_rules WHERE workspace_id = ? ORDER BY table_name, rowid')
      .all(workspaceId) as SelectionRuleRow[]
  ).map(toSelectionRule)
}

export function getSelectionRule(id: string): SelectionRule | undefined {
  const row = getDb().prepare('SELECT * FROM selection_rules WHERE id = ?').get(id) as
    SelectionRuleRow | undefined
  return row ? toSelectionRule(row) : undefined
}

/**
 * Persisted column values for a rule. `raw_where` and `conditions_json` are mutually exclusive by
 * design — a rule filters one way or the other, never both (docs/selection-rules-v2.md) — so a rule
 * with a `rawWhere` stores an empty condition list rather than a stale one nothing will read.
 */
function toColumns(input: SelectionRuleInput): {
  match_mode: MatchMode
  conditions_json: string
  take_json: string
  raw_where: string | null
} {
  const raw = input.rawWhere?.trim()
  return {
    match_mode: input.match === 'any' ? 'any' : 'all',
    conditions_json: JSON.stringify(raw ? [] : (input.where ?? [])),
    take_json: JSON.stringify(input.take ?? { kind: 'all' }),
    raw_where: raw ? raw : null
  }
}

export function createSelectionRule(input: SelectionRuleInput): SelectionRule {
  const id = randomUUID()
  const cols = toColumns(input)
  getDb()
    .prepare(
      `INSERT INTO selection_rules
         (id, workspace_id, table_name, match_mode, conditions_json, take_json, raw_where, anonymize)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.workspaceId,
      input.table,
      cols.match_mode,
      cols.conditions_json,
      cols.take_json,
      cols.raw_where,
      input.anonymize ? 1 : 0
    )
  return getSelectionRule(id)!
}

export function updateSelectionRule(
  id: string,
  patch: Partial<SelectionRuleInput>
): SelectionRule | undefined {
  const existing = getSelectionRule(id)
  if (!existing) return undefined
  const next = { ...existing, ...patch }
  const cols = toColumns(next)
  getDb()
    .prepare(
      `UPDATE selection_rules
         SET table_name = ?, match_mode = ?, conditions_json = ?, take_json = ?,
             raw_where = ?, anonymize = ?
       WHERE id = ?`
    )
    .run(
      next.table,
      cols.match_mode,
      cols.conditions_json,
      cols.take_json,
      cols.raw_where,
      next.anonymize ? 1 : 0,
      id
    )
  return getSelectionRule(id)
}

export function deleteSelectionRule(id: string): void {
  getDb().prepare('DELETE FROM selection_rules WHERE id = ?').run(id)
}
