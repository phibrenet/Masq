import knex, { type Knex } from 'knex'
import { describe, expect, it } from 'vitest'
import type { Condition, MatchMode } from '@shared/types'
import {
  applyConditions,
  applyFilter,
  applyTake,
  conditionColumns,
  evaluateConditions,
  isPushable,
  partitionConditions,
  resolveCutoff,
  validateConditions
} from '../../src/main/extract/conditions'

/**
 * Condition compilation (docs/selection-rules-v2.md). The whole module is a pure function of
 * (conditions, match, cutoff), so these run without a database: knex builds SQL for a dialect
 * without ever connecting, which is what lets one assertion check MySQL, Postgres and SQLite
 * output side by side.
 *
 * The SQL face and the JS face are tested against the *same* condition fixtures on purpose — they
 * decide the same question in two places, and a divergence between them is a silent wrong-rows bug.
 */

const clients = {
  mysql: knex({ client: 'mysql2' }),
  postgres: knex({ client: 'pg' }),
  sqlite: knex({ client: 'better-sqlite3', useNullAsDefault: true })
}

/** The compiled `WHERE` for one dialect, parameters inlined so assertions read like SQL. */
function sqlFor(
  client: keyof typeof clients,
  conditions: Condition[],
  match: MatchMode = 'all',
  now = NOW
): { sql: string; bindings: readonly unknown[] } {
  const qb = applyConditions(clients[client]('users').select('id'), conditions, match, 'id', now)
  const compiled = (qb as Knex.QueryBuilder).toSQL()
  return { sql: compiled.sql, bindings: compiled.bindings as unknown[] }
}

/** A fixed instant, so relative-date assertions are exact rather than approximate. */
const NOW = new Date('2026-08-29T12:00:00.000Z')

describe('resolveCutoff', () => {
  it('resolves each unit against the reference instant, in UTC', () => {
    expect(resolveCutoff({ n: 90, unit: 'day' }, NOW)).toBe('2026-05-31 12:00:00')
    expect(resolveCutoff({ n: 2, unit: 'week' }, NOW)).toBe('2026-08-15 12:00:00')
    expect(resolveCutoff({ n: 3, unit: 'month' }, NOW)).toBe('2026-05-29 12:00:00')
    expect(resolveCutoff({ n: 1, unit: 'year' }, NOW)).toBe('2025-08-29 12:00:00')
  })

  it('emits the one spelling that compares correctly on all three dialects', () => {
    // Not ISO-8601: a `T` and a `Z` sort wrong against the `YYYY-MM-DD HH:MM:SS` text a SQLite or
    // MySQL datetime column actually holds, and better-sqlite3 refuses to bind a JS Date at all.
    expect(resolveCutoff({ n: 1, unit: 'day' }, NOW)).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
    )
  })
})

describe('applyConditions — SQL face', () => {
  it('ANDs conditions inside one group', () => {
    const { sql, bindings } = sqlFor('mysql', [
      { column: 'status', op: 'eq', value: 'active' },
      { column: 'age', op: 'gte', value: 18 }
    ])

    expect(sql).toContain('`status` = ?')
    expect(sql).toContain('`age` >= ?')
    expect(bindings).toEqual(['active', 18])
  })

  it('ORs under match:any, and keeps the whole list in its own group', () => {
    const { sql } = sqlFor(
      'postgres',
      [
        { column: 'status', op: 'eq', value: 'active' },
        { column: 'status', op: 'eq', value: 'trial' }
      ],
      'any'
    )

    // The outer parens are the point: without them a rule's ORs would leak into any WHERE the
    // caller had already added and quietly widen it.
    expect(sql).toMatch(/where \(\(.*or.*\)\)/i)
  })

  it('widens a negative operator to match NULL by default — the trap this design exists to absorb', () => {
    // "users who do not have a work email". Written as a bare NOT LIKE, three-valued logic drops
    // every user whose email is NULL, which is never what anyone means.
    const { sql } = sqlFor('mysql', [
      { column: 'email', op: 'notContains', value: '@staff.example.com' }
    ])

    // `NOT LIKE` keeps the raw fragment's own casing; knex lower-cases only the SQL it generates.
    expect(sql).toMatch(/not like/i)
    expect(sql).toMatch(/or `email` is null/i)
  })

  it('honours an explicit opt-out of NULL matching', () => {
    const { sql } = sqlFor('mysql', [
      { column: 'email', op: 'notContains', value: '@staff.example.com', includeNulls: false }
    ])

    expect(sql).not.toContain('is null')
  })

  it('widens neq and notIn the same way', () => {
    expect(sqlFor('mysql', [{ column: 'role', op: 'neq', value: 'admin' }]).sql).toContain(
      'is null'
    )
    expect(sqlFor('mysql', [{ column: 'role', op: 'notIn', value: ['a', 'b'] }]).sql).toContain(
      'is null'
    )
    // A positive operator is left alone: `= NULL` is already false, and widening it would be wrong.
    expect(sqlFor('mysql', [{ column: 'role', op: 'eq', value: 'admin' }]).sql).not.toContain(
      'is null'
    )
  })

  it('lower-cases both sides of a LIKE so case-sensitivity does not vary by dialect', () => {
    // MySQL folds case by collation, Postgres does not. Neither is wrong; a rule behaving
    // differently depending on which is underneath it would be.
    for (const client of ['mysql', 'postgres', 'sqlite'] as const) {
      const { sql, bindings } = sqlFor(client, [
        { column: 'email', op: 'contains', value: '@Staff.Example.com' }
      ])
      expect(sql.toLowerCase()).toContain('lower(')
      expect(bindings[0]).toBe('%@staff.example.com%')
    }
  })

  it('escapes LIKE wildcards in the user value, with an escape character all three dialects share', () => {
    const { sql, bindings } = sqlFor('sqlite', [
      { column: 'note', op: 'contains', value: '50% off_now' }
    ])

    // `!`, not `\`: SQLite has no default escape character, and MySQL treats a backslash as an
    // escape inside the string literal too.
    expect(sql).toContain("ESCAPE '!'")
    expect(bindings[0]).toBe('%50!% off!_now%')
  })

  it('anchors startsWith and endsWith on the correct side', () => {
    expect(sqlFor('mysql', [{ column: 'sku', op: 'startsWith', value: 'AB' }]).bindings[0]).toBe(
      'ab%'
    )
    expect(sqlFor('mysql', [{ column: 'sku', op: 'endsWith', value: 'AB' }]).bindings[0]).toBe(
      '%ab'
    )
  })

  it('binds a resolved instant for relative dates rather than dialect interval syntax', () => {
    const { sql, bindings } = sqlFor('postgres', [
      { column: 'created_at', op: 'withinLast', value: { n: 90, unit: 'day' } }
    ])

    expect(sql).toContain('>= ?')
    expect(sql).not.toMatch(/interval|date_sub|datetime\(/i)
    expect(bindings).toEqual(['2026-05-31 12:00:00'])
  })

  it('reads the PK sentinel as the table key — what migration 010 writes for an explicit rule', () => {
    const { sql, bindings } = sqlFor('mysql', [{ column: null, op: 'in', value: [1, 2, 3] }])

    expect(sql).toContain('`id` in (?, ?, ?)')
    expect(bindings).toEqual([1, 2, 3])
  })

  it('renders an empty condition list as no WHERE at all', () => {
    expect(sqlFor('mysql', []).sql).not.toContain('where')
  })

  it('refuses to compile a regex — it must be partitioned out first', () => {
    expect(() => sqlFor('mysql', [{ column: 'email', op: 'matches', value: '^a' }])).toThrow(
      /can't be pushed into SQL/
    )
  })
})

describe('partitionConditions', () => {
  const regex: Condition = { column: 'email', op: 'matches', value: '@staff\\.example\\.com$' }
  const recent: Condition = {
    column: 'created_at',
    op: 'withinLast',
    value: { n: 90, unit: 'day' }
  }

  it('pushes what it can and keeps the regex for Node under match:all', () => {
    const { pushable, clientSide } = partitionConditions([regex, recent], 'all')

    expect(pushable).toEqual([recent])
    expect(clientSide).toEqual([regex])
  })

  it('pushes NOTHING when an `any` rule contains a regex', () => {
    // The correctness case. `email matches /x/ OR created_at >= cutoff` pushed as just the date
    // would drop every row that qualified only via the regex — a silently smaller subset.
    const { pushable, clientSide } = partitionConditions([regex, recent], 'any')

    expect(pushable).toEqual([])
    expect(clientSide).toEqual([regex, recent])
  })

  it('leaves an `any` rule with no regex fully pushable', () => {
    const { pushable, clientSide } = partitionConditions([recent, recent], 'any')

    expect(pushable).toHaveLength(2)
    expect(clientSide).toEqual([])
  })

  it('marks only `matches` as non-pushable', () => {
    expect(isPushable('matches')).toBe(false)
    expect(isPushable('notContains')).toBe(true)
    expect(isPushable('withinLast')).toBe(true)
  })
})

describe('evaluateConditions — JS face', () => {
  const row = {
    id: 42,
    email: 'ada@staff.example.com',
    role: null,
    created_at: '2026-08-01 09:00:00',
    score: '150'
  }
  const evaluate = (conditions: Condition[], match: MatchMode = 'all'): boolean =>
    evaluateConditions(row, conditions, match, 'id', NOW)

  it('matches a regex against the column', () => {
    expect(evaluate([{ column: 'email', op: 'matches', value: '@staff\\.example\\.com$' }])).toBe(
      true
    )
    expect(evaluate([{ column: 'email', op: 'matches', value: '^bob' }])).toBe(false)
  })

  it('mirrors SQL NULL semantics — comparisons fail, negatives widen', () => {
    // `role` is NULL. In SQL `role = 'admin'` is NULL (not kept) and `role <> 'admin'` is NULL too,
    // which is exactly why the negative operators widen. Both faces must agree.
    expect(evaluate([{ column: 'role', op: 'eq', value: 'admin' }])).toBe(false)
    expect(evaluate([{ column: 'role', op: 'neq', value: 'admin' }])).toBe(true)
    expect(evaluate([{ column: 'role', op: 'neq', value: 'admin', includeNulls: false }])).toBe(
      false
    )
    expect(evaluate([{ column: 'role', op: 'isNull' }])).toBe(true)
    expect(evaluate([{ column: 'role', op: 'notNull' }])).toBe(false)
  })

  it('is case-insensitive for contains, as the SQL face is', () => {
    expect(evaluate([{ column: 'email', op: 'contains', value: '@Staff.Example.COM' }])).toBe(true)
    expect(evaluate([{ column: 'email', op: 'notContains', value: '@other.com' }])).toBe(true)
  })

  it('compares across driver type drift', () => {
    // A bigint PK arrives as a string from node-pg and a number from mysql2; a rule's configured
    // value is whatever JSON held. `42` and `'42'` have to compare equal, as they would in SQL.
    expect(evaluate([{ column: 'id', op: 'eq', value: '42' }])).toBe(true)
    expect(evaluate([{ column: null, op: 'in', value: ['42'] }])).toBe(true)
    expect(evaluate([{ column: 'score', op: 'gt', value: 100 }])).toBe(true)
    expect(evaluate([{ column: 'score', op: 'lt', value: 100 }])).toBe(false)
  })

  it('resolves relative dates against the same cutoff the SQL face binds', () => {
    const within: Condition = {
      column: 'created_at',
      op: 'withinLast',
      value: { n: 90, unit: 'day' }
    }
    const older: Condition = {
      column: 'created_at',
      op: 'olderThan',
      value: { n: 90, unit: 'day' }
    }

    expect(evaluate([within])).toBe(true)
    expect(evaluate([older])).toBe(false)
    expect(sqlFor('mysql', [within]).bindings[0]).toBe(resolveCutoff({ n: 90, unit: 'day' }, NOW))
  })

  it('normalises a Date the same way it normalises server text', () => {
    // mysql2 hands back a JS Date for DATETIME; the Postgres adapter forces verbatim text. Parsing
    // `2026-08-01 09:00:00` with `new Date()` would read it as *local* time and shift the compare.
    const asDate = { created_at: new Date('2026-08-01T09:00:00.000Z') }
    const cond: Condition = {
      column: 'created_at',
      op: 'withinLast',
      value: { n: 90, unit: 'day' }
    }

    expect(evaluateConditions(asDate, [cond], 'all', 'id', NOW)).toBe(
      evaluateConditions(row, [cond], 'all', 'id', NOW)
    )
  })

  it('honours match:any', () => {
    const conditions: Condition[] = [
      { column: 'email', op: 'matches', value: '^nobody' },
      { column: 'id', op: 'eq', value: 42 }
    ]

    expect(evaluate(conditions, 'any')).toBe(true)
    expect(evaluate(conditions, 'all')).toBe(false)
  })

  it('keeps every row when there are no conditions', () => {
    expect(evaluate([])).toBe(true)
  })
})

describe('applyFilter and applyTake', () => {
  it('uses a raw predicate instead of conditions, parenthesised', () => {
    const qb = applyFilter(
      clients.postgres('users').select('id'),
      {
        where: [{ column: 'email', op: 'contains', value: 'x' }],
        rawWhere: 'EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id) OR id < 5',
        now: NOW
      },
      'id'
    )

    const { sql } = qb.toSQL()
    // Parenthesised so a fragment containing a bare OR can't bind loosely against anything else.
    expect(sql).toContain(
      '(EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id) OR id < 5)'
    )
    expect(sql).not.toContain('lower(')
  })

  it('orders randomly with each dialect s own function', () => {
    const take = { kind: 'sample' as const, count: 20 }

    expect(applyTake(clients.mysql('users').select('id'), take, 'RAND()').toSQL().sql).toContain(
      'RAND()'
    )
    expect(
      applyTake(clients.postgres('users').select('id'), take, 'RANDOM()').toSQL().sql
    ).toContain('RANDOM()')
  })

  it('orders by a column for a top-N take', () => {
    const { sql } = applyTake(
      clients.mysql('users').select('id'),
      { kind: 'top', count: 20, orderBy: 'created_at', dir: 'desc' },
      'RAND()'
    ).toSQL()

    expect(sql).toContain('order by `created_at` desc')
    expect(sql).toContain('limit ?')
  })

  it('adds no ordering or limit for take:all', () => {
    const { sql } = applyTake(
      clients.mysql('users').select('id'),
      { kind: 'all' },
      'RAND()'
    ).toSQL()

    expect(sql).not.toContain('order by')
    expect(sql).not.toContain('limit')
  })
})

describe('validateConditions and conditionColumns', () => {
  it('names the table and column when a regex will not compile', () => {
    expect(() =>
      validateConditions([{ column: 'email', op: 'matches', value: '([' }], 'users')
    ).toThrow(/Invalid pattern for users\.email/)
  })

  it('accepts a valid regex and ignores non-regex operators', () => {
    expect(() =>
      validateConditions(
        [
          { column: 'email', op: 'matches', value: '^a+$' },
          { column: 'x', op: 'contains', value: '([' }
        ],
        'users'
      )
    ).not.toThrow()
  })

  it('resolves the PK sentinel and de-duplicates', () => {
    expect(
      conditionColumns(
        [
          { column: 'email', op: 'contains', value: 'a' },
          { column: null, op: 'in', value: [1] },
          { column: 'email', op: 'notContains', value: 'b' }
        ],
        'user_id'
      )
    ).toEqual(['email', 'user_id'])
  })
})
