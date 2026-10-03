import { PassThrough, Writable } from 'stream'
import { describe, expect, it } from 'vitest'
import type { Row } from '@shared/types'
import {
  createPostgresDumpDialect,
  mysqlDumpDialect,
  sqliteDumpDialect
} from '../../src/main/extract/dump-dialect'
import {
  writeCombinedDump,
  writeSplitDump,
  type DumpPlan,
  type DumpTable
} from '../../src/main/extract/dump-writer'

/**
 * Dump writer output shape — specifically the two things a dump needs before it will load a second
 * time into the same database: `DROP TABLE IF EXISTS` ahead of the DDL, and an encoding declaration
 * that matches the bytes the file is actually written in.
 *
 * Asserted against the text of the whole file rather than by mocking the dialect: the ordering
 * between the sections is the part that is easy to break, and it only exists in the assembled file.
 */

function collect(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough()
  const chunks: Buffer[] = []
  stream.on('data', (c: Buffer) => chunks.push(c))
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') }
}

async function rows(...values: Row[]): Promise<AsyncIterable<Row>> {
  return (async function* () {
    yield* values
  })()
}

/** Two tables in dependency order: `orders` references `users`. */
async function fixture(): Promise<DumpTable[]> {
  return [
    {
      table: 'users',
      ddl: 'CREATE TABLE `users` (`id` int, `email` varchar(255))',
      columns: ['id', 'email'],
      rows: await rows({ id: 1, email: 'a@example.com' })
    },
    {
      table: 'orders',
      ddl: 'CREATE TABLE `orders` (`id` int, `user_id` int)',
      columns: ['id', 'user_id'],
      rows: await rows({ id: 9, user_id: 1 })
    }
  ]
}

async function combined(plan: Omit<DumpPlan, 'tables'>): Promise<string> {
  const { stream, text } = collect()
  await writeCombinedDump(stream, { ...plan, tables: await fixture() })
  return text()
}

describe('drop-existing-tables', () => {
  it('puts each drop immediately before its own CREATE, not in a block up front', async () => {
    // Blast radius, learned from a failed import. MySQL commits every DDL statement as it runs and
    // cannot roll them back, so a file that drops all 77 tables and then fails on the first CREATE
    // leaves an empty database. Interleaved, that same failure costs exactly one table.
    const sql = await combined({ dialect: mysqlDumpDialect, dropExistingTables: true })

    expect(sql).toContain('DROP TABLE IF EXISTS `users`;\nCREATE TABLE `users`')
    expect(sql).toContain('DROP TABLE IF EXISTS `orders`;\nCREATE TABLE `orders`')
    // The parent's CREATE lands before the child's DROP — i.e. they really are interleaved rather
    // than two blocks that happen to contain the right statements.
    expect(sql.indexOf('CREATE TABLE `users`')).toBeLessThan(
      sql.indexOf('DROP TABLE IF EXISTS `orders`')
    )
  })

  it('keeps the drops in dependency order, so a child is dropped after its parent is rebuilt', async () => {
    // Dependency order is what makes interleaving safe for a Postgres `DROP … CASCADE`: a cascade
    // can only reach a table that has not been created yet.
    const sql = await combined({ dialect: mysqlDumpDialect, dropExistingTables: true })

    expect(sql.indexOf('DROP TABLE IF EXISTS `users`')).toBeLessThan(
      sql.indexOf('DROP TABLE IF EXISTS `orders`')
    )
  })

  it('emits nothing when the workspace has it off', async () => {
    expect(await combined({ dialect: mysqlDumpDialect, dropExistingTables: false })).not.toContain(
      'DROP TABLE'
    )
    // Absent reads the same as off, so a caller that predates the option is unaffected.
    expect(await combined({ dialect: mysqlDumpDialect })).not.toContain('DROP TABLE')
  })

  it('puts the drops in the schema file of a split dump, not the data file', async () => {
    const schema = collect()
    const data = collect()
    await writeSplitDump(schema.stream, data.stream, {
      tables: await fixture(),
      dialect: mysqlDumpDialect,
      dropExistingTables: true
    })

    expect(schema.text()).toContain('DROP TABLE IF EXISTS `orders`;')
    // The data file re-runs against a schema that already exists; dropping there would take the
    // tables out from under it. TRUNCATE is its equivalent and is already emitted.
    expect(data.text()).not.toContain('DROP TABLE')
    expect(data.text()).toContain('TRUNCATE TABLE `orders`;')
  })

  it('leaves the schema file untouched when dropping is off', async () => {
    const schema = collect()
    const data = collect()
    await writeSplitDump(schema.stream, data.stream, {
      tables: await fixture(),
      dialect: mysqlDumpDialect
    })

    // No drops means no FK toggle either: tables arrive in dependency order, so there is nothing
    // to suppress and the schema file stays pure DDL.
    expect(schema.text()).not.toContain('FOREIGN_KEY_CHECKS')
  })

  it('cascades the drop on Postgres, where a dependent view or FK would otherwise refuse it', async () => {
    const sql = await combined({
      dialect: createPostgresDumpDialect(['public']),
      dropExistingTables: true
    })

    expect(sql).toContain('DROP TABLE IF EXISTS "orders" CASCADE;')
  })
})

describe('quoting — the contract that makes a dump load on a different machine', () => {
  it('quotes MySQL identifiers with backticks and never double quotes', async () => {
    // Double quotes are identifiers only under `ANSI_QUOTES`; to any other MySQL they are string
    // literals, so `CREATE TABLE "users"` is a syntax error. Backticks work under both.
    const sql = await combined({ dialect: mysqlDumpDialect })

    expect(sql).toContain('INSERT INTO `users` (`id`, `email`)')
    // Only single-quoted values should carry quotes at all; no identifier may be double-quoted.
    expect(sql).not.toMatch(/(?:INSERT INTO|CREATE TABLE|DROP TABLE IF EXISTS)\s+"/)
  })

  it("adds to the sql_mode instead of replacing it, so it cannot clobber the operator's", async () => {
    // Replacing it was a reported bug: someone prepending `ANSI_QUOTES` to the stream had it
    // silently overwritten, and the load then failed after the DROPs had already run. Nothing in
    // the file needs the mode cleared — backticks are valid identifiers under every mode.
    const sql = await combined({ dialect: mysqlDumpDialect })

    expect(sql).toContain("CONCAT(',', @@SESSION.sql_mode, ',')")
    expect(sql).toContain("'NO_AUTO_VALUE_ON_ZERO'")
    expect(sql).not.toContain("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO';")
  })

  it('removes only NO_BACKSLASH_ESCAPES, which the escaped values cannot load under', async () => {
    // `O'Reilly` is written `'O\\'Reilly'`; with that mode on it is a syntax error.
    const sql = await combined({ dialect: mysqlDumpDialect })

    expect(sql).toContain("',NO_BACKSLASH_ESCAPES,', ','")
  })

  it('restores the sql_mode it changed, and does so after the FK toggle', async () => {
    const sql = await combined({ dialect: mysqlDumpDialect })

    expect(sql).toContain('SET @MASQ_OLD_SQL_MODE = @@SESSION.sql_mode;')
    expect(sql.trimEnd().endsWith('SET SESSION sql_mode = @MASQ_OLD_SQL_MODE;')).toBe(true)
    expect(sql.indexOf('SET FOREIGN_KEY_CHECKS=1;')).toBeLessThan(
      sql.indexOf('SET SESSION sql_mode = @MASQ_OLD_SQL_MODE;')
    )
  })

  it('quotes Postgres identifiers with double quotes and pins string conformance', async () => {
    // The opposite convention, and the standard one — Postgres has no mode that changes it, so
    // only the literal-escaping rule needs stating.
    const sql = await combined({ dialect: createPostgresDumpDialect(['public']) })

    expect(sql).toContain('INSERT INTO "users" ("id", "email")')
    expect(sql).toContain('SET standard_conforming_strings = on;')
    // No sql_mode anywhere: it is MySQL-only, and emitting it would break the load outright.
    expect(sql).not.toContain('sql_mode')
  })

  it('leaves SQLite without any session mode statements', async () => {
    // SQLite accepts every quoting style and has no session mode a script could set.
    const sql = await combined({ dialect: sqliteDumpDialect })

    expect(sql).toContain('INSERT INTO "users" ("id", "email")')
    expect(sql).not.toContain('sql_mode')
    expect(sql).not.toContain('standard_conforming_strings')
  })
})

describe('encoding declaration', () => {
  it('declares the file encoding, not the source database charset', async () => {
    // UTF-8 because that is what `createWriteStream` writes, whatever the source's own charset is.
    expect(await combined({ dialect: mysqlDumpDialect })).toContain("SET NAMES 'utf8mb4';")
    expect(await combined({ dialect: createPostgresDumpDialect(['public']) })).toContain(
      "SET client_encoding = 'UTF8';"
    )
  })

  it('comes before the preamble, which is itself SQL that has to be decoded', async () => {
    const sql = await combined({ dialect: createPostgresDumpDialect(['app']) })

    expect(sql.indexOf('SET client_encoding')).toBeLessThan(sql.indexOf('CREATE SCHEMA'))
    expect(sql.indexOf('SET client_encoding')).toBeLessThan(sql.indexOf('SET search_path'))
  })

  it('omits it for SQLite, whose encoding is fixed when the file is created', async () => {
    const sql = await combined({ dialect: sqliteDumpDialect })

    expect(sql).not.toContain('encoding')
    expect(sql).not.toContain('SET NAMES')
  })

  it('appears in both files of a split dump', async () => {
    const schema = collect()
    const data = collect()
    await writeSplitDump(schema.stream, data.stream, {
      tables: await fixture(),
      dialect: mysqlDumpDialect
    })

    // The data file is loaded on its own, so it cannot rely on the schema file having set this.
    expect(schema.text()).toContain("SET NAMES 'utf8mb4';")
    expect(data.text()).toContain("SET NAMES 'utf8mb4';")
  })
})

describe('stream errors', () => {
  it('rejects the writer, rather than crashing the process, when the file errors between rows', async () => {
    // A file stream reports a full disk as an `error` event. If that fires while the writer is
    // waiting on a slow source row, nothing is listening, and Node throws it at the top level.
    const out = new Writable({ write: (_chunk, _enc, cb) => cb() })
    const slowRows = (async function* () {
      yield { id: 1, email: 'a@example.com' }
      await new Promise((resolve) => setTimeout(resolve, 20))
      yield { id: 2, email: 'b@example.com' }
    })()
    setTimeout(
      () => out.destroy(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })),
      5
    )

    await expect(
      writeCombinedDump(out, {
        dialect: mysqlDumpDialect,
        batchSize: 1,
        tables: [
          {
            table: 'users',
            ddl: 'CREATE TABLE `users` (`id` int)',
            columns: ['id'],
            rows: slowRows
          }
        ]
      })
    ).rejects.toThrow('ENOSPC')
  })
})
