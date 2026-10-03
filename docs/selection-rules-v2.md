# Selection rules v2: filter + take — design plan

_Status: **BUILT** 2026-08-29 (designed the same day). All six build-order steps landed; lint,
typecheck, `npm test` (112 checks, 53 new) and build are clean. **Partially live-verified**: the
preview ran against the real MySQL source (an `endsWith` on `users.email` → 282 rows), exercising
`applyFilter` → `LIKE … ESCAPE` → `countRows` → IPC. `selectRows`, take push-down, relative dates, a
full extract, and the other two dialects are still unexercised. Two things are deliberately not
built: the preview's
**overlap count** ("also matched by another rule") and **cohorts** — see
[What this does *not* solve](#what-this-does-not-solve-partial-preservation) and
[Out of scope](#out-of-scope)._

_Three decisions were made during the build that this plan didn't anticipate. They're marked
**[build]** below: the `any` + regex partition rule, withholding the take from SQL, and the `LIKE`
escape character._

Spec §6 gives a table four disjoint strategies — `random`, `pattern`, `all`, `explicit`. Between them
they cannot express the pair of rules a real workspace wants on one table:

1. users who **have no work email** and were **created recently** → take 20, anonymize
2. users who **have a work email** → take all, preserve

Neither is writable today. `random` cannot be filtered; `pattern` cannot be limited; `pattern` filters
on exactly one column with exactly one regex, so "no work email **and** created recently" has nowhere
to go.

## The diagnosis: `strategy` conflates two axes

A selection rule answers two independent questions, and v1 fuses them into one enum:

| | **which rows qualify** | **how many of them to take** |
|---|---|---|
| `random N` | all of them | a random N |
| `pattern` | those matching a regex | all of them |
| `all` | all of them | all of them |
| `explicit` | those with a listed PK | all of them |

Every cell of the missing half of that grid — *filtered* **and** *limited* — is a rule someone will
eventually want, and case 1 above is the first one that showed up. So the fix is not a fifth strategy;
it is to split the enum into the two axes it was always hiding:

```
rule = WHERE (a list of conditions)  +  TAKE (all | random N | top N)  +  anonymize
```

All four v1 strategies are then presets over the same model, which is what makes this a
non-breaking change (see [Migration](#migration-010)).

## Why not "just regex"

The obvious cheap move is to keep `pattern` and let it hold several column/regex pairs. Rejected, for
two independent reasons.

**Regex cannot express most real filters.** "created within 90 days" is not a regex. Neither is
`> 100`, `IS NULL`, `IN (…)`, or `BETWEEN`. Regex only describes the *shape of a string*, and string
shape is the minority of what people filter on. Building the interface around it means every
non-string filter is unreachable forever.

**Regex cannot be pushed into SQL, and everything else can.** v1 resolves `pattern` client-side on
purpose — MySQL `REGEXP`, Postgres `~`, SQL Server (none) and SQLite (none without a custom function)
all diverge, so `resolveSelection` pulls `(pk, column)` pairs for **every row in the table** and
filters them in Node with a real `RegExp`. That is the right call *for regex* and it stays. But the
dialect-divergence argument that justified it **does not apply to ordinary comparison operators**:
`=`, `<>`, `<`, `>`, `IS NULL`, `IN`, `LIKE` and `BETWEEN` are portable across MySQL, Postgres and
SQLite verbatim, and knex already emits them correctly per dialect.

Pushing them down is what makes case 1 affordable. Today a `pattern` rule on `users` transfers the
whole table to keep a handful of rows; as a pushed-down `WHERE … ORDER BY RAND() LIMIT 20` it is one
indexed query.

**The hybrid, which is the part worth getting right:** a rule may mix pushable conditions with a
regex condition. Push every pushable condition into the query, then pull `(pk, column)` pairs **only
for the rows that survived it** and apply the `RegExp` to those. A regex condition therefore costs a
narrowed read rather than a full-table read, and the more of the rule that is expressible in SQL the
cheaper its regex half becomes.

**[build] That hybrid is only valid under `match: 'all'`.** AND lets you narrow in stages; OR does
not. `email matches /x/ OR created_at >= cutoff`, pushed as just the date, would drop every row that
qualified *only* via the regex — a silently smaller subset, with nothing to notice. So a single
non-pushable condition in an `any` rule forces the **whole** filter client-side. That costs exactly
what a v1 `pattern` rule already cost (one full-table read), never more, and `partitionConditions`
owns the decision in one place.

**[build] The take is withheld from SQL whenever a client-side condition survives.** A `LIMIT`
pushed alongside an unevaluated regex caps the rows *before* the regex runs: sampling 20 and keeping
the 3 that match is a different rule from keeping 20 that match. In that case the rows come back
unlimited, Node filters them, and the take is applied in memory — a shuffle for `sample` (slicing a
database's natural order would bias every sample toward the oldest rows), a sort for `top`.

One caveat to document in the UI rather than paper over: **`LIKE` case-sensitivity is
collation-dependent** (MySQL's default collations fold case; Postgres does not). So the `contains` /
`startsWith` / `endsWith` operators emit `LOWER(col) LIKE LOWER(?)`, which is portable and predictable
on every dialect, at the cost of not using a plain B-tree index. `matches` (regex) is always
case-sensitive unless the pattern says otherwise, which is what a regex author expects.

**[build] The `LIKE` escape character is `!`, not `\`.** A user value has to be escaped or "50% off"
searches for a wildcard, and escaping needs a named `ESCAPE` clause because **SQLite has no default
escape character at all** — a `\` in a SQLite `LIKE` pattern is a literal backslash. `\` can't be the
named one either: MySQL treats a backslash as an escape *inside the string literal too*, so
`ESCAPE '\'` needs a doubling that then depends on the server's `NO_BACKSLASH_ESCAPES` mode. `!` has
no special meaning in a string literal on any of the three, so one spelling works everywhere.

## The model

```ts
export type ConditionOp =
  | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'contains' | 'notContains' | 'startsWith' | 'endsWith'
  | 'isNull' | 'notNull'
  | 'in' | 'notIn'
  | 'withinLast' | 'olderThan'   // relative date; value = { n, unit: 'day'|'week'|'month'|'year' }
  | 'matches'                     // JS regex source — the client-side escape hatch

export interface Condition {
  column: string
  op: ConditionOp
  value?: unknown                 // absent for isNull/notNull; array for in/notIn
  /** Negative operators only. See "NULL is the trap that will actually bite". */
  includeNulls?: boolean
}

export type Take =
  | { kind: 'all' }
  | { kind: 'sample'; count: number }                                     // ORDER BY RAND() LIMIT n
  | { kind: 'top'; count: number; orderBy: string; dir: 'asc' | 'desc' }  // newest/oldest n

export interface SelectionRule {
  id: string
  workspaceId: string
  table: string
  match: 'all' | 'any'      // AND / OR across `where`. Flat — no nested groups.
  where: Condition[]        // empty = every row
  take: Take
  /** Advanced: a verbatim SQL predicate, used *instead of* `where`. Not portable. */
  rawWhere?: string
  anonymize: boolean
}
```

The two motivating rules:

```ts
{ table: 'users', match: 'all', anonymize: true,
  where: [ { column: 'email',      op: 'notContains', value: '@example.com', includeNulls: true },
           { column: 'created_at', op: 'withinLast',  value: { n: 90, unit: 'day' } } ],
  take: { kind: 'sample', count: 20 } }

{ table: 'users', match: 'all', anonymize: false,
  where: [ { column: 'email', op: 'contains', value: '@example.com' } ],
  take: { kind: 'all' } }
```

### `top` earns its place next to `sample`

"The 20 most recent users" is stable across runs; "a random 20 of the recent ones" is a different set
every time. That matters more here than in most tools, because anonymization is *deliberately*
deterministic — faker is seeded from a stable identity key precisely so re-running the same source
produces byte-identical fake data (spec §8). A random seed set throws that reproducibility away at the
first step. `top` makes a whole dump reproducible, and it is usually what someone means when they say
"recent users" anyway.

`sample` stays for the case it is genuinely better at: a representative spread rather than a
head-of-the-table slice.

### Flat `match: all | any`, not a nested tree

One toggle over a flat condition list covers both motivating cases and, in practice, nearly every
real one. Nested boolean groups are where query builders become unusable — they need drag targets,
depth indentation and a mental model of operator precedence, all to serve a case that
[`rawWhere`](#rawwhere-the-escape-hatch) already handles. If nested groups are ever genuinely needed,
the flat list is a strict subset of any tree model and can be widened without a data migration.

## Storage — migration 010

`conditions` and `take` are stored as JSON columns on `selection_rules` rather than as a child table.
The config store's grain is "one table per concept" (see the note in migration 008), and a condition
is not a concept — it is never addressed on its own, never queried across rules, and has no life
outside the rule that owns it. It is read and written whole, exactly like `explicit_values` and
`field_strategies.template_json` already are.

The cost is that SQLite `CHECK` cannot validate the payload, so shape validation lives at the
repository boundary — the same place `parseValues` already handles a malformed `explicit_values`.

Widening `strategy`'s CHECK constraint is impossible in place (SQLite cannot ALTER a CHECK), so this
is a **full 12-step table rebuild**, as migration 005 was — which means the v1 → v2 rewrite is free:
it happens in the `INSERT … SELECT` that copies rows into the new table.

```sql
CREATE TABLE selection_rules_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  match_mode TEXT NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all', 'any')),
  -- JSON array of { column, op, value?, includeNulls? }. '[]' = every row.
  conditions_json TEXT NOT NULL DEFAULT '[]',
  -- JSON: { kind: 'all' } | { kind: 'sample', count } | { kind: 'top', count, orderBy, dir }
  take_json TEXT NOT NULL DEFAULT '{"kind":"all"}',
  -- Verbatim SQL predicate, used INSTEAD OF conditions_json. NULL for builder-authored rules.
  raw_where TEXT,
  anonymize INTEGER NOT NULL CHECK (anonymize IN (0, 1))
);
```

Note `strategy`, `count`, `column_name`, `pattern` and `explicit_values` are all gone — every one of
them is now a shape inside `conditions_json` / `take_json`.

### The v1 → v2 rewrite

Mechanical, lossless, and behaviour-preserving in every case:

| v1 | v2 |
|---|---|
| `random N` | `where: [] · take: { sample, N }` |
| `pattern col/re` | `where: [{ col, matches, re }] · take: all` |
| `all` | `where: [] · take: all` |
| `explicit vals` | `where: [{ pk, in, vals }] · take: all` |

`explicit` needs the PK column name, which the config store does not hold — it is a *source-schema*
fact. Two options: resolve it at extract time by leaving `column: null` to mean "the primary key", or
introspect during migration (impossible — migrations run at app start with no source connection).
**Use the null-means-PK sentinel.** It also keeps `explicit` rules working if a table's PK is ever
renamed.

That rewrite quietly fixes a v1 mismatch worth noting: `explicit` resolves through `getExistingIds`,
which only ever compares against the **primary key** — despite the modal's placeholder offering
`admin@example.com` as an example value. As `column in (…)` over any column, it finally does what the
placeholder always implied.

## Four traps the interface must absorb

### NULL is the trap that will actually bite

"users who do not have a work email", written the obvious way as
`email NOT LIKE '%@example.com'`, **silently excludes every user whose email is NULL**. SQL's
three-valued logic says NULL is not "not like" anything; the predicate evaluates to NULL, and the row
is dropped. Nobody has ever meant that.

So every negative operator (`neq`, `notContains`, `notIn`) emits
`(col IS NULL OR col NOT LIKE ?)` **by default** on a nullable column, with `includeNulls` exposed as
a visible checkbox rather than buried. The builder already knows nullability — `ColumnInfo` carries
it, and `discovery.columns(table)` caches it — so the UI can be concrete about the stakes:

> ☑ include the 3,100 users with no email

On a NOT NULL column the checkbox is hidden entirely; there is nothing to decide.

### Relative dates must be computed in Node, not in SQL

`DATE_SUB(NOW(), INTERVAL 90 DAY)` / `now() - interval '90 days'` / `datetime('now','-90 days')` —
three dialects, three syntaxes, no overlap. `withinLast` / `olderThan` therefore resolve to a concrete
timestamp **once, at run start**, and bind it as an ordinary parameter.

Two things fall out of that for free. Every table in a run shares one cutoff instant, so a long
extract cannot have `users` and `orders` disagree about where "90 days ago" is. And the resolved
cutoff is a plain value that can be logged into the run record, so a dump's contents stay explicable
months later.

Storing a relative value rather than an absolute date is the point: a workspace's rules are long-lived
config, and a hard-coded `created_at > '2026-05-31'` starts rotting the day it is written.

### "Limit 20" does not mean 20 rows in the dump

Per [.memory/state.md](../.memory/state.md), a workspace whose only rule was `users: random 20`
produced a dump containing **74 users** — `backfillSelection` pulled staff in through
`welded_by_user_id` and its 25 sibling FK columns. That growth is [correct and
wanted](../.memory/decisions.md) on that workspace, but a field labelled **Limit** is still lying
about it.

Label it **Seed rows**, say so inline, and link to Backfill Management:

> ⓘ Seed rows. Following foreign keys may add more — see Backfill Management.

After a run, show the actual figure beside it (`20 seeds → 74 rows`). The rules screen is where that
mismatch should be confessed, not a console log.

### Overlapping rules waste sample slots

The two motivating rules are disjoint by construction, but nothing enforces that, and if they
overlapped, rule 1's random 20 would spend slots on rows rule 2 already keeps whole. Preserve-wins
resolves the *anonymize* conflict correctly (spec §6) and needs no change; the sample-slot waste is
invisible.

Which is the argument for the single highest-value addition here:

### A preview count

One `SELECT COUNT(*) … WHERE <conditions>` per rule, on demand:

```
Matched 1,284 rows · keeping 20 · 0 also matched by another rule on users
```

It is a cheap query, and it converts rule-writing from guesswork into feedback: a typo'd column name,
an accidentally-empty match set, a NULL trap and an overlap all become visible *before* a 40-minute
extract rather than after it. It is also the validator for `rawWhere` — a fragment that counts is a
fragment that parses.

## `rawWhere`: the escape hatch

Some predicates are structurally outside a column/operator/value builder — most commonly correlated
subqueries (`EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id)`, i.e. "users who have
ever ordered"). Rather than grow the builder toward SQL one operator at a time, offer SQL:

The editor accepts only the predicate after `WHERE`, without an outer `SELECT`, `WHERE`, `ORDER BY`,
`LIMIT`, or trailing semicolon. Subqueries inside the predicate are fine. Set the row count under
**Take**. A raw predicate is wrapped as `WHERE (<predicate>)` in a query against the selected table.

- `rawWhere` **replaces** `where` — never merged with it. Two filter mechanisms live in one rule is
  a bug factory; one or the other, chosen explicitly, is legible.
- It is **not portable**, and the UI says so. Acceptable because a workspace's source connection has
  exactly one dialect.
- It is validated by the preview count before save.

Injection is not the threat model — the operator is querying their own database with their own
read-only credentials, and any SQL they could inject here they could simply type into a client. The
risk being managed is a *typo costing a failed run*, and the preview handles that.

## UI shape

```
Table   [ users ▾ ]

Keep rows where   [ Match all ▾ ]
  [ email      ▾ ] [ does not contain ▾ ] [ @example.com ]  ☑ include empty   [×]
  [ created_at ▾ ] [ in the last      ▾ ] [ 90 ] [ days ▾ ]                       [×]
  + Add condition                                        · Use raw SQL instead

Take     ( ) All matching rows
         (•) Random sample of [ 20 ]
         ( ) Newest [ 20 ] by [ created_at ▾ ]

         ⓘ Seed rows. Following foreign keys may add more — see Backfill Management.
         Matched 1,284 · keeping 20                         [ Preview ]

Rows are  (•) Anonymized   ( ) Preserved as-is
```

**Operators are filtered by column type.** This is what separates it from a generic query builder: a
`datetime` column offers *is before / is after / in the last N*, a `varchar` offers *contains /
matches / is empty*, an `int` offers comparisons. No "contains" on a date column, no "in the last 90
days" on a name. `discovery.columns(table)` already caches `ColumnInfo` (name, type, nullable,
`isPrimaryKey`) per `${workspaceId}::${table}`, so the type information is on hand with no new IPC.

The column select stays `tag`-enabled (free text accepted) for the case where discovery has not run
or the source is unreachable, exactly as the table select does today.

`RulesView`'s `describe()` becomes a readable sentence rather than a strategy name:

> Random 20 of users where email does not contain "@example.com" and created_at is in the last 90 days

## Flag-only rules: `take: { kind: 'none' }`

_Added 2026-08-29, after the first live run of the two motivating rules did not finish._

Motivating rule 2 was written as *"users with a work email → take all, preserve"*, and that is a
different thing from what was meant. Seeding all 282 staff makes the extract enormous, because
`cascadeSelection` follows **every** inbound foreign key downward with no policy gate: a staff user
is referenced by `welded_by_user_id`, `qa_checked_by_user_id`, `photoed_by_user_id` and
`card_lookups.artist_id` across most of the database, so keeping one pulls in every record they ever
touched, and each of those cascades to its own children. (The per-edge backfill policy from
migration 009 doesn't help — it governs the *upward* direction only.)

**What was actually wanted is "don't anonymize staff", not "include all staff".** Seed the customers,
let cascade and backfill pull in whichever staff those records reference, and preserve *those*.

Rules couldn't say that, because every rule both selects and flags: the only way to set
`anonymize: false` on a row was to seed it. `take: { kind: 'none' }` separates the two — the rule
adds nothing, and is applied by `applyFlagRules` **after** cascade and backfill, against whatever is
by then in the subset.

Three properties make it safe to bolt a stage onto the end of selection:

- **It can only lower `anonymize`.** A matched row that isn't already kept is skipped, so the subset
  never grows and nothing above it is invalidated.
- **Preserve-wins still governs the merge**, which means an *anonymizing* flag rule is a no-op. That
  falls out of §6 rather than being an oversight — a late stage able to un-preserve a row would
  defeat the precedence rule's whole purpose. The modal warns when a rule is written that way.
- **No migration.** The take lives in the same `take_json` column as every other kind.

It is *not* cohorts: it sets one boolean for a whole row, so "keep staff names but still fake their
phone numbers" remains out of reach. It covers the case that actually turned up.

## What this does *not* solve: partial preservation

Motivating case 2 says *"we wish to keep **most** details"* — most, not all. That is not expressible,
and this design does not make it so.

`anonymize` is a boolean **per row**, while field strategies are per-column and **table-wide**. So a
staff user is dumped either wholly verbatim or wholly faked; "keep staff names and emails but still
fake their phone numbers" has nowhere to live. Adding conditions to selection rules does not touch
this — it is a field-strategy limitation that selection rules merely expose.

The clean fix is **cohorts**: a rule labels the rows it matches (`staff`), and a field strategy may be
scoped to a cohort — `users.email → preserve for staff, fake otherwise`. The engine cost is genuinely
small: `TableSelection.ids` is already a `Map<PkValue, boolean>` and would become
`Map<PkValue, { anonymize: boolean; cohort?: string }>`, with the cascade propagating the cohort the
same way it already propagates the flag. The real cost is on the Fields screen, which grows a
dimension, plus a precedence rule for a row matching two cohorts.

**Deliberately deferred.** Ship filter + take, run it, and find out whether the boolean actually
chafes — the boolean plus preserve-wins may well be enough. If it does chafe, cohorts are the answer,
and nothing in the model above has to change to accommodate them: a `cohort?: string` field on
`SelectionRule` is additive.

## Build order — all landed 2026-08-29

1. ✅ **Types + migration 010.** `Condition` / `Take` / the rewritten `SelectionRule` in
   [src/shared/types.ts](../src/shared/types.ts);
   [010_selection_rules_v2.sql](../src/main/config/migrations/010_selection_rules_v2.sql) rebuilds the
   table and rewrites v1 rows in its `INSERT … SELECT` (SQLite JSON1 does the shaping);
   [selection-rules.ts](../src/main/config/repositories/selection-rules.ts) round-trips the JSON and
   validates shape at the boundary.
2. ✅ **The condition compiler** — [src/main/extract/conditions.ts](../src/main/extract/conditions.ts).
   One operator table with **two faces**: `applyConditions` emits SQL, `evaluateConditions` decides
   the same question in Node. They live in one file because a divergence between them is a silent
   wrong-rows bug, and they're tested against the same fixtures for the same reason.
3. ✅ **Adapter primitives `selectRows` / `countRows`**, replacing the un-filterable
   `sampleRandomIds`, on all three adapters. Only the random-ordering expression differs by dialect
   (`RAND()` vs `RANDOM()`), so it's a parameter rather than three copies of the query builder.
4. ✅ **`resolveSelection` rewritten** ([select.ts](../src/main/extract/select.ts)). `identities`,
   `keepAll` and preserve-wins are unchanged; `keepAll` now means "no filter of any kind and no cap".
5. ✅ **Condition-builder UI** — type-aware operators, the NULL checkbox, and the preview count
   (new `source:previewSelectionRule` IPC over [preview.ts](../src/main/extract/preview.ts), which
   shares `planRule` with the extract so what it counts is what a run will keep).
6. ✅ **`describeRule`** ([lib/conditions.ts](../src/renderer/src/lib/conditions.ts)) renders a rule
   as a sentence.

**Test coverage** (53 new checks): every operator's generated SQL asserted per dialect without a
connection (knex compiles without connecting), both faces over shared fixtures, the partition rule
including the `any` + regex case, the migration's rewrite replayed against a scratch database, and
`resolveSelection` against a stub adapter that records *what was asked for* — because the load-bearing
behaviour is which half of a rule got pushed down, not only which ids came back.

**Not yet done: run it against a real database.** Every test is a pure function or a stub, so the SQL
has been asserted but never executed. That is the next thing.

## Out of scope

- **The preview's overlap count** ("also matched by another rule on users"). The sketch above shows
  it and it isn't built: `matched`/`keeping` are per-rule counts, whereas overlap means resolving
  two rules' PK sets and intersecting them. Worth adding, but it's a different query shape.
- **Nested boolean groups** — flat `match all/any` plus `rawWhere`. Widenable later without a data
  migration.
- **Cohorts / partial preservation** — see above. Additive when wanted.
- **Cross-table conditions in the builder** ("users who have ordered") — `rawWhere` handles these;
  putting joins in the builder means modelling the FK graph in the UI.
- **Composite primary keys** — unchanged from v1, still unsupported for id-based selection
  (spec §4).
- **A cascade fan-out cap** — the other half of dump-size control, still nonexistent, still unrelated
  to selection rules. See [.memory/state.md](../.memory/state.md).
