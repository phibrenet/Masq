import type { Knex } from 'knex'

/**
 * The predicate that narrows a table's dumped rows (`streamRows`).
 *
 * Two shapes, because the dump has two ways of deciding a row belongs. The ordinary one is
 * `columns` — "this column's value is one of the kept ids", which covers a subset table filtered by
 * its primary key and a link table filtered by its foreign keys alike. `morphs` exists for the one
 * case that can't be written as an AND of INs: a polymorphic pair, where the *set* an id must belong
 * to is chosen by a sibling type column, so the predicate is an OR over type values (see
 * `link-tables.ts`).
 *
 * **Layering note:** the adapters import this module, the same deliberate inversion `conditions.ts`
 * documents — it's a leaf that imports only knex's types, and keeping the filter shape next to the
 * code that builds it beats splitting the two halves across the adapter boundary.
 */

/**
 * One polymorphic endpoint: `typeColumn` chooses which table `idColumn` points at, so each mapped
 * type value carries its own allowed-id set. Compiles to an OR of `(type = ? AND id IN (…))` groups.
 *
 * A row whose type value has no alternative here matches nothing and is dropped — the "log and
 * skip" stance `findUnmappedTypeValues` already reports on, applied to row selection.
 */
export interface MorphFilter {
  typeColumn: string
  idColumn: string
  alternatives: MorphAlternative[]
}

/** `ids` omitted = every id is allowed for this type value (its target is dumped whole). */
export interface MorphAlternative {
  typeValue: string
  ids?: unknown[]
}

export interface RowFilter {
  /** Column → allowed values. ANDed, one `IN` each. */
  columns?: Record<string, unknown[]>
  /** Polymorphic endpoints. ANDed with each other and with `columns`. */
  morphs?: MorphFilter[]
}

/**
 * Compile a `RowFilter` onto a knex query.
 *
 * An empty allowed-value list is *meaningful*, not a no-op: "no kept parents" must yield no rows,
 * which is what knex's own `whereIn(col, [])` → `1 = 0` gives. A morph with no usable alternatives
 * is the same statement and is written explicitly, because an empty `where` callback would compile
 * to an empty group and fail to parse.
 */
export function applyRowFilter(
  query: Knex.QueryBuilder,
  filter: RowFilter | undefined
): Knex.QueryBuilder {
  if (!filter) return query
  for (const [column, values] of Object.entries(filter.columns ?? {})) {
    query = query.whereIn(column, values as (string | number)[])
  }
  for (const morph of filter.morphs ?? []) {
    if (morph.alternatives.length === 0) {
      query = query.whereRaw('1 = 0')
      continue
    }
    query = query.where((group) => {
      for (const alternative of morph.alternatives) {
        group.orWhere((one) => {
          one.where(morph.typeColumn, alternative.typeValue)
          if (alternative.ids) one.whereIn(morph.idColumn, alternative.ids as (string | number)[])
        })
      }
    })
  }
  return query
}
