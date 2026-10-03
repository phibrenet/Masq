import { escape as mysqlEscape, escapeId as mysqlEscapeId } from 'mysql2'
import { escapeIdentifier as pgEscapeId, escapeLiteral as pgEscapeLiteral } from 'pg'
import type { ExtensionInfo } from '../adapters/types'

/**
 * Dialect-specific SQL fragments the dump writer needs (spec §9). Kept behind an interface so the
 * writer stays dialect-agnostic. Value/identifier escaping delegates to each driver's own routines
 * (mysql2's `escape`/`escapeId`, pg's `escapeLiteral`/`escapeIdentifier`) — the dump is literal SQL
 * text rather than parameter-bound queries, and reusing the driver's escaper beats hand-rolling one.
 */
export interface DumpDialect {
  /** Quote an identifier (table/column). */
  id(name: string): string
  /** Serialize a JS value to a SQL literal (`NULL`, number, quoted+escaped string, date, blob). */
  value(v: unknown): string
  /**
   * Statements emitted once at the top of every output file, before anything else. Postgres uses
   * it to create the target schema(s) and set the search path — the writer emits **bare** table
   * identifiers everywhere, so without this a dump taken from a non-`public` schema wouldn't
   * resolve on load. Undefined for MySQL, where the connected database already is the schema.
   */
  preamble?: string
  /**
   * Clause inserted between an INSERT's column list and `VALUES`. Postgres needs
   * `OVERRIDING SYSTEM VALUE` so a `GENERATED ALWAYS AS IDENTITY` column accepts the dumped value
   * instead of rejecting it (`cannot insert a non-DEFAULT value into column …`). Undefined for
   * MySQL, whose `AUTO_INCREMENT` columns take an explicit value happily.
   */
  insertModifier?: string
  /**
   * Session settings emitted before anything else in the file — the statements that tell the
   * loading client how to *read* everything that follows. Two things, both of which have produced
   * a dump that loads on one machine and not another:
   *
   * **Encoding.** A per-dialect constant, deliberately **not** read from the source database. The
   * dump is written by Node's `createWriteStream`, which encodes UTF-8 — so the bytes in the file
   * are UTF-8 whatever the source's own charset is. Echoing a `latin1` source back as
   * `SET NAMES latin1` would tell the loading client to read UTF-8 bytes as latin1 and mojibake
   * every non-ASCII value. The source's charset is already preserved where it belongs: the
   * per-table `DEFAULT CHARSET=…` clause rides along in the DDL.
   *
   * **Quoting.** MySQL decides whether `"x"` is an identifier or a string literal from the
   * session's `sql_mode`, and Postgres decides whether a backslash in a literal is an escape from
   * `standard_conforming_strings`. Both default differently across servers, so a file that says
   * nothing is read according to whatever the *importing* machine happens to be configured for.
   * Pinning them is what makes the file mean the same thing everywhere.
   *
   * Undefined for SQLite: its encoding is fixed when the database file is created, and it has no
   * session quoting mode a script could set.
   */
  sessionSettings?: string
  /**
   * Undoes what `sessionSettings` changed, emitted last. Only matters when the file is `source`d
   * into an interactive session that carries on afterwards — piping it to a client that then exits
   * would discard the session anyway — but leaving someone's `sql_mode` altered because they loaded
   * a dump is a surprise worth not causing. This is what `mysqldump` does.
   */
  sessionRestore?: string
  /**
   * Drop a table before its DDL recreates it, when the workspace asks for it
   * (`Workspace.dropExistingTables`). Emitted in reverse dependency order.
   */
  dropTable(table: string): string
  /** Statement to disable FK enforcement for the load (spec §9). */
  disableForeignKeys: string
  /** Statement to restore FK enforcement. */
  enableForeignKeys: string
  /** Empty a table before re-inserting, for re-runnable split data files. */
  truncate(table: string): string
  /**
   * Remove foreign-key constraints from a table's DDL when the parent table **isn't in the dump**.
   *
   * Without this, excluding a table that an included table references produces a dump that **cannot
   * load at all**: the DDL still carries `… REFERENCES <excluded>` and the load aborts with
   * `relation "…" does not exist`. Turning FK enforcement off doesn't help — this is DDL, not data.
   *
   * `absentTables` holds **bare, lower-cased** table names (no schema, no quotes), which is what
   * `bareTableName` produces from whatever form the dialect's DDL uses.
   *
   * Per-dialect because the DDL shape differs fundamentally: `pg_dump` emits each FK as its own
   * trailing `ALTER TABLE … ADD CONSTRAINT` statement, while `SHOW CREATE TABLE` inlines them as
   * comma-separated items *inside* the CREATE TABLE body — so MySQL also has to repair the dangling
   * comma left when the removed constraint was the last item.
   */
  stripForeignKeysTo(ddl: string, absentTables: Set<string>): string
  /**
   * Reset `table.column`'s sequence so the next INSERT doesn't collide with the loaded rows.
   * Emitted after the data section. **Omitted where the dialect self-heals:** MySQL's
   * `AUTO_INCREMENT` recovers from the highest inserted value on its own, so `mysqlDumpDialect`
   * leaves this undefined and the writer skips the section entirely.
   */
  resetSequence?(table: string, column: string): string
}

/**
 * A referenced table as it appears in DDL, reduced to a bare lower-cased name: `app.orgs`,
 * `"app"."orgs"`, `` `orgs` `` and `orgs` all become `orgs`. Comparing bare names is what lets one
 * `absentTables` set serve both dialects, and it matches how the rest of the config model keys
 * tables (see the bare-name note in `.memory/state.md`).
 */
export function bareTableName(reference: string): string {
  const last = reference.trim().split('.').pop() ?? reference
  return last
    .replace(/["`[\]]/g, '')
    .trim()
    .toLowerCase()
}

/**
 * MySQL: FK constraints are comma-separated items inside the CREATE TABLE body. Dropping one that
 * happens to be the **last** item leaves `…,\n) ENGINE=…`, which is a syntax error — so the dangling
 * comma has to be repaired afterwards.
 */
function mysqlStripForeignKeysTo(ddl: string, absentTables: Set<string>): string {
  if (absentTables.size === 0) return ddl
  const kept = ddl.split('\n').filter((line) => {
    const match = /^\s*CONSTRAINT\s+.*?\bFOREIGN KEY\b.*?\bREFERENCES\s+(`[^`]+`|[^\s(]+)/i.exec(
      line
    )
    return !match || !absentTables.has(bareTableName(match[1]))
  })
  // A comma directly before the body's closing paren can only be a leftover: a real column or
  // constraint always follows one.
  return kept.join('\n').replace(/,(\s*\n\s*\))/g, '$1')
}

/**
 * Postgres: `pg_dump` emits each FK as a standalone statement, so the whole statement goes. Matched
 * non-greedily and bounded by `[^;]` so it can never swallow the statement that follows — and
 * narrowed to `FOREIGN KEY` so the PRIMARY KEY constraint, which shares the
 * `ALTER TABLE … ADD CONSTRAINT` shape, is left alone.
 */
function postgresStripForeignKeysTo(ddl: string, absentTables: Set<string>): string {
  if (absentTables.size === 0) return ddl
  return ddl.replace(
    /ALTER TABLE(?:\s+ONLY)?\s[^;]*?\bADD CONSTRAINT\b[^;]*?\bFOREIGN KEY\b[^;]*?\bREFERENCES\s+([^\s(]+)[^;]*?;[ \t]*\n?/gi,
    (statement, reference: string) => (absentTables.has(bareTableName(reference)) ? '' : statement)
  )
}

export const mysqlDumpDialect: DumpDialect = {
  id: (name) => mysqlEscapeId(name),
  value: (v) => {
    // JSON columns come back from mysql2 as parsed objects/arrays. Passing those straight to
    // escape() produces SET-clause syntax (`` `k` = v ``) / `[object Object]`, corrupting the
    // INSERT — so serialize them to a JSON string literal first. Date and Buffer are objects too
    // but escape() handles them correctly (quoted datetime / `0x..` blob), so leave them alone.
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
      return mysqlEscape(JSON.stringify(v))
    }
    // mysql2's escape accepts a broad SqlValue union; a dump serializes arbitrary column values.
    return mysqlEscape(v as Parameters<typeof mysqlEscape>[0])
  },
  // `utf8mb4` rather than `utf8`: in MySQL 5.7 `utf8` is the 3-byte `utf8mb3` alias, which cannot
  // represent an emoji or any other astral-plane character. `SET NAMES` also sets the connection
  // collation, which is harmless here — nothing in a dump compares strings.
  //
  // The `sql_mode` line **adds** `NO_AUTO_VALUE_ON_ZERO` to whatever mode the session already has,
  // rather than replacing the mode outright.
  //
  // Replacing it was a real bug, reported from an import: an operator prepending `ANSI_QUOTES` to
  // the stream had it silently overwritten by this line, and the load then failed part-way — after
  // the DROPs had run. A dump has no business overriding a setting the person running it chose,
  // and it does not need to: Masq emits backticks everywhere, including in normalised DDL
  // (`toBacktickIdentifiers`), and **backticks are valid identifiers under every mode** —
  // `ANSI_QUOTES` *adds* `"` as a quote, it never removes the backtick. So nothing here depends on
  // the mode being cleared, and being additive costs nothing.
  //
  // `NO_AUTO_VALUE_ON_ZERO` is the one mode that is genuinely needed, and is what mysqldump pins
  // for the same reason: without it, inserting an explicit `0` into an AUTO_INCREMENT column makes
  // the server generate a fresh id instead of storing the zero, so a subset legitimately containing
  // a zero id comes back with a different one.
  //
  // `NO_BACKSLASH_ESCAPES` is the one mode that is **removed**, because the values depend on its
  // absence: `mysqlEscape` writes `O'Reilly` as `'O\'Reilly'`, which under that mode is a syntax
  // error (verified on 8.0), and a stored backslash would load doubled. Only that token goes; the
  // rest of the operator's mode, `ANSI_QUOTES` included, is kept, and the whole mode is restored at
  // the end.
  //
  // Done on a comma-wrapped copy so the token is matched whole wherever it sits in the list, then
  // the new mode is appended and the stray commas trimmed — which also covers an empty starting
  // mode, where a bare `CONCAT` would leave a leading comma that MySQL rejects.
  sessionSettings: [
    `SET NAMES ${mysqlEscape('utf8mb4')};`,
    'SET @MASQ_OLD_SQL_MODE = @@SESSION.sql_mode;',
    "SET SESSION sql_mode = TRIM(BOTH ',' FROM CONCAT(REPLACE(" +
      "CONCAT(',', @@SESSION.sql_mode, ','), ',NO_BACKSLASH_ESCAPES,', ','), " +
      "'NO_AUTO_VALUE_ON_ZERO'));"
  ].join('\n'),
  sessionRestore: 'SET SESSION sql_mode = @MASQ_OLD_SQL_MODE;',
  disableForeignKeys: 'SET FOREIGN_KEY_CHECKS=0;',
  enableForeignKeys: 'SET FOREIGN_KEY_CHECKS=1;',
  dropTable: (table) => `DROP TABLE IF EXISTS ${mysqlEscapeId(table)};`,
  truncate: (table) => `TRUNCATE TABLE ${mysqlEscapeId(table)};`,
  stripForeignKeysTo: mysqlStripForeignKeysTo
  // resetSequence intentionally absent — see the interface note.
}

/**
 * Build a Postgres array literal (`{a,b,NULL}`) from a JS array. `node-pg` returns array columns
 * as real JS arrays, and those must NOT be serialized as JSON — `[1,2]` has to become `{1,2}`, not
 * `[1,2]`. Elements are always double-quoted (verified: Postgres accepts `'{"1","2"}'::int[]`),
 * which sidesteps having to decide when quoting is required; `"` and `\` are backslash-escaped
 * inside, and an unquoted bare `NULL` is the array-input spelling of a null element.
 *
 * The caller passes the result through `escapeLiteral`, so this returns the *inner* text only.
 */
function pgArrayLiteral(arr: readonly unknown[]): string {
  const elements = arr.map((el) => {
    if (el === null || el === undefined) return 'NULL'
    if (Array.isArray(el)) return pgArrayLiteral(el)
    const text = Buffer.isBuffer(el)
      ? `\\x${el.toString('hex')}`
      : el instanceof Date
        ? el.toISOString()
        : typeof el === 'object'
          ? JSON.stringify(el)
          : String(el)
    return `"${text.replace(/(["\\])/g, '\\$1')}"`
  })
  return `{${elements.join(',')}}`
}

/**
 * Postgres dialect for a given search path and extension set. This is a factory rather than a
 * constant because the dump has to name the schema(s) it targets and recreate the extensions its
 * DDL depends on — both live-introspected. The writer emits bare identifiers (Masq's config model
 * keys everything on a bare table name), so the loaded file needs `search_path` set to the same
 * schemas the extract read from, and it needs them to exist. `pg_dump --schema-only` emits neither
 * a `CREATE SCHEMA`, a `CREATE EXTENSION`, nor a `search_path` for a single-table dump, so all three
 * belong here.
 *
 * Preamble order is load-bearing: schemas first (an extension's target schema must exist before it
 * is created), then extensions (their types/operators must exist before the table DDL that uses
 * them), then `search_path`. Each extension is created `WITH SCHEMA` the schema it lived in on the
 * source, because the pg_dump'd DDL references its types schema-qualified (`resconx_staging.vector`)
 * — recreating it anywhere else would leave that type unresolved.
 *
 * `public` and `pg_catalog` are never issued as `CREATE SCHEMA` — they exist in every database and
 * `CREATE SCHEMA IF NOT EXISTS public` can trip on ownership.
 */
export function createPostgresDumpDialect(
  schemas: string[],
  extensions: ExtensionInfo[] = []
): DumpDialect {
  const BUILTIN_SCHEMAS = new Set(['public', 'pg_catalog'])

  // Union of the search-path schemas and any schema an extension lives in, so an extension in a
  // schema off the search path still has its schema created. Order: search path first, then extras.
  const schemasToCreate: string[] = []
  for (const s of [...schemas, ...extensions.map((e) => e.schema)]) {
    if (!BUILTIN_SCHEMAS.has(s) && !schemasToCreate.includes(s)) schemasToCreate.push(s)
  }

  const createSchemas = schemasToCreate.map((s) => `CREATE SCHEMA IF NOT EXISTS ${pgEscapeId(s)};`)
  const createExtensions = extensions.map(
    (e) =>
      `CREATE EXTENSION IF NOT EXISTS ${pgEscapeId(e.name)} WITH SCHEMA ${pgEscapeId(e.schema)};`
  )
  const setSearchPath = `SET search_path TO ${schemas.map((s) => pgEscapeId(s)).join(', ')};`

  const preamble = [...createSchemas, ...createExtensions, setSearchPath].join('\n')

  return { ...postgresDumpDialectBase, preamble }
}

const postgresDumpDialectBase: DumpDialect = {
  id: (name) => pgEscapeId(name),

  // Emitted on every INSERT rather than only for tables that have an identity column, so it can't
  // be missed for one. Verified harmless where there's nothing to override: a `GENERATED BY DEFAULT
  // AS IDENTITY` column, a plain `serial` PK, and a table with no sequence or identity at all all
  // accept it without complaint. (Requires PG 10+, which is also where identity columns arrived.)
  insertModifier: 'OVERRIDING SYSTEM VALUE',

  value: (v) => {
    if (v === null || v === undefined) return 'NULL'
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
    if (typeof v === 'bigint') return v.toString()
    if (typeof v === 'number') {
      // NaN/±Infinity have no bare numeric literal. A quoted, uncast literal coerces to whatever
      // the target column is (both float8 and numeric accept these spellings).
      return Number.isFinite(v) ? String(v) : pgEscapeLiteral(String(v))
    }
    // bytea: hex input format. escapeLiteral emits the E'' form for the backslash, which unescapes
    // back to `\xdeadbeef` on load.
    if (Buffer.isBuffer(v)) return pgEscapeLiteral(`\\x${v.toString('hex')}`)
    // Dates shouldn't normally reach here — `createKnex` makes Postgres return date/timestamp
    // columns as verbatim server text so they can't be shifted by a local-timezone round-trip.
    // Kept as a defensive branch; ISO-8601 is unambiguous.
    if (v instanceof Date) return pgEscapeLiteral(v.toISOString())
    if (Array.isArray(v)) return pgEscapeLiteral(pgArrayLiteral(v))
    // Any remaining object is a composite/range/unknown type; JSON is the least-wrong rendering.
    // json/jsonb columns arrive as verbatim text (see `createKnex`), not objects, so they don't
    // collide with the array branch above.
    if (typeof v === 'object') return pgEscapeLiteral(JSON.stringify(v))
    return pgEscapeLiteral(String(v))
  },

  // Postgres has no session-level FK switch, but `session_replication_role = replica` suppresses
  // the FK *triggers* — verified to let an orphan INSERT through and to reject it again once reset.
  // This is what `pg_dump --disable-triggers` emits. It needs superuser (or an equivalent grant),
  // which is a fair ask for loading a dump into a local dev database.
  disableForeignKeys: 'SET session_replication_role = replica;',
  enableForeignKeys: 'SET session_replication_role = origin;',

  // What `pg_dump` emits, for the same reasons.
  //
  // `client_encoding` describes the encoding of the file, not of the source database. `UTF8` is
  // Postgres's own spelling — not `UTF-8`.
  //
  // `standard_conforming_strings = on` is the quoting half, and Postgres's counterpart to MySQL's
  // `sql_mode`. With it off, a backslash inside an ordinary `'…'` literal is an escape character,
  // so a value containing `\n` or `\\` loads as something other than what was dumped. `escapeLiteral`
  // already emits the `E'…'` form where it needs to, which is correct under either setting — but
  // the DDL captured from `pg_dump` contains literals Masq never wrote, and those are only safe
  // under the setting pg_dump assumed. Identifier quoting needs no equivalent: `"x"` is the
  // standard spelling and Postgres has no mode that changes it.
  sessionSettings: [
    `SET client_encoding = ${pgEscapeLiteral('UTF8')};`,
    'SET standard_conforming_strings = on;'
  ].join('\n'),

  // CASCADE because a dropped table may be referenced by an FK, or by a view, from a table outside
  // the dump set; without it the DROP fails and the CREATE that follows fails too. Unlike the
  // TRUNCATE below, this cascade does not delete rows — it drops the dependent constraint or view.
  dropTable: (table) => `DROP TABLE IF EXISTS ${pgEscapeId(table)} CASCADE;`,

  // CASCADE is mandatory, not defensive: Postgres refuses to truncate a table that is referenced by
  // an FK *even when the referencing table is empty* — verified — and `session_replication_role`
  // does not relax it. Since the writer truncates every table in the dump anyway, the cascade is a
  // no-op within the dump set. It can however reach a referencing table *outside* the dump set.
  truncate: (table) => `TRUNCATE TABLE ${pgEscapeId(table)} CASCADE;`,

  /**
   * `pg_get_serial_sequence` takes the table as *text* holding a (quoted) identifier — so the name
   * is quoted and then escaped as a literal, or a mixed-case table would silently fold to lowercase
   * and fail. Its column argument, by contrast, must be the **raw** name: `'"Id"'` errors where
   * `'Id'` works (both verified).
   *
   * `COALESCE(MAX(col), 1)` with `MAX(col) IS NOT NULL` as `is_called` handles an empty table —
   * routine here, since a subset can legitimately select zero rows from a table. Passing `MAX(col)`
   * straight through (the usual hand-written form) makes `setval` a silent no-op in that case,
   * leaving the sequence at whatever it was.
   *
   * **Only call this for a genuinely sequence-backed column** (`getSequenceColumns`). It is *not*
   * self-guarding: while `pg_get_serial_sequence` returns NULL for a non-sequence column and
   * `setval` is strict, `MAX(col)` is still resolved when the statement is parsed, and a type such
   * as `uuid` has no `max()` overload — so the statement fails outright (verified: `ERROR: function
   * max(uuid) does not exist`). No runtime guard can avoid that, since it's a parse-time failure.
   */
  resetSequence: (table, column) => {
    const col = pgEscapeId(column)
    return (
      `SELECT pg_catalog.setval(` +
      `pg_get_serial_sequence(${pgEscapeLiteral(pgEscapeId(table))}, ${pgEscapeLiteral(column)}), ` +
      `COALESCE(MAX(${col}), 1), MAX(${col}) IS NOT NULL) FROM ${pgEscapeId(table)};`
    )
  },
  stripForeignKeysTo: postgresStripForeignKeysTo
}

// ── SQLite ────────────────────────────────────────────────────────────────────

/**
 * An identifier as it can appear after `REFERENCES` in SQLite DDL. Unlike the other two dialects,
 * this text is **whatever the author typed** — `sqlite_master.sql` is stored verbatim, not
 * regenerated — so every quoting style SQLite accepts has to be recognised.
 */
const SQLITE_REF_NAME = '(?:"[^"]*"|`[^`]*`|\\[[^\\]]*\\]|\'[^\']*\'|[A-Za-z_][\\w$]*)'
/** A parenthesised column list. Column lists never nest, so `[^)]*` is exact. */
const SQLITE_COL_LIST = '(?:\\s*\\([^)]*\\))?'
/** The optional trailing clauses of a foreign-key definition, in any order and number. */
const SQLITE_FK_ACTIONS =
  '(?:\\s+(?:ON\\s+(?:DELETE|UPDATE)\\s+' +
  '(?:SET\\s+NULL|SET\\s+DEFAULT|CASCADE|RESTRICT|NO\\s+ACTION)' +
  '|MATCH\\s+\\w+' +
  '|(?:NOT\\s+)?DEFERRABLE(?:\\s+INITIALLY\\s+(?:DEFERRED|IMMEDIATE))?))*'

/** Table-level: `[CONSTRAINT x] FOREIGN KEY (cols) REFERENCES parent[(cols)] [actions]`. */
const SQLITE_TABLE_FK = new RegExp(
  `(?:,\\s*)?(?:CONSTRAINT\\s+${SQLITE_REF_NAME}\\s+)?FOREIGN\\s+KEY\\s*\\([^)]*\\)` +
    `\\s*REFERENCES\\s+(${SQLITE_REF_NAME})${SQLITE_COL_LIST}${SQLITE_FK_ACTIONS}`,
  'gi'
)
/** Column-level: `col TYPE REFERENCES parent[(cols)] [actions]` — only the reference part goes. */
const SQLITE_COLUMN_FK = new RegExp(
  `\\s*REFERENCES\\s+(${SQLITE_REF_NAME})${SQLITE_COL_LIST}${SQLITE_FK_ACTIONS}`,
  'gi'
)

/** Whether every `(` in `text` has a matching `)` — a cheap "did the edit damage the DDL" proxy. */
function parensBalanced(text: string): boolean {
  let depth = 0
  for (const ch of text) {
    if (ch === '(') depth++
    else if (ch === ')' && --depth < 0) return false
  }
  return depth === 0
}

/**
 * SQLite: drop foreign-key definitions whose parent table isn't in the dump.
 *
 * **Not needed for loadability** — unlike the server dialects. SQLite resolves an FK's parent lazily,
 * when DML runs with enforcement on, so `CREATE TABLE t (x REFERENCES gone(id))` is accepted against
 * a database where `gone` doesn't exist (verified). What it's needed for is the *usability of the
 * loaded database*: with `PRAGMA foreign_keys = ON` — which `better-sqlite3` and many tools set by
 * default — every INSERT into that table then fails with `no such table: main.gone` (also verified).
 * A developer would hit that the first time they used their fresh local copy.
 *
 * Two shapes, and neither is line-oriented the way MySQL's is: SQLite stores the DDL exactly as
 * written, and generated schemas routinely put the whole `CREATE TABLE` on one line (Laravel's
 * sqlite migrations do). So the table-level clause and the column-level `REFERENCES` are matched as
 * inline fragments, table-level first (its `REFERENCES` would otherwise be caught by the
 * column-level pattern, leaving a stray `FOREIGN KEY (…)` behind).
 *
 * The edit is **fail-open**: SQLite DDL is free text, so a `REFERENCES` inside a string default or a
 * CHECK expression could in principle be matched. If the result is no longer a balanced
 * `CREATE TABLE`, the original DDL is returned untouched — leaving the load working, with the FK
 * caveat above, rather than emitting mangled SQL.
 */
function sqliteStripForeignKeysTo(ddl: string, absentTables: Set<string>): string {
  if (absentTables.size === 0) return ddl

  const absent = (reference: string): boolean => absentTables.has(bareTableName(reference))
  let out = ddl.replace(SQLITE_TABLE_FK, (clause, ref: string) => (absent(ref) ? '' : clause))
  out = out.replace(SQLITE_COLUMN_FK, (clause, ref: string) => (absent(ref) ? '' : clause))
  if (out === ddl) return ddl

  // Repair the separators the removal can leave behind: a doubled comma, or one now adjacent to the
  // body's opening or closing paren. Only reachable when a clause was actually removed.
  out = out
    .replace(/,(\s*,)+/g, ',')
    .replace(/\(\s*,/g, '(')
    .replace(/,(\s*\n?\s*\))/g, '$1')

  return /CREATE\s+TABLE/i.test(out) && parensBalanced(out) ? out : ddl
}

/**
 * SQLite text literal. Only `'` needs escaping (by doubling) — newlines, tabs and backslashes are
 * literal, verified against SQLite's own `quote()`. A NUL byte is the one character a text literal
 * cannot carry (SQLite's `quote()` truncates there), so such a string is emitted as a blob cast back
 * to text, which round-trips exactly.
 */
function sqliteTextLiteral(text: string): string {
  if (text.includes('\u0000')) {
    return `CAST(X'${Buffer.from(text, 'utf8').toString('hex')}' AS TEXT)`
  }
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * SQLite dialect. No preamble (one file, one schema — nothing to create), no `insertModifier`, and
 * no `resetSequence`: SQLite self-heals like MySQL, since inserting an explicit rowid advances
 * `sqlite_sequence` for an `AUTOINCREMENT` table (verified — an explicit `id = 500` left the next
 * auto id at 501).
 */
export const sqliteDumpDialect: DumpDialect = {
  // SQLite accepts several quoting styles; double quotes are the standard one. An embedded `"` is
  // escaped by doubling.
  id: (name) => `"${name.replace(/"/g, '""')}"`,

  value: (v) => {
    if (v === null || v === undefined) return 'NULL'
    // SQLite has no boolean storage class — booleans are 1/0, which is also what its own `TRUE`
    // and `FALSE` keywords evaluate to.
    if (typeof v === 'boolean') return v ? '1' : '0'
    // Exact digits. Defensive: the adapter opens the connection with safe integers and already hands
    // back anything beyond ±2^53 as a decimal string.
    if (typeof v === 'bigint') return v.toString()
    if (typeof v === 'number') {
      // NaN and ±Infinity have no SQLite literal, and SQLite stores them as NULL itself (verified:
      // inserting `Infinity` reads back as null, and the literal `9e999` is null too). Emitting NULL
      // is therefore not a lossy choice — it's the same value the source column holds.
      return Number.isFinite(v) ? String(v) : 'NULL'
    }
    // Blob literal. Verified byte-exact: `X'0001ff0a'` compares equal to the stored blob.
    if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`
    // SQLite has no date type, so the driver never produces a `Date` — this is defensive. ISO-8601
    // text is SQLite's own recommended date encoding and what its date functions accept.
    if (v instanceof Date) return sqliteTextLiteral(v.toISOString())
    // Arrays and objects only reach here from an anonymizer template on a JSON-in-text column;
    // SQLite's `json` functions read exactly this representation.
    if (typeof v === 'object') return sqliteTextLiteral(JSON.stringify(v))
    return sqliteTextLiteral(String(v))
  },

  // SQLite's own default is OFF, but tools differ (`better-sqlite3` turns it ON), so the dump states
  // it either way. Note this pragma is a **no-op inside a transaction** — the writer emits no
  // BEGIN/COMMIT, so a dump loaded with `sqlite3 db < dump.sql` gets the intended behaviour.
  disableForeignKeys: 'PRAGMA foreign_keys = OFF;',
  enableForeignKeys: 'PRAGMA foreign_keys = ON;',

  // `sessionSettings` intentionally absent — see the interface note. `PRAGMA encoding` is a no-op
  // once a database file exists, and SQLite has no session quoting mode: it accepts `"x"`,
  // `` `x` `` and `[x]` as identifiers regardless, and Masq emits the standard double-quoted form.

  dropTable: (table) => `DROP TABLE IF EXISTS "${table.replace(/"/g, '""')}";`,

  // No TRUNCATE in SQLite. An unqualified `DELETE FROM t` hits SQLite's own truncate optimization
  // (the whole-table drop), so this is the direct equivalent rather than a slower fallback.
  truncate: (table) => `DELETE FROM "${table.replace(/"/g, '""')}";`,

  stripForeignKeysTo: sqliteStripForeignKeysTo
}
