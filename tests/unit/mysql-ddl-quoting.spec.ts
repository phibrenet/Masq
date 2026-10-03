import { describe, expect, it } from 'vitest'
import { toBacktickIdentifiers } from '../../src/main/adapters/mysql'

/**
 * Normalising ANSI-quoted DDL to backticks (`toBacktickIdentifiers`).
 *
 * The bug this exists for: `SHOW CREATE TABLE` quotes identifiers per the *server's* `sql_mode`, so
 * a source running `ANSI_QUOTES` hands back `"users"`. Masq copied that into the dump verbatim, and
 * to any MySQL not running `ANSI_QUOTES` a double-quoted name is a **string literal** — so the load
 * died on the first CREATE TABLE with ERROR 1064, after the DROPs had already run.
 *
 * Backticks are the right target because they are valid under every mode: `ANSI_QUOTES` *adds* `"`
 * as an identifier quote, it never takes the backtick away.
 */

describe('toBacktickIdentifiers', () => {
  it('rewrites ANSI-quoted identifiers throughout the statement', () => {
    const ansi =
      'CREATE TABLE "users" (\n  "id" int NOT NULL,\n  "email" varchar(255),\n  PRIMARY KEY ("id")\n)'

    expect(toBacktickIdentifiers(ansi)).toBe(
      'CREATE TABLE `users` (\n  `id` int NOT NULL,\n  `email` varchar(255),\n  PRIMARY KEY (`id`)\n)'
    )
  })

  it('leaves DDL that already uses backticks completely alone', () => {
    // The common case. Returning the input unchanged rather than round-tripping it through the
    // scanner means ordinary DDL can't be damaged by a bug in this function.
    const normal = 'CREATE TABLE `users` (`id` int, `note` varchar(50) DEFAULT \'say "hi"\')'

    expect(toBacktickIdentifiers(normal)).toBe(normal)
  })

  it('does not touch a double quote inside a string literal', () => {
    // The whole reason the rewrite is gated on the CREATE line: a `"` inside a DEFAULT or COMMENT
    // is a character, not a quote, and turning it into a backtick would corrupt the value.
    const ansi =
      'CREATE TABLE "t" ("a" varchar(10) DEFAULT \'say "hi"\' COMMENT \'the "a" column\')'

    expect(toBacktickIdentifiers(ansi)).toBe(
      'CREATE TABLE `t` (`a` varchar(10) DEFAULT \'say "hi"\' COMMENT \'the "a" column\')'
    )
  })

  it('handles both spellings of an escaped quote inside a literal', () => {
    // `\'` and `''` both mean a single quote; mis-reading either ends the literal early and the
    // rest of the statement gets scanned as if it were identifiers.
    const backslash = 'CREATE TABLE "t" ("a" varchar(10) DEFAULT \'it\\\'s "fine"\')'
    expect(toBacktickIdentifiers(backslash)).toBe(
      "CREATE TABLE `t` (`a` varchar(10) DEFAULT 'it\\'s \"fine\"')"
    )

    const doubled = 'CREATE TABLE "t" ("a" varchar(10) DEFAULT \'it\'\'s "fine"\')'
    expect(toBacktickIdentifiers(doubled)).toBe(
      "CREATE TABLE `t` (`a` varchar(10) DEFAULT 'it''s \"fine\"')"
    )
  })

  it('unescapes a doubled quote inside an identifier', () => {
    // `""` is how ANSI_QUOTES spells a literal `"` within a name.
    expect(toBacktickIdentifiers('CREATE TABLE "od""d" ("x" int)')).toBe(
      'CREATE TABLE `od"d` (`x` int)'
    )
  })

  it('escapes a backtick that appears inside an identifier name', () => {
    // A name containing a backtick is legal and round-trips as a doubled backtick. Without this the
    // rewritten DDL would terminate the identifier early — a corrupt statement, not just an ugly one.
    expect(toBacktickIdentifiers('CREATE TABLE "we`ird" ("x" int)')).toBe(
      'CREATE TABLE `we``ird` (`x` int)'
    )
  })

  it('rewrites the trailing table options and constraint clauses too', () => {
    const ansi =
      'CREATE TABLE "orders" (\n' +
      '  "id" int NOT NULL,\n' +
      '  "user_id" int DEFAULT NULL,\n' +
      '  KEY "orders_user_id_foreign" ("user_id"),\n' +
      '  CONSTRAINT "orders_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "users" ("id")\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'

    const out = toBacktickIdentifiers(ansi)

    expect(out).toContain('REFERENCES `users` (`id`)')
    expect(out).toContain('CONSTRAINT `orders_user_id_foreign` FOREIGN KEY (`user_id`)')
    // The FK-stripping pass in dump-dialect.ts matches on backticks, so anything left double-quoted
    // here would also silently escape that.
    expect(out).not.toContain('"')
  })

  it('recognises the CREATE variants a server may emit', () => {
    expect(toBacktickIdentifiers('CREATE TEMPORARY TABLE "t" ("x" int)')).toContain('`t`')
    expect(toBacktickIdentifiers('CREATE TABLE IF NOT EXISTS "t" ("x" int)')).toContain('`t`')
    expect(toBacktickIdentifiers('create table "t" ("x" int)')).toContain('`t`')
  })

  it('leaves a statement it does not recognise untouched rather than guessing', () => {
    // Fail-open: if the trigger doesn't fire, the DDL goes out exactly as the server gave it.
    const odd = 'SOMETHING ELSE "quoted"'
    expect(toBacktickIdentifiers(odd)).toBe(odd)
  })
})
