import type { DbAdapter } from '../adapters'
import { CancelledError } from './cancel'

/**
 * The single-column primary key of a table. Throws on a composite or missing PK — the extract
 * engine addresses rows by a single id value (selection, cascade), which a composite PK can't
 * provide yet (spec §4; composite support is a later enhancement). Mirrors the adapter's own
 * private resolver, but lives here so pipeline stages can resolve a PK without a data-movement call.
 */
export async function primaryKeyColumn(adapter: DbAdapter, table: string): Promise<string> {
  const pks = (await adapter.getColumns(table)).filter((c) => c.isPrimaryKey)
  if (pks.length === 0) throw new Error(`Table "${table}" has no primary key.`)
  if (pks.length > 1) {
    throw new Error(
      `Table "${table}" has a composite primary key (${pks
        .map((c) => c.name)
        .join(', ')}) — not supported for id-based selection/cascade yet.`
    )
  }
  return pks[0].name
}

/**
 * Drop items whose table can't be addressed by a single-column primary key, reporting each once.
 *
 * `cascadeSelection` and `backfillSelection` address rows by a single id, so a composite- or
 * missing-PK table can't take part. The important thing is *where* that gets decided: resolving it
 * up front turns "the whole extract throws" into "this edge is reported and skipped", which matters
 * because the offending table is often perfectly ordinary — Laravel/Spatie's `model_has_roles` and
 * `model_has_permissions` are pivot tables with a three-column PK and a real FK each, so a schema can
 * contain them without anything being wrong.
 *
 * Shared by the FK and morph paths: both need the same verdict, and one cache means a table is
 * introspected once however many edges touch it.
 */
export async function filterAddressable<T>(
  adapter: DbAdapter,
  items: T[],
  describe: (item: T) => { table: string; label: string }
): Promise<{ items: T[]; warnings: string[] }> {
  const warnings: string[] = []
  const verdict = new Map<string, boolean>()
  const kept: T[] = []

  for (const item of items) {
    const { table, label } = describe(item)
    let addressable = verdict.get(table)
    if (addressable === undefined) {
      try {
        await primaryKeyColumn(adapter, table)
        addressable = true
      } catch (err) {
        if (err instanceof CancelledError) throw err
        addressable = false
        warnings.push(`${label} can't be followed: ${(err as Error).message}`)
      }
      verdict.set(table, addressable)
    }
    if (addressable) kept.push(item)
  }
  return { items: kept, warnings }
}
