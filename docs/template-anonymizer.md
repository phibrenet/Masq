# Template anonymizer (JSON-shaped fields) — design plan

_Status: **BUILT** 2026-07-30 (migration **005**, not 004 — morph support shipped first and took that
number). Captured 2026-07-26; kept as the design record. See `.memory/decisions.md` for what changed
during implementation._

A field-strategy kind that anonymizes **structured (JSON) columns** by binding JSON paths to the
existing faker generators and overlaying them onto each row's real value. Motivated by a real
blocker: `users.address` on the resconx schema is a JSON object (`{address1, city, county, country,
postcode, …}`), and the current column-level strategies (`fake`/`redact`/`jitter`) can only replace
the whole column, not a value *inside* the blob.

This supersedes the earlier "json-lorem" idea (scramble every string with lorem). A template
produces **realistic, shaped, locale-correct** output instead of noise — which is what usable dev
data needs. Build this instead of json-lorem, not both.

## Why a template, and why overlay

Grounding from real data (`resconx_staging.users.address`, 2026-07-26):

- **Shape varies per row.** 17 rows have `{address1, city, country, county, postcode}`; 5 also have
  `address2`. A fixed "emit this template" would drop `address2` for those 5 or invent it for the
  other 17.
- **JSON is a whole class of the schema**, not one column: ~20 json/jsonb columns (addresses,
  keyword arrays, task lists, stripe metadata, message attachments).

So the strategy is **overlay**, not generate: walk the row's actual JSON, replace only the paths the
user bound to a generator, and leave everything else untouched (including `null`s and keys this row
happens to have). This handles shape variance for free and can't drop a key some rows carry.

## Config model

A new `FieldStrategyRule` variant:

```ts
| { kind: 'template'; bindings: TemplateBinding[] }

type TemplateAction = 'fake' | 'redact' | 'remove'

interface TemplateBinding {
  path: string                 // dot path into the JSON, e.g. "address1", "geo.lat"
  action?: TemplateAction      // omitted = 'fake' (back-compat with pre-action bindings)
  generator?: FakeGenerator    // for 'fake'; reuses the existing generator set
}
```

**`redact` and `remove` were added 2026-07-30 after the first live run** (see below): a template that
can only *fake* has no answer for a secret. A bcrypt hash in `audits.new_values` has no useful fake —
it needs to be gone. The two differ deliberately: `redact` keeps the key and sets it to `null`
(shape-preserving, for readers that expect the key), `remove` deletes the key so its former presence
can't be inferred.

- **Leaves reference existing `FakeGenerator`s** (`streetAddress`, `city`, `zipCode`, …). This is
  the "on top of the default ones" layering — no new generators required, just a way to assemble
  them into a shape.
- A path with **no binding is preserved** as-is. There is no "fake everything" mode in v1; you name
  what you want changed.

## Semantics

For a row whose column value is `V` (a JSON object) and a `template` rule with bindings `B`:

1. Parse `V` to an object (see the round-trip note — it may arrive as text or as an object).
2. For each binding `b` in `B`: if path `b.path` **exists** in this row, replace its value with the
   generator's output. If the path is absent in this row, skip it (no key is created).
3. Re-serialize in the **same form `V` arrived in** (text → text, object → object).

Paths that don't resolve are silently skipped, not error — rows legitimately differ in shape.

### Determinism + locale (reuse what exists)

- **Locale per row.** The whole object is generated from `fakerFor(row's country)` — the same
  per-row locale machinery the scalar `fake` strategy already uses (`table_locale_sources`). A
  Hungarian user's faked address gets a Hungarian city *and* a Hungarian postcode from one locale,
  not a mismatched pair. This is the single biggest reason a template beats hand-rolling.
- **Seed per leaf** on `identityKey:column:path`, so: re-runs are stable, and the same person's
  fake address is identical wherever it appears. Consistent with the existing seed discipline
  (`.memory/decisions.md`, 2026-07-15 identity seeding).
- **Uniqueness guard: skipped for v1.** The scalar unique-collision salt operates on single values;
  a UNIQUE constraint on a whole JSON blob is rare and dedup on a blob is ill-defined. Template
  columns bypass `uniqueColumns`.

## Storage + migration

`field_strategies` is flat (`kind`, `generator`, `jitter_percent`). A template is structured, so:

- Add a `template_json TEXT` column holding the serialized `bindings`.
- Extend the `kind` CHECK to include `'template'`. **SQLite can't alter a CHECK**, so this is
  **migration 005** — a table rebuild (create-new, copy, drop, rename), same shape the json-lorem
  idea would have needed. Migrations 003/004 were simple `ADD COLUMN`/`CREATE TABLE`; this one isn't.
- Repo `toRule()`/`toColumns()` gain the `template` case: parse/serialize `template_json`, null the
  scalar columns.

## The round-trip wrinkle (must not miss)

`json`/`jsonb` reach the anonymizer differently per dialect:

- **Postgres**: verbatim **text** (the `PG_VERBATIM_TEXT_OIDS` type-parser override, 2026-07-25) —
  so the strategy receives a JSON *string*.
- **MySQL**: a parsed **object** (mysql2 default).

The template strategy must accept both, normalize to an object to overlay, and **return the same
form it received** (string in → string out, object in → object out). Each dialect's `value()` then
serializes correctly (the pg dialect quotes the text literal; the mysql dialect `JSON.stringify`s
the object — the 2026-07-24 mysql2 JSON fix). Returning the wrong form re-introduces exactly the
`[object Object]` / double-encoding bugs already fixed.

## UI — the "builder" (the bulk of the work)

The good version is discoverable, matching the user's "builder" framing:

1. Pick the table + column (existing pickers; column already live-introspected).
2. Masq samples one non-null value of that column (live) and **shows the discovered JSON paths**.
3. Per path, one dropdown covering all four outcomes: **leave as-is** (default), **redact** (null it),
   **remove** (drop the key), or a generator from the existing grouped list.
4. Falls back to raw JSON/bindings editing when there's no sample (no source connection, empty
   column).

This reuses the live sampling and the generator option list already in `FieldStrategyFormModal`.

## v1 scope

- **In:** flat objects and one level of nesting via dot paths; string-valued leaves; overlay
  semantics; per-row locale; per-path seeding. Covers `users.address`, `institutions.address`,
  stripe `metadata`.
- **Out (defer to v2):** arrays (`keywords`, `authors`, `attachments`) — faking each element vs.
  regenerating the array is a separate decision; non-string leaves (numbers/bools) — replacing a
  number changes semantics; leave untouched unless explicitly bound.
- **Replaces** the json-lorem concept entirely.

## Open decisions (confirm before building)

1. **Overlay vs generate** — recommended **overlay** (data proves shape varies). Confirmed direction
   in conversation; recorded here.
2. **Arrays in v1** — recommended **defer**.
3. **Path syntax** — dot paths (`geo.lat`). Bracket/array syntax deferred with arrays.
4. **Numbers/bools** — v1 only overlays paths the user binds; a bound path replaces whatever type
   was there with the generator's (string) output. Flag if a bound path was a number.

## Implementation notes (added 2026-07-30)

Three things the plan under-specified, decided while building:

- **Sample many rows, not one.** The plan said "samples one non-null value". Shape variance is the
  entire reason the strategy is an overlay, and one sample shows one shape — a user would never think
  to bind a key the other rows carry. Discovery samples 50 and unions, reporting `presentIn` per path
  so partial keys are visible. On the real `audits.new_values` this surfaced 21 paths with wildly
  different frequencies (`firstname` 9/50, `email` 6/50) because each row audits a different model.
- **Paths cross IPC, never sampled values.** The sample comes from a production column, so returning
  values to the renderer would move real PII into the UI for no benefit. `JsonPathSample` carries the
  path, the JS types seen there, and how many sampled rows had it.
- **A saved binding is never dropped by a later sample.** The builder unions discovered paths with the
  strategy's existing ones, so a binding whose key isn't in *this* sample stays visible and editable
  rather than silently disappearing on save.

The "flag if a bound path was a number" open decision is answered in the UI rather than the engine:
each row shows the detected type, so binding a `number` leaf to a string generator is visible before
saving. The engine still replaces it, per decision 4.

## Rough build order

1. Type + engine: `template` rule, overlay transform in `anonymize.ts` (dialect-form-preserving),
   per-path seed, locale reuse. Unit-test the transform against text-in and object-in.
2. Migration 004 + repo mapping.
3. IPC/store (existing field-strategy channels extend).
4. Builder UI (sample → paths → per-path generator).
5. Live-verify against `users.address` end to end (both shapes; re-run stability; locale).
