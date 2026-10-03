import type { Knex } from 'knex'
import {
  NEGATIVE_OPS,
  type Condition,
  type ConditionOp,
  type MatchMode,
  type RelativeDuration,
  type Take
} from '@shared/types'

/**
 * Condition compilation (docs/selection-rules-v2.md): one operator table with **two faces** —
 * `applyConditions` emits SQL through knex, `evaluateConditions` decides the same question in Node.
 * They live in one module because they must agree; a divergence between them is a silent
 * wrong-rows bug, not a crash.
 *
 * Both faces are needed because `matches` (regex) can't be pushed into SQL — MySQL `REGEXP`,
 * Postgres `~` and SQLite (none) diverge, the v1 reasoning that this design narrows from "every
 * pattern rule" to "the one operator that needs it". See `partitionConditions` for when the JS face
 * takes over from the SQL one.
 *
 * Nothing here touches a database or the config store: it's a pure function of
 * (conditions, match, cutoff instant), which is what makes it testable against every dialect's
 * generated SQL without a connection.
 *
 * **Layering note:** the adapters import this module, inverting the usual extract → adapters
 * direction. Deliberate, and acyclic — this is a leaf that imports only knex's types and
 * `@shared/types`. Splitting the SQL face into `adapters/` to satisfy the arrow would put the two
 * faces of one operator table in two files, which is the one thing this module exists to prevent.
 */

/**
 * The `LIKE` escape character, chosen as `!` rather than the conventional `\`.
 *
 * SQLite has **no default escape character at all** (a `\` in a LIKE pattern is a literal
 * backslash), so a portable `LIKE` has to name one explicitly with `ESCAPE`. `\` can't be that
 * character: MySQL treats a backslash as an escape *inside the string literal too*, so `ESCAPE '\'`
 * needs doubling that then depends on the server's `NO_BACKSLASH_ESCAPES` mode. `!` has no special
 * meaning in a string literal on any of the three dialects, so one spelling works everywhere.
 */
const LIKE_ESCAPE = '!'

/** Escape a user value for use inside a LIKE pattern, so `50% off` searches for a literal `%`. */
function likeLiteral(value: unknown): string {
  return String(value).replace(/[!%_]/g, (c) => LIKE_ESCAPE + c)
}

/**
 * Operators whose truth is decided in Node rather than in SQL. Only `matches` — everything else is
 * portable across MySQL, Postgres and SQLite verbatim.
 */
export function isPushable(op: ConditionOp): boolean {
  return op !== 'matches'
}

/**
 * Split a rule's conditions into the half that becomes a `WHERE` clause and the half Node evaluates.
 *
 * **The `any` case is the one to get right.** Under `match: 'all'` the pushable conditions can be
 * applied in SQL and the regex ones re-checked over the survivors, because AND lets you narrow in
 * stages. Under `match: 'any'` that is **wrong**: `email matches /x/ OR id > 5` pushed as `id > 5`
 * would drop every row that qualified only via the regex. So a single non-pushable condition in an
 * `any` rule forces the *whole* filter client-side — which costs exactly what a v1 `pattern` rule
 * already cost (a full-table read), never more.
 */
export function partitionConditions(
  conditions: Condition[],
  match: MatchMode
): { pushable: Condition[]; clientSide: Condition[] } {
  const anyNonPushable = conditions.some((c) => !isPushable(c.op))
  if (match === 'any' && anyNonPushable) return { pushable: [], clientSide: conditions }
  return {
    pushable: conditions.filter((c) => isPushable(c.op)),
    clientSide: conditions.filter((c) => !isPushable(c.op))
  }
}

/** Distinct columns a condition list reads, with the PK sentinel (`null`) resolved. */
export function conditionColumns(conditions: Condition[], pkColumn: string): string[] {
  return [...new Set(conditions.map((c) => c.column ?? pkColumn))]
}

/**
 * Compile every `matches` pattern up front so an invalid regex fails the run with the column it came
 * from, rather than midway through streaming. Mirrors v1's `resolveSelection` error text.
 */
export function validateConditions(conditions: Condition[], table: string): void {
  for (const c of conditions) {
    if (c.op !== 'matches') continue
    try {
      new RegExp(String(c.value ?? ''))
    } catch (err) {
      throw new Error(
        `Invalid pattern for ${table}.${c.column ?? '(pk)'}: ${(err as Error).message}`
      )
    }
  }
}

// ─── Relative dates ───────────────────────────────────────────────────────────

/**
 * Resolve `{ n, unit }` against a reference instant, as `YYYY-MM-DD HH:MM:SS` in **UTC**.
 *
 * Computed here rather than in SQL because the three dialects share no syntax for it
 * (`DATE_SUB(NOW(), INTERVAL 90 DAY)` / `now() - interval '90 days'` /
 * `datetime('now','-90 days')`). Two things fall out: every table in a run compares against the
 * same instant, so a long extract can't disagree with itself about where "90 days ago" is; and the
 * cutoff is a plain value that can be logged with the run.
 *
 * The **format** is the portable part. A bound JS `Date` isn't an option — `better-sqlite3` refuses
 * to bind one at all — and an ISO string with a `T` and a `Z` sorts wrong against the
 * `YYYY-MM-DD HH:MM:SS` text a SQLite/MySQL datetime column actually holds. This spelling compares
 * correctly on all three: as a datetime on MySQL/Postgres, lexically on SQLite.
 *
 * **UTC is a documented assumption**, not a detected one: a `DATETIME` column carries no timezone,
 * so if a source stores local times the cutoff is off by that offset. Storing wall-clock UTC is
 * what Laravel and most frameworks do, and a predictable rule beats a guess.
 */
export function resolveCutoff(duration: RelativeDuration, now: Date): string {
  const d = new Date(now.getTime())
  const n = Math.trunc(duration.n)
  switch (duration.unit) {
    case 'day':
      d.setUTCDate(d.getUTCDate() - n)
      break
    case 'week':
      d.setUTCDate(d.getUTCDate() - n * 7)
      break
    case 'month':
      d.setUTCMonth(d.getUTCMonth() - n)
      break
    case 'year':
      d.setUTCFullYear(d.getUTCFullYear() - n)
      break
  }
  return formatInstant(d)
}

/** `YYYY-MM-DD HH:MM:SS`, UTC — see `resolveCutoff` for why this spelling. */
function formatInstant(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

function durationOf(value: unknown): RelativeDuration {
  const d = value as RelativeDuration | undefined
  if (!d || typeof d.n !== 'number' || !d.unit) {
    throw new Error('A relative-date condition needs a { n, unit } value.')
  }
  return d
}

// ─── SQL face ─────────────────────────────────────────────────────────────────

/**
 * Add a rule's conditions to a query as a single grouped predicate.
 *
 * Always wrapped in its own group, even for one condition: the caller may be building a query that
 * already carries a `WHERE`, and an ungrouped `any` list would let this rule's ORs escape into it.
 *
 * `conditions` must already be the **pushable** half (see `partitionConditions`) — a `matches`
 * condition reaching here throws rather than silently selecting nothing.
 */
export function applyConditions(
  qb: Knex.QueryBuilder,
  conditions: Condition[],
  match: MatchMode,
  pkColumn: string,
  now: Date
): Knex.QueryBuilder {
  if (conditions.length === 0) return qb
  return qb.where((outer) => {
    conditions.forEach((c, i) => {
      const add = (cb: (b: Knex.QueryBuilder) => void): unknown =>
        match === 'any' && i > 0 ? outer.orWhere(cb) : outer.where(cb)
      add((b) => applyOne(b, c, pkColumn, now))
    })
  })
}

/**
 * Widen a negative operator to also match NULL, unless the condition opted out.
 *
 * This is the design's most important default — see `Condition.includeNulls`. `core` must add
 * exactly one predicate, so the `orWhereNull` ORs against it rather than against a sub-group.
 */
function orNull(
  b: Knex.QueryBuilder,
  column: string,
  includeNulls: boolean | undefined,
  core: (q: Knex.QueryBuilder) => void
): void {
  if (includeNulls === false) {
    core(b)
    return
  }
  b.where((g) => {
    core(g)
    g.orWhereNull(column)
  })
}

function applyOne(b: Knex.QueryBuilder, c: Condition, pkColumn: string, now: Date): void {
  const col = c.column ?? pkColumn
  /**
   * `LOWER(col) LIKE ?` — portable *and* predictable, since MySQL folds case by collation and
   * Postgres doesn't. The cost is that it can't use a plain B-tree index.
   *
   * Takes its builder as an argument rather than closing over `b`: under `orNull` the predicate has
   * to land inside the group, and a closed-over `b` would emit `(col IS NULL) AND col NOT LIKE ?`
   * — an AND where the whole point was an OR.
   */
  const like = (q: Knex.QueryBuilder, pattern: string, negate = false): void => {
    q.whereRaw(`LOWER(??) ${negate ? 'NOT LIKE' : 'LIKE'} ? ESCAPE '${LIKE_ESCAPE}'`, [
      col,
      pattern.toLowerCase()
    ])
  }

  switch (c.op) {
    case 'eq':
      b.where(col, '=', c.value as never)
      break
    case 'neq':
      orNull(b, col, c.includeNulls, (q) => q.where(col, '<>', c.value as never))
      break
    case 'lt':
      b.where(col, '<', c.value as never)
      break
    case 'lte':
      b.where(col, '<=', c.value as never)
      break
    case 'gt':
      b.where(col, '>', c.value as never)
      break
    case 'gte':
      b.where(col, '>=', c.value as never)
      break
    case 'contains':
      like(b, `%${likeLiteral(c.value)}%`)
      break
    case 'notContains':
      orNull(b, col, c.includeNulls, (q) => like(q, `%${likeLiteral(c.value)}%`, true))
      break
    case 'startsWith':
      like(b, `${likeLiteral(c.value)}%`)
      break
    case 'endsWith':
      like(b, `%${likeLiteral(c.value)}`)
      break
    case 'isNull':
      b.whereNull(col)
      break
    case 'notNull':
      b.whereNotNull(col)
      break
    case 'in':
      b.whereIn(col, asArray(c.value))
      break
    case 'notIn':
      orNull(b, col, c.includeNulls, (q) => q.whereNotIn(col, asArray(c.value)))
      break
    case 'withinLast':
      b.where(col, '>=', resolveCutoff(durationOf(c.value), now))
      break
    case 'olderThan':
      b.where(col, '<', resolveCutoff(durationOf(c.value), now))
      break
    case 'matches':
      throw new Error(
        `The "matches" operator can't be pushed into SQL — partition it out first (${col}).`
      )
  }
}

/** An `in`/`notIn` value, defensively. A non-array (malformed config) matches nothing, which knex
 * renders as `1 = 0` — the same answer SQL would give for an empty list. */
function asArray(value: unknown): (string | number)[] {
  return Array.isArray(value) ? (value as (string | number)[]) : []
}

// ─── Query assembly ───────────────────────────────────────────────────────────

/**
 * What a rule asks the source for. The adapters take this verbatim; `resolveSelection` builds it
 * from a `SelectionRule` after partitioning out the client-side conditions.
 */
export interface SelectRowsOptions {
  /** Already-pushable conditions only. Ignored when `rawWhere` is set. */
  where?: Condition[]
  match?: MatchMode
  /** Verbatim SQL predicate, used *instead of* `where` — one filter mechanism per rule. */
  rawWhere?: string
  /** The run's single cutoff instant, for relative-date conditions. */
  now: Date
  /**
   * Ordering + row cap. **Omitted whenever the rule has client-side conditions**, because a limit
   * applied in SQL would cap the rows *before* the regex filter ran — sampling 20 and then keeping
   * the 3 that match is not the same rule as keeping 20 that match. `resolveSelection` owns that
   * decision; the adapter just does as it's told.
   */
  take?: Take
}

/** Apply a rule's filter — the raw predicate if it has one, its conditions otherwise. */
export function applyFilter(
  qb: Knex.QueryBuilder,
  opts: SelectRowsOptions,
  pkColumn: string
): Knex.QueryBuilder {
  const raw = opts.rawWhere?.trim()
  // Parenthesised: a fragment containing a bare `OR` would otherwise bind loosely against
  // anything the caller has already added.
  if (raw) return qb.whereRaw(`(${raw})`)
  return applyConditions(qb, opts.where ?? [], opts.match ?? 'all', pkColumn, opts.now)
}

/**
 * Apply a rule's take. `randomExpr` is the dialect's random ordering (`RAND()` on MySQL,
 * `RANDOM()` on Postgres and SQLite) — the only part of this that isn't portable, and the reason
 * it's a parameter rather than a constant. Same full-scan caveat as spec §4.
 */
export function applyTake(
  qb: Knex.QueryBuilder,
  take: Take | undefined,
  randomExpr: string
): Knex.QueryBuilder {
  // `none` adds no ordering or limit for the same reason `all` doesn't: a flag-only rule's query is
  // "which rows match", and its caller (`applyFlagRules`) intersects the answer with what's kept
  // rather than capping it here.
  if (!take || take.kind === 'all' || take.kind === 'none') return qb
  if (take.kind === 'sample') return qb.orderByRaw(randomExpr).limit(take.count)
  return qb.orderBy(take.orderBy, take.dir).limit(take.count)
}

// ─── JS face ──────────────────────────────────────────────────────────────────

/**
 * Decide the same predicate in Node, over a row already read from the source.
 *
 * Used for `matches` conditions, and for the whole filter when an `any` rule contains one (see
 * `partitionConditions`). Must mirror the SQL face **including its NULL semantics**: a comparison
 * against NULL is false, and a negative operator is true for NULL unless `includeNulls: false`.
 */
export function evaluateConditions(
  row: Record<string, unknown>,
  conditions: Condition[],
  match: MatchMode,
  pkColumn: string,
  now: Date
): boolean {
  if (conditions.length === 0) return true
  const test = (c: Condition): boolean => evaluateOne(row, c, pkColumn, now)
  return match === 'any' ? conditions.some(test) : conditions.every(test)
}

/** Operators that widen to NULL — the JS mirror of `orNull`. */
function evaluateOne(
  row: Record<string, unknown>,
  c: Condition,
  pkColumn: string,
  now: Date
): boolean {
  const value = row[c.column ?? pkColumn]

  if (c.op === 'isNull') return value == null
  if (c.op === 'notNull') return value != null
  if (value == null) {
    // Mirrors SQL: a comparison against NULL is NULL (→ not kept), except where `orNull` widened it.
    return NEGATIVE_OPS.some((op) => op === c.op) && c.includeNulls !== false
  }

  const text = String(value)
  const lower = text.toLowerCase()
  const target = String(c.value ?? '').toLowerCase()

  switch (c.op) {
    case 'eq':
      return looseEq(value, c.value)
    case 'neq':
      return !looseEq(value, c.value)
    case 'lt':
      return compareValues(value, c.value) < 0
    case 'lte':
      return compareValues(value, c.value) <= 0
    case 'gt':
      return compareValues(value, c.value) > 0
    case 'gte':
      return compareValues(value, c.value) >= 0
    case 'contains':
      return lower.includes(target)
    case 'notContains':
      return !lower.includes(target)
    case 'startsWith':
      return lower.startsWith(target)
    case 'endsWith':
      return lower.endsWith(target)
    case 'in':
      return asArray(c.value).some((v) => looseEq(value, v))
    case 'notIn':
      return !asArray(c.value).some((v) => looseEq(value, v))
    case 'withinLast':
      return instantOf(value) >= resolveCutoff(durationOf(c.value), now)
    case 'olderThan':
      return instantOf(value) < resolveCutoff(durationOf(c.value), now)
    case 'matches':
      return new RegExp(String(c.value ?? '')).test(text)
    default:
      return false
  }
}

/**
 * Equality across driver type drift. A `bigint` PK arrives as a **string** from node-pg and a
 * number from mysql2, and a rule's configured value is whatever JSON held — so `42` and `'42'` have
 * to compare equal here, exactly as they would in SQL. Same hazard as the selection-key rule in
 * `.memory/decisions.md` (2026-07-30), one layer up.
 */
function looseEq(a: unknown, b: unknown): boolean {
  if (a instanceof Date) return instantOf(a) === instantOf(b)
  return String(a) === String(b)
}

/**
 * Numeric where both sides are numeric, lexical otherwise — matching what SQL does per column type.
 *
 * Exported because the in-memory `top N` ordering must agree with it: when a rule is fully pushable
 * the *database* orders the rows, and when a regex forces the take in-memory this does. A plain
 * `String()` comparison there put `10` before `2` and quietly selected different rows depending on
 * whether the rule happened to contain a regex.
 *
 * Not a perfect emulation of any dialect's ORDER BY — text still compares by JS code unit rather than
 * the column's collation, so case and accent ordering can differ from the server's. Numbers and
 * datetimes, which is what anyone orders a `top N` by, agree.
 */
export function compareValues(a: unknown, b: unknown): number {
  const na = Number(a)
  const nb = Number(b)
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  const sa = instantOf(a)
  const sb = instantOf(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/**
 * Normalise a datetime-ish value to the same `YYYY-MM-DD HH:MM:SS` spelling `resolveCutoff`
 * produces, so the JS face compares like-for-like with the SQL one.
 *
 * A driver may hand back a `Date` (mysql2 for `DATETIME`) or the server's own text (the Postgres
 * adapter forces verbatim text; SQLite has only text). Both are normalised rather than one being
 * assumed: `new Date('2026-05-31 12:00:00')` parses as **local** time in Node, which would silently
 * shift the comparison by the machine's offset.
 */
function instantOf(value: unknown): string {
  if (value instanceof Date) return formatInstant(value)
  return String(value).replace('T', ' ').slice(0, 19)
}
