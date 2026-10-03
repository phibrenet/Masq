import { describe, expect, it } from 'vitest'
import type { ColumnInfo, SelectionRule } from '@shared/types'
import type { DbAdapter, SelectRowsOptions } from '../../src/main/adapters/types'
import { resolveSelection } from '../../src/main/extract/select'

/**
 * Selection resolution over the v2 filter + take model (docs/selection-rules-v2.md).
 *
 * The adapter is a stub that records what it was *asked* for, because the behaviour that matters
 * here isn't only which ids come back — it's **what got pushed into the query and what didn't**. A
 * take pushed down alongside a client-side regex would cap the rows before the regex ran, which is
 * a quietly wrong subset rather than an error.
 */

interface Call {
  table: string
  columns: string[]
  opts: SelectRowsOptions
}

function stubAdapter(rowsByTable: Record<string, Record<string, unknown>[]>): {
  adapter: DbAdapter
  calls: Call[]
} {
  const calls: Call[] = []
  const adapter = {
    getColumns: async (table: string): Promise<ColumnInfo[]> => {
      const sample = rowsByTable[table]?.[0] ?? { id: 1 }
      return Object.keys(sample).map((name) => ({
        name,
        dataType: 'text',
        nullable: true,
        isPrimaryKey: name === 'id'
      }))
    },
    selectRows: async (
      table: string,
      columns: string[],
      opts: SelectRowsOptions
    ): Promise<Record<string, unknown>[]> => {
      calls.push({ table, columns, opts })
      const rows = rowsByTable[table] ?? []
      // The stub does NOT filter: these tests assert what the engine asked for and what it did with
      // the answer. Condition semantics are covered exhaustively in conditions.spec.ts.
      const take = opts.take
      const capped = take && (take.kind === 'sample' || take.kind === 'top')
      return capped ? rows.slice(0, take.count) : rows
    }
  } as unknown as DbAdapter
  return { adapter, calls }
}

function rule(over: Partial<SelectionRule>): SelectionRule {
  return {
    id: 'r1',
    workspaceId: 'w',
    table: 'users',
    match: 'all',
    where: [],
    take: { kind: 'all' },
    anonymize: true,
    ...over
  }
}

const USERS = [
  { id: 1, email: 'ada@staff.example.com' },
  { id: 2, email: 'bob@example.com' },
  { id: 3, email: 'cy@example.com' },
  { id: 4, email: null }
]

describe('resolveSelection — pushing the filter down', () => {
  it('pushes both the filter and the take when the rule is fully pushable', () => {
    const { adapter, calls } = stubAdapter({ users: USERS })

    return resolveSelection(adapter, [
      rule({
        where: [{ column: 'email', op: 'notContains', value: '@staff.example.com' }],
        take: { kind: 'sample', count: 2 }
      })
    ]).then((result) => {
      expect(calls).toHaveLength(1)
      expect(calls[0].opts.where).toHaveLength(1)
      // The point of v2: a filtered *and* limited rule is one query.
      expect(calls[0].opts.take).toEqual({ kind: 'sample', count: 2 })
      expect(result.get('users')!.ids.size).toBe(2)
    })
  })

  it('withholds the take when a regex still has to run in Node', async () => {
    const { adapter, calls } = stubAdapter({ users: USERS })

    const selection = await resolveSelection(adapter, [
      rule({
        where: [{ column: 'email', op: 'matches', value: '@example\\.com$' }],
        take: { kind: 'sample', count: 5 }
      })
    ])

    // Pushing `LIMIT 5` here would cap the rows *before* the regex filtered them — sampling 5 and
    // keeping the 2 that match is a different rule from keeping 5 that match.
    expect(calls[0].opts.take).toBeUndefined()
    expect(calls[0].opts.where).toEqual([])
    // bob and cy match; ada doesn't, and the NULL email can't.
    expect([...selection.get('users')!.ids.keys()].sort()).toEqual([2, 3])
  })

  it('reads the columns a client-side condition needs, alongside the PK', async () => {
    const { adapter, calls } = stubAdapter({ users: USERS })

    await resolveSelection(adapter, [
      rule({ where: [{ column: 'email', op: 'matches', value: 'x' }] })
    ])

    expect(calls[0].columns.sort()).toEqual(['email', 'id'])
  })

  it('reads only the PK when everything pushed down', async () => {
    const { adapter, calls } = stubAdapter({ users: USERS })

    await resolveSelection(adapter, [
      rule({ where: [{ column: 'email', op: 'contains', value: 'x' }] })
    ])

    expect(calls[0].columns).toEqual(['id'])
  })

  it('also reads the ordering column when a top take is applied in memory', async () => {
    const { adapter, calls } = stubAdapter({
      users: [{ id: 1, email: 'a@b.com', created_at: '2026-01-01' }]
    })

    await resolveSelection(adapter, [
      rule({
        where: [{ column: 'email', op: 'matches', value: '@b' }],
        take: { kind: 'top', count: 1, orderBy: 'created_at', dir: 'desc' }
      })
    ])

    expect(calls[0].columns.sort()).toEqual(['created_at', 'email', 'id'])
  })

  it('applies a top take in memory, newest first', async () => {
    const { adapter } = stubAdapter({
      users: [
        { id: 1, email: 'a@b.com', created_at: '2026-01-01' },
        { id: 2, email: 'c@b.com', created_at: '2026-08-01' },
        { id: 3, email: 'd@b.com', created_at: '2026-04-01' }
      ]
    })

    const selection = await resolveSelection(adapter, [
      rule({
        where: [{ column: 'email', op: 'matches', value: '@b' }],
        take: { kind: 'top', count: 2, orderBy: 'created_at', dir: 'desc' }
      })
    ])

    expect([...selection.get('users')!.ids.keys()]).toEqual([2, 3])
  })

  it('passes a raw predicate straight through, with no conditions', async () => {
    const { adapter, calls } = stubAdapter({ users: USERS })

    await resolveSelection(adapter, [
      rule({
        where: [{ column: 'email', op: 'matches', value: 'ignored' }],
        rawWhere: 'EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id)'
      })
    ])

    expect(calls[0].opts.rawWhere).toContain('EXISTS')
    expect(calls[0].opts.where).toEqual([])
    // A raw rule has no client-side half, so its take can push down like any other.
    expect(calls[0].columns).toEqual(['id'])
  })

  it('rejects a standalone query before selecting rows', async () => {
    const { adapter, calls } = stubAdapter({ users: USERS })

    await expect(
      resolveSelection(adapter, [rule({ rawWhere: 'SELECT id FROM users LIMIT 20;' })])
    ).rejects.toThrow(/WHERE predicate.*Take/)
    expect(calls).toHaveLength(0)
  })
})

describe('resolveSelection — merging and keepAll', () => {
  it('keeps preserve-wins across two rules on one table', async () => {
    const { adapter } = stubAdapter({ users: USERS })

    const selection = await resolveSelection(adapter, [
      rule({ id: 'a', take: { kind: 'all' }, anonymize: true }),
      rule({
        id: 'b',
        where: [{ column: 'email', op: 'matches', value: '@staff\\.example\\.com$' }],
        anonymize: false
      })
    ])

    const ids = selection.get('users')!.ids
    // Ada matched both rules; preserve must win (spec §6) — an admin row must never end up
    // half-anonymized because it also fell into a broader sample.
    expect(ids.get(1)).toBe(false)
    expect(ids.get(2)).toBe(true)
  })

  it('sets keepAll only for a rule with no filter and no cap', async () => {
    const { adapter } = stubAdapter({ users: USERS })

    const unfiltered = await resolveSelection(adapter, [rule({})])
    expect(unfiltered.get('users')!.keepAll).toBe(true)

    const capped = await resolveSelection(adapter, [rule({ take: { kind: 'sample', count: 2 } })])
    expect(capped.get('users')!.keepAll).toBe(false)

    const filtered = await resolveSelection(adapter, [
      rule({ where: [{ column: 'email', op: 'contains', value: 'x' }] })
    ])
    expect(filtered.get('users')!.keepAll).toBe(false)

    const raw = await resolveSelection(adapter, [rule({ rawWhere: 'id > 0' })])
    expect(raw.get('users')!.keepAll).toBe(false)
  })

  it('shares one cutoff instant across every table in the run', async () => {
    const { adapter, calls } = stubAdapter({ users: USERS, orders: [{ id: 9 }] })
    const now = new Date('2026-08-29T12:00:00.000Z')

    await resolveSelection(
      adapter,
      [
        rule({
          table: 'users',
          where: [{ column: 'x', op: 'withinLast', value: { n: 1, unit: 'day' } }]
        }),
        rule({
          table: 'orders',
          where: [{ column: 'x', op: 'withinLast', value: { n: 1, unit: 'day' } }]
        })
      ],
      now
    )

    expect(calls.map((c) => c.opts.now)).toEqual([now, now])
  })

  it('refuses to run a rule the store could not read back faithfully', async () => {
    const { adapter, calls } = stubAdapter({ users: USERS })

    // The repository reads leniently so a damaged rule can be repaired on screen — but every repair
    // widens it, and a widened preserve rule dumps a whole table with real data. Fail loudly.
    await expect(
      resolveSelection(adapter, [
        rule({ anonymize: false, invalid: 'its row limit could not be read' })
      ])
    ).rejects.toThrow(/can't be run.*row limit could not be read/s)
    expect(calls).toHaveLength(0)
  })

  it('orders a client-side top take numerically, as the database would', async () => {
    // The divergence: with no regex the *database* orders these, and `id` is numeric. Sorting the
    // in-memory path with String() put `10` before `2`, so the same rule returned different rows
    // depending only on whether it happened to contain a regex.
    const { adapter } = stubAdapter({
      users: [
        { id: 2, email: 'b@x.com' },
        { id: 10, email: 'c@x.com' },
        { id: 9, email: 'd@x.com' }
      ]
    })

    const selection = await resolveSelection(adapter, [
      rule({
        where: [{ column: 'email', op: 'matches', value: '@x' }],
        take: { kind: 'top', count: 2, orderBy: 'id', dir: 'desc' }
      })
    ])

    expect([...selection.get('users')!.ids.keys()]).toEqual([10, 9])
  })

  it('fails the run with the offending column when a regex will not compile', async () => {
    const { adapter } = stubAdapter({ users: USERS })

    await expect(
      resolveSelection(adapter, [
        rule({ where: [{ column: 'email', op: 'matches', value: '([' }] })
      ])
    ).rejects.toThrow(/Invalid pattern for users\.email/)
  })
})
