import type { ColumnInfo, ForeignKeyRef, Row } from '@shared/types'
import type { SelectRowsOptions } from '../extract/conditions'
import type { RowFilter } from '../extract/row-filter'

export type { SelectRowsOptions, RowFilter }

/**
 * A database extension the dump must recreate before its objects can load — e.g. Postgres `vector`
 * (pgvector) or `pg_trgm`. `schema` is where the extension's objects live, which matters because a
 * `pg_dump --table` DDL references types by schema-qualified name (`resconx_staging.vector(1536)`),
 * so the extension has to be created `WITH SCHEMA` that same schema or the type won't resolve.
 * Dialects with no extension concept (MySQL) return an empty list.
 */
export interface ExtensionInfo {
  name: string
  schema: string
}

/**
 * Common interface each dialect adapter implements (spec §4). `knex` handles query
 * *execution*; introspection is genuinely NOT unified across dialects (SQLite has no
 * `information_schema` — uses PRAGMA/sqlite_master), so each dialect implements these
 * itself. See `.memory/decisions.md` (2026-07-15, "knex for execution only").
 *
 * Two groups: **introspection** (built in step 3) and **data movement** (the extract
 * slices, steps 5–7) — selection resolution, FK cascade, and the dump writer call the
 * latter.
 */
export interface DbAdapter {
  /**
   * Set by `withCancellation` for the duration of a run, and consulted by the **internally chunked**
   * methods — `getRowsReferencing`, `getReferencedIds`, `getExistingIds` and their morph variants.
   *
   * The proxy in `cancel.ts` checks once per *call*, which is enough for a stage that loops in the
   * pipeline. It is not enough here: these methods slice a large id set into `IN (…)` chunks and run
   * one query per chunk **inside a single call**, so a cascade over a few hundred thousand ids can
   * issue hundreds of queries without the proxy getting another look in. Checking per chunk is what
   * makes Stop take effect in seconds rather than at the end of the whole id set.
   */
  cancellationSignal?: AbortSignal

  // ── Introspection ──────────────────────────────────────────────────────────
  /** BASE TABLEs in the connection's database/schema, name-sorted (no views). */
  getTables(): Promise<string[]>
  /** Columns for one table, in ordinal order. */
  getColumns(table: string): Promise<ColumnInfo[]>
  /**
   * Names of columns covered by a **single-column** UNIQUE (or PRIMARY) index — the columns whose
   * values must stay distinct across the dump. Composite unique indexes are excluded (no single
   * column is individually unique). Lets the anonymizer avoid generating duplicate fake values
   * that would fail the constraint on load.
   */
  getUniqueColumns(table: string): Promise<string[]>
  /**
   * Names of columns whose values come from a sequence / auto-increment (MySQL `AUTO_INCREMENT`,
   * Postgres `serial` or `GENERATED AS IDENTITY`). The dump writer resets these after loading data
   * so the next INSERT doesn't collide.
   *
   * This has to be introspected rather than inferred from "is the primary key": the generated
   * Postgres `setval` reads `MAX(column)`, and `max()` **has no overload for types like `uuid`** —
   * which is a *parse-time* error, so no runtime guard can make the statement safe. Emitting it only
   * for genuinely sequence-backed columns is the only correct option.
   */
  getSequenceColumns(table: string): Promise<string[]>
  /**
   * Names of columns whose values the database computes from other columns (`GENERATED ALWAYS AS
   * (…) STORED`/`VIRTUAL`). These must be **left out of the dump's INSERT column list**: both
   * Postgres and MySQL reject an explicit value for them (`cannot insert a non-DEFAULT value into
   * column …`), and the value is recomputed on load anyway.
   *
   * Distinct from `getSequenceColumns` — an identity column is *not* a generated column (Postgres
   * reports `is_identity = YES` with `is_generated = NEVER`), and the two are handled differently:
   * identity values are dumped and forced in with `OVERRIDING SYSTEM VALUE`, generated values are
   * omitted entirely.
   */
  getGeneratedColumns(table: string): Promise<string[]>
  /**
   * Extensions the dump must recreate before its objects load (Postgres `vector`, `pg_trgm`, …).
   * `pg_dump --table` never emits `CREATE EXTENSION`, so a dump of a schema that uses one would
   * fail on the missing type/operator; the writer emits `CREATE EXTENSION` in the preamble from
   * this. Empty for dialects with no extension concept (MySQL).
   */
  getExtensions(): Promise<ExtensionInfo[]>
  /** Every outbound foreign-key edge in the database. */
  getForeignKeys(): Promise<ForeignKeyRef[]>
  /** Dialect-native schema DDL for one table (MySQL: `SHOW CREATE TABLE`). */
  getCreateTableStatement(table: string): Promise<string>
  /** Cheap round-trip to confirm the connection is live and authenticated. */
  ping(): Promise<void>

  // ── Data movement (extract) ──────────────────────────────────────────────────
  /**
   * Values of the given columns across every row of a table. Used to resolve `pattern`
   * selection rules client-side (pull `(pk, column)` pairs, filter with a real `RegExp`),
   * which sidesteps per-dialect regex divergence (spec §6).
   */
  getColumnValues(table: string, columns: string[]): Promise<Record<string, unknown>[]>
  /**
   * The selection-rule primitive (docs/selection-rules-v2.md): rows matching a rule's filter, with
   * its ordering and row cap applied, returning `columns` (the caller always includes the PK).
   *
   * Replaces v1's `sampleRandomIds`, which could only sample an unfiltered table — the limitation
   * that made "20 recent users without a work email" unwritable. Every operator but `matches`
   * compiles to portable SQL here; `matches` is partitioned out by the caller and re-checked in
   * Node over whatever this returns.
   *
   * Single-column PK assumed, as elsewhere. `take: sample` carries the same `ORDER BY RAND()`
   * full-scan caveat as spec §4 — narrowed now by whatever the filter pushed down.
   */
  selectRows(
    table: string,
    columns: string[],
    opts: SelectRowsOptions
  ): Promise<Record<string, unknown>[]>
  /**
   * How many rows match a filter — the Rules screen's preview, which turns rule-writing from
   * guesswork into feedback before a long extract rather than after it.
   *
   * `opts.take` is ignored: the question is how many rows *qualify*, which the cap then trims. Only
   * exact when the rule is fully pushable; a rule with a `matches` condition is counted by the
   * caller over the rows this can't decide on.
   */
  countRows(table: string, opts: SelectRowsOptions): Promise<number>
  /**
   * For child rows whose `fkColumn` points at any of `parentIds`, return `(childId, parentId)`
   * pairs — the FK-cascade primitive (spec §7). `childId` is the child's single-column PK.
   */
  getRowsReferencing(
    childTable: string,
    fkColumn: string,
    parentIds: (string | number)[]
  ): Promise<{ childId: string | number; parentId: string | number }[]>
  /**
   * `getRowsReferencing`, restricted to child rows whose `typeColumn` equals `typeValue` — the
   * **polymorphic** cascade primitive (docs/polymorphic-cascade.md). A morph relation is an FK whose
   * parent table is chosen per row by a sibling column, so following it is the plain FK query plus
   * that one predicate.
   *
   * Rows with a NULL type column match nothing and are excluded by the equality test itself.
   *
   * Carries the same typing caveat as `getRowsReferencing`: `parentId` comes back as the *child's*
   * id column types it, which for a morph column (no constraint forcing agreement) can easily differ
   * from the target's PK type. Never use it as a selection key without canonicalizing.
   */
  getRowsReferencingMorph(
    childTable: string,
    typeColumn: string,
    typeValue: string,
    idColumn: string,
    parentIds: (string | number)[]
  ): Promise<{ childId: string | number; parentId: string | number }[]>
  /**
   * Distinct non-null values of `fkColumn` across the given child rows — the **parent-backfill**
   * primitive (the upward counterpart of `getRowsReferencing`). Answers "which parents do these
   * kept rows point at", so the cascade can pull any that aren't in the subset yet.
   *
   * `childIds` restricts it to those child PK values; **omit it for every row in the table** — the
   * case for a `keepAll` selection or a reference table dumped whole.
   *
   * NULLs are dropped rather than returned: a nullable FK holding NULL references nothing and
   * needs no parent.
   *
   * **These values are typed by the *child's* FK column, which is not necessarily how the parent's
   * PK column is typed** — an FK only has to be *comparable* to the key it references, not identical
   * to it. Postgres happily accepts an `int8` FK onto an `int4` PK (it records separate equality
   * operators in `pg_constraint` for this), and `node-postgres` then returns the first as a string
   * and the second as a number. So never use these values as keys against parent-side data: feed
   * them through `getExistingIds` first, which re-reads them as the parent's own PK values.
   */
  getReferencedIds(
    childTable: string,
    fkColumn: string,
    childIds?: (string | number)[]
  ): Promise<(string | number)[]>
  /**
   * `getReferencedIds`, restricted to child rows whose `typeColumn` equals `typeValue` — the
   * **polymorphic up-backfill** primitive. Answers "which targets do these kept rows point at, for
   * this one type value", so the missing ones can be pulled in.
   *
   * `childIds` omitted = every row in the table (a `keepAll` selection, or a reference table dumped
   * whole). NULL id columns are dropped, as in `getReferencedIds`.
   *
   * The typing caveat bites *harder* here than for a plain FK: a morph id column has **no constraint
   * forcing it to agree** with any target's PK type, so these values must always go through
   * `getExistingIds` before being used as selection keys.
   */
  getReferencedIdsMorph(
    childTable: string,
    typeColumn: string,
    typeValue: string,
    idColumn: string,
    childIds?: (string | number)[]
  ): Promise<(string | number)[]>
  /**
   * Which of `ids` actually exist as primary-key values in `table`, returned **as that table's own
   * PK column types them**. Two jobs, both needed by parent backfill:
   *
   * 1. **Canonicalizes the type.** The comparison happens in SQL, where the database applies its own
   *    coercions, so an id read off a differently-typed FK column (see `getReferencedIds`) comes back
   *    typed the way the dump's row stream will emit it. Without this, a kept-row lookup keyed on the
   *    streamed PK value misses, and the row is dumped verbatim instead of anonymized.
   * 2. **Drops ids with no matching row**, so a source database that is *already* referentially
   *    broken is reported rather than silently counted as repaired.
   */
  getExistingIds(table: string, ids: (string | number)[]): Promise<(string | number)[]>
  /**
   * Distinct non-null values of one column, capped at `limit`. Seeds the morph builder UI with the
   * `*_type` values actually present in the data, so declaring a relation is confirm-not-author.
   *
   * Capped deliberately: a genuine morph type column holds a handful of values, so an unbounded
   * `DISTINCT` would only ever be expensive on a column that *isn't* one. Order is not guaranteed —
   * callers sort.
   */
  getDistinctValues(table: string, column: string, limit: number): Promise<unknown[]>
  /**
   * Up to `limit` non-null values of one column. Feeds the template builder's path discovery.
   *
   * Deliberately not `getDistinctValues`: Postgres `json` (as opposed to `jsonb`) has **no equality
   * operator**, so `SELECT DISTINCT` on it fails outright — and json columns are exactly what this is
   * for. No ordering is imposed; any sample of real rows will do.
   */
  sampleColumnValues(table: string, column: string, limit: number): Promise<unknown[]>
  /**
   * Stream a table's rows for the dump writer, never buffering the whole table (spec §9).
   * `where` narrows the rows — an allowed-value set per column, plus the polymorphic form a link
   * table needs (see `RowFilter`); omit to stream the whole table (reference tables).
   */
  streamRows(table: string, where?: RowFilter): AsyncIterable<Row>
}
