import knex, { type Knex } from 'knex'
import { describe, expect, it } from 'vitest'
import { applyRowFilter, type RowFilter } from '../../src/main/extract/row-filter'

/**
 * `RowFilter` compilation. Like `conditions.spec.ts`, these run without a database — knex builds SQL
 * for a dialect without connecting — so one assertion can check MySQL, Postgres and SQLite side by
 * side. What matters here is the *shape* of the predicate: an empty allowed set has to compile to
 * "no rows" rather than "no restriction", and a morph group has to be parenthesised, or an AND with
 * the other endpoints would bind wrong and widen the result.
 */

const clients = {
  mysql: knex({ client: 'mysql2' }),
  postgres: knex({ client: 'pg' }),
  sqlite: knex({ client: 'better-sqlite3', useNullAsDefault: true })
}

/** The compiled statement for one dialect, parameters inlined so assertions read like SQL. */
function sqlFor(client: keyof typeof clients, filter: RowFilter | undefined): string {
  const qb = applyRowFilter(clients[client]('pivot').select('*'), filter)
  const { sql, bindings } = (qb as Knex.QueryBuilder).toSQL()
  let i = 0
  return sql.replace(/\?/g, () => {
    const v = bindings[i++]
    return typeof v === 'string' ? `'${v}'` : String(v)
  })
}

const dialects = Object.keys(clients) as (keyof typeof clients)[]

describe('applyRowFilter', () => {
  it('is a no-op without a filter', () => {
    for (const d of dialects) expect(sqlFor(d, undefined)).not.toContain('where')
  })

  it('ANDs one IN per column', () => {
    expect(sqlFor('postgres', { columns: { label_id: [1, 2], card_lookup_id: [7] } })).toBe(
      'select * from "pivot" where "label_id" in (1, 2) and "card_lookup_id" in (7)'
    )
    expect(sqlFor('mysql', { columns: { label_id: [1, 2] } })).toBe(
      'select * from `pivot` where `label_id` in (1, 2)'
    )
  })

  it('keeps no rows for an empty allowed set', () => {
    // The load-bearing case: "this parent kept nothing" must empty the pivot, not stop filtering it.
    for (const d of dialects) expect(sqlFor(d, { columns: { label_id: [] } })).toContain('1 = 0')
  })

  it('groups a morph endpoint so it can be ANDed with the others', () => {
    expect(
      sqlFor('postgres', {
        columns: { role_id: [1] },
        morphs: [
          {
            typeColumn: 'model_type',
            idColumn: 'model_id',
            alternatives: [
              { typeValue: 'User', ids: [10, 11] },
              { typeValue: 'Team', ids: [5] }
            ]
          }
        ]
      })
    ).toBe(
      'select * from "pivot" where "role_id" in (1) and ' +
        '(("model_type" = \'User\' and "model_id" in (10, 11)) or ' +
        '("model_type" = \'Team\' and "model_id" in (5)))'
    )
  })

  it('matches on type alone when a target is dumped whole', () => {
    expect(
      sqlFor('postgres', {
        morphs: [
          {
            typeColumn: 'model_type',
            idColumn: 'model_id',
            alternatives: [{ typeValue: 'User' }]
          }
        ]
      })
    ).toBe('select * from "pivot" where (("model_type" = \'User\'))')
  })

  it('keeps no rows for a morph with no alternatives, rather than emitting an empty group', () => {
    // An empty `where` callback compiles to `()`, which no dialect parses.
    for (const d of dialects) {
      const sql = sqlFor(d, {
        morphs: [{ typeColumn: 'model_type', idColumn: 'model_id', alternatives: [] }]
      })
      expect(sql).toContain('1 = 0')
      expect(sql).not.toMatch(/\(\s*\)/)
    }
  })
})
