import type { ForeignKeyRef, MorphCandidate, MorphCandidateValue } from '@shared/types'
import type { DbAdapter } from './types'

/**
 * Propose morph relations by introspecting a source (docs/polymorphic-cascade.md, "Config model").
 *
 * A polymorphic relation carries no constraint, so it cannot be introspected *as a relation* — only
 * guessed at from column naming and then confirmed. This makes the builder UI confirm-not-author:
 * find the `X_type`/`X_id` column pairs, read the type values actually present, and best-guess each
 * value's target table. The user ticks and corrects rather than typing everything.
 *
 * Nothing here writes config. A candidate is a suggestion until the user declares it.
 */

/** Suffix that marks the type half of a morph pair. Laravel's convention, and the only one used. */
const TYPE_SUFFIX = '_type'

/**
 * Cap on distinct type values read per candidate. A real morph type column holds a handful of
 * values; a column with hundreds is something else (a category, a free-text label), and the cap
 * stops detection from doing expensive work to prove it.
 */
const MAX_TYPE_VALUES = 50

export async function detectMorphCandidates(adapter: DbAdapter): Promise<MorphCandidate[]> {
  const tables = await adapter.getTables()
  const tableSet = new Set(tables)
  const foreignKeys = await adapter.getForeignKeys()
  // A column that already has a real FK is a plain relation, not a morph — its target doesn't vary.
  // Keyed on the *id* column, which is what a morph would have left unconstrained.
  const constrained = new Set(foreignKeys.map((fk: ForeignKeyRef) => `${fk.table}.${fk.column}`))

  const candidates: MorphCandidate[] = []
  for (const table of tables) {
    const columns = await adapter.getColumns(table)
    const names = new Set(columns.map((c) => c.name))

    for (const column of columns) {
      if (!column.name.endsWith(TYPE_SUFFIX)) continue
      const base = column.name.slice(0, -TYPE_SUFFIX.length)
      if (!base) continue
      const idColumn = `${base}_id`
      if (!names.has(idColumn)) continue // no sibling id column — not a morph pair
      if (constrained.has(`${table}.${idColumn}`)) continue // real FK: a plain relation

      // Empty result is still reported: an empty table (or an all-NULL column) is a relation the user
      // may well want declared before the data arrives.
      const raw = await adapter.getDistinctValues(table, column.name, MAX_TYPE_VALUES)
      const typeValues: MorphCandidateValue[] = raw
        .map((v) => String(v))
        .filter((v) => v.length > 0)
        .sort()
        .map((typeValue) => ({ typeValue, guessedTable: guessTargetTable(typeValue, tableSet) }))

      candidates.push({ tableName: table, typeColumn: column.name, idColumn, typeValues })
    }
  }
  return candidates
}

/**
 * Best guess at the table a type value points at: class basename → snake_case → pluralised
 * (`App\Models\Conference` → `conferences`).
 *
 * **Validated against the real table list**, which is what makes a heuristic safe here: an unmatched
 * guess returns `undefined` and the UI asks, rather than offering a plausible-looking table name that
 * doesn't exist. Irregular plurals we don't model (`Person` → `people`) simply fall through to that.
 */
export function guessTargetTable(typeValue: string, tables: Set<string>): string | undefined {
  // Basename of a namespaced class, tolerating either separator; a bare alias (`user`) is unchanged.
  const base = typeValue.split(/[\\/]/).pop()?.trim()
  if (!base) return undefined
  const snake = toSnakeCase(base)
  if (!snake) return undefined
  for (const candidate of pluralCandidates(snake)) {
    if (tables.has(candidate)) return candidate
  }
  return undefined
}

function toSnakeCase(value: string): string {
  return (
    value
      // Split an acronym from a following word first (`APIClient` → `API_Client`), so the general
      // boundary rule below doesn't chop the acronym into single letters.
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[\s-]+/g, '_')
      .toLowerCase()
  )
}

/**
 * Candidate table names for a singular snake_case noun, **most specific first**. The unchanged form
 * leads so an already-plural or uncountable name (`media`, or a type value that's literally the table
 * name) matches before a wrong `+s` is tried.
 */
function pluralCandidates(snake: string): string[] {
  const out = [snake]
  if (/(s|x|z|ch|sh)$/.test(snake)) out.push(`${snake}es`) // address → addresses
  if (/[^aeiou]y$/.test(snake)) out.push(`${snake.slice(0, -1)}ies`) // category → categories
  out.push(`${snake}s`)
  return out
}
