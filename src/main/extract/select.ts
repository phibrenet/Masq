import type { Condition, SelectionRule } from '@shared/types'
import { rawWhereError } from '@shared/raw-where'
import type { DbAdapter } from '../adapters'
import {
  compareValues,
  conditionColumns,
  evaluateConditions,
  partitionConditions,
  validateConditions
} from './conditions'
import { primaryKeyColumn } from './pk'
import { mergeKeep, type PkValue, type TableSelection } from './types'

/**
 * Selection resolution (spec §6, v2 — docs/selection-rules-v2.md): turn a workspace's selection
 * rules into a set of kept PK values per table, each tagged with an anonymize flag. This produces
 * only the **direct** (rule-matched) seed rows — a transactional table with no rule simply isn't in
 * the result and gets its rows purely from FK cascade (slice 3). Merge precedence across a table's
 * rules is preserve-wins.
 *
 * A v2 rule is a **filter** (`where` + `match`, or a `rawWhere` escape hatch) plus a **take** (all /
 * random sample / ordered top-N). Resolution is therefore one of two shapes per rule:
 *
 * - **Fully pushable** (no `matches` condition) — the whole rule becomes one query. Filter *and*
 *   limit run in the database, which is what makes "20 recent users without a work email" a single
 *   indexed read rather than v1's whole-table transfer.
 * - **Partly client-side** (a `matches` condition) — the pushable half filters in SQL, the regex is
 *   re-checked in Node, and **the take is applied afterwards, here**. Pushing the limit too would
 *   cap the rows *before* the regex ran: sampling 20 and keeping the 3 that match is a different
 *   rule from keeping 20 that match. See `applyTakeInMemory`.
 */
export async function resolveSelection(
  adapter: DbAdapter,
  rules: SelectionRule[],
  /**
   * The run's single cutoff instant for relative-date conditions. Passed in rather than read here
   * so every table in one extract compares against the same "90 days ago", and so tests are
   * deterministic.
   */
  now: Date = new Date()
): Promise<Map<string, TableSelection>> {
  const byTable = new Map<string, SelectionRule[]>()
  for (const rule of rules) {
    const arr = byTable.get(rule.table) ?? []
    arr.push(rule)
    byTable.set(rule.table, arr)
  }

  const result = new Map<string, TableSelection>()
  for (const [table, tableRules] of byTable) {
    const pkColumn = await primaryKeyColumn(adapter, table)
    const ids = new Map<PkValue, boolean>()
    // Rule-matched rows ARE the root entities, so they carry no identity entry — see `identities`.
    const identities = new Map<PkValue, string>()
    let keepAll = false

    for (const rule of tableRules) {
      // Flag-only rules add no rows by definition — they're applied after cascade and backfill by
      // `applyFlagRules`, against whatever those stages ended up keeping.
      if (rule.take.kind === 'none') continue
      // `keepAll` lets the dump writer skip a `WHERE … IN (…)` over every PK in the table. It is
      // only true for a rule that genuinely selects everything: no filter of any kind, no cap.
      if (isUnfiltered(rule)) keepAll = true

      for (const id of await resolveRule(adapter, rule, pkColumn, now)) {
        mergeKeep(ids, id, rule.anonymize)
      }
    }

    result.set(table, { table, pkColumn, ids, identities, keepAll })
  }

  return result
}

/** A rule that selects the whole table — the v2 spelling of v1's `all` strategy. */
function isUnfiltered(rule: SelectionRule): boolean {
  return !rule.rawWhere?.trim() && rule.where.length === 0 && rule.take.kind === 'all'
}

/**
 * How a rule splits between the database and Node. Shared with the Rules screen's preview
 * (`preview.ts`), so what the preview counts is what the extract will keep.
 */
export interface RulePlan {
  /** Conditions the database can answer. Empty when a `rawWhere` takes over. */
  pushable: Condition[]
  /** Conditions Node must answer — regexes, or everything when an `any` rule contains one. */
  clientSide: Condition[]
  /** The raw SQL predicate, if the rule uses one instead of conditions. */
  raw?: string
}

export function planRule(
  rule: Pick<SelectionRule, 'table' | 'match' | 'where' | 'rawWhere' | 'invalid'>
): RulePlan {
  // Refuse rather than run a rule the store couldn't read back faithfully. Every repair the
  // repository makes **widens** the rule, and a widened `anonymize: false` rule dumps a whole table
  // with real data — so failing the run loudly is the only safe answer. The rule still opens on the
  // Rules screen; saving it rewrites the JSON and clears this.
  if (rule.invalid) {
    throw new Error(
      `The selection rule for "${rule.table}" can't be run: ${rule.invalid}. ` +
        `Open it on the Rules screen, check it reads the way you intended, and save it.`
    )
  }
  validateConditions(rule.where, rule.table)
  // A raw predicate is opaque to the partitioner — it's SQL by definition, so all of it pushes.
  const raw = rule.rawWhere?.trim()
  if (raw) {
    const error = rawWhereError(raw)
    if (error) throw new Error(`Raw SQL rule for "${rule.table}": ${error}`)
    return { pushable: [], clientSide: [], raw }
  }
  return partitionConditions(rule.where, rule.match)
}

/**
 * Rows matching a rule's filter, with the take applied. Returns whole rows (PK plus whatever the
 * client-side half needed) rather than ids, so the preview can count them without a second read.
 */
export async function selectRuleRows(
  adapter: DbAdapter,
  rule: SelectionRule,
  pkColumn: string,
  now: Date
): Promise<Record<string, unknown>[]> {
  const { pushable, clientSide, raw } = planRule(rule)

  // Read the PK, plus whatever columns the client-side half needs to make its decision, plus the
  // ordering column when `top` is being applied in memory (it can't sort by a column it can't see).
  const needed = new Set<string>([pkColumn, ...conditionColumns(clientSide, pkColumn)])
  if (clientSide.length > 0 && rule.take.kind === 'top') needed.add(rule.take.orderBy)

  const rows = await adapter.selectRows(rule.table, [...needed], {
    where: pushable,
    match: rule.match,
    rawWhere: raw,
    now,
    // Withheld whenever a client-side filter still has to run — see the note on `resolveSelection`.
    take: clientSide.length > 0 ? undefined : rule.take
  })

  if (clientSide.length === 0) return rows

  const matched = rows.filter((row) =>
    evaluateConditions(row, clientSide, rule.match, pkColumn, now)
  )
  return applyTakeInMemory(matched, rule, pkColumn)
}

/**
 * The PK values one rule selects.
 *
 * Note what happens to the values themselves: every id here was read back **from the table's own PK
 * column**, so it is typed the way the dump's row stream will emit it. That's the property v1 had to
 * buy for its `explicit` strategy with a `getExistingIds` round trip — as `pk IN (…)` pushed into
 * SQL, the database does the comparison and hands back its own values, so it comes for free. See
 * the selection-key rule in `.memory/decisions.md` (2026-07-30).
 */
async function resolveRule(
  adapter: DbAdapter,
  rule: SelectionRule,
  pkColumn: string,
  now: Date
): Promise<PkValue[]> {
  const rows = await selectRuleRows(adapter, rule, pkColumn, now)
  return rows.map((row) => row[pkColumn] as PkValue)
}

/**
 * The in-memory counterpart of `applyTake`, used only when a client-side filter ran first.
 *
 * `sample` shuffles rather than slicing: taking the first N of a database's natural order would
 * bias every sample toward the oldest rows, which is the one thing a random sample exists to avoid.
 */
function applyTakeInMemory(
  rows: Record<string, unknown>[],
  rule: SelectionRule,
  pkColumn: string
): Record<string, unknown>[] {
  const take = rule.take
  // `none` never reaches here — `resolveSelection` skips flag-only rules entirely — but the guard
  // keeps the narrowing honest rather than resting on that.
  if (take.kind === 'all' || take.kind === 'none') return rows
  if (take.kind === 'sample') return shuffle(rows).slice(0, Math.max(0, take.count))

  const key = take.orderBy || pkColumn
  // `compareValues`, not `String()`: this path only runs when a regex forced the take in-memory, and
  // the *same rule without the regex* would have been ordered by the database. A lexical comparison
  // put `10` before `2`, so "newest 20 by id" quietly returned a different set depending on whether
  // the rule happened to contain a regex.
  const sorted = [...rows].sort((a, b) => compareValues(a[key], b[key]))
  // Sorted ascending then reversed, rather than negating the comparator, so ties keep a stable order.
  if (take.dir === 'desc') sorted.reverse()
  return sorted.slice(0, Math.max(0, take.count))
}

/** Fisher–Yates, in place on a copy. */
function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
