import { describe, expect, it } from 'vitest'
import type { ColumnInfo, ForeignKeyRef } from '@shared/types'
import type { DbAdapter } from '../../src/main/adapters'
import { backfillSelection, type TableRole } from '../../src/main/extract/backfill'
import { CancelledError } from '../../src/main/extract/cancel'
import type { PkValue, TableSelection } from '../../src/main/extract/types'

/**
 * `backfillSelection` against a hand-built in-memory schema. Only three adapter methods are reached
 * on the plain-FK path, so the rest of `DbAdapter` is deliberately left unimplemented — a call to any
 * of them should fail the test loudly rather than pass on a stub's empty answer.
 */
interface FakeTable {
  /** Row id → its FK column values. */
  rows: Map<PkValue, Record<string, PkValue | null>>
}

function fakeAdapter(tables: Record<string, FakeTable>): DbAdapter {
  // Every fixture table is keyed by a single `id`, which is all `primaryKeyColumn` needs.
  const columns: ColumnInfo[] = [
    { name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true }
  ]
  const reached: Partial<DbAdapter> = {
    getColumns: async () => columns,
    getReferencedIds: async (childTable, fkColumn, childIds) => {
      const rows = tables[childTable]?.rows ?? new Map()
      const wanted = childIds ? new Set(childIds.map(String)) : undefined
      const out: PkValue[] = []
      for (const [id, values] of rows) {
        if (wanted && !wanted.has(String(id))) continue
        const value = values[fkColumn]
        if (value !== null && value !== undefined) out.push(value)
      }
      return out
    },
    // The real one compares in SQL and hands back the parent's own PK values; matching on text is the
    // same canonicalization this fixture can express.
    getExistingIds: async (table, ids) => {
      const rows = tables[table]?.rows ?? new Map()
      const present = new Map([...rows.keys()].map((id) => [String(id), id]))
      const seen = new Set<PkValue>()
      const out: PkValue[] = []
      for (const id of ids) {
        const real = present.get(String(id))
        if (real !== undefined && !seen.has(real)) {
          seen.add(real)
          out.push(real)
        }
      }
      return out
    }
  }
  return reached as DbAdapter
}

function fk(table: string, column: string, referencedTable: string): ForeignKeyRef {
  return { table, column, referencedTable, referencedColumn: 'id' }
}

function selectionOf(table: string, ids: PkValue[]): TableSelection {
  return {
    table,
    pkColumn: 'id',
    ids: new Map(ids.map((id) => [id, true])),
    identities: new Map(),
    keepAll: false
  }
}

/**
 * The shape that motivated per-edge policies: one submission owned by a selected user, but touched
 * by a member of staff nobody selected. Following both references pulls the staff member in.
 */
function fixture(): {
  adapter: DbAdapter
  selection: Map<string, TableSelection>
  foreignKeys: ForeignKeyRef[]
} {
  const adapter = fakeAdapter({
    users: {
      rows: new Map([
        [1, {}],
        [2, {}],
        [99, {}]
      ])
    },
    submissions: { rows: new Map([[10, { user_id: 1, welded_by_user_id: 99 }]]) }
  })
  return {
    adapter,
    selection: new Map([
      ['users', selectionOf('users', [1])],
      ['submissions', selectionOf('submissions', [10])]
    ]),
    foreignKeys: [
      fk('submissions', 'user_id', 'users'),
      fk('submissions', 'welded_by_user_id', 'users')
    ]
  }
}

const subset = (): TableRole => 'subset'

describe('backfillSelection with per-edge policies', () => {
  it('stops on cancellation instead of reporting each remaining edge as broken', async () => {
    const { adapter, selection, foreignKeys } = fixture()
    adapter.getReferencedIds = async () => {
      throw new CancelledError()
    }

    await expect(backfillSelection(adapter, selection, foreignKeys, subset)).rejects.toBeInstanceOf(
      CancelledError
    )
  })

  it('pulls in every referenced parent when no policy is declared', async () => {
    // The pre-policy behaviour, and the reason a "20 users" rule can produce 74: the staff member is
    // dragged in by an edge that says nothing about ownership.
    const { adapter, selection, foreignKeys } = fixture()

    const report = await backfillSelection(adapter, selection, foreignKeys, subset)

    expect([...selection.get('users')!.ids.keys()].sort()).toEqual([1, 99])
    expect(report.added).toEqual({ users: 1 })
    expect(report.skipped).toEqual([])
  })

  it('attributes each added row to the edge that pulled it in', async () => {
    const { adapter, selection, foreignKeys } = fixture()

    const report = await backfillSelection(adapter, selection, foreignKeys, subset)

    // `user_id` adds nothing — user 1 was already selected — so the whole growth is attributable to
    // the incidental edge. This is what makes the report actionable rather than just "users +1".
    expect(report.addedByEdge).toEqual({ 'submissions.welded_by_user_id': 1 })
  })

  it('does not pull a parent in through an edge marked null', async () => {
    const { adapter, selection, foreignKeys } = fixture()

    const report = await backfillSelection(adapter, selection, foreignKeys, subset, [], (_t, c) =>
      c === 'welded_by_user_id' ? 'null' : 'follow'
    )

    expect([...selection.get('users')!.ids.keys()]).toEqual([1])
    expect(report.added).toEqual({})
    expect(report.skipped).toEqual(['submissions.welded_by_user_id'])
  })

  it('still follows the ownership edge on the same table', async () => {
    const { adapter, selection, foreignKeys } = fixture()
    // Nothing selected in `users` this time: the owner has to be backfilled, the welder must not be.
    selection.set('users', selectionOf('users', []))

    await backfillSelection(adapter, selection, foreignKeys, subset, [], (_t, c) =>
      c === 'welded_by_user_id' ? 'null' : 'follow'
    )

    expect([...selection.get('users')!.ids.keys()]).toEqual([1])
  })

  it('reports a skipped edge once however many batches reach it', async () => {
    const { adapter, selection, foreignKeys } = fixture()
    selection.set('submissions', selectionOf('submissions', [10]))

    const report = await backfillSelection(
      adapter,
      selection,
      foreignKeys,
      subset,
      [],
      () => 'null'
    )

    expect(report.skipped).toEqual(['submissions.user_id', 'submissions.welded_by_user_id'])
  })
})
