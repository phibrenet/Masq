import { describe, expect, it } from 'vitest'
import type { FkBackfillPolicy, ForeignKeyRef } from '@shared/types'
import {
  applyNullEdges,
  buildNullEdges,
  resolveBackfillPolicies
} from '../../src/main/extract/backfill-policy'
import type { TableRole } from '../../src/main/extract/backfill'
import type { PkValue, TableSelection } from '../../src/main/extract/types'

function fk(table: string, column: string, referencedTable: string): ForeignKeyRef {
  return { table, column, referencedTable, referencedColumn: 'id' }
}

function policy(tableName: string, columnName: string, kind: 'follow' | 'null'): FkBackfillPolicy {
  return { id: `${tableName}.${columnName}`, workspaceId: 'w', tableName, columnName, policy: kind }
}

function selectionOf(table: string, ids: PkValue[], keepAll = false): TableSelection {
  return {
    table,
    pkColumn: 'id',
    ids: new Map(ids.map((id) => [id, true])),
    identities: new Map(),
    keepAll
  }
}

/** Every column nullable — the common case, so tests only say otherwise when it's the point. */
const allNullable = (): boolean => true
/** Every table keyed by `id`, matching `fk()`'s default `referencedColumn`. */
const idPk = (): string => 'id'

describe('resolveBackfillPolicies', () => {
  const fks = [
    fk('submissions', 'user_id', 'users'),
    fk('submissions', 'welded_by_user_id', 'users')
  ]
  const included = (): boolean => true

  it('leaves every edge followed when nothing is declared', () => {
    const resolved = resolveBackfillPolicies([], fks, allNullable, included, idPk)

    expect(resolved.policyOf('submissions', 'welded_by_user_id')).toBe('follow')
    expect(resolved.nullColumns.size).toBe(0)
    expect(resolved.warnings).toEqual([])
  })

  it('honours a null policy on a nullable edge, and only that edge', () => {
    const resolved = resolveBackfillPolicies(
      [policy('submissions', 'welded_by_user_id', 'null')],
      fks,
      allNullable,
      included,
      idPk
    )

    expect(resolved.policyOf('submissions', 'welded_by_user_id')).toBe('null')
    // The ownership edge alongside it is untouched — a policy is per column, not per table.
    expect(resolved.policyOf('submissions', 'user_id')).toBe('follow')
    expect(resolved.nullColumns.get('submissions')).toEqual(['welded_by_user_id'])
    expect(resolved.warnings).toEqual([])
  })

  it('stores follow as a no-op rather than an exception', () => {
    const resolved = resolveBackfillPolicies(
      [policy('submissions', 'welded_by_user_id', 'follow')],
      fks,
      allNullable,
      included,
      idPk
    )

    expect(resolved.policyOf('submissions', 'welded_by_user_id')).toBe('follow')
    expect(resolved.nullColumns.size).toBe(0)
    expect(resolved.warnings).toEqual([])
  })

  it('downgrades a null policy on a NOT NULL column and says why', () => {
    // The load-breaking case: nulling this column produces a dump the target rejects, which is worse
    // than the row growth the policy was trying to prevent.
    const resolved = resolveBackfillPolicies(
      [policy('submissions', 'user_id', 'null')],
      fks,
      (_table, column) => column !== 'user_id',
      included,
      idPk
    )

    expect(resolved.policyOf('submissions', 'user_id')).toBe('follow')
    expect(resolved.nullColumns.size).toBe(0)
    expect(resolved.warnings).toHaveLength(1)
    expect(resolved.warnings[0]).toContain('NOT NULL')
  })

  it('fails closed when nullability is unknown', () => {
    const resolved = resolveBackfillPolicies(
      [policy('submissions', 'welded_by_user_id', 'null')],
      fks,
      () => undefined,
      included,
      idPk
    )

    expect(resolved.policyOf('submissions', 'welded_by_user_id')).toBe('follow')
    expect(resolved.warnings).toHaveLength(1)
  })

  it('reports a policy whose edge is not a foreign key', () => {
    const resolved = resolveBackfillPolicies(
      [policy('submissions', 'renamed_column', 'null')],
      fks,
      allNullable,
      included,
      idPk
    )

    expect(resolved.policyOf('submissions', 'renamed_column')).toBe('follow')
    expect(resolved.warnings).toHaveLength(1)
    expect(resolved.warnings[0]).toContain('not a foreign key')
  })

  it('drops a policy on an excluded table without warning about it', () => {
    // Inert, not wrong: the table emits no rows either way, so warning would be noise.
    const resolved = resolveBackfillPolicies(
      [policy('submissions', 'welded_by_user_id', 'null')],
      fks,
      allNullable,
      () => false,
      idPk
    )

    expect(resolved.nullColumns.size).toBe(0)
    expect(resolved.warnings).toEqual([])
  })

  it('rejects a policy on a foreign key that targets a non-primary-key column', () => {
    // `orders.customer_email → users.email` is legal against any UNIQUE column. Nulling is decided by
    // testing a reference against the parent's kept **PK** values, so an email would match nothing and
    // every valid address would be blanked — silent destruction of real data. And it cannot lean on
    // `backfillSelection`'s own non-PK warning: the policy check runs before `pull`, so a policied
    // edge never reaches it. Rejected here, or nothing reports it at all.
    const emailFk: ForeignKeyRef = {
      table: 'orders',
      column: 'customer_email',
      referencedTable: 'users',
      referencedColumn: 'email'
    }

    const resolved = resolveBackfillPolicies(
      [policy('orders', 'customer_email', 'null')],
      [emailFk],
      allNullable,
      included,
      idPk
    )

    expect(resolved.policyOf('orders', 'customer_email')).toBe('follow')
    expect(resolved.nullColumns.size).toBe(0)
    expect(resolved.warnings).toHaveLength(1)
    expect(resolved.warnings[0]).toContain('primary key')
  })

  it('rejects a policy when the parent primary key is unknown', () => {
    // Composite or missing PK: `primaryKeyOf` returns undefined and this fails closed, like unknown
    // nullability, rather than assuming the reference is resolvable.
    const resolved = resolveBackfillPolicies(
      [policy('submissions', 'welded_by_user_id', 'null')],
      fks,
      allNullable,
      included,
      () => undefined
    )

    expect(resolved.policyOf('submissions', 'welded_by_user_id')).toBe('follow')
    expect(resolved.warnings).toHaveLength(1)
  })

  it('rejects the policy if any one of a column`s constraints targets a non-primary key', () => {
    // A column may carry more than one foreign key. One unresolvable target makes the emitted value
    // untrustworthy, because the row has to satisfy every constraint.
    const resolved = resolveBackfillPolicies(
      [policy('orders', 'ref', 'null')],
      [
        fk('orders', 'ref', 'users'),
        { table: 'orders', column: 'ref', referencedTable: 'legacy', referencedColumn: 'code' }
      ],
      allNullable,
      included,
      idPk
    )

    expect(resolved.policyOf('orders', 'ref')).toBe('follow')
    expect(resolved.warnings).toHaveLength(1)
  })
})

describe('buildNullEdges', () => {
  const fks = [fk('submissions', 'welded_by_user_id', 'users')]
  const nullColumns = new Map([['submissions', ['welded_by_user_id']]])
  const subset = (): TableRole => 'subset'

  it('keeps references to kept rows and nulls the rest', () => {
    const selection = new Map([['users', selectionOf('users', [1, 2])]])
    const edges = buildNullEdges(nullColumns, fks, selection, subset)!.get('submissions')!

    expect(edges).toHaveLength(1)
    expect(edges[0].column).toBe('welded_by_user_id')
    expect(edges[0].isKept(1)).toBe(true)
    expect(edges[0].isKept(99)).toBe(false)
  })

  it('compares ids as text, so a string FK matches a numeric PK and vice versa', () => {
    // An FK only has to be *comparable* to the key it references, not identically typed: node-pg
    // returns int4 as a number and int8 as a string. A raw === would null a perfectly good reference.
    const numericPk = new Map([['users', selectionOf('users', [42])]])
    expect(
      buildNullEdges(nullColumns, fks, numericPk, subset).get('submissions')![0].isKept('42')
    ).toBe(true)

    const stringPk = new Map([['users', selectionOf('users', ['42'])]])
    expect(
      buildNullEdges(nullColumns, fks, stringPk, subset).get('submissions')![0].isKept(42)
    ).toBe(true)
  })

  it('nulls everything when the parent is excluded from the dump', () => {
    // The one case where a policy strictly improves on the status quo — backfill can only warn about
    // an excluded parent, whereas nulling actually repairs the reference.
    const edges = buildNullEdges(nullColumns, fks, new Map(), () => 'omitted').get('submissions')!

    expect(edges[0].isKept(1)).toBe(false)
  })

  it('issues no instruction when nothing can dangle', () => {
    // A parent dumped whole, and a parent with an `all` rule, both contain every row a child could
    // point at — nulling there would only destroy good data.
    expect(buildNullEdges(nullColumns, fks, new Map(), () => 'complete').size).toBe(0)

    const keepAll = new Map([['users', selectionOf('users', [1], true)]])
    expect(buildNullEdges(nullColumns, fks, keepAll, subset).size).toBe(0)
  })

  it('treats a parent with nothing kept as entirely absent', () => {
    const edges = buildNullEdges(nullColumns, fks, new Map(), subset).get('submissions')!

    expect(edges[0].isKept(1)).toBe(false)
  })

  describe('when one column carries more than one foreign key', () => {
    // Legal in both MySQL and Postgres: the same value referencing two tables, which the row must
    // satisfy in both. Keying the lookup on `table.column` alone silently kept whichever constraint
    // came last, so a value present in that parent but missing from the other survived and dangled
    // against the constraint that was never checked.
    const twoConstraints = [fk('orders', 'ref', 'users'), fk('orders', 'ref', 'accounts')]
    const refColumn = new Map([['orders', ['ref']]])

    it('keeps a value only when every parent has it', () => {
      // Deliberately asymmetric in BOTH directions. An implementation that checks only one constraint
      // gets the value unique to the *other* parent wrong, so whichever one it happens to keep, a
      // single-parent check fails here — the earlier fixture (kept in `users`, missing from
      // `accounts`) agreed with last-wins by accident and would have passed against the bug.
      const selection = new Map([
        ['users', selectionOf('users', [1, 2])],
        ['accounts', selectionOf('accounts', [1, 3])]
      ])

      const edge = buildNullEdges(refColumn, twoConstraints, selection, subset).get('orders')![0]

      expect(edge.isKept(1)).toBe(true) // in both
      expect(edge.isKept(2)).toBe(false) // users only — dangles against accounts
      expect(edge.isKept(3)).toBe(false) // accounts only — dangles against users
      expect(edge.isKept(9)).toBe(false) // in neither
    })

    it('checks only the constraints that can actually dangle', () => {
      // `accounts` is dumped whole, so nothing can dangle into it — the value's fate rests on `users`.
      // The whole-table parent is the LAST constraint deliberately: a last-wins lookup lands on it,
      // decides nothing can dangle, and emits no edge at all, so this fails on the missing edge. With
      // the roles the other way round a single-parent check agrees by luck and proves nothing.
      const selection = new Map([['users', selectionOf('users', [1])]])
      const roleOf = (table: string): TableRole => (table === 'accounts' ? 'complete' : 'subset')

      const edges = buildNullEdges(refColumn, twoConstraints, selection, roleOf).get('orders')
      expect(edges).toHaveLength(1)

      expect(edges![0].isKept(1)).toBe(true)
      expect(edges![0].isKept(2)).toBe(false)
    })

    it('nulls everything when any one parent is excluded from the dump', () => {
      // The excluded parent is the FIRST constraint while the second would happily keep the value, so
      // a single-parent check returns true here and the test fails against the bug.
      const selection = new Map([['accounts', selectionOf('accounts', [1])]])
      const roleOf = (table: string): TableRole => (table === 'users' ? 'omitted' : 'subset')

      const edge = buildNullEdges(refColumn, twoConstraints, selection, roleOf).get('orders')![0]

      expect(edge.isKept(1)).toBe(false)
    })
  })
})

describe('applyNullEdges', () => {
  const edge = (
    column: string,
    kept: PkValue[]
  ): { column: string; isKept: (v: unknown) => boolean } => ({
    column,
    isKept: (value) => kept.map(String).includes(String(value))
  })

  it('returns the same object untouched when every reference is kept', () => {
    const row = { id: 1, welded_by_user_id: 7 }
    const nulled: string[] = []

    const out = applyNullEdges(row, [edge('welded_by_user_id', [7])], (c) => nulled.push(c))

    expect(out).toBe(row) // copy-on-write: no allocation in the common case
    expect(nulled).toEqual([])
  })

  it('nulls a dangling reference without mutating the streamed row', () => {
    const row = { id: 1, welded_by_user_id: 99, user_id: 7 }
    const nulled: string[] = []

    const out = applyNullEdges(row, [edge('welded_by_user_id', [7])], (c) => nulled.push(c))

    expect(out).toEqual({ id: 1, welded_by_user_id: null, user_id: 7 })
    expect(row.welded_by_user_id).toBe(99) // the driver's own object is never written to
    expect(nulled).toEqual(['welded_by_user_id'])
  })

  it('leaves an already-NULL reference alone and does not count it', () => {
    const row = { id: 1, welded_by_user_id: null }
    const nulled: string[] = []

    const out = applyNullEdges(row, [edge('welded_by_user_id', [7])], (c) => nulled.push(c))

    expect(out).toBe(row)
    expect(nulled).toEqual([])
  })

  it('applies each edge independently on one row', () => {
    const row = { id: 1, welded_by_user_id: 99, photoed_by_user_id: 7 }
    const nulled: string[] = []

    const out = applyNullEdges(
      row,
      [edge('welded_by_user_id', [7]), edge('photoed_by_user_id', [7])],
      (c) => nulled.push(c)
    )

    expect(out).toEqual({ id: 1, welded_by_user_id: null, photoed_by_user_id: 7 })
    expect(nulled).toEqual(['welded_by_user_id'])
  })
})
