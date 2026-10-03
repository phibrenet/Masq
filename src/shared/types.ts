/**
 * Shared domain types — the contract between renderer and (future) main process.
 *
 * These are derived from the spec (§6/§8/§10, docs/db-subsetter-spec.md) and are the
 * single source of truth for the shapes shared by the renderer and main process.
 *
 * Convention: camelCase in TS (the config SQLite schema uses snake_case; the main
 * process maps between the two at the IPC boundary).
 */

// ─── Connections ────────────────────────────────────────────────────────────

export type Dialect = 'mysql' | 'postgres' | 'sqlite' | 'mssql'

export type ConnectionRole = 'source' | 'target'

export interface Connection {
  id: string
  workspaceId: string
  label: string
  dialect: Dialect
  role: ConnectionRole
  /** Server-based dialects (mysql/postgres/mssql). */
  host?: string
  port?: number
  database?: string
  username?: string
  /**
   * Postgres only: the schema(s) to introspect and dump, as typed — a single schema
   * (`tenant`) or a comma-separated list (`tenant, public`), mirroring Laravel's
   * `DB_SEARCH_PATH`. Blank/absent means `public`. Unlike MySQL, where `table_schema` *is*
   * the database, a Postgres database holds many schemas and plenty of apps don't use
   * `public` — so this can't be inferred from `database`. Parsed by
   * `src/main/adapters/search-path.ts`.
   */
  searchPath?: string
  /** File-based dialects (sqlite). Mutually exclusive with the server fields. */
  filePath?: string
}

import type { FrameworkId } from './frameworks'

export type { FrameworkId }

// ─── Workspaces ─────────────────────────────────────────────────────────────

/** Combined = one .sql (schema + data). Split = separate schema + data files. */
export type DumpOutputMode = 'combined' | 'split'

export interface Workspace {
  id: string
  name: string
  dumpOutputMode: DumpOutputMode
  /**
   * Where this workspace's dumps are written. Absent = the default, `<userData>/dumps`.
   *
   * Stored unresolved: the default depends on the OS *and* on dev-vs-packaged, so writing one
   * machine's answer into the shared config store would follow the file somewhere it's wrong.
   * `extract.dumpDirectory` resolves it for display.
   */
  dumpOutputDir?: string
  /**
   * Emit `DROP TABLE IF EXISTS` before each table's DDL, so a dump can be loaded over itself.
   *
   * On by default (migration 012). Without it a combined dump only loads into an empty database —
   * the second load stops at the first `table already exists`. Turn it off when the dump is being
   * loaded alongside data the recipient wants to keep.
   */
  dropExistingTables: boolean
  /**
   * Which framework this workspace's source database belongs to, or absent for none/not yet known.
   * Detected from the discovered table names (`detectFramework`) and overridable by hand; it
   * selects which table presets the Tables screen offers. See `src/shared/frameworks.ts`.
   */
  framework?: FrameworkId
  createdAt: string
  updatedAt: string
}

/** Portable configuration file. Generated database IDs and machine-local settings are omitted. */
export interface WorkspaceTransfer {
  format: 'masq-workspace'
  version: 1
  /**
   * `dropExistingTables` is optional so a file exported before it existed still imports; absent
   * means the column default (on). The format version stays at 1 — a field older Masq builds
   * simply never wrote, not a breaking change to what they did write.
   */
  workspace: Pick<Workspace, 'name' | 'dumpOutputMode'> &
    Partial<Pick<Workspace, 'dropExistingTables' | 'framework'>>
  tableClassifications: Omit<TableClassification, 'id' | 'workspaceId' | 'source'>[]
  selectionRules: Omit<SelectionRule, 'id' | 'workspaceId' | 'invalid'>[]
  fieldStrategies: Omit<FieldStrategy, 'id' | 'workspaceId'>[]
  tableLocaleSources: Omit<TableLocaleSource, 'id' | 'workspaceId'>[]
  tableIdentitySources: Omit<TableIdentitySource, 'id' | 'workspaceId'>[]
  morphRelations: Omit<MorphRelation, 'id' | 'workspaceId'>[]
  fkBackfillPolicies: Omit<FkBackfillPolicy, 'id' | 'workspaceId'>[]
}

// ─── Table classification (§5) ────────────────────────────────────────────────

/**
 * - excluded: skipped entirely (not introspected, dumped, or cascaded through)
 * - reference: copied 100%, untouched, never anonymized
 * - transactional: goes through selection rules → cascade → field anonymization
 * - structure: DDL is dumped, rows never are — cascade and backfill don't reach it (migration 013)
 *
 * `structure` exists because "transactional with no selection rule" is **not** a reliable way to
 * get an empty table: a rule-less table is still a cascade target, so a kept parent pulls its
 * children in. Laravel's `sessions.user_id` is the case that proves it — seeding `users` at all
 * drags live session rows into the dump. `structure` says the intent instead of depending on the
 * absence of configuration.
 */
export type TableClass = 'excluded' | 'reference' | 'transactional' | 'structure'

/**
 * Where a classification came from: set by hand, or written by a framework's presets.
 *
 * This is what lets re-applying presets be a *repair* rather than a no-op — preset-written rows can
 * be refreshed and newly-listed tables added, while a hand-set choice is never overwritten. Stored
 * as `'manual'` or `'preset:<frameworkId>'`.
 */
export type ClassificationSource = 'manual' | `preset:${FrameworkId}`

export interface TableClassification {
  id: string
  workspaceId: string
  tableName: string
  class: TableClass
  source: ClassificationSource
}

/** What applying a framework's presets did, for the message the Tables screen shows. */
export interface PresetApplyResult {
  /** Tables the workspace had no classification for. */
  added: number
  /** Preset-written rows whose class the catalogue has since changed. */
  refreshed: number
  /** Tables left alone because someone had classified them by hand, or under another framework. */
  skippedManual: string[]
}

/**
 * Data-driven faker locale (spec §8): the column in `tableName` whose value gives each row's
 * country, so `fake` strategies produce country-appropriate output. One per (workspace, table);
 * the value→locale mapping is resolved by the anonymization engine at dump time.
 */
export interface TableLocaleSource {
  id: string
  workspaceId: string
  tableName: string
  /** The column whose value gives the row's country — or which *contains* it, if `countryPath` is set. */
  countryColumn: string
  /**
   * Dot path to the country **inside** `countryColumn`'s JSON value (`address` + `country`). Absent
   * means the column's own value is the country, which is the original behaviour.
   *
   * Exists because naming a column can't reach a country stored in a blob, and real schemas do that:
   * on the workspace this was built for, `country_code` is set on 3 of 18 users while every one of
   * them has `address.country`. Same path convention as template field-strategy bindings.
   */
  countryPath?: string
}

/**
 * Which entity a table's rows belong to, declared rather than inferred (migration 008).
 *
 * Cross-table identity otherwise follows the cascade graph, which can't distinguish an ownership edge
 * (`users → orders`) from an incidental one (`posts → comments`, where the commenter isn't the post's
 * author). Declaring `comments.user_id → users` gives each comment its own commenter's identity,
 * overriding what the cascade would have propagated.
 */
export interface TableIdentitySource {
  id: string
  workspaceId: string
  tableName: string
  /** Column on `tableName` holding the owning entity's id (e.g. `user_id`). */
  identityColumn: string
  /** Table the entity lives in (e.g. `users`) — stored, not derived from the FK graph. */
  identityTable: string
}

/**
 * What parent backfill does with one foreign-key column (migration 009).
 *
 * - `follow` — pull the referenced parent row into the dump. The default, and the only behaviour
 *   before this existed: it is what makes a subset referentially complete.
 * - `null`   — don't pull it in; emit NULL for the column on any row whose reference points outside
 *   the subset. Only legal on a **nullable** column.
 *
 * The distinction the engine can't make on its own is *ownership* versus *incidence*:
 * `submissions.user_id` says whose submission it is, `submissions.welded_by_user_id` says which
 * member of staff touched it. Following the second drags in a population nobody selected.
 */
export type BackfillPolicyKind = 'follow' | 'null'

/**
 * A declared exception to "backfill follows every foreign key", one per (workspace, table, column).
 * Absence means `follow`, so a workspace with none of these behaves exactly as it always has.
 */
export interface FkBackfillPolicy {
  id: string
  workspaceId: string
  /** The child table the foreign key leaves from. */
  tableName: string
  /** The foreign-key column on `tableName`. */
  columnName: string
  policy: BackfillPolicyKind
}

/**
 * A foreign-key edge plus the one fact the policy screen needs that `ForeignKeyRef` doesn't carry:
 * whether the child column is nullable, which decides if `null` is even a legal policy for it.
 *
 * Resolved in main (one `getColumns` per child table) rather than in the renderer, so the screen
 * costs a single introspection call instead of one per table.
 */
export interface ForeignKeyEdge extends ForeignKeyRef {
  nullable: boolean
}

// ─── Polymorphic (morph) relations ────────────────────────────────────────────
// Laravel's `*_type` + `*_id` pairs: the type column names the target model, the id column is that
// model's PK. No FK constraint exists (the target varies per row), so these are invisible to
// `getForeignKeys()` and must be declared. See docs/polymorphic-cascade.md.

/** One entry of a relation's type→table map: the value as it appears in the data → target table. */
export interface MorphTypeMapping {
  typeValue: string
  targetTable: string
}

/**
 * A declared morph relation. Declaring it *is* the opt-in — undeclared morphs are ignored, exactly
 * as today. `typeMap` travels with the relation because one is meaningless without the other (a
 * relation with no mappings resolves to nothing), and the builder UI edits them as one unit.
 */
export interface MorphRelation {
  id: string
  workspaceId: string
  tableName: string
  typeColumn: string
  idColumn: string
  /** Keep an entity → pull the rows it owns. Off by default: it changes the dump's size. */
  cascadeDown: boolean
  /** A kept row's morph reference must point at a kept row. On by default: integrity. */
  backfillUp: boolean
  typeMap: MorphTypeMapping[]
}

/**
 * A morph relation *proposed* by introspection, for the builder UI to present for confirmation.
 * Detection is naming-based (`X_type` with a sibling `X_id`) plus the distinct values actually
 * present in the type column, so the user confirms rather than authors.
 */
export interface MorphCandidate {
  tableName: string
  typeColumn: string
  idColumn: string
  /** Distinct non-null type values found in the data, each with a best-guess target table. */
  typeValues: MorphCandidateValue[]
}

export interface MorphCandidateValue {
  typeValue: string
  /**
   * Best guess at the target table (class basename → snake_case → pluralised), **validated against
   * the real table list** — so it's either a table that exists or undefined, never a guess the user
   * has to check. Undefined means "you pick".
   */
  guessedTable?: string
}

// ─── Row selection rules (§6, v2 — docs/selection-rules-v2.md) ────────────────

/**
 * One `column · operator · value` clause. A rule ANDs or ORs a flat list of them (`match`); there
 * are no nested groups — `rawWhere` covers what a flat list can't say.
 *
 * Every operator except `matches` compiles to portable SQL and is pushed into the query. `matches`
 * is a JS `RegExp` evaluated client-side, because MySQL `REGEXP`, Postgres `~`, and SQLite (no
 * regex at all without a custom function) diverge — the v1 reasoning, now scoped to the one
 * operator that needs it.
 */
export const CONDITION_OPS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'isNull',
  'notNull',
  'in',
  'notIn',
  'withinLast',
  'olderThan',
  'matches'
] as const
export type ConditionOp = (typeof CONDITION_OPS)[number]
export const NEGATIVE_OPS = [
  'neq',
  'notContains',
  'notIn'
] as const satisfies readonly ConditionOp[]
export const DURATION_UNIT_VALUES = ['day', 'week', 'month', 'year'] as const
export type DurationUnit = (typeof DURATION_UNIT_VALUES)[number]

export interface RelativeDuration {
  n: number
  unit: DurationUnit
}

export interface Condition {
  /**
   * The column to test. **`null` means "this table's primary key"** — the sentinel migration 010
   * writes for a v1 `explicit` rule, whose PK column name is a *source-schema* fact the config store
   * doesn't hold. Resolved at extract time, so it also survives a PK rename.
   */
  column: string | null
  op: ConditionOp
  /** Absent for `isNull`/`notNull`; an array for `in`/`notIn`; a `RelativeDuration` for the dates. */
  value?: unknown
  /**
   * Negative operators (`neq`, `notContains`, `notIn`) only, and **defaults to `true`**.
   *
   * SQL's three-valued logic makes `email NOT LIKE '%@work.com'` evaluate to NULL — not true — for
   * a NULL email, so the obvious way to write "has no work email" silently drops every user without
   * one. Nobody means that, so the compiler emits `(col <> ? OR col IS NULL)` unless this is
   * explicitly `false`.
   */
  includeNulls?: boolean
}

/** How a rule combines its conditions. Flat — nesting is `rawWhere`'s job. */
export type MatchMode = 'all' | 'any'

/**
 * How many of the qualifying rows to keep — the axis v1's `SelectionStrategy` fused with the
 * filter (docs/selection-rules-v2.md).
 *
 * `top` is deterministic and `sample` isn't, which matters more here than in most tools: faker is
 * seeded from a stable identity key precisely so a re-run reproduces byte-identical output (§8), and
 * a random seed set throws that away at step one.
 */
export type Take =
  | { kind: 'all' }
  | { kind: 'sample'; count: number }
  | { kind: 'top'; count: number; orderBy: string; dir: 'asc' | 'desc' }
  /**
   * **Add no rows — only set `anonymize` on rows the subset already contains.**
   *
   * Every other rule both *selects* rows and *flags* them, which conflates two intentions that
   * usually differ. "Keep our staff's real names" does not mean "include all 282 staff": seeding
   * them pulls in every record they ever touched, because cascade follows every inbound foreign key
   * downward and a staff user is referenced by `welded_by_user_id`, `qa_checked_by_user_id`,
   * `artist_id` on half the database. What was actually wanted is: seed the customers, let cascade
   * and backfill pull in whichever staff those records reference, and preserve *those*.
   *
   * A `none` rule is applied **after** cascade and backfill (`applyFlagRules`), against whatever is
   * by then in the subset. It can only ever lower `anonymize` — preserve-wins is global — so an
   * anonymizing `none` rule is a no-op, and the UI says so.
   */
  | { kind: 'none' }

export interface SelectionRule {
  id: string
  workspaceId: string
  table: string
  match: MatchMode
  /** Empty = every row qualifies. Ignored entirely when `rawWhere` is set. */
  where: Condition[]
  take: Take
  /**
   * Advanced escape hatch: a verbatim SQL predicate used **instead of** `where`, for what the
   * builder structurally can't say (`EXISTS (SELECT 1 FROM orders …)`). Dialect-specific by
   * definition. Never merged with `where` — one filter mechanism per rule, chosen explicitly.
   */
  rawWhere?: string
  /** If a row matches conflicting rules, preserve (anonymize:false) wins. */
  anonymize: boolean
  /**
   * Why this stored rule could not be read back faithfully — absent when it's fine.
   *
   * The repository reads leniently so a damaged rule still *opens* on the Rules screen and can be
   * repaired. It must never be *run*: dropping a condition or falling back to `take: all` widens a
   * rule, and on an `anonymize: false` rule "widened" means **an entire table dumped with real
   * data**. So a rule carrying this is rejected at extract time (`planRule`) rather than silently
   * broadened. Cleared by saving the rule, which rewrites the JSON from the parsed model.
   */
  invalid?: string
}

/**
 * What the Rules screen's preview reports for one rule.
 *
 * `keeping` is **seed rows**, not rows in the dump: FK cascade and backfill add more downstream. A
 * workspace whose only rule was `users: random 20` produced a dump holding 74 users — see the
 * 2026-08-29 entries in `.memory/decisions.md`. The UI has to say so, or the number lies.
 */
export interface SelectionRulePreview {
  /** Rows qualifying under the rule's filter, before its take is applied. */
  matched: number
  /** How many of those the take keeps. */
  keeping: number
}

// ─── Field-level anonymization (§8) ───────────────────────────────────────────

/**
 * Fake-value generators (spec §8). Each value maps to a `@faker-js/faker` v9 call in the
 * (still-to-build) anonymization engine — the mapping is fixed here so the engine and the UI
 * agree on names:
 *   firstName        → person.firstName()
 *   lastName         → person.lastName()          (surname)
 *   fullName         → person.fullName()
 *   email            → internet.email()
 *   phone            → phone.number()
 *   streetAddress    → location.streetAddress()   (line 1)
 *   secondaryAddress → location.secondaryAddress() (line 2 — apt/suite)
 *   city             → location.city()
 *   state            → location.state()           (region/county)
 *   zipCode          → location.zipCode()          (postcode)
 *   country          → location.country()          (full name, e.g. "United Kingdom")
 *   countryCode      → location.countryCode()      (ISO alpha-2, e.g. GB, US, NL)
 *   creditCardNumber → finance.creditCardNumber()
 *   creditCardCVV    → finance.creditCardCVV()
 *   iban             → finance.iban()
 *   companyName      → company.name()
 *   loremWords       → lorem.words() (a few placeholder words — titles, short free text)
 *   loremSentence    → lorem.sentence() (one sentence — medium free text)
 *   loremParagraph   → lorem.paragraph() (a paragraph — long free text; will overflow a tight
 *                      `varchar`, so intend it for `text`/`longtext` columns)
 *   dateOfBirth      → date.birthdate() as `YYYY-MM-DD` (deterministic: pinned refDate — see
 *                      anonymize.ts; the default refDate is `now`, which is NOT seed-stable)
 *   avatarUrl        → image.avatar() (placeholder portrait/avatar image URL)
 *   url              → internet.url() (generic website URL, e.g. https://example.net/)
 */
export const FAKE_GENERATORS = [
  'firstName',
  'lastName',
  'fullName',
  'email',
  'phone',
  'streetAddress',
  'secondaryAddress',
  'city',
  'state',
  'zipCode',
  'country',
  'countryCode',
  'creditCardNumber',
  'creditCardCVV',
  'iban',
  'companyName',
  'loremWords',
  'loremSentence',
  'loremParagraph',
  'dateOfBirth',
  'avatarUrl',
  'url'
] as const
export type FakeGenerator = (typeof FAKE_GENERATORS)[number]

export type FieldStrategyKind = 'preserve' | 'redact' | 'fake' | 'jitter' | 'template' | 'obfuscate'

/** Which end of the value `obfuscate` scrambles. */
export type ObfuscateSide = 'first' | 'last'

/**
 * Fewest characters an `obfuscate` rule may scramble.
 *
 * Six is a floor, not a default: scrambling one or two characters of a reference leaves it trivially
 * re-identifiable by anyone holding the original list, which would make the rule feel like
 * anonymization while providing almost none. Enforced at the repository boundary, so it holds for
 * the form, an imported workspace file, and any future caller alike.
 */
export const OBFUSCATE_MIN_COUNT = 6

/**
 * What a template does with the value at one path.
 *
 * `redact` and `remove` differ in a way that matters: `redact` keeps the key and sets it to `null`,
 * preserving the blob's shape for anything that reads it; `remove` deletes the key entirely, so the
 * value cannot be inferred to have existed. Use `remove` for secrets (a password hash has no useful
 * anonymized form), `redact` when consuming code expects the key to be present.
 */
export type TemplateAction = 'fake' | 'redact' | 'remove'

/**
 * One JSON path inside a structured column and what happens to it
 * (docs/template-anonymizer.md). Paths are dot-separated (`address1`, `geo.lat`).
 *
 * A path with no binding at all is left untouched — bindings name only what changes.
 */
export interface TemplateBinding {
  path: string
  /**
   * Omitted means `'fake'`. Kept optional for backward compatibility: bindings persisted before
   * actions existed carry only a `generator`, and must keep working untouched.
   */
  action?: TemplateAction
  /** The generator to use when `action` is `'fake'`; ignored otherwise. */
  generator?: FakeGenerator
}

export type FieldStrategyRule =
  | { kind: 'preserve' }
  | { kind: 'redact' } // null it out
  | { kind: 'fake'; generator: FakeGenerator }
  | { kind: 'jitter'; percent: number } // perturb realistic amounts
  /**
   * Anonymize *inside* a JSON column by overlaying generated values onto the row's real value —
   * the only strategy that can reach a value nested in a blob. **Overlay, not generate**: a path
   * with no binding is left exactly as it was, and a bound path that this row doesn't have is
   * skipped rather than created, so rows of differing shape all survive. See
   * docs/template-anonymizer.md.
   */
  | { kind: 'template'; bindings: TemplateBinding[] }
  /**
   * Scramble the first or last `count` characters, leaving the rest of the value intact.
   *
   * For values that must stay *recognisably themselves* while ceasing to identify anyone — a
   * customer reference, an account number, a licence key. `fake` would replace the whole thing and
   * lose its shape; `redact` would empty it.
   *
   * **Character class is preserved**: a letter becomes a random letter, a digit a random digit, and
   * anything else — a dash, a dot, an `@`, a space — is left exactly as it was. So the result still
   * matches whatever format the column holds, which matters when a CHECK constraint, a downstream
   * parser, or a human reading the dump expects that shape.
   *
   * `count` is at least `OBFUSCATE_MIN_COUNT`. A value shorter than `count` is scrambled entirely —
   * never less than asked for.
   */
  | { kind: 'obfuscate'; side: ObfuscateSide; count: number }

export interface FieldStrategy {
  id: string
  workspaceId: string
  tableName: string
  columnName: string
  rule: FieldStrategyRule
}

// ─── Dialect adapter layer (§4) ───────────────────────────────────────────────
// Introspection shapes returned by a `DbAdapter` (implemented per-dialect in the main
// process). These cross IPC to the renderer, so they live here. The adapter *interface*
// itself stays in main (`src/main/adapters/`) — it returns Promises/streams the renderer
// never touches directly.

/** A foreign-key edge: `table.column` → `referencedTable.referencedColumn`. */
export interface ForeignKeyRef {
  table: string
  column: string
  referencedTable: string
  referencedColumn: string
}

export interface ColumnInfo {
  name: string
  /** Dialect-native type text, e.g. `varchar(255)`, `bigint unsigned`. */
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
}

/**
 * Paths discovered inside a JSON column by sampling the source — what the template builder shows so
 * declaring a template is confirm-not-author (docs/template-anonymizer.md).
 *
 * Deliberately carries **no sampled values**, only their shape: the sample comes from a production
 * column, so shipping values into the renderer would move real PII into the UI for no benefit.
 */
export interface JsonPathSample {
  /** Rows sampled (each had a non-null value in the column). */
  sampled: number
  paths: JsonPathInfo[]
}

export interface JsonPathInfo {
  /** Dot path, e.g. `address1` or `geo.lat`. */
  path: string
  /** JS types seen at this path across the sample — flags a leaf that isn't a string. */
  types: string[]
  /** How many sampled rows carried this path (reveals shape variance). */
  presentIn: number
}

/** A single data row, column-name keyed. */
export type Row = Record<string, unknown>

/** Result of a source-connection health check (a failure is an expected outcome, not
 * an exception — so it's reported as data, with the table count on success). */
export interface ConnectionTestResult {
  ok: boolean
  tableCount?: number
  error?: string
}

// ─── Runs (§10) ───────────────────────────────────────────────────────────────

export type RunStatus = 'running' | 'completed' | 'failed'

/** e.g. { schema, data } (split) or { combined } (combined mode). */
export interface RunOutputFiles {
  combined?: string
  schema?: string
  data?: string
}

export interface Run {
  id: string
  workspaceId: string
  startedAt: string
  finishedAt?: string
  status: RunStatus
  /** Per-table kept-row counts, e.g. { users: 500, orders: 1240 }. */
  rowCounts?: Record<string, number>
  outputFiles?: RunOutputFiles
  errorMessage?: string
  /**
   * Problems the run reported: references backfill couldn't repair, FK constraints stripped from the
   * DDL because their parent isn't in the dump, unmapped polymorphic type values, tables it couldn't
   * address by a single-column PK. Each string is already stage-prefixed (`backfill: …`).
   *
   * These describe ways the dump is quietly *less complete* than the selection rules imply, so they
   * are the most important thing a run produces after the file itself. Present on failed runs too —
   * whatever was collected before the failure is kept.
   */
  warnings?: string[]
}
