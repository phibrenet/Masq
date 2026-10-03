import type { JsonPathInfo, JsonPathSample } from '@shared/types'
import type { DbAdapter } from './types'

/**
 * Discover the JSON paths inside a column by sampling real rows — the seed for the template builder
 * (docs/template-anonymizer.md), so binding paths to generators is confirm-not-author.
 *
 * **Samples many rows, not one.** The plan called for a single sample, but shape variance is the whole
 * reason the strategy is an *overlay*: on resconx's `users.address`, 17 rows carry
 * `{address1, city, country, county, postcode}` and 5 also carry `address2`. One sample would show
 * only one of those shapes and the user would never think to bind the key the other rows have.
 * Unioning across a sample surfaces both, and `presentIn` tells the user which keys are partial.
 *
 * **Returns shape, never values.** The sample comes from a production column; the renderer gets paths
 * and their JS types only.
 */

/** Rows to sample. Enough to expose optional keys without scanning a large table. */
const SAMPLE_SIZE = 50

/** Depth cap. v1 binds one level of nesting; going deeper would offer paths the engine won't overlay. */
const MAX_DEPTH = 3

export async function discoverJsonPaths(
  adapter: DbAdapter,
  table: string,
  column: string
): Promise<JsonPathSample> {
  const raw = await adapter.sampleColumnValues(table, column, SAMPLE_SIZE)

  // path → what we saw there. Insertion order is first-seen order, which keeps the builder's rows in
  // roughly the order the JSON itself declares them.
  const found = new Map<string, { types: Set<string>; presentIn: number }>()
  let sampled = 0

  for (const value of raw) {
    const parsed = parseJsonValue(value)
    // Only objects contribute paths. A top-level array is out of v1 scope, and a non-JSON string means
    // the column isn't actually JSON — either way there is nothing to bind.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    sampled++
    for (const [path, type] of walk(parsed as Record<string, unknown>, '', 1)) {
      const entry = found.get(path) ?? { types: new Set<string>(), presentIn: 0 }
      entry.types.add(type)
      entry.presentIn++
      found.set(path, entry)
    }
  }

  const paths: JsonPathInfo[] = [...found.entries()].map(([path, v]) => ({
    path,
    types: [...v.types].sort(),
    presentIn: v.presentIn
  }))
  return { sampled, paths }
}

/**
 * Normalize a column value to a parsed structure, tolerating both dialect forms: Postgres delivers
 * json as verbatim text (the `PG_VERBATIM_TEXT_OIDS` override), mysql2 as a parsed object.
 */
function parseJsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value ?? null
}

/**
 * Every bindable leaf path in an object, as `[path, jsType]` pairs.
 *
 * Objects are descended into (up to `MAX_DEPTH`) and yield no path of their own — you bind a leaf, not
 * a subtree. Arrays yield a path so the builder can *show* them, but their type marks them clearly:
 * the engine leaves arrays alone in v1, and hiding them would make a bound-but-ignored path look like
 * a bug rather than a documented limit.
 */
function* walk(
  node: Record<string, unknown>,
  prefix: string,
  depth: number
): Generator<[string, string]> {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (Array.isArray(value)) {
      yield [path, 'array']
    } else if (value !== null && typeof value === 'object') {
      if (depth < MAX_DEPTH) {
        yield* walk(value as Record<string, unknown>, path, depth + 1)
      } else {
        yield [path, 'object']
      }
    } else {
      yield [path, value === null ? 'null' : typeof value]
    }
  }
}
