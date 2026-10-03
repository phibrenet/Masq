import type { ForeignKeyRef } from '@shared/types'

/**
 * Topological order of tables — parents (referenced) before children (referencing) — so a dump
 * reads in dependency order (spec §9). Kahn's algorithm over the FK graph, restricted to the given
 * table set. Self-references and FKs pointing outside the set are ignored. Any tables left in a
 * cycle are appended in their original order — the dump disables FK checks during load anyway, so a
 * perfect ordering isn't required (spec §9), this is for readability.
 */
export function topologicalOrder(tables: string[], foreignKeys: ForeignKeyRef[]): string[] {
  const inSet = new Set(tables)
  const indegree = new Map<string, number>(tables.map((t) => [t, 0]))
  // Edge parent → child. Dedupe so a multi-column FK counts once.
  const children = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]))

  for (const fk of foreignKeys) {
    const parent = fk.referencedTable
    const child = fk.table
    if (parent === child) continue // self-reference: no ordering constraint
    if (!inSet.has(parent) || !inSet.has(child)) continue
    const kids = children.get(parent)!
    if (!kids.has(child)) {
      kids.add(child)
      indegree.set(child, (indegree.get(child) ?? 0) + 1)
    }
  }

  // Seed with zero-indegree tables, preserving the input order for determinism.
  const queue = tables.filter((t) => (indegree.get(t) ?? 0) === 0)
  const ordered: string[] = []
  const emitted = new Set<string>()

  while (queue.length > 0) {
    const table = queue.shift()!
    ordered.push(table)
    emitted.add(table)
    for (const child of children.get(table) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1
      indegree.set(child, next)
      if (next === 0) queue.push(child)
    }
  }

  // Cycle remainder: append anything not yet emitted, in original order.
  for (const table of tables) {
    if (!emitted.has(table)) ordered.push(table)
  }

  return ordered
}
