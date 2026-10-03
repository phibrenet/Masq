import type { Knex } from 'knex'
import type { ColumnInfo, ForeignKeyRef, Row } from '@shared/types'
import { applyFilter, applyTake } from '../extract/conditions'
import { throwIfCancelled } from '../extract/cancel'
import { applyRowFilter, type RowFilter } from '../extract/row-filter'
import type { DbAdapter, ExtensionInfo, SelectRowsOptions } from './types'

/**
 * IN-clause chunk size for the id-set queries. SQLite's `SQLITE_MAX_VARIABLE_NUMBER` is 32766 in
 * the version we bundle (verified: 20 000 placeholders execute fine), so 1000 is deliberately
 * conservative and matches the other adapters.
 */
const IN_CHUNK = 1000

/** The only schema Masq introspects. `temp` and any ATTACHed database are deliberately ignored. */
const MAIN_SCHEMA = 'main'

/**
 * Minimal shape of the `better-sqlite3` handle knex hands back from its pool — enough to prepare a
 * statement and walk it lazily. Typed structurally rather than importing `better-sqlite3`'s types
 * so the adapter has no compile-time dependency on the driver package.
 */
interface SqliteConnection {
  prepare(sql: string): {
    iterate(...params: unknown[]): IterableIterator<unknown> & { return?: () => unknown }
  }
}

/** Just the bits of `Knex.Client` used here; knex's own types leave these loosely typed. */
interface PoolClient {
  acquireConnection(): Promise<SqliteConnection>
  releaseConnection(connection: SqliteConnection): Promise<void>
}

/** `PRAGMA table_xinfo.hidden` values. 1 = a virtual table's hidden column (absent from `SELECT *`). */
const HIDDEN_VIRTUAL_TABLE_COLUMN = 1
const HIDDEN_GENERATED_VIRTUAL = 2
const HIDDEN_GENERATED_STORED = 3

/**
 * Widen a `bigint` from the driver to something the rest of the engine can key a selection on.
 *
 * The pool opens SQLite with `safeIntegers`, so **every** INTEGER arrives as a `bigint` — that's the
 * only way to see an int64 exactly. Verified: with safe integers off, `9223372036854775807` comes
 * back as `9223372036854776000` — silently, with no error to catch, so a dump would carry a
 * corrupted id and a `WHERE pk IN (…)` built from it would quietly match nothing.
 *
 * `bigint` itself can't flow onward: `PkValue` is `string | number`, and both `Map` keys and the
 * dialect's `value()` are built around those. So each integer is narrowed to a `number` when that is
 * lossless, and to its **decimal string** when it isn't — mirroring what `node-pg` already does with
 * `int8` (see the `getReferencedIds` typing note in `types.ts`).
 *
 * **This must be applied on every read path, without exception.** The mapping is a pure function of
 * the value, so an id read from one query keys identically to the same id read from another — which
 * is exactly the invariant `PkValue`'s doc comment demands. Apply it to one path and not another and
 * you reintroduce the silent-PII-leak class: the `WHERE pk IN (…)` is evaluated by SQLite, which
 * coerces happily (verified: a bound number, string, *and* bigint all match an INTEGER column), so
 * the row is still selected and still passes every integrity check — only the in-process anonymize
 * lookup misses, and the row is emitted with real data.
 *
 * Known limitation: an int64 beyond ±2^53 becomes a quoted literal in the dump. SQLite's column
 * affinity converts that straight back to an integer for any INTEGER/NUMERIC-affinity column (the
 * normal case), but a column declared with *no* type has BLOB affinity and would store it as text.
 */
function narrowInteger(v: unknown): unknown {
  if (typeof v !== 'bigint') return v
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(v)
    : v.toString()
}

/**
 * `narrowInteger` across one row's values. Returns a new object; key order is preserved.
 *
 * **Every row the driver produces goes through this — introspection included, not just data.** Safe
 * integers apply to `PRAGMA` output too, so `table_xinfo.hidden` arrives as `3n` and
 * `index_list.unique` as `1n`; a `=== 1` test against those is silently false forever. That bug is
 * invisible in the obvious test (a `NOT NULL` column really is non-nullable, so `notNull === 0`
 * returning false still "passes"), so the rule is applied uniformly rather than per call site.
 */
function narrowRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[k] = narrowInteger(v)
  return out as T
}

/**
 * Coerce a knex binding to something `better-sqlite3` accepts (numbers, strings, bigints, buffers,
 * null). Mirrors what knex's own better-sqlite3 dialect does to bindings before it binds them —
 * needed here because `streamRows` bypasses knex's execution path (see its comment).
 */
function formatBinding(v: unknown): unknown {
  if (v instanceof Date) return v.valueOf()
  if (typeof v === 'boolean') return Number(v)
  if (v === undefined) return null
  return v
}

/**
 * SQLite introspection via `PRAGMA` table-valued functions and `sqlite_master` (spec §4 — there is
 * no `information_schema`). Deliberately not a copy-edit of either sibling adapter; what differs:
 *
 * - **No schemas, no server.** Everything is `main` in one file, so there's no search-path or
 *   database scoping — and, unlike Postgres' `pg_dump`, **no version skew is possible**: the SQLite
 *   that reads the file is the one bundled into `better-sqlite3`, which is also the one whose DDL
 *   and pragma output this code is written against.
 * - **`PRAGMA table_list` classifies objects properly.** `sqlite_master` reports a virtual table
 *   *and its shadow tables* as `type='table'` (verified: an `fts5` table contributes `ft`, plus
 *   `ft_config`/`ft_content`/`ft_data`/`ft_docsize`/`ft_idx`), which would put five internal tables
 *   into the dump. `table_list` labels those `virtual`/`shadow` and views `view`, so filtering on
 *   `type='table'` gets it right in one predicate.
 * - **`table_info` hides generated columns; `table_xinfo` doesn't.** But `SELECT *` *does* return
 *   them (verified for both STORED and VIRTUAL), so `getColumns` has to use `table_xinfo` or the
 *   streamed rows would carry columns the introspection never reported.
 * - **A single-column `INTEGER PRIMARY KEY` has no index at all** (it's the rowid alias), so it is
 *   absent from `PRAGMA index_list` — `getUniqueColumns` has to add the primary key separately.
 * - **Foreign keys need repair, not just reading**: `PRAGMA foreign_key_list` reports the parent
 *   column as NULL when the DDL referenced the parent implicitly, reports the parent's name with
 *   whatever casing the DDL used, and happily reports a parent table that doesn't exist. See
 *   `getForeignKeys`.
 */
export class SQLiteAdapter implements DbAdapter {
  /** Per-table single-column PK cache (introspected once per adapter lifetime). */
  private readonly pkCache = new Map<string, string>()
  /** Set by `withCancellation` per run; consulted per IN-chunk so Stop lands mid-call. */
  cancellationSignal?: AbortSignal
  /** Canonical (`sqlite_master`-cased) table name, keyed by lower-cased name. */
  private tableNames?: Promise<Map<string, string>>

  constructor(private readonly db: Knex) {}

  async ping(): Promise<void> {
    // Not `SELECT 1`: that answers without touching the file, so a wrong path or a non-database
    // file would still "pass". Reading `sqlite_master` forces SQLite to parse the schema.
    // (`better-sqlite3` also rejects a non-database file at open — verified: `file is not a
    // database` — and the pool opens lazily, so this call is what surfaces it.)
    await this.db.raw('SELECT COUNT(*) FROM sqlite_master')
  }

  async getTables(): Promise<string[]> {
    const rows = await this.db.raw<{ name: string }[]>(
      `SELECT name
         FROM pragma_table_list()
        WHERE schema = ? AND type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
      [MAIN_SCHEMA]
    )
    return rows.map((r) => r.name)
  }

  async getColumns(table: string): Promise<ColumnInfo[]> {
    await this.assertTableExists(table)
    const rows = await this.db.raw<
      { name: string; dataType: string; notNull: number; pk: number; hidden: number }[]
    >(
      `SELECT name, type AS dataType, "notnull" AS "notNull", pk, hidden
         FROM pragma_table_xinfo(?)
        ORDER BY cid`,
      [table]
    )
    return (
      rows
        .map(narrowRow)
        // Generated columns (hidden 2/3) are kept — they're in `SELECT *`, and the writer drops them
        // from the INSERT list via `getGeneratedColumns`. Only a virtual table's hidden columns are
        // dropped, since those never appear in a row.
        .filter((r) => r.hidden !== HIDDEN_VIRTUAL_TABLE_COLUMN)
        .map((r) => ({
          name: r.name,
          // Verbatim declared type — empty string for an untyped column, which is legal SQLite and
          // is reported honestly rather than guessed at.
          dataType: r.dataType,
          // Reported as SQLite reports it. Note a rowid alias (`INTEGER PRIMARY KEY`) says
          // `notnull = 0` even though it can never hold NULL, and conversely a rowid table's
          // *composite* PK columns genuinely do accept NULL — so neither is worth "correcting".
          nullable: r.notNull === 0,
          isPrimaryKey: r.pk > 0
        }))
    )
  }

  async getUniqueColumns(table: string): Promise<string[]> {
    const unique = new Set<string>()

    // The primary key first, and separately: a single-column `INTEGER PRIMARY KEY` is the rowid
    // alias and has **no entry in `index_list` at all** (verified), so reading indexes alone would
    // miss the most common unique column in any SQLite schema.
    const pks = (await this.getColumns(table)).filter((c) => c.isPrimaryKey)
    if (pks.length === 1) unique.add(pks[0].name)

    const indexes = await this.db.raw<{ name: string; unique: number; partial: number }[]>(
      `SELECT name, "unique", partial FROM pragma_index_list(?)`,
      [table]
    )
    const narrowedIndexes = indexes.map(narrowRow)
    for (const index of narrowedIndexes) {
      // `partial` excludes `CREATE UNIQUE INDEX … WHERE …`: that only constrains the matching
      // subset, so the column isn't globally unique.
      if (index.unique !== 1 || index.partial === 1) continue
      const cols = await this.db.raw<{ name: string | null }[]>(
        `SELECT name FROM pragma_index_info(?)`,
        [index.name]
      )
      // A single *key* column makes that column individually unique. An expression index reports
      // `name = NULL` (verified: `cid = -2`), which constrains no column on its own.
      if (cols.length === 1 && cols[0].name !== null) unique.add(cols[0].name)
    }
    return [...unique]
  }

  async getSequenceColumns(): Promise<string[]> {
    // Only Postgres needs this: `sqliteDumpDialect` has no `resetSequence`, because SQLite
    // self-heals (verified: an explicit `id = 500` moved `sqlite_sequence.seq` to 500 and the next
    // auto id was 501), so the pipeline never asks.
    return []
  }

  async getGeneratedColumns(table: string): Promise<string[]> {
    // `hidden` 2 = `GENERATED ALWAYS AS (…) VIRTUAL`, 3 = `… STORED`. Both must be left out of the
    // INSERT list (SQLite: `cannot INSERT into generated column`), and both are still present in
    // `SELECT *`, so the DDL and the anonymizer see them.
    const rows = await this.db.raw<{ name: string; hidden: number }[]>(
      `SELECT name, hidden FROM pragma_table_xinfo(?) ORDER BY cid`,
      [table]
    )
    return rows
      .map(narrowRow)
      .filter((r) => r.hidden === HIDDEN_GENERATED_VIRTUAL || r.hidden === HIDDEN_GENERATED_STORED)
      .map((r) => r.name)
  }

  async getExtensions(): Promise<ExtensionInfo[]> {
    // SQLite loads extensions into the *process*, not the database file — there is nothing a dump
    // could recreate ahead of the schema.
    return []
  }

  async getForeignKeys(): Promise<ForeignKeyRef[]> {
    // One `foreign_key_list` per table, joined in SQL via the table-valued pragma form. Scoped to
    // `table_list` (not `sqlite_master`) so an FTS shadow table can't contribute edges. A composite
    // FK yields one row per column pair, ordered by `seq`, matching what MySQL's
    // `key_column_usage` produces.
    const rows = await this.db.raw<
      { table: string; column: string; referencedTable: string; referencedColumn: string | null }[]
    >(
      `SELECT m.name    AS "table",
              f."from"  AS "column",
              f."table" AS "referencedTable",
              f."to"    AS "referencedColumn"
         FROM pragma_table_list() m
         JOIN pragma_foreign_key_list(m.name) f
        WHERE m.schema = ? AND m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
        ORDER BY m.name, f.id, f.seq`,
      [MAIN_SCHEMA]
    )

    const canonical = await this.canonicalTableNames()
    const out: ForeignKeyRef[] = []
    for (const r of rows) {
      // Identifiers are case-insensitive in SQLite, so the DDL may name the parent with different
      // casing than the table actually has (verified: `REFERENCES Categories(id)` against a table
      // created as `categories`). Everything downstream — the FK graph, the topological order, the
      // config model's bare-name keys — compares names exactly, so resolve to the real one.
      const referencedTable = canonical.get(r.referencedTable.toLowerCase())

      // **A parent that doesn't exist at all is legal in SQLite** — neither server dialect can
      // produce this. The reference is resolved only when DML runs with enforcement on (verified:
      // `CREATE TABLE … REFERENCES no_such_table(id)` succeeds, and the failure surfaces later as
      // `no such table: main.no_such_table`).
      //
      // The edge is **kept**, pointing at the name as written. That's what makes the rest of the
      // engine treat it like any other parent that isn't in the dump: `run.ts` puts it in
      // `absentParents`, so `stripForeignKeysTo` removes the reference from the emitted DDL and the
      // loaded database stays usable with FK enforcement back on. Dropping the edge instead would
      // leave the dangling `REFERENCES` in place and break the first INSERT into that table. Nothing
      // else trips over it: `topologicalOrder` ignores edges outside the table set, the cascade only
      // walks *from* tables that have a selection, and `backfillSelection` reports an `omitted`
      // target rather than querying it.
      if (!referencedTable && r.referencedColumn === null) {
        // The one unresolvable combination: no parent to read a primary key from, and no column named
        // in the DDL. Skipped rather than guessed at — every consumer needs a column name.
        continue
      }
      out.push({
        table: r.table,
        column: r.column,
        referencedTable: referencedTable ?? r.referencedTable,
        // NULL means the DDL referenced the parent without naming a column (`REFERENCES users`),
        // which SQLite resolves to the parent's primary key — so resolve it the same way. Verified
        // NULL in exactly that case.
        referencedColumn:
          r.referencedColumn ?? (await this.primaryKeyColumn(referencedTable as string))
      })
    }
    return out
  }

  /**
   * Table DDL straight out of `sqlite_master.sql` (spec §9 — the original `CREATE TABLE` text,
   * verbatim), plus the table's own `CREATE INDEX` statements.
   *
   * The indexes matter for parity: MySQL inlines them in `SHOW CREATE TABLE` and `pg_dump` emits
   * them alongside the table, so without this SQLite would be the one dialect whose dumps silently
   * lose every index. Auto-indexes (`sqlite_autoindex_*`, and any other row with `sql IS NULL`) are
   * skipped — they're created implicitly by the UNIQUE/PRIMARY KEY clauses already in the DDL.
   *
   * Triggers and views are **not** included, matching MySQL's `SHOW CREATE TABLE`.
   *
   * The stored text has no trailing semicolon, which the writer normalizes; a multi-statement blob
   * is fine there too (`pg_dump` output already is one).
   */
  async getCreateTableStatement(table: string): Promise<string> {
    const [row] = await this.db.raw<{ sql: string | null }[]>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [table]
    )
    if (!row?.sql) {
      throw new Error(`No CREATE TABLE statement found for "${table}" in sqlite_master.`)
    }
    const indexes = await this.db.raw<{ sql: string }[]>(
      `SELECT sql
         FROM sqlite_master
        WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
        ORDER BY name`,
      [table]
    )
    return [row.sql, ...indexes.map((i) => i.sql)].map((s) => s.trimEnd()).join(';\n')
  }

  // ── Data movement (extract) ──────────────────────────────────────────────────
  //
  // Every one of these narrows integers through `narrowInteger`/`narrowRow`. That is not optional —
  // see the `narrowInteger` doc comment for what breaks silently if one path skips it.

  async getColumnValues(table: string, columns: string[]): Promise<Record<string, unknown>[]> {
    const rows = (await this.db(table).select(columns)) as Record<string, unknown>[]
    return rows.map(narrowRow)
  }

  async selectRows(
    table: string,
    columns: string[],
    opts: SelectRowsOptions
  ): Promise<Record<string, unknown>[]> {
    const pk = await this.primaryKeyColumn(table)
    const q = applyFilter(this.db(table).select(columns), opts, pk)
    // `RANDOM()`, as Postgres — not MySQL's `RAND()`. Same full-scan caveat (spec §4).
    const rows = (await applyTake(q, opts.take, 'RANDOM()')) as Record<string, unknown>[]
    // Narrowed like every other read here: safe-integer mode hands back `bigint`s (see the
    // "Safe integers" glossary entry), and a `bigint` PK would never match a selection key.
    return rows.map(narrowRow)
  }

  async countRows(table: string, opts: SelectRowsOptions): Promise<number> {
    const pk = await this.primaryKeyColumn(table)
    // Safe-integer mode makes this a `bigint`; `narrowInteger` is the house rule for every read.
    const rows = (await applyFilter(this.db(table), opts, pk).count({ n: '*' })) as {
      n: number | bigint
    }[]
    return Number(narrowInteger(rows[0]?.n ?? 0))
  }

  async getRowsReferencing(
    childTable: string,
    fkColumn: string,
    parentIds: (string | number)[]
  ): Promise<{ childId: string | number; parentId: string | number }[]> {
    if (parentIds.length === 0) return []
    const childPk = await this.primaryKeyColumn(childTable)
    const out: { childId: string | number; parentId: string | number }[] = []
    for (let i = 0; i < parentIds.length; i += IN_CHUNK) {
      throwIfCancelled(this.cancellationSignal)
      const rows = (await this.db(childTable)
        .select({ childId: childPk, parentId: fkColumn })
        .whereIn(fkColumn, parentIds.slice(i, i + IN_CHUNK))) as {
        childId: string | number
        parentId: string | number
      }[]
      out.push(...rows.map(narrowRow))
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
      out.push(...rows.map(narrowRow))
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
      for (const row of (await query) as { parentId: unknown }[]) {
        out.add(narrowInteger(row.parentId) as string | number)
      }
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
      for (const row of (await query) as { parentId: unknown }[]) {
        out.add(narrowInteger(row.parentId) as string | number)
      }
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
        .whereIn(pk, ids.slice(i, i + IN_CHUNK))) as { id: unknown }[]
      out.push(...rows.map((r) => narrowInteger(r.id) as string | number))
    }
    return out
  }

  async getDistinctValues(table: string, column: string, limit: number): Promise<unknown[]> {
    const rows = (await this.db(table)
      .distinct({ value: column })
      .whereNotNull(column)
      .limit(limit)) as { value: unknown }[]
    return rows.map((r) => narrowInteger(r.value))
  }

  async sampleColumnValues(table: string, column: string, limit: number): Promise<unknown[]> {
    const rows = (await this.db(table)
      .select({ value: column })
      .whereNotNull(column)
      .limit(limit)) as { value: unknown }[]
    return rows.map((r) => narrowInteger(r.value))
  }

  /**
   * Stream a table's rows without ever holding the whole table (spec §9).
   *
   * **`knex.stream()` cannot be used here.** Its sqlite3 dialect — which the better-sqlite3 client
   * inherits — implements `_stream` as `statement.all()` followed by `rows.forEach(row =>
   * stream.write(row))`: the entire result set is materialized first, so the "stream" is a formality
   * and a large table would be buffered in memory. `better-sqlite3`'s own `iterate()` is a genuinely
   * lazy cursor, so the query is *built* with knex (identifier quoting, `whereIn` chunking, bindings)
   * and then executed against the pooled driver handle directly.
   *
   * The iterator holds the connection busy, so it's explicitly closed before the handle goes back to
   * the pool — otherwise abandoning iteration early would leave the next statement on that
   * connection failing with "This database connection is busy executing a query".
   */
  async *streamRows(table: string, where?: RowFilter): AsyncIterable<Row> {
    const query = applyRowFilter(this.db(table).select('*'), where)
    const { sql, bindings } = query.toSQL().toNative()

    const client = this.db.client as unknown as PoolClient
    const connection = await client.acquireConnection()
    let iterator: (IterableIterator<unknown> & { return?: () => unknown }) | undefined
    try {
      iterator = connection.prepare(sql).iterate(...bindings.map(formatBinding))
      for (const row of iterator) {
        yield narrowRow(row as Record<string, unknown>) as Row
      }
    } finally {
      iterator?.return?.()
      await client.releaseConnection(connection)
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /**
   * Real table names keyed by lower-cased name, cached for the adapter's lifetime. SQLite compares
   * identifiers case-insensitively, so this is what turns a name as *written in the DDL* into the
   * name every other layer uses.
   */
  private canonicalTableNames(): Promise<Map<string, string>> {
    this.tableNames ??= this.getTables().then(
      (names) => new Map(names.map((n) => [n.toLowerCase(), n]))
    )
    return this.tableNames
  }

  /**
   * Fail early and clearly when a table isn't there. `PRAGMA table_xinfo` on a missing table returns
   * an **empty result rather than an error**, which would otherwise surface much later as a table
   * with no columns and no primary key.
   */
  private async assertTableExists(table: string): Promise<void> {
    const canonical = await this.canonicalTableNames()
    if (!canonical.has(table.toLowerCase())) {
      throw new Error(`Table "${table}" was not found in the database.`)
    }
  }

  /**
   * The single-column primary key of a table, cached. Throws on a composite or missing PK, as the
   * other adapters do — the engine addresses rows by one id value (spec §4). Callers that must
   * tolerate it use `filterAddressable`, which turns the throw into a warning.
   *
   * A rowid fallback is deliberately *not* used for a PK-less table: `rowid` is absent from
   * `SELECT *`, so it would have to be selected specially and would still not survive a load
   * (nothing in the dump re-assigns it), and diverging from the sibling adapters here would make an
   * unaddressable table behave differently on SQLite than on MySQL for no gain in the dump.
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
