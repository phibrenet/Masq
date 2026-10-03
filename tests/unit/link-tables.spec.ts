import { describe, expect, it } from 'vitest'
import type { ColumnInfo, ForeignKeyRef, MorphRelation } from '@shared/types'
import type { DbAdapter } from '../../src/main/adapters'
import type { TableRole } from '../../src/main/extract/backfill'
import {
  detectLinkTables,
  linkTableFilters,
  type LinkTable
} from '../../src/main/extract/link-tables'
import type { PkValue, TableSelection } from '../../src/main/extract/types'

/**
 * Link-table subsetting (link-tables.ts): keeping the rows of a composite- or missing-PK pivot by
 * matching its endpoints against the kept sets, instead of by a row id it hasn't got.
 *
 * Detection reaches exactly one adapter method, so the rest of `DbAdapter` is left unimplemented on
 * purpose — a call to any other should fail loudly rather than pass on a stub's empty answer.
 * `linkTableFilters` reaches none at all, which is the point of splitting the two passes.
 */

/** Primary-key column names per table; every other column is irrelevant here. */
function fakeAdapter(pks: Record<string, string[]>): DbAdapter {
  const reached: Partial<DbAdapter> = {
    getColumns: async (table) => {
      const keys = pks[table]
      if (!keys) throw new Error(`Table "${table}" was not found in the database.`)
      const columns: ColumnInfo[] = keys.map((name) => ({
        name,
        dataType: 'bigint',
        nullable: false,
        isPrimaryKey: true
      }))
      return [
        ...columns,
        { name: 'created_at', dataType: 'datetime', nullable: true, isPrimaryKey: false }
      ]
    }
  }
  return reached as DbAdapter
}

function fk(table: string, column: string, referencedTable: string): ForeignKeyRef {
  return { table, column, referencedTable, referencedColumn: 'id' }
}

function morph(
  tableName: string,
  typeMap: { typeValue: string; targetTable: string }[],
  flags: { cascadeDown?: boolean; backfillUp?: boolean } = {}
): MorphRelation {
  return {
    id: `m-${tableName}`,
    workspaceId: 'w',
    tableName,
    typeColumn: 'model_type',
    idColumn: 'model_id',
    cascadeDown: flags.cascadeDown ?? false,
    backfillUp: flags.backfillUp ?? false,
    typeMap
  }
}

function selectionOf(entries: Record<string, PkValue[] | 'all'>): Map<string, TableSelection> {
  const map = new Map<string, TableSelection>()
  for (const [table, ids] of Object.entries(entries)) {
    map.set(table, {
      table,
      pkColumn: 'id',
      ids: new Map(ids === 'all' ? [] : ids.map((id) => [id, true])),
      identities: new Map(),
      keepAll: ids === 'all'
    })
  }
  return map
}

/** Every table is a subset table unless named otherwise. */
function roles(overrides: Record<string, TableRole> = {}): (table: string) => TableRole {
  return (table) => overrides[table] ?? 'subset'
}

describe('detectLinkTables', () => {
  const pivotFks = [
    fk('label_card_lookups', 'label_id', 'labels'),
    fk('label_card_lookups', 'card_lookup_id', 'card_lookups')
  ]

  it('claims a composite-PK pivot that nothing references', async () => {
    const adapter = fakeAdapter({
      labels: ['id'],
      card_lookups: ['id'],
      label_card_lookups: ['label_id', 'card_lookup_id']
    })
    const result = await detectLinkTables(
      adapter,
      ['labels', 'card_lookups', 'label_card_lookups'],
      pivotFks,
      [],
      roles()
    )

    expect(result.tables.map((t) => t.table)).toEqual(['label_card_lookups'])
    expect(result.tables[0].foreignKeys).toHaveLength(2)
    expect(result.tables[0].pkColumns).toEqual(['label_id', 'card_lookup_id'])
    expect(result.warnings).toEqual([])
    // Reported whether or not it qualifies, so run.ts can keep the cascade pre-flights quiet about it.
    expect([...result.unaddressable]).toEqual(['label_card_lookups'])
  })

  it('leaves single-column-PK tables alone', async () => {
    const adapter = fakeAdapter({ users: ['id'], orders: ['id'] })
    const result = await detectLinkTables(
      adapter,
      ['users', 'orders'],
      [fk('orders', 'user_id', 'users')],
      [],
      roles()
    )

    expect(result.tables).toEqual([])
    expect(result.unaddressable.size).toBe(0)
    expect(result.warnings).toEqual([])
  })

  it('refuses a composite-PK table that something references, and says why', async () => {
    // A referenced table has to be addressable: a child's FK value is matched against a kept parent
    // *row*, which endpoint matching can't produce.
    const adapter = fakeAdapter({ variants: ['sku', 'size'], stock: ['id'] })
    const result = await detectLinkTables(
      adapter,
      ['variants', 'stock'],
      [fk('variants', 'product_id', 'products'), fk('stock', 'variant_sku', 'variants')],
      [],
      roles()
    )

    expect(result.tables).toEqual([])
    expect(result.unaddressable.has('variants')).toBe(true)
    expect(result.warnings[0]).toContain('referenced by another table')
  })

  it('refuses a composite-PK table with nothing to match on', async () => {
    // Key columns that aren't `*_id` give name inference nothing to work with either.
    const adapter = fakeAdapter({ audit_snapshots: ['taken_at', 'shard'] })
    const result = await detectLinkTables(adapter, ['audit_snapshots'], [], [], roles())

    expect(result.tables).toEqual([])
    expect(result.warnings[0]).toContain('no foreign keys')
  })

  it('infers endpoints from key column names when no constraint declares them', async () => {
    // Laravel's `grading_report_user`, created with plain `unsignedBigInteger` columns: the schema
    // declares nothing, but the names do. Without this it dumped empty.
    const adapter = fakeAdapter({
      grading_report_user: ['grading_report_id', 'user_id'],
      grading_reports: ['id'],
      users: ['id']
    })
    const result = await detectLinkTables(
      adapter,
      ['grading_report_user', 'grading_reports', 'users'],
      [],
      [],
      roles()
    )

    expect(result.tables[0].inferred).toEqual([
      { column: 'grading_report_id', targetTable: 'grading_reports' },
      { column: 'user_id', targetTable: 'users' }
    ])
    // Reported every run: this is the one endpoint the database itself doesn't vouch for.
    expect(result.warnings[0]).toContain('grading_report_id → grading_reports, user_id → users')
  })

  it('only infers a name that matches a real table', async () => {
    // `widget_id` has no `widgets` table, so it yields nothing rather than a plausible-looking name.
    const adapter = fakeAdapter({ thing_widget: ['thing_id', 'widget_id'], things: ['id'] })
    const result = await detectLinkTables(adapter, ['thing_widget', 'things'], [], [], roles())

    expect(result.tables[0].inferred).toEqual([{ column: 'thing_id', targetTable: 'things' }])
  })

  it('never infers over a column a constraint or a declared morph already speaks for', async () => {
    const adapter = fakeAdapter({
      model_has_roles: ['role_id', 'model_type', 'model_id'],
      roles: ['id'],
      users: ['id']
    })
    const result = await detectLinkTables(
      adapter,
      ['model_has_roles', 'roles', 'users'],
      [fk('model_has_roles', 'role_id', 'roles')],
      [morph('model_has_roles', [{ typeValue: 'App\\Models\\User', targetTable: 'users' }])],
      roles()
    )

    expect(result.tables[0].inferred).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('leaves an undeclared morph id column uninferred', async () => {
    // `model_id` looks like a plain reference in isolation, and there is no `models` table, so it
    // stays uncovered — which is what `linkTableFilters` warns about and the Morphs screen fixes.
    const adapter = fakeAdapter({
      model_has_roles: ['role_id', 'model_type', 'model_id'],
      roles: ['id']
    })
    const result = await detectLinkTables(
      adapter,
      ['model_has_roles', 'roles'],
      [fk('model_has_roles', 'role_id', 'roles')],
      [],
      roles()
    )

    expect(result.tables[0].inferred).toEqual([])
  })

  it('claims a PK-less table with foreign keys', async () => {
    const adapter = fakeAdapter({ taggables: [], tags: ['id'] })
    const result = await detectLinkTables(
      adapter,
      ['taggables', 'tags'],
      [fk('taggables', 'tag_id', 'tags')],
      [],
      roles()
    )

    expect(result.tables.map((t) => t.table)).toEqual(['taggables'])
    expect(result.tables[0].pkColumns).toEqual([])
  })

  it('skips reference and excluded tables — they are already dumped whole or not at all', async () => {
    const adapter = fakeAdapter({ role_has_permissions: ['permission_id', 'role_id'] })
    const result = await detectLinkTables(
      adapter,
      ['role_has_permissions'],
      [fk('role_has_permissions', 'role_id', 'roles')],
      [],
      roles({ role_has_permissions: 'complete' })
    )

    expect(result.tables).toEqual([])
    expect(result.unaddressable.size).toBe(0)
  })

  it('counts a declared morph target as a reference to that table', async () => {
    // `comments` is the target of a declared relation, so it is referenced even though no FK says so.
    const adapter = fakeAdapter({ comments: ['post_id', 'seq'], reactions: ['id'] })
    const result = await detectLinkTables(
      adapter,
      ['comments'],
      [fk('comments', 'post_id', 'posts')],
      [morph('reactions', [{ typeValue: 'Comment', targetTable: 'comments' }])],
      roles()
    )

    expect(result.tables).toEqual([])
    expect(result.warnings[0]).toContain('referenced by another table')
  })
})

describe('linkTableFilters', () => {
  const pivot = {
    table: 'label_card_lookups',
    foreignKeys: [
      fk('label_card_lookups', 'label_id', 'labels'),
      fk('label_card_lookups', 'card_lookup_id', 'card_lookups')
    ],
    morphRelations: [],
    inferred: [],
    pkColumns: ['label_id', 'card_lookup_id']
  }

  it('restricts every endpoint to its parent’s kept ids', () => {
    const report = linkTableFilters(
      [pivot],
      selectionOf({ labels: [1, 2], card_lookups: [7, 8, 9] }),
      roles()
    )

    expect(report.filters.get('label_card_lookups')).toEqual({
      columns: { label_id: [1, 2], card_lookup_id: [7, 8, 9] },
      morphs: []
    })
    expect(report.warnings).toEqual([])
  })

  it('leaves an endpoint unrestricted when its parent is in the dump whole', () => {
    // A reference table and a `keepAll` selection are the same statement: every value the column can
    // hold is present, so an `IN` over it would only cost time.
    const report = linkTableFilters(
      [pivot],
      selectionOf({ card_lookups: 'all' }),
      roles({ labels: 'complete' })
    )

    expect(report.filters.get('label_card_lookups')).toEqual({ columns: {}, morphs: [] })
  })

  it('keeps no rows when a parent kept nothing', () => {
    // Not a no-op: an empty allowed set is the correct answer, and knex compiles it to `1 = 0`.
    const report = linkTableFilters([pivot], selectionOf({ labels: [1] }), roles())

    expect(report.filters.get('label_card_lookups')?.columns).toEqual({
      label_id: [1],
      card_lookup_id: []
    })
  })

  it('restricts an inferred endpoint exactly like a declared one', () => {
    const report = linkTableFilters(
      [
        {
          table: 'grading_report_user',
          foreignKeys: [],
          morphRelations: [],
          inferred: [
            { column: 'grading_report_id', targetTable: 'grading_reports' },
            { column: 'user_id', targetTable: 'users' }
          ],
          pkColumns: ['grading_report_id', 'user_id']
        }
      ],
      selectionOf({ grading_reports: [24], users: [1, 2] }),
      roles()
    )

    expect(report.filters.get('grading_report_user')).toEqual({
      columns: { grading_report_id: [24], user_id: [1, 2] },
      morphs: []
    })
    // Every key column is vouched for, so no "not covered" warning — raising the inference itself is
    // detection's job, once, and isn't repeated here.
    expect(report.warnings).toEqual([])
    expect(report.notes[0]).toContain('→?')
  })

  it('empties the table when an endpoint is excluded, and says so', () => {
    const report = linkTableFilters(
      [pivot],
      selectionOf({ labels: [1, 2] }),
      roles({ card_lookups: 'omitted' })
    )

    expect(report.filters.get('label_card_lookups')?.columns?.card_lookup_id).toEqual([])
    expect(report.warnings[0]).toContain('excluded from the dump')
  })

  describe('polymorphic endpoints', () => {
    const modelHasRoles = (relations: MorphRelation[]): LinkTable => ({
      table: 'model_has_roles',
      foreignKeys: [fk('model_has_roles', 'role_id', 'roles')],
      morphRelations: relations,
      inferred: [],
      pkColumns: ['role_id', 'model_type', 'model_id']
    })

    it('turns each mapped type value into its own allowed-id set', () => {
      const report = linkTableFilters(
        [
          modelHasRoles([
            morph('model_has_roles', [
              { typeValue: 'App\\Models\\User', targetTable: 'users' },
              { typeValue: 'App\\Models\\Team', targetTable: 'teams' }
            ])
          ])
        ],
        selectionOf({ roles: [1, 2], users: [10, 11], teams: [5] }),
        roles()
      )

      expect(report.filters.get('model_has_roles')).toEqual({
        columns: { role_id: [1, 2] },
        morphs: [
          {
            typeColumn: 'model_type',
            idColumn: 'model_id',
            alternatives: [
              { typeValue: 'App\\Models\\User', ids: [10, 11] },
              { typeValue: 'App\\Models\\Team', ids: [5] }
            ]
          }
        ]
      })
      expect(report.warnings).toEqual([])
    })

    it('reads the type map whatever the relation’s cascade flags say', () => {
      // `cascadeDown`/`backfillUp` govern traversal, and no traversal happens here — all this needs
      // is the map's other job, saying which table a type value names.
      const report = linkTableFilters(
        [
          modelHasRoles([
            morph('model_has_roles', [{ typeValue: 'App\\Models\\User', targetTable: 'users' }], {
              cascadeDown: false,
              backfillUp: false
            })
          ])
        ],
        selectionOf({ roles: [1], users: [10] }),
        roles()
      )

      expect(report.filters.get('model_has_roles')?.morphs?.[0].alternatives).toEqual([
        { typeValue: 'App\\Models\\User', ids: [10] }
      ])
    })

    it('drops the alternatives whose target is excluded', () => {
      const report = linkTableFilters(
        [
          modelHasRoles([
            morph('model_has_roles', [
              { typeValue: 'App\\Models\\User', targetTable: 'users' },
              { typeValue: 'App\\Models\\Bot', targetTable: 'bots' }
            ])
          ])
        ],
        selectionOf({ roles: [1], users: [10] }),
        roles({ bots: 'omitted' })
      )

      expect(report.filters.get('model_has_roles')?.morphs?.[0].alternatives).toEqual([
        { typeValue: 'App\\Models\\User', ids: [10] }
      ])
    })

    it('warns rather than empties when a declared relation has no usable mappings', () => {
      const report = linkTableFilters(
        [modelHasRoles([morph('model_has_roles', [])])],
        selectionOf({ roles: [1] }),
        roles()
      )

      expect(report.filters.get('model_has_roles')?.morphs).toEqual([])
      expect(report.warnings.some((w) => w.includes('no usable type mappings'))).toBe(true)
    })

    it('names the key columns nothing vouches for', () => {
      // The undeclared-morph case: `role_id` restricts, `model_type`/`model_id` don't, so rows survive
      // for models that aren't in the dump. The fix is a declared relation, so the message says so.
      const report = linkTableFilters([modelHasRoles([])], selectionOf({ roles: [1] }), roles())

      const warning = report.warnings.find((w) => w.includes('model_type, model_id'))
      expect(warning).toBeDefined()
      expect(warning).toContain('Morphs screen')
    })
  })
})
