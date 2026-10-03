import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ColumnInfo, Connection, ForeignKeyRef, Row } from '@shared/types'
import { getDb } from '../../src/main/config/db'
import { runMigrations } from '../../src/main/config/migrate'
import { createWorkspace } from '../../src/main/config/repositories/workspaces'
import { setTableClassification } from '../../src/main/config/repositories/table-classifications'
import { createSelectionRule } from '../../src/main/config/repositories/selection-rules'
import { createFieldStrategy } from '../../src/main/config/repositories/field-strategies'
import type { DbAdapter } from '../../src/main/adapters'
import { executePipeline } from '../../src/main/extract/run'

/**
 * End-to-end shape of a produced dump, driven through `executePipeline` with a fake adapter so the
 * classification → DDL → rows path can be asserted without a live database.
 *
 * The question this exists to answer: **which classifications put a table's schema in the dump, and
 * which put rows in it**. Those are two separate decisions, and a table that appears with a CREATE
 * and no INSERT is a legitimate, useful outcome — an empty `sessions` table is the motivating case.
 */

const userData = mkdtempSync(join(tmpdir(), 'masq-pipeline-spec-'))
const previousUserData = process.env.MASQ_TEST_USERDATA
process.env.MASQ_TEST_USERDATA = userData

const dumpDir = mkdtempSync(join(tmpdir(), 'masq-pipeline-dumps-'))

beforeAll(() => {
  runMigrations()
})

afterAll(() => {
  getDb().close()
  if (previousUserData === undefined) delete process.env.MASQ_TEST_USERDATA
  else process.env.MASQ_TEST_USERDATA = previousUserData
  rmSync(userData, { recursive: true, force: true })
  rmSync(dumpDir, { recursive: true, force: true })
})

const connection: Connection = {
  id: 'conn-1',
  workspaceId: 'ws',
  label: 'Fake MySQL',
  dialect: 'mysql',
  role: 'source',
  host: 'localhost',
  port: 3306,
  database: 'app',
  username: 'root'
}

function column(name: string, isPrimaryKey = false): ColumnInfo {
  return { name, dataType: 'varchar(255)', nullable: !isPrimaryKey, isPrimaryKey }
}

/**
 * Two unrelated tables. `sessions` carries rows in the source — the point being that emitting its
 * schema without them is a choice the classification makes, not an artefact of the table happening
 * to be empty upstream.
 */
const TABLES: Record<string, { columns: ColumnInfo[]; rows: Row[] }> = {
  users: {
    columns: [column('id', true), column('email')],
    rows: [
      { id: 1, email: 'a@example.com' },
      { id: 2, email: 'b@example.com' }
    ]
  },
  sessions: {
    columns: [column('id', true), column('payload'), column('user_id')],
    rows: [
      { id: 'sess-1', payload: 'live-session-data', user_id: 1 },
      { id: 'sess-2', payload: 'more-session-data', user_id: 2 }
    ]
  }
}

/** `sessions.user_id → users.id` — the edge Laravel ships, and the one that causes the trap. */
const SESSIONS_FK: ForeignKeyRef[] = [
  { table: 'sessions', column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }
]

/**
 * `lateRows` are rows that only the dump stream sees — inserted into the source after selection ran
 * and before the table was streamed. Nothing else in the fake returns them.
 */
function fakeAdapter(
  foreignKeys: ForeignKeyRef[] = [],
  lateRows: Record<string, Row[]> = {}
): DbAdapter {
  const adapter: Partial<DbAdapter> = {
    getTables: async () => Object.keys(TABLES),
    getColumns: async (table) => TABLES[table].columns,
    getForeignKeys: async () => foreignKeys,
    getExtensions: async () => [],
    getUniqueColumns: async () => [],
    getSequenceColumns: async () => [],
    getGeneratedColumns: async () => [],
    getCreateTableStatement: async (table) =>
      `CREATE TABLE \`${table}\` (${TABLES[table].columns.map((c) => `\`${c.name}\` varchar(255)`).join(', ')})`,
    getColumnValues: async (table) => TABLES[table].rows,
    getRowsReferencing: async (childTable, fkColumn, parentIds) =>
      TABLES[childTable].rows
        .filter((row) => parentIds.includes(row[fkColumn] as string | number))
        .map((row) => ({
          childId: row.id as string | number,
          parentId: row[fkColumn] as string | number
        })),
    getReferencedIds: async () => [],
    // Honours `equals` only — the one operator these cases use. Anything else would silently
    // return the whole table and make a "nothing matched" assertion pass for the wrong reason.
    selectRows: async (table, _columns, opts) =>
      TABLES[table].rows.filter((row) =>
        (opts.where ?? []).every((c) =>
          c.op === 'eq'
            ? // `column: null` is the "this table's primary key" sentinel; these cases never use it.
              row[c.column ?? 'id'] === c.value
            : (() => {
                throw new Error(`fake adapter: unsupported condition ${c.op}`)
              })()
        )
      ),
    streamRows: (table, where) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<Row> {
        for (const row of [...TABLES[table].rows, ...(lateRows[table] ?? [])]) {
          if (where?.columns) {
            const keep = Object.entries(where.columns).every(([col, values]) =>
              (values as unknown[]).includes(row[col])
            )
            if (!keep) continue
          }
          yield row
        }
      }
    })
  }
  return new Proxy(adapter as DbAdapter, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof DbAdapter]
      throw new Error(`fake adapter: unexpected call to ${prop}`)
    }
  })
}

/** Run the pipeline for a workspace and return the combined dump's text. */
async function dumpFor(workspaceId: string, foreignKeys: ForeignKeyRef[] = []): Promise<string> {
  const dir = mkdtempSync(join(dumpDir, 'run-'))
  await executePipeline(fakeAdapter(foreignKeys), connection, workspaceId, dir, [])
  const file = readdirSync(dir).find((f) => f.endsWith('.sql'))!
  return readFileSync(join(dir, file), 'utf8')
}

describe('which classification puts a table in the dump', () => {
  it('dumps a transactional table with no selection rule as schema-only', async () => {
    // The motivating case: an empty `sessions` table. Transactional with nothing selected keeps the
    // CREATE — a dump that silently omitted the table would fail the app on its first write to it —
    // and keeps every row out, which is the whole point of not wanting production sessions locally.
    const ws = createWorkspace({ name: 'Schema-only sessions' })
    setTableClassification({ workspaceId: ws.id, tableName: 'sessions', class: 'transactional' })

    const sql = await dumpFor(ws.id)

    expect(sql).toContain('CREATE TABLE `sessions`')
    expect(sql).not.toContain('INSERT INTO `sessions`')
    expect(sql).not.toContain('live-session-data')
  })

  it('leaves a table out entirely when it is excluded', async () => {
    // What the Laravel preset does to `sessions` by default, and the behaviour to change if the
    // schema is wanted: excluded removes the CREATE too, not just the rows.
    const ws = createWorkspace({ name: 'Excluded sessions' })
    setTableClassification({ workspaceId: ws.id, tableName: 'sessions', class: 'excluded' })

    const sql = await dumpFor(ws.id)

    expect(sql).not.toContain('CREATE TABLE `sessions`')
    expect(sql).not.toContain('INSERT INTO `sessions`')
  })

  it('copies every row when a table is reference', async () => {
    // Reference means "copy 100%, untouched" — so for `sessions` it is the wrong answer unless the
    // table really is empty upstream. It is not a way to get schema-only.
    const ws = createWorkspace({ name: 'Reference sessions' })
    setTableClassification({ workspaceId: ws.id, tableName: 'sessions', class: 'reference' })

    const sql = await dumpFor(ws.id)

    expect(sql).toContain('CREATE TABLE `sessions`')
    expect(sql).toContain('live-session-data')
    expect(sql).toContain('more-session-data')
  })

  it('still emits schema-only for a transactional table whose rule matches nothing', async () => {
    // Distinct from "no rule at all": a rule that selects zero rows must not start dumping the
    // whole table, which would be the worst possible failure mode for this exact table.
    const ws = createWorkspace({ name: 'Unmatched rule' })
    setTableClassification({ workspaceId: ws.id, tableName: 'sessions', class: 'transactional' })
    createSelectionRule({
      workspaceId: ws.id,
      table: 'sessions',
      match: 'all',
      where: [{ column: 'id', op: 'eq', value: 'no-such-id' }],
      take: { kind: 'all' },
      anonymize: true
    })

    const sql = await dumpFor(ws.id)

    expect(sql).toContain('CREATE TABLE `sessions`')
    expect(sql).not.toContain('live-session-data')
  })
  it('pulls rows into a rule-less transactional table via cascade — the reason `structure` exists', async () => {
    // The trap this documents: a transactional table with no selection rule looks schema-only, but
    // it is still a cascade target, so a kept parent drags its children in. Laravel's
    // `sessions.user_id` makes this the default outcome for the exact table people want empty.
    const ws = createWorkspace({ name: 'Cascade pulls rows' })
    setTableClassification({ workspaceId: ws.id, tableName: 'sessions', class: 'transactional' })
    createSelectionRule({
      workspaceId: ws.id,
      table: 'users',
      match: 'all',
      where: [],
      take: { kind: 'all' },
      anonymize: true
    })

    const sql = await dumpFor(ws.id, SESSIONS_FK)

    expect(sql).toContain('live-session-data')
  })

  it('keeps a structure table empty even when cascade would have filled it', async () => {
    // Same workspace shape as above, one classification different. This is the whole point of the
    // class: the guarantee holds against cascade, not just against the absence of a rule.
    const ws = createWorkspace({ name: 'Structure beats cascade' })
    setTableClassification({ workspaceId: ws.id, tableName: 'sessions', class: 'structure' })
    createSelectionRule({
      workspaceId: ws.id,
      table: 'users',
      match: 'all',
      where: [],
      take: { kind: 'all' },
      anonymize: true
    })

    const sql = await dumpFor(ws.id, SESSIONS_FK)

    expect(sql).toContain('CREATE TABLE `sessions`')
    expect(sql).not.toContain('INSERT INTO `sessions`')
    expect(sql).not.toContain('live-session-data')
    // The users rows that cascade would have followed are still there — `structure` withholds one
    // table's rows, it doesn't narrow the subset.
    expect(sql).toContain('INSERT INTO `users`')
  })

  it('ignores a selection rule on a structure table, and says so', async () => {
    // A rule left over from before the reclassification is still visible on the Rules screen. It
    // must not quietly do nothing.
    const ws = createWorkspace({ name: 'Structure with a rule' })
    setTableClassification({ workspaceId: ws.id, tableName: 'sessions', class: 'structure' })
    createSelectionRule({
      workspaceId: ws.id,
      table: 'sessions',
      match: 'all',
      where: [],
      take: { kind: 'all' },
      anonymize: true
    })

    const warnings: string[] = []
    const dir = mkdtempSync(join(dumpDir, 'run-'))
    await executePipeline(fakeAdapter(), connection, ws.id, dir, warnings)
    const sql = readFileSync(
      join(
        dir,
        readdirSync(dir).find((f) => f.endsWith('.sql'))!
      ),
      'utf8'
    )

    expect(sql).not.toContain('live-session-data')
    expect(warnings.join('\n')).toMatch(/structure-only.*ignored/i)
  })

  it('never emits a row that selection did not see, even when the table is dumped whole', async () => {
    // An unfiltered `all` rule streams the table without a WHERE. A row inserted between selection
    // and streaming has no anonymize flag, so it used to be written with its real values.
    const ws = createWorkspace({ name: 'Row inserted mid-extract' })
    createSelectionRule({
      workspaceId: ws.id,
      table: 'users',
      match: 'all',
      where: [],
      take: { kind: 'all' },
      anonymize: true
    })
    createFieldStrategy({
      workspaceId: ws.id,
      tableName: 'users',
      columnName: 'email',
      rule: { kind: 'redact' }
    })

    const dir = mkdtempSync(join(dumpDir, 'run-'))
    const late = { users: [{ id: 3, email: 'inserted-during-extract@example.test' }] }
    await executePipeline(fakeAdapter([], late), connection, ws.id, dir, [])
    const sql = readFileSync(
      join(
        dir,
        readdirSync(dir).find((f) => f.endsWith('.sql'))!
      ),
      'utf8'
    )

    expect(sql).toContain('INSERT INTO `users`')
    expect(sql).not.toContain('a@example.com')
    expect(sql).not.toContain('inserted-during-extract@example.test')
  })
})
