import knex, { type Knex } from 'knex'
import { types as pgTypes } from 'pg'
import type { Connection } from '@shared/types'
import { parseSearchPath } from './search-path'

/**
 * Postgres type OIDs we want back as the server's **own text**, not as parsed JS values, because
 * `node-pg`'s default parsing is either lossy or ambiguous for a dump:
 *
 * - `date`/`timestamp`/`timestamptz` parse to a JS `Date` in the *local* timezone. Verified: a
 *   `date` of `2026-07-25` came back as `2026-07-24T23:00:00Z` under BST, so re-serializing it
 *   silently shifted the value by a day. Verbatim text can't drift.
 * - `interval` parses to a plain object with no SQL rendering.
 * - `json`/`jsonb` parse to objects — and a json column holding a top-level array becomes a JS
 *   `Array`, indistinguishable from a real `int[]`/`text[]` column. One needs `[1,2]` and the
 *   other `{1,2}`, so guessing from the value is a coin flip. Keeping JSON as text means any
 *   remaining JS array is genuinely an array column.
 *
 * Everything else keeps pg's defaults, which are already dump-safe: `bigint`/`numeric` arrive as
 * strings (no float precision loss), `bytea` as a `Buffer`, `boolean` as a boolean.
 *
 * **Each type is listed with its array form.** The array parser recurses into the element parser, so
 * overriding only the scalar leaves `date[]`/`json[]`/… on pg's defaults and the corruption comes
 * straight back — verified before the fix: a `date[]` of `{2026-07-25,2026-01-01}` was emitted as
 * `{"2026-07-24T23:00:00.000Z",…}` (a day earlier), `interval[]` became an array of JSON objects,
 * and a `json[]` element of `[1,2]` turned into a *nested* `{{"1","2"}}` — a multidimensional array
 * literal that no longer matches the column. Add both OIDs, or neither.
 *
 * Array types whose elements pg already returns dump-safely (`text[]`, `numeric[]`, `uuid[]`,
 * `bool[]`, `int[]`, …) are deliberately absent: `pgArrayLiteral` renders those correctly.
 */
const PG_VERBATIM_TEXT_OIDS = new Set(
  [
    [1082, 1182], // date, date[]
    [1114, 1115], // timestamp, timestamp[]
    [1184, 1185], // timestamptz, timestamptz[]
    [1186, 1187], // interval, interval[]
    [114, 199], // json, json[]
    [3802, 3807] // jsonb, jsonb[]
  ].flat()
)

const identity = (v: string): string => v

/** `pg-types` narrows these to a builtins enum / `'text' | 'binary'`; knex's own
 * `PgGetTypeParser` (the type this object has to satisfy) widens them to `number`/`string`, so
 * delegating to pg's default parser needs a cast back down. */
type PgTypeParserArgs = Parameters<typeof pgTypes.getTypeParser>

/** Per-connection parser overrides — scoped to our pool, never a process-wide `setTypeParser`. */
const pgVerbatimTypes = {
  getTypeParser: (oid: number, format: string) =>
    PG_VERBATIM_TEXT_OIDS.has(oid)
      ? identity
      : pgTypes.getTypeParser(oid as PgTypeParserArgs[0], format as PgTypeParserArgs[1])
}

/**
 * Build a `knex` instance for a source/target connection. Only the dialect's execution
 * client is configured here — introspection lives in the per-dialect adapter (spec §4).
 *
 * The pool is deliberately small and allowed to drain to zero: these are short-lived,
 * per-operation handles (introspect / test), destroyed by the caller in a `finally`.
 * Password is passed in separately (it lives in the OS keychain, never on `Connection`).
 */
export function createKnex(connection: Connection, password?: string): Knex {
  const pool = { min: 0, max: 5 }
  /**
   * Server sources get a **read-only session** as soon as each pooled connection opens, so Masq's
   * "never writes to a source" holds at the database rather than only in our own SQL. That matters
   * because a selection rule's raw predicate is user text spliced into a query, and rules arrive in
   * imported workspaces too. Credentials with write access are still better avoided — this is the
   * backstop, not the recommendation.
   */
  const readOnlyPool = (statement: string): Knex.PoolConfig => ({
    ...pool,
    afterCreate: (
      conn: { query: (sql: string, cb: (err: Error | null) => void) => void },
      done: (err: Error | null, conn: unknown) => void
    ) => conn.query(statement, (err) => done(err, conn))
  })

  switch (connection.dialect) {
    case 'mysql':
      return knex({
        client: 'mysql2',
        connection: {
          host: connection.host,
          port: connection.port,
          user: connection.username,
          password,
          database: connection.database,
          /**
           * mysql2 defaults the connection charset to `UTF8_GENERAL_CI` — the 3-byte `utf8mb3`.
           * Over that connection the server transcodes a `utf8mb4` column on the way out, and any
           * character outside the BMP (an emoji, most obviously) arrives in Node already replaced
           * with `?`. The dump would then be faithfully written as `?`, with nothing downstream
           * able to tell it had ever been anything else. Reading as `utf8mb4` is what makes the
           * dump's own `SET NAMES utf8mb4` true end to end.
           */
          charset: 'utf8mb4',
          /**
           * Same stance as the Postgres OIDs above: nothing may round a value on the way in.
           * Left at mysql2's defaults, a BIGINT past 2^53 is decoded through a double
           * (`9007199254740993` → `…992`, so two PKs can merge into one selection entry), and a
           * DATETIME becomes a JS `Date`, which keeps only milliseconds and is re-rendered in the
           * machine's local zone. With these, unsafe integers arrive as exact strings (safe ones
           * stay numbers) and every date/time type arrives as the server's own text.
           */
          supportBigNumbers: true,
          dateStrings: true
        },
        pool: readOnlyPool('SET SESSION TRANSACTION READ ONLY')
      })

    case 'postgres':
      return knex({
        client: 'pg',
        connection: {
          host: connection.host,
          port: connection.port,
          user: connection.username,
          password,
          database: connection.database,
          types: pgVerbatimTypes
        },
        // Unlike MySQL, the database doesn't identify the schema — set the session search path
        // so unqualified table names in the extract queries resolve the way the app's own
        // queries do. Order matters; blank falls back to `public`. The username is passed so a
        // `$user` entry resolves to the role's own schema instead of being dropped.
        searchPath: parseSearchPath(connection.searchPath, connection.username),
        pool: readOnlyPool('SET default_transaction_read_only = on')
      })

    case 'sqlite':
      if (!connection.filePath) {
        throw new Error('This SQLite connection has no file path.')
      }
      return knex({
        client: 'better-sqlite3',
        connection: {
          filename: connection.filePath,
          options: {
            /**
             * **Read-only, deliberately.** Masq never writes to a source, and for a file-based
             * dialect that promise is enforceable rather than aspirational. It also removes a real
             * footgun: `better-sqlite3` **creates** an empty database when a read-write open finds
             * no file, so a mistyped path would leave a stray empty `.sqlite` behind and report a
             * successful connection test. Read-only fails cleanly instead (`unable to open database
             * file`), and a file that isn't a database fails at open (`file is not a database`).
             *
             * Verified this does *not* break WAL databases, the obvious worry: a read-only open
             * succeeded against a live WAL (writer attached), against an orphaned `-wal` left by a
             * dead writer, and even with the db + `-wal` mode 444 and no `-shm` present.
             */
            readonly: true,
            /**
             * Return every INTEGER as a `bigint` so an int64 is seen **exactly**. Off (the default),
             * `better-sqlite3` funnels integers through a double and
             * `9223372036854775807` reads back as `9223372036854776000` — silently, with nothing to
             * catch. `SQLiteAdapter` narrows each value straight back to a `number` where that is
             * lossless (see `narrowInteger`), so this costs nothing downstream.
             */
            safeIntegers: true
          }
        },
        // knex warns on every insert without this. Nothing here inserts into a source, but the
        // warning would be noise in the log either way.
        useNullAsDefault: true,
        // `better-sqlite3` is synchronous, so a pool buys no concurrency here — it's kept at the
        // shared size for **deadlock safety**: `streamRows` holds one connection for the length of a
        // table scan, and a single-member pool would make any introspection call issued during a
        // stream wait forever on the member the generator is holding.
        pool
      })

    // The MSSQL adapter lands in a later step (spec §13, step 10).
    default:
      throw new Error(
        `The ${connection.dialect} adapter isn't built yet — MySQL, Postgres and SQLite are the supported source dialects so far.`
      )
  }
}
