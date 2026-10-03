import { describe, expect, it } from 'vitest'
import type { ForeignKeyRef } from '@shared/types'
import { topologicalOrder } from '../../src/main/extract/graph'

function fk(table: string, column: string, referencedTable: string): ForeignKeyRef {
  return { table, column, referencedTable, referencedColumn: 'id' }
}

describe('topologicalOrder', () => {
  it('orders parents before children regardless of input order', () => {
    const fks = [fk('orders', 'user_id', 'users')]

    expect(topologicalOrder(['orders', 'users'], fks)).toEqual(['users', 'orders'])
    expect(topologicalOrder(['users', 'orders'], fks)).toEqual(['users', 'orders'])
  })

  it('resolves a transitive chain from any input permutation', () => {
    const fks = [fk('payments', 'order_id', 'orders'), fk('orders', 'user_id', 'users')]

    expect(topologicalOrder(['payments', 'orders', 'users'], fks)).toEqual([
      'users',
      'orders',
      'payments'
    ])
    expect(topologicalOrder(['payments', 'users', 'orders'], fks)).toEqual([
      'users',
      'orders',
      'payments'
    ])
  })

  it('ignores self-references', () => {
    const fks = [fk('users', 'parent_id', 'users')]

    expect(topologicalOrder(['users'], fks)).toEqual(['users'])
  })

  it('ignores FKs whose parent is outside the table set', () => {
    const fks = [fk('orders', 'user_id', 'users'), fk('audit', 'order_id', 'orders')]

    expect(topologicalOrder(['audit', 'orders'], fks)).toEqual(['orders', 'audit'])
  })

  it('ignores FKs whose child is outside the table set', () => {
    const fks = [fk('audit', 'order_id', 'orders'), fk('orders', 'user_id', 'users')]

    expect(topologicalOrder(['orders'], fks)).toEqual(['orders'])
    expect(topologicalOrder(['orders', 'users'], fks)).toEqual(['users', 'orders'])
  })

  it('appends cycle members after the acyclic tables, in original order', () => {
    const fks = [fk('b', 'x', 'a'), fk('a', 'y', 'b')]

    expect(topologicalOrder(['a', 'c', 'b'], fks)).toEqual(['c', 'a', 'b'])
  })

  it('counts a duplicated edge once so a child is not stuck at phantom indegree', () => {
    const fks = [fk('team_user', 'team_id', 'teams'), fk('team_user', 'team_id', 'teams')]

    expect(topologicalOrder(['team_user', 'teams'], fks)).toEqual(['teams', 'team_user'])
  })

  it('is deterministic: zero-indegree seeds follow input order', () => {
    expect(topologicalOrder(['zebra', 'alpha', 'mid'], [])).toEqual(['zebra', 'alpha', 'mid'])
  })
})
