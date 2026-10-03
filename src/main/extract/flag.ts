import type { SelectionRule } from '@shared/types'
import type { DbAdapter } from '../adapters'
import { conditionColumns, evaluateConditions } from './conditions'
import { planRule } from './select'
import { mergeKeep, type PkValue, type TableSelection } from './types'

/**
 * Flag-only rules (`take: { kind: 'none' }` — docs/selection-rules-v2.md): change how rows are
 * anonymized **without adding any**.
 *
 * Why this is a separate stage rather than part of `resolveSelection`: a flag rule's whole purpose is
 * to act on rows it did not select. `resolveSelection` runs first, before cascade and backfill have
 * pulled anything in, so a rule evaluated there could only ever flag its own seeds. Running after
 * both means "preserve our staff" applies to the staff the *cascade* dragged in — which is the case
 * that motivated it.
 *
 * The rule that makes this safe: **a matched row that isn't already kept is skipped.** This stage
 * can lower an `anonymize` flag and nothing else. It never grows the subset, so it cannot invalidate
 * the cascade or backfill that already ran above it.
 *
 * Preserve-wins still governs the merge (`mergeKeep`), which means an *anonymizing* flag rule is a
 * no-op — it can't raise a preserved row back. That's deliberate rather than an oversight: §6's
 * precedence exists so an admin row can never end up partially anonymized, and a late stage that
 * could undo it would defeat the point. The Rules screen warns when a rule is written that way.
 */
export interface FlagReport {
  /** Rows whose anonymize flag actually changed, per table. Absent table = nothing changed. */
  changed: Record<string, number>
  /** Flag rules whose table contributed nothing to the subset — worth saying, since they did nothing. */
  warnings: string[]
}

export async function applyFlagRules(
  adapter: DbAdapter,
  selection: Map<string, TableSelection>,
  rules: SelectionRule[],
  now: Date
): Promise<FlagReport> {
  const changed: Record<string, number> = {}
  const warnings: string[] = []

  for (const rule of rules) {
    if (rule.take.kind !== 'none') continue

    const sel = selection.get(rule.table)
    if (!sel || sel.ids.size === 0) {
      warnings.push(
        `flag-only rule on "${rule.table}" did nothing: no rows from that table are in the subset.`
      )
      continue
    }

    const { pushable, clientSide, raw } = planRule(rule)
    // Reads every matching row's PK rather than restricting to the kept set: the kept set can hold
    // hundreds of thousands of ids, and chunking that into `IN (…)` lists costs more than the
    // filtered scan it would save. Same shape of read a v1 `pattern` rule always performed.
    const needed = new Set<string>([sel.pkColumn, ...conditionColumns(clientSide, sel.pkColumn)])
    const rows = await adapter.selectRows(rule.table, [...needed], {
      where: pushable,
      match: rule.match,
      rawWhere: raw,
      now
    })

    let n = 0
    for (const row of rows) {
      if (
        clientSide.length > 0 &&
        !evaluateConditions(row, clientSide, rule.match, sel.pkColumn, now)
      ) {
        continue
      }
      const id = row[sel.pkColumn] as PkValue
      // The whole contract of this stage: flag what's kept, add nothing.
      if (!sel.ids.has(id)) continue
      const before = sel.ids.get(id)
      mergeKeep(sel.ids, id, rule.anonymize)
      if (sel.ids.get(id) !== before) n++
    }

    if (n > 0) changed[rule.table] = (changed[rule.table] ?? 0) + n
  }

  return { changed, warnings }
}
