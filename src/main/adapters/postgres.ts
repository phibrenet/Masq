import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Knex } from 'knex'
import type { ColumnInfo, ForeignKeyRef, Row } from '@shared/types'
import { applyFilter, applyTake } from '../extract/conditions'
import { throwIfCancelled } from '../extract/cancel'
import { applyRowFilter, type RowFilter } from '../extract/row-filter'
import type { DbAdapter, ExtensionInfo, SelectRowsOptions } from './types'

const execFileAsync = promisify(execFile)

/** IN-clause chunk size for the id-set queries — keeps parameter counts well within limits. */
const IN_CHUNK = 1000

export interface PostgresAdapterOptions {
  /** Ordered schema list from the connection's search path (`parseSearchPath`). */
  schemas: string[]
  /** Connection details, needed to invoke `pg_dump` for table DDL. */
  host?: string
  port?: number
  database: string
  username?: string
  password?: string
}

/**
 * Postgres introspection over `pg_catalog`/`information_schema`, scoped to the connection's search
 * path. Deliberately *not* a copy of `MySQLAdapter`: almost every query differs.
 *
 * **Bare table names, resolved against the search path.** Masq keys its whole config model on an
 * unqualified table name, and `createKnex` sets the session `search_path`, so data-movement queries
 * resolve exactly the way the app's own queries do. Introspection can't rely on that — an
 * `information_schema` predicate needs a concrete schema — so a bare name is resolved to the *first*
 * schema on the path that contains it, mirroring Postgres' own resolution order, and cached.
 * A table of the same name in two schemas on the path is therefore reachable only as the first;
 * that ambiguity is inherent to the bare-name config model (see `.memory/state.md`).
 */
export class PostgresAdapter implements DbAdapter {
  /** Per-table resolved schema, and single-column PK — each introspected once per adapter. */
  private readonly schemaCache = new Map<string, string>()
  private readonly pkCache = new Map<string, string>()
  /** Set by `withCancellation` per run; consulted per IN-chunk so Stop lands mid-call. */
  cancellationSignal?: AbortSignal
  /** `pg_dump` preflight runs at most once, successful or not. */
  private pgDumpCheck?: Promise<void>

  constructor(
    private readonly db: Knex,
    private readonly options: PostgresAdapterOptions
  ) {}

  async ping(): Promise<void> {
    await this.db.raw('SELECT 1')
  }

  async getTables(): Promise<string[]> {
    // DISTINCT because the same name may exist in more than one schema on the path; the dump
    // addresses it by bare name, so it appears once. Partitioned tables and their partitions are
    // both reported as BASE TABLE (as in MySQL) — partitioning isn't specially handled.
    const { rows } = await this.db.raw<{ rows: { name: string }[] }>(
      `SELECT DISTINCT table_name AS name
         FROM information_schema.tables
        WHERE table_schema = ANY(?) AND table_type = 'BASE TABLE'
        ORDER BY name`,
      [this.options.schemas]
    )
    return rows.map((r) => r.name)
  }

  async getColumns(table: string): Promise<ColumnInfo[]> {
    const schema = await this.schemaOf(table)
    // `format_type` renders the native type text (`character varying(255)`, `numeric(12,2)`), the
    // closest analogue to MySQL's `column_type`. Reading from pg_attribute rather than
    // information_schema keeps the primary-key join cheap and handles dropped columns explicitly.
    const { rows } = await this.db.raw<{
      rows: { name: string; dataType: string; nullable: boolean; isPrimaryKey: boolean }[]
    }>(
      `SELECT a.attname                                AS name,
              format_type(a.atttypid, a.atttypmod)     AS "dataType",
              NOT a.attnotnull                         AS nullable,
              COALESCE(i.indisprimary, false)          AS "isPrimaryKey"
         FROM pg_attribute a
         JOIN pg_class     c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_index i
                ON i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)
        WHERE n.nspname = ? AND c.relname = ?
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, table]
    )
    return rows.map((r) => ({
      name: r.name,
      dataType: r.dataType,
      nullable: r.nullable,
      isPrimaryKey: r.isPrimaryKey
    }))
  }

  async getUniqueColumns(table: string): Promise<string[]> {
    const schema = await this.schemaOf(table)
    // Read from `pg_index`, not `information_schema.table_constraints`: the latter only knows about
    // named constraints and would miss a bare `CREATE UNIQUE INDEX`, which enforces uniqueness just
    // as hard and would fail the load if the anonymizer duplicated a value.
    //
    // `indnkeyatts = 1` counts *key* columns, so an index with extra INCLUDE columns still counts as
    // single-column. `indpred IS NULL` excludes partial indexes — those only constrain the matching
    // subset, so the column isn't globally unique. Expression indexes fall out naturally: their
    // `indkey[0]` is 0, which matches no `attnum`.
    const { rows } = await this.db.raw<{ rows: { name: string }[] }>(
      `SELECT DISTINCT a.attname AS name
         FROM pg_index     i
         JOIN pg_class     c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
        WHERE n.nspname = ? AND c.relname = ?
          AND (i.indisunique OR i.indisprimary)
          AND i.indnkeyatts = 1
          AND i.indpred IS NULL`,
      [schema, table]
    )
    return rows.map((r) => r.name)
  }

  async getSequenceColumns(table: string): Promise<string[]> {
    const schema = await this.schemaOf(table)
    // Covers both spellings: `serial` (a `nextval(...)` default) and `GENERATED … AS IDENTITY`.
    const { rows } = await this.db.raw<{ rows: { name: string }[] }>(
      `SELECT column_name AS name
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
          AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')
        ORDER BY ordinal_position`,
      [schema, table]
    )
    return rows.map((r) => r.name)
  }

  async getGeneratedColumns(table: string): Promise<string[]> {
    const schema = await this.schemaOf(table)
    // `is_generated = 'ALWAYS'` means `GENERATED ALWAYS AS (expr)` only. An identity column reports
    // `is_generated = 'NEVER'` (with `is_identity = 'YES'`), and an expression *default* is likewise
    // NEVER — so neither is wrongly dropped from the INSERT list.
    const { rows } = await this.db.raw<{ rows: { name: string }[] }>(
      `SELECT column_name AS name
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ? AND is_generated = 'ALWAYS'
        ORDER BY ordinal_position`,
      [schema, table]
    )
    return rows.map((r) => r.name)
  }

  async getExtensions(): Promise<ExtensionInfo[]> {
    // `plpgsql` is excluded: it lives in `pg_catalog` and is present in every database, so
    // recreating it is pointless (and `WITH SCHEMA pg_catalog` is a special case). Every other
    // installed extension is reported with the schema its objects live in — pg_dump omits these
    // entirely, so without this a schema using `vector`/`pg_trgm`/… produces an unloadable dump.
    const { rows } = await this.db.raw<{ rows: ExtensionInfo[] }>(
      `SELECT e.extname AS name, n.nspname AS schema
         FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname <> 'plpgsql'
        ORDER BY e.extname`
    )
    return rows.map((r) => ({ name: r.name, schema: r.schema }))
  }

  async getForeignKeys(): Promise<ForeignKeyRef[]> {
    // `information_schema.key_column_usage` has no referenced-table column in Postgres (unlike
    // MySQL), so this reads `pg_constraint` directly. `generate_subscripts` walks conkey/confkey in
    // step, emitting one row per column pair — so a composite FK yields several edges, matching the
    // per-column rows MySQL's `key_column_usage` produces.
    const { rows } = await this.db.raw<{
      rows: {
        table: string
        column: string
        referencedTable: string
        referencedColumn: string
      }[]
    }>(
      `SELECT c.relname   AS "table",
              a.attname   AS "column",
              fc.relname  AS "referencedTable",
              fa.attname  AS "referencedColumn"
         FROM pg_constraint con
         JOIN pg_class      c  ON c.oid  = con.conrelid
         JOIN pg_namespace  n  ON n.oid  = c.relnamespace
         JOIN pg_class      fc ON fc.oid = con.confrelid
         JOIN pg_namespace  fn ON fn.oid = fc.relnamespace
         JOIN LATERAL generate_subscripts(con.conkey, 1) AS s(i) ON true
         JOIN pg_attribute  a  ON a.attrelid  = con.conrelid  AND a.attnum  = con.conkey[s.i]
         JOIN pg_attribute  fa ON fa.attrelid = con.confrelid AND fa.attnum = con.confkey[s.i]
        WHERE con.contype = 'f'
          AND n.nspname  = ANY(?)
          AND fn.nspname = ANY(?)`,
      [this.options.schemas, this.options.schemas]
    )
    return rows.map((r) => ({
      table: r.table,
      column: r.column,
      referencedTable: r.referencedTable,
      referencedColumn: r.referencedColumn
    }))
  }

  /**
   * Table DDL via `pg_dump --schema-only` (spec §9 — hand-rolling Postgres DDL means partial
   * indexes, check constraints, sequences and custom types, so we shell out).
   *
   * Two things this has to clean up. `--no-owner --no-acl` drops `ALTER TABLE … OWNER TO`, which
   * would reference roles that don't exist on a dev machine. More importantly the output carries
   * session setup including `SELECT pg_catalog.set_config('search_path', '', false)` — which would
   * **wipe the search path the dump's own preamble just set** and break every bare-identifier INSERT
   * that follows it. So `SET`/`set_config`/comment lines are stripped, leaving just the DDL.
   */
  async getCreateTableStatement(table: string): Promise<string> {
    await this.ensurePgDumpUsable()
    const schema = await this.schemaOf(table)

    const args = [
      '--schema-only',
      '--no-owner',
      '--no-acl',
      `--table=${quoteIdent(schema)}.${quoteIdent(table)}`,
      '--dbname',
      this.options.database
    ]
    if (this.options.host) args.push('--host', this.options.host)
    if (this.options.port) args.push('--port', String(this.options.port))
    if (this.options.username) args.push('--username', this.options.username)

    let stdout: string
    try {
      ;({ stdout } = await execFileAsync('pg_dump', args, {
        env: pgEnv(this.options.password),
        maxBuffer: 32 * 1024 * 1024
      }))
    } catch (err) {
      const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message
      throw new Error(`pg_dump failed for "${schema}.${table}": ${detail}`)
    }

    const ddl = stripPgDumpSessionLines(stdout)
    if (!/CREATE TABLE/i.test(ddl)) {
      throw new Error(
        `pg_dump returned no CREATE TABLE for "${schema}.${table}" — the table may have been dropped mid-run.`
      )
    }
    return ddl
  }

  // ── Data movement (extract) ──────────────────────────────────────────────────
  //
  // These use bare table names on purpose: the session `search_path` set by `createKnex` resolves
  // them the same way the source application's own queries do.

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
    // `RANDOM()`, not MySQL's `RAND()`. Same full-scan caveat as the MySQL adapter (spec §4).
    return (await applyTake(q, opts.take, 'RANDOM()')) as Record<string, unknown>[]
  }

  async countRows(table: string, opts: SelectRowsOptions): Promise<number> {
    const pk = await this.primaryKeyColumn(table)
    // `count(*)` comes back from node-pg as a **string** (it's a bigint) — Number() is not optional.
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
    // knex delegates this to `pg-query-stream` (an explicit dependency for exactly this reason).
    const stream = query.stream()
    try {
      for await (const row of stream) {
        yield row as Row
      }
    } finally {
      stream.destroy()
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /** The first schema on the search path holding `table`, cached. */
  private async schemaOf(table: string): Promise<string> {
    const cached = this.schemaCache.get(table)
    if (cached) return cached

    const { rows } = await this.db.raw<{ rows: { schema: string }[] }>(
      `SELECT table_schema AS schema
         FROM information_schema.tables
        WHERE table_name = ? AND table_schema = ANY(?) AND table_type = 'BASE TABLE'`,
      [table, this.options.schemas]
    )
    // Order by the search path rather than by name — Postgres resolves an unqualified name against
    // the first schema on the path that has it, and introspection must agree with that.
    const found = this.options.schemas.find((s) => rows.some((r) => r.schema === s))
    if (!found) {
      throw new Error(
        `Table "${table}" was not found in the search path (${this.options.schemas.join(', ')}).`
      )
    }
    this.schemaCache.set(table, found)
    return found
  }

  /**
   * The single-column primary key of a table, cached. Throws on a composite or missing PK: id-based
   * sampling/cascade can't address a row by a single value without one. (Mirrors the MySQL adapter;
   * composite-PK support is a later enhancement — spec §4.)
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

  /**
   * Confirm `pg_dump` is present and new enough, once per adapter. Both failures are worth catching
   * up front with a clear message rather than as a cryptic spawn error on the first table:
   *
   * - `pg_dump` is an **external binary, not bundled with the app** — a packaged Masq has no
   *   guarantee the user installed the Postgres client tools.
   * - `pg_dump` **refuses to dump from a server newer than itself**, so a PG 17 server with PG 16
   *   client tools fails on every table.
   */
  private ensurePgDumpUsable(): Promise<void> {
    this.pgDumpCheck ??= this.checkPgDump()
    return this.pgDumpCheck
  }

  private async checkPgDump(): Promise<void> {
    let versionText: string
    try {
      ;({ stdout: versionText } = await execFileAsync('pg_dump', ['--version']))
    } catch {
      throw new Error(
        'pg_dump was not found on this machine. Postgres table DDL is produced by pg_dump, so the ' +
          'PostgreSQL client tools need to be installed and on PATH.'
      )
    }

    const clientMajor = majorVersion(versionText)
    const { rows } = await this.db.raw<{ rows: { v: string }[] }>('SHOW server_version')
    const serverMajor = majorVersion(rows[0]?.v ?? '')

    if (clientMajor !== undefined && serverMajor !== undefined && clientMajor < serverMajor) {
      throw new Error(
        `pg_dump ${clientMajor} is older than the server (PostgreSQL ${serverMajor}) and will refuse ` +
          `to dump from it. Install PostgreSQL client tools ${serverMajor} or newer.`
      )
    }
  }
}

/** First dotted number in a version string (`pg_dump (PostgreSQL) 16.14` → 16). */
function majorVersion(text: string): number | undefined {
  const match = text.match(/(\d+)(?:\.\d+)*/)
  return match ? Number(match[1]) : undefined
}

/**
 * Quote an identifier for a `pg_dump --table` pattern. Quoting is required, not cosmetic: an
 * unquoted mixed-case name would be folded to lower case and match nothing, and `*`/`?` in the
 * pattern are wildcards unless quoted.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** `pg_dump` reads the password from `PGPASSWORD`; omit the var entirely when there isn't one. */
function pgEnv(password?: string): NodeJS.ProcessEnv {
  return password ? { ...process.env, PGPASSWORD: password } : { ...process.env }
}

/**
 * Reduce `pg_dump --schema-only` output to just the DDL. Drops its session setup (`SET …`,
 * `SELECT pg_catalog.set_config(…)`), comment banners, and **psql meta-command lines**, then
 * collapses the blank runs those leave behind.
 *
 * Two of these matter beyond tidiness:
 *
 * - `SELECT pg_catalog.set_config('search_path','',false)` would wipe the search path the dump's own
 *   preamble sets, breaking every bare-identifier INSERT after it (see `getCreateTableStatement`).
 * - **Lines beginning with a backslash are psql meta-commands, not SQL.** Current `pg_dump` (16.10+ /
 *   17.6+, from the 2025 security fixes) brackets its output with `\restrict <token>` …
 *   `\unrestrict <token>`. Left in, they load fine under `psql` — which is why this went unnoticed
 *   at first — but Masq's deliverable is a *portable* `.sql` file (spec §9) that a developer may open
 *   in a GUI client or feed through a driver, and there `\restrict` is a syntax error. No SQL
 *   statement begins with a backslash, so dropping such lines is safe and covers future
 *   meta-commands too.
 */
export function stripPgDumpSessionLines(output: string): string {
  return output
    .split('\n')
    .filter(
      (line) =>
        !/^SET\s/i.test(line) &&
        !/^SELECT\s+pg_catalog\.set_config/i.test(line) &&
        !/^\\/.test(line) &&
        !/^--/.test(line)
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
