import type { Knex } from 'knex'
import type { ColumnInfo, ForeignKeyRef, Row } from '@shared/types'
import { applyFilter, applyTake } from '../extract/conditions'
import { throwIfCancelled } from '../extract/cancel'
import { applyRowFilter, type RowFilter } from '../extract/row-filter'
import type { DbAdapter, ExtensionInfo, SelectRowsOptions } from './types'

/** IN-clause chunk size for the id-set queries — keeps parameter counts well within limits. */
const IN_CHUNK = 1000

/**
 * MySQL introspection via `information_schema`, scoped to one database. Columns are
 * aliased to camelCase in each query so result keys are deterministic regardless of the
 * server's `information_schema` name casing.
 */
export class MySQLAdapter implements DbAdapter {
  /** Per-table single-column PK cache (introspected once per adapter lifetime). */
  private readonly pkCache = new Map<string, string>()
  /** Set by `withCancellation` per run; consulted per IN-chunk so Stop lands mid-call. */
  cancellationSignal?: AbortSignal

  constructor(
    private readonly db: Knex,
    private readonly database: string
  ) {}

  async ping(): Promise<void> {
    await this.db.raw('SELECT 1')
  }

  async getTables(): Promise<string[]> {
    const rows = await this.db('information_schema.tables')
      .where({ table_schema: this.database, table_type: 'BASE TABLE' })
      .orderBy('table_name')
      .select<{ name: string }[]>({ name: 'table_name' })
    return rows.map((r) => r.name)
  }

  async getColumns(table: string): Promise<ColumnInfo[]> {
    const rows = await this.db('information_schema.columns')
      .where({ table_schema: this.database, table_name: table })
      .orderBy('ordinal_position')
      .select<{ name: string; dataType: string; isNullable: string; columnKey: string }[]>({
        name: 'column_name',
        dataType: 'column_type',
        isNullable: 'is_nullable',
        columnKey: 'column_key'
      })
    return rows.map((r) => ({
      name: r.name,
      dataType: r.dataType,
      nullable: r.isNullable === 'YES',
      isPrimaryKey: r.columnKey === 'PRI'
    }))
  }

  async getUniqueColumns(table: string): Promise<string[]> {
    const rows = await this.db('information_schema.statistics')
      .where({ table_schema: this.database, table_name: table, non_unique: 0 })
      .select<{ indexName: string; column: string }[]>({
        indexName: 'index_name',
        column: 'column_name'
      })
    // Group index columns; a single-column unique index makes that column individually unique.
    const byIndex = new Map<string, string[]>()
    for (const r of rows) {
      const cols = byIndex.get(r.indexName) ?? []
      cols.push(r.column)
      byIndex.set(r.indexName, cols)
    }
    const unique = new Set<string>()
    for (const cols of byIndex.values()) if (cols.length === 1) unique.add(cols[0])
    return [...unique]
  }

  async getSequenceColumns(): Promise<string[]> {
    // Only Postgres needs this: `mysqlDumpDialect` has no `resetSequence`, because AUTO_INCREMENT
    // moves past the loaded ids by itself, so the pipeline never asks.
    return []
  }

  async getGeneratedColumns(table: string): Promise<string[]> {
    // Matched on `extra` only — that column exists in every MySQL version, whereas
    // `generation_expression` arrived in 5.7, and a missing column would throw and fail the whole
    // extract. Generated columns don't exist before 5.7 either, so `extra` alone is sufficient.
    //
    // The patterns are deliberately specific rather than a bare `%generated%`: MySQL 8 also reports
    // `extra = 'DEFAULT_GENERATED'` for an ordinary column with an expression default (e.g.
    // `DEFAULT CURRENT_TIMESTAMP`). Those are *normal* columns whose values must be dumped — a loose
    // match would silently drop them from every INSERT. The bare `virtual`/`persistent` equality
    // checks cover older MariaDB, which spelled the same thing that way.
    const rows = await this.db('information_schema.columns')
      .where({ table_schema: this.database, table_name: table })
      .andWhere((b) =>
        b
          .whereRaw("LOWER(extra) LIKE '%virtual generated%'")
          .orWhereRaw("LOWER(extra) LIKE '%stored generated%'")
          .orWhereRaw("LOWER(extra) = 'virtual'")
          .orWhereRaw("LOWER(extra) = 'persistent'")
      )
      .select<{ name: string }[]>({ name: 'column_name' })
    return rows.map((r) => r.name)
  }

  async getExtensions(): Promise<ExtensionInfo[]> {
    // MySQL has no CREATE EXTENSION concept — nothing to recreate ahead of the schema.
    return []
  }

  async getForeignKeys(): Promise<ForeignKeyRef[]> {
    const rows = await this.db('information_schema.key_column_usage')
      .where({ table_schema: this.database })
      .whereNotNull('referenced_table_name')
      .select<
        {
          table: string
          column: string
          referencedTable: string
          referencedColumn: string
        }[]
      >({
        table: 'table_name',
        column: 'column_name',
        referencedTable: 'referenced_table_name',
        referencedColumn: 'referenced_column_name'
      })
    return rows.map((r) => ({
      table: r.table,
      column: r.column,
      referencedTable: r.referencedTable,
      referencedColumn: r.referencedColumn
    }))
  }

  async getCreateTableStatement(table: string): Promise<string> {
    // mysql2 via knex.raw returns [rows, fields]; SHOW CREATE TABLE yields one row with
    // a `Create Table` column (a view would use `Create View` — we only dump base tables).
    const [rows] = (await this.db.raw('SHOW CREATE TABLE ??', [table])) as [
      Array<Record<string, string>>,
      unknown
    ]
    const ddl = rows?.[0]?.['Create Table']
    if (!ddl) throw new Error(`No CREATE TABLE statement returned for "${table}".`)
    // Normalised here rather than trusted: what the server hands back depends on its own sql_mode,
    // and the dump has to be the same file wherever it was taken from. See `toBacktickIdentifiers`.
    return toBacktickIdentifiers(ddl)
  }

  // ── Data movement (extract) ──────────────────────────────────────────────────

  async getColumnValues(table: string, columns: string[]): Promise<Record<string, unknown>[]> {
    return this.db(table).select(columns) as Promise<Record<string, unknown>[]>
  }

  async selectRows(
    table: string,
    columns: string[],
    opts: SelectRowsOptions
  ): Promise<Record<string, unknown>[]> {
    const pk = await this.primaryKeyColumn(table)
    const q = applyFilter(this.db(table).select(columns), opts, pk)
    // `RAND()`, not the `RANDOM()` Postgres and SQLite use.
    return (await applyTake(q, opts.take, 'RAND()')) as Record<string, unknown>[]
  }

  async countRows(table: string, opts: SelectRowsOptions): Promise<number> {
    const pk = await this.primaryKeyColumn(table)
    const rows = (await applyFilter(this.db(table), opts, pk).count({ n: '*' })) as {
      n: number | string
    }[]
    return Number(rows[0]?.n ?? 0)
  }

  async getRowsReferencing(
    childTable: string,
    fkColumn: string,
    parentIds: (string | number)[]
  ): Promise<{ childId: string | number; parentId: string | number }[]> {
    if (parentIds.length === 0) return []
    const childPk = await this.primaryKeyColumn(childTable)
    const out: { childId: string | number; parentId: string | number }[] = []
    // Chunk the IN list so a large parent set can't blow the placeholder limit.
    for (let i = 0; i < parentIds.length; i += IN_CHUNK) {
      throwIfCancelled(this.cancellationSignal)
      const chunk = parentIds.slice(i, i + IN_CHUNK)
      const rows = (await this.db(childTable)
        .select({ childId: childPk, parentId: fkColumn })
        .whereIn(fkColumn, chunk)) as {
        childId: string | number
        parentId: string | number
      }[]
      out.push(...rows)
    }
    return out
  }

  async getRowsReferencingMorph(
    childTable: string,
    typeColumn: string,
    typeValue: string,
    idColumn: string,
    parentIds: (string | number)[]
  ): Promise<{ childId: string | number; parentId: string | number }[]> {
    if (parentIds.length === 0) return []
    const childPk = await this.primaryKeyColumn(childTable)
    const out: { childId: string | number; parentId: string | number }[] = []
    for (let i = 0; i < parentIds.length; i += IN_CHUNK) {
      throwIfCancelled(this.cancellationSignal)
      const rows = (await this.db(childTable)
        .select({ childId: childPk, parentId: idColumn })
        .where(typeColumn, typeValue)
        .whereIn(idColumn, parentIds.slice(i, i + IN_CHUNK))) as {
        childId: string | number
        parentId: string | number
      }[]
      out.push(...rows)
    }
    return out
  }

  async getReferencedIds(
    childTable: string,
    fkColumn: string,
    childIds?: (string | number)[]
  ): Promise<(string | number)[]> {
    // An explicitly empty child set references nothing; `undefined` means "the whole table".
    if (childIds && childIds.length === 0) return []
    const out = new Set<string | number>()
    // DISTINCT per chunk, de-duplicated again in JS — one chunk can't see another's values.
    const collect = async (chunk?: (string | number)[]): Promise<void> => {
      let query = this.db(childTable).distinct({ parentId: fkColumn }).whereNotNull(fkColumn)
      if (chunk) query = query.whereIn(await this.primaryKeyColumn(childTable), chunk)
      for (const row of (await query) as { parentId: string | number }[]) out.add(row.parentId)
    }

    if (!childIds) await collect()
    else {
      for (let i = 0; i < childIds.length; i += IN_CHUNK) {
        throwIfCancelled(this.cancellationSignal)
        await collect(childIds.slice(i, i + IN_CHUNK))
      }
    }
    return [...out]
  }

  async getReferencedIdsMorph(
    childTable: string,
    typeColumn: string,
    typeValue: string,
    idColumn: string,
    childIds?: (string | number)[]
  ): Promise<(string | number)[]> {
    if (childIds && childIds.length === 0) return []
    const out = new Set<string | number>()
    const collect = async (chunk?: (string | number)[]): Promise<void> => {
      let query = this.db(childTable)
        .distinct({ parentId: idColumn })
        .where(typeColumn, typeValue)
        .whereNotNull(idColumn)
      if (chunk) query = query.whereIn(await this.primaryKeyColumn(childTable), chunk)
      for (const row of (await query) as { parentId: string | number }[]) out.add(row.parentId)
    }

    if (!childIds) await collect()
    else {
      for (let i = 0; i < childIds.length; i += IN_CHUNK) {
        throwIfCancelled(this.cancellationSignal)
        await collect(childIds.slice(i, i + IN_CHUNK))
      }
    }
    return [...out]
  }

  async getExistingIds(table: string, ids: (string | number)[]): Promise<(string | number)[]> {
    if (ids.length === 0) return []
    const pk = await this.primaryKeyColumn(table)
    const out: (string | number)[] = []
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      throwIfCancelled(this.cancellationSignal)
      const rows = (await this.db(table)
        .select({ id: pk })
        .whereIn(pk, ids.slice(i, i + IN_CHUNK))) as { id: string | number }[]
      out.push(...rows.map((r) => r.id))
    }
    return out
  }

  async getDistinctValues(table: string, column: string, limit: number): Promise<unknown[]> {
    // No ORDER BY: combining it with DISTINCT has dialect-specific rules about what may appear in
    // the list, and the result set is capped small enough that callers sort it themselves.
    const rows = (await this.db(table)
      .distinct({ value: column })
      .whereNotNull(column)
      .limit(limit)) as { value: unknown }[]
    return rows.map((r) => r.value)
  }

  async sampleColumnValues(table: string, column: string, limit: number): Promise<unknown[]> {
    const rows = (await this.db(table)
      .select({ value: column })
      .whereNotNull(column)
      .limit(limit)) as { value: unknown }[]
    return rows.map((r) => r.value)
  }

  async *streamRows(table: string, where?: RowFilter): AsyncIterable<Row> {
    const query = applyRowFilter(this.db(table).select('*'), where)
    const stream = query.stream()
    try {
      for await (const row of stream) {
        yield row as Row
      }
    } finally {
      // Ensure the underlying connection is released if iteration is abandoned early.
      stream.destroy()
    }
  }

  /**
   * The single-column primary key of a table, cached. Throws on a composite or missing PK:
   * id-based sampling/cascade (`sampleRandomIds`, `getRowsReferencing`) can't address a row by
   * a single value without one. (Composite-PK support is a later enhancement — spec §4.)
   */
  private async primaryKeyColumn(table: string): Promise<string> {
    const cached = this.pkCache.get(table)
    if (cached) return cached
    const pks = (await this.getColumns(table)).filter((c) => c.isPrimaryKey)
    if (pks.length === 0) throw new Error(`Table "${table}" has no primary key.`)
    if (pks.length > 1) {
      throw new Error(
        `Table "${table}" has a composite primary key (${pks
          .map((c) => c.name)
          .join(', ')}) — not supported for id-based sampling/cascade yet.`
      )
    }
    const name = pks[0].name
    this.pkCache.set(table, name)
    return name
  }
}

/**
 * A `CREATE TABLE` whose own table identifier is double-quoted — the fingerprint of DDL produced
 * by a server running `ANSI_QUOTES`. Used as the trigger for rewriting, so DDL that already uses
 * backticks is returned untouched rather than run through a scanner it doesn't need.
 */
const ANSI_QUOTED_CREATE = /^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"/i

/**
 * Rewrite ANSI-quoted identifiers in captured DDL to backticks.
 *
 * **Why this can't be left to the session.** `SHOW CREATE TABLE` quotes identifiers according to
 * the server's `sql_mode`: under `ANSI_QUOTES` (or the compound `ANSI` that contains it) it emits
 * `"users"`, otherwise `` `users` ``. Masq copies that text into the dump verbatim, so a dump taken
 * from an `ANSI_QUOTES` server only loads into another `ANSI_QUOTES` server — and to any other
 * MySQL, `"users"` is a *string literal*, so the load dies on the first CREATE TABLE with
 * `ERROR 1064`.
 *
 * An earlier attempt asked the source *session* to drop `ANSI_QUOTES` so the server would hand back
 * backticks. It was observed not to take effect, and a dump's portability is too important to rest
 * on a setting we can only request — so the text is normalised here, where the result is certain.
 * Backticks are the right target because they are accepted under **every** mode: `ANSI_QUOTES`
 * *adds* `"` as an identifier quote, it does not remove the backtick.
 *
 * Only rewrites DDL that announces itself as ANSI-quoted (`ANSI_QUOTED_CREATE`). That matters: in
 * ordinary MySQL a `"` is a string delimiter, so rewriting unconditionally would turn string
 * literals into identifiers. Under `ANSI_QUOTES` the ambiguity is gone — literals can only be
 * single-quoted — which is exactly what makes the rewrite safe once the trigger has fired.
 *
 * Single-quoted literals are copied through untouched, so a `"` inside a DEFAULT or a COMMENT stays
 * a character rather than becoming a quote. `""` inside an identifier is MySQL's escape for a
 * literal double quote, and a backtick inside the resulting name is re-escaped by doubling.
 *
 * Known limit: a literal is scanned assuming backslash escapes are active, MySQL's default. Under
 * `NO_BACKSLASH_ESCAPES` a value ending in a backslash would be mis-scanned — a combination that
 * also requires `ANSI_QUOTES`, and that no dump seen so far has hit.
 */
export function toBacktickIdentifiers(ddl: string): string {
  if (!ANSI_QUOTED_CREATE.test(ddl)) return ddl

  let out = ''
  let i = 0
  while (i < ddl.length) {
    const ch = ddl[i]

    if (ch === "'") {
      // A string literal: copied byte for byte, including any `"` it contains.
      out += ch
      i++
      while (i < ddl.length) {
        const c = ddl[i]
        if (c === '\\') {
          out += c + (ddl[i + 1] ?? '')
          i += 2
          continue
        }
        if (c === "'") {
          // `''` is an escaped quote, not the end of the literal.
          if (ddl[i + 1] === "'") {
            out += "''"
            i += 2
            continue
          }
          out += c
          i++
          break
        }
        out += c
        i++
      }
      continue
    }

    if (ch === '"') {
      i++
      let name = ''
      while (i < ddl.length) {
        const c = ddl[i]
        if (c === '"') {
          if (ddl[i + 1] === '"') {
            name += '"'
            i += 2
            continue
          }
          i++
          break
        }
        name += c
        i++
      }
      out += `\`${name.replace(/`/g, '``')}\``
      continue
    }

    out += ch
    i++
  }
  return out
}
