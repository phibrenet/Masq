import type { SelectionRule, SelectionRulePreview } from '@shared/types'
import type { DbAdapter } from '../adapters'
import { conditionColumns, evaluateConditions } from './conditions'
import { primaryKeyColumn } from './pk'
import { planRule } from './select'

/**
 * How many rows a rule matches, for the Rules screen (docs/selection-rules-v2.md).
 *
 * Cheap feedback that turns rule-writing from guesswork into something you can check: a typo'd
 * column, an accidentally-empty match set, a NULL trap and a mis-scoped filter all become visible
 * *before* a 40-minute extract rather than after it. It doubles as the validator for the `rawWhere`
 * escape hatch — a fragment that counts is a fragment that parses.
 *
 * Deliberately shares `planRule` with the extract, so what this counts is what the run will keep.
 */
export async function previewRule(
  adapter: DbAdapter,
  /** An unsaved draft is the normal case — the screen previews before it saves. */
  rule: Omit<SelectionRule, 'id' | 'workspaceId'>,
  now: Date = new Date()
): Promise<SelectionRulePreview> {
  const pkColumn = await primaryKeyColumn(adapter, rule.table)
  const { pushable, clientSide, raw } = planRule(rule)
  const filter = { where: pushable, match: rule.match, rawWhere: raw, now }

  let matched: number
  if (clientSide.length === 0) {
    // Fully pushable: one `COUNT(*)`, no rows over the wire.
    matched = await adapter.countRows(rule.table, filter)
  } else {
    // A regex still has to run in Node, so the rows it needs have to be read — the same cost the
    // extract itself would pay, and the same cost a v1 `pattern` rule always paid.
    const needed = new Set<string>([pkColumn, ...conditionColumns(clientSide, pkColumn)])
    const rows = await adapter.selectRows(rule.table, [...needed], filter)
    matched = rows.filter((row) =>
      evaluateConditions(row, clientSide, rule.match, pkColumn, now)
    ).length
  }

  // Exact either way: the client-side branch evaluates every row the pushable half returned, so it
  // counts the same set the extract would keep — it just pays for the rows to do it.
  //
  // `keeping` means "rows this rule contributes to the subset", so a flag-only rule reports 0 —
  // literally correct, and the screen explains the rest. How many of the `matched` rows it will
  // actually re-flag is unknowable here: that depends on what cascade and backfill pull in, which
  // hasn't happened.
  const take = rule.take
  const keeping =
    take.kind === 'none'
      ? 0
      : take.kind === 'all'
        ? matched
        : Math.min(matched, Math.max(0, take.count))

  return { matched, keeping }
}
