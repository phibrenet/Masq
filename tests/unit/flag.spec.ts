import { describe, expect, it } from 'vitest'
import type { SelectionRule } from '@shared/types'
import type { DbAdapter, SelectRowsOptions } from '../../src/main/adapters/types'
import { applyFlagRules } from '../../src/main/extract/flag'
import type { PkValue, TableSelection } from '../../src/main/extract/types'

/**
 * Flag-only rules (`take: { kind: 'none' }` — docs/selection-rules-v2.md).
 *
 * The behaviour under test is the *contract*, not the filtering: this stage may lower an
 * `anonymize` flag on rows already kept and must do nothing else. If it could add rows it would
 * invalidate the cascade and backfill that ran before it.
 */

const NOW = new Date('2026-08-29T12:00:00.000Z')

function stubAdapter(rows: Record<string, unknown>[]): {
  adapter: DbAdapter
  calls: SelectRowsOptions[]
} {
  const calls: SelectRowsOptions[] = []
  const adapter = {
    selectRows: async (
      _table: string,
      _columns: string[],
      opts: SelectRowsOptions
    ): Promise<Record<string, unknown>[]> => {
      calls.push(opts)
      return rows
    }
  } as unknown as DbAdapter
  return { adapter, calls }
}

function selectionOf(ids: [PkValue, boolean][]): Map<string, TableSelection> {
  return new Map([
    [
      'users',
      {
        table: 'users',
        pkColumn: 'id',
        ids: new Map(ids),
        identities: new Map(),
        keepAll: false
      }
    ]
  ])
}

function flagRule(over: Partial<SelectionRule> = {}): SelectionRule {
  return {
    id: 'f1',
    workspaceId: 'w',
    table: 'users',
    match: 'all',
    where: [{ column: 'email', op: 'endsWith', value: '@staff.example.com' }],
    take: { kind: 'none' },
    anonymize: false,
    ...over
  }
}

describe('applyFlagRules', () => {
  it('preserves matched rows that the subset already contains', async () => {
    // 1 and 2 are staff the cascade pulled in; 3 is a customer.
    const selection = selectionOf([
      [1, true],
      [2, true],
      [3, true]
    ])
    const { adapter } = stubAdapter([{ id: 1 }, { id: 2 }])

    const report = await applyFlagRules(adapter, selection, [flagRule()], NOW)

    const ids = selection.get('users')!.ids
    expect(ids.get(1)).toBe(false)
    expect(ids.get(2)).toBe(false)
    expect(ids.get(3)).toBe(true)
    expect(report.changed).toEqual({ users: 2 })
  })

  it('never adds a row, however many the filter matched', async () => {
    // The contract. 7 and 8 match the rule but aren't in the subset — cascade didn't reach them,
    // and a flag rule seeding them is exactly the runaway this feature exists to avoid.
    const selection = selectionOf([[1, true]])
    const { adapter } = stubAdapter([{ id: 1 }, { id: 7 }, { id: 8 }])

    await applyFlagRules(adapter, selection, [flagRule()], NOW)

    const ids = selection.get('users')!.ids
    expect([...ids.keys()]).toEqual([1])
    expect(ids.size).toBe(1)
  })

  it('asks for no ordering or limit — the take is not a cap here', async () => {
    const { adapter, calls } = stubAdapter([{ id: 1 }])

    await applyFlagRules(adapter, selectionOf([[1, true]]), [flagRule()], NOW)

    expect(calls[0].take).toBeUndefined()
    expect(calls[0].now).toBe(NOW)
  })

  it('cannot re-anonymize a preserved row — preserve-wins is global', async () => {
    const selection = selectionOf([[1, false]])
    const { adapter } = stubAdapter([{ id: 1 }])

    const report = await applyFlagRules(adapter, selection, [flagRule({ anonymize: true })], NOW)

    // §6's precedence exists so an admin row can never end up partially anonymized; a late stage
    // able to undo it would defeat that. So an anonymizing flag rule is a no-op, and the Rules
    // screen warns when one is written.
    expect(selection.get('users')!.ids.get(1)).toBe(false)
    expect(report.changed).toEqual({})
  })

  it('applies a regex condition in Node, like every other stage', async () => {
    const selection = selectionOf([
      [1, true],
      [2, true]
    ])
    const { adapter, calls } = stubAdapter([
      { id: 1, email: 'ada@staff.example.com' },
      { id: 2, email: 'bob@example.com' }
    ])

    await applyFlagRules(
      adapter,
      selection,
      [flagRule({ where: [{ column: 'email', op: 'matches', value: '@staff\\.example\\.com$' }] })],
      NOW
    )

    expect(calls[0].where).toEqual([]) // nothing pushable
    expect(selection.get('users')!.ids.get(1)).toBe(false)
    expect(selection.get('users')!.ids.get(2)).toBe(true)
  })

  it('warns rather than silently doing nothing when its table contributed no rows', async () => {
    const { adapter, calls } = stubAdapter([{ id: 1 }])

    const report = await applyFlagRules(adapter, new Map(), [flagRule()], NOW)

    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]).toContain('users')
    expect(calls).toHaveLength(0) // and doesn't waste a query finding out
  })

  it('ignores rules that actually select rows', async () => {
    const { adapter, calls } = stubAdapter([{ id: 1 }])

    const report = await applyFlagRules(
      adapter,
      selectionOf([[1, true]]),
      [flagRule({ take: { kind: 'sample', count: 20 } })],
      NOW
    )

    expect(calls).toHaveLength(0)
    expect(report.changed).toEqual({})
  })
})
