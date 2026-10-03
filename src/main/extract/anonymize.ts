import { createHash } from 'crypto'
import type { Faker } from '@faker-js/faker'
import type {
  FakeGenerator,
  FieldStrategyRule,
  ObfuscateSide,
  Row,
  TemplateBinding
} from '@shared/types'

/**
 * Field-level anonymization (spec §8). `anonymizeRow` transforms a row that selection/cascade
 * flagged **anonymize=true**; preserve-flagged rows are copied verbatim by the caller and never
 * reach here. Each column's `FieldStrategyRule` decides its fate; a column with no strategy is
 * left unchanged (preserve is the default).
 *
 * `template` reaches *inside* a JSON column, overlaying only the paths bound to a generator — see
 * `applyTemplate`.
 *
 * Determinism (spec §8): faker is re-seeded before each generated value from a SHA-256 hash of a
 * *stable key*, never left to run freely. `fake` values seed on `identityKey:generator`, so the
 * same person's fake name/email/address is identical everywhere they appear — across tables and
 * across re-runs — independent of column name or field order. `jitter` seeds on `rowKey:column`,
 * so a given row's perturbation is reproducible. `obfuscate` seeds on `column:value`, so the *same*
 * input always scrambles to the same output — see `obfuscate`.
 */

type GeneratorFn = (f: Faker) => unknown

/**
 * Fixed reference date for `dateOfBirth`. `faker.date.birthdate()` defaults its `refDate` to **now**,
 * so without pinning it the same seed yields a different date on every run (it subtracts an age from
 * the current instant) — silently breaking the re-run stability guarantee. A constant refDate makes
 * the output a pure function of the seed. The exact value is arbitrary; it only has to be stable.
 */
const DOB_REF_DATE = new Date('2025-01-01T00:00:00Z')

/** A birthdate as `YYYY-MM-DD` text — never a JS `Date`, which the Postgres dialect would serialize
 * as an ISO *datetime* (wrong type text for a `date` column, and tz-shiftable). */
function birthdate(f: Faker): string {
  const d = f.date.birthdate({ mode: 'age', min: 18, max: 90, refDate: DOB_REF_DATE })
  return d.toISOString().slice(0, 10)
}

const GENERATORS: Record<FakeGenerator, GeneratorFn> = {
  firstName: (f) => f.person.firstName(),
  lastName: (f) => f.person.lastName(),
  fullName: (f) => f.person.fullName(),
  email: (f) => f.internet.email(),
  phone: (f) => f.phone.number(),
  streetAddress: (f) => f.location.streetAddress(),
  secondaryAddress: (f) => f.location.secondaryAddress(),
  city: (f) => f.location.city(),
  state: (f) => f.location.state(),
  zipCode: (f) => f.location.zipCode(),
  country: (f) => f.location.country(),
  countryCode: (f) => f.location.countryCode(),
  creditCardNumber: (f) => f.finance.creditCardNumber(),
  creditCardCVV: (f) => f.finance.creditCardCVV(),
  iban: (f) => f.finance.iban(),
  companyName: (f) => f.company.name(),
  loremWords: (f) => f.lorem.words(),
  loremSentence: (f) => f.lorem.sentence(),
  loremParagraph: (f) => f.lorem.paragraph(),
  dateOfBirth: birthdate,
  avatarUrl: (f) => f.image.avatar(),
  url: (f) => f.internet.url()
}

/** Deterministic 48-bit seed from a stable string key (SHA-256 → first 6 bytes). */
function seedInt(key: string): number {
  return createHash('sha256').update(key).digest().readUIntBE(0, 6)
}

export interface AnonymizeContext {
  /** column → strategy for this table (columns absent from the map are preserved). */
  strategies: Map<string, FieldStrategyRule>
  /** Stable identity of the originating entity — drives cross-table fake-value consistency. */
  identityKey: string
  /** This specific row's key — drives per-row perturbation (jitter). */
  rowKey: string
  /** Locale-resolved faker instance for this row's country (see `locale.ts`). */
  faker: Faker
  /** Columns with a single-column UNIQUE constraint — faked values here must not collide. */
  uniqueColumns?: Set<string>
  /**
   * Per-column set of fake values already emitted for this table, shared across the table's rows
   * (the caller creates it once and reuses it). Used to detect and resolve collisions on
   * `uniqueColumns`. Mutated as values are handed out.
   */
  usedValues?: Map<string, Set<unknown>>
}

/** Max salt attempts before giving up on finding a unique fake value (then accept a duplicate). */
const MAX_UNIQUE_ATTEMPTS = 1000

/** Apply the table's field strategies to an anonymize-flagged row, returning a new row. */
export function anonymizeRow(row: Row, ctx: AnonymizeContext): Row {
  if (ctx.strategies.size === 0) return row
  const out: Row = { ...row }
  for (const [column, rule] of ctx.strategies) {
    if (!(column in out)) continue
    out[column] = applyRule(out[column], rule, column, ctx)
  }
  return out
}

function applyRule(
  value: unknown,
  rule: FieldStrategyRule,
  column: string,
  ctx: AnonymizeContext
): unknown {
  switch (rule.kind) {
    case 'preserve':
      return value
    case 'redact':
      return null
    case 'fake': {
      const generate = GENERATORS[rule.generator]
      const base = `${ctx.identityKey}:${rule.generator}`
      // Non-unique column: single deterministic value keyed on identity + generator.
      if (!ctx.uniqueColumns?.has(column) || !ctx.usedValues) {
        ctx.faker.seed(seedInt(base))
        return generate(ctx.faker)
      }
      // Unique column: keep the first-attempt value identical to the non-unique case (so
      // cross-table consistency holds), then salt deterministically only on an actual collision.
      const used = ctx.usedValues.get(column) ?? new Set<unknown>()
      if (!ctx.usedValues.has(column)) ctx.usedValues.set(column, used)
      let value: unknown
      for (let attempt = 0; attempt < MAX_UNIQUE_ATTEMPTS; attempt++) {
        ctx.faker.seed(seedInt(attempt === 0 ? base : `${base}:dup${attempt}`))
        value = generate(ctx.faker)
        if (!used.has(value)) break
      }
      used.add(value)
      return value
    }
    case 'template':
      return applyTemplate(value, rule.bindings, column, ctx)
    case 'obfuscate':
      return obfuscate(value, rule.side, rule.count, column, ctx)
    case 'jitter': {
      const num = toNumber(value)
      if (num === null) return value // non-numeric / null → leave untouched
      ctx.faker.seed(seedInt(`${ctx.rowKey}:${column}`))
      const spread = rule.percent / 100
      const jittered = num * (1 + ctx.faker.number.float({ min: -spread, max: spread }))
      // Keep integers integral (e.g. counts) while letting decimal amounts stay fractional.
      return Number.isInteger(num) ? Math.round(jittered) : jittered
    }
  }
}

/**
 * Overlay generated values onto the bound paths of a JSON column, leaving everything else untouched
 * (docs/template-anonymizer.md). This is the only strategy that can anonymize a value *nested inside*
 * a blob — the scalar kinds can only replace the whole column.
 *
 * **Form-preserving, and that is not cosmetic.** A `json`/`jsonb` column reaches here differently per
 * dialect: Postgres hands over verbatim **text** (the `PG_VERBATIM_TEXT_OIDS` type-parser override,
 * which exists because pg's own parse is ambiguous between a json array and a real array column),
 * while mysql2 hands over a parsed **object**. Each dialect's `value()` then expects that same form
 * back — the pg dialect quotes a text literal, the mysql dialect `JSON.stringify`s an object. Return
 * the wrong one and you resurrect exactly the `[object Object]` / double-encoding corruption already
 * fixed on 2026-07-24. So: text in → text out, object in → object out.
 *
 * Anything that isn't a JSON **object** is returned untouched: a non-JSON string, a scalar, or a
 * top-level array (arrays are deliberately out of v1 scope — faking each element versus regenerating
 * the array is a separate decision).
 */
function applyTemplate(
  value: unknown,
  bindings: TemplateBinding[],
  column: string,
  ctx: AnonymizeContext
): unknown {
  if (value == null || bindings.length === 0) return value

  const wasText = typeof value === 'string'
  let parsed: unknown
  if (wasText) {
    try {
      parsed = JSON.parse(value as string)
    } catch {
      return value // not JSON after all — leave it exactly as found
    }
  } else if (typeof value === 'object') {
    // Clone: `anonymizeRow` copies the row shallowly, so nested objects are still shared with the
    // source row. Overlaying in place would mutate the caller's data.
    parsed = JSON.parse(JSON.stringify(value))
  } else {
    return value
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return value

  const target = parsed as Record<string, unknown>
  for (const binding of bindings) {
    // Absent `action` means 'fake' — that's what bindings written before actions existed look like.
    switch (binding.action ?? 'fake') {
      case 'remove':
        // Delete the key outright: a password hash has no useful anonymized form, and leaving a
        // `null` behind still says the field was there.
        deletePath(target, binding.path)
        break
      case 'redact':
        // Keep the key, drop the value — shape-preserving, for readers that expect the key.
        overlayPath(target, binding.path, () => null)
        break
      default: {
        const generate = binding.generator ? GENERATORS[binding.generator] : undefined
        if (!generate) break // unknown/missing generator (stale config) — skip, don't crash the run
        overlayPath(target, binding.path, () => {
          // Seeded per leaf on identity + column + path, so a re-run reproduces the same blob and two
          // paths bound to the same generator (`address1`/`address2` → streetAddress) don't collide on
          // one value. Cross-column consistency with the scalar `fake` strategy is deliberately not
          // attempted: a bound leaf is identified by where it lives.
          ctx.faker.seed(seedInt(`${ctx.identityKey}:${column}:${binding.path}`))
          return generate(ctx.faker)
        })
      }
    }
  }

  return wasText ? JSON.stringify(target) : target
}

/**
 * Read the value at a dot path inside a JSON column value — for a caller that needs a value *out of* a
 * blob rather than a rewrite of one. The data-driven faker locale uses it, because a country is often
 * stored at `address.country` rather than in a column of its own (migration 007).
 *
 * Lives next to `overlayPath`/`deletePath` so one module defines what a path means: the same
 * dot-separated segments, the same refusal to descend into an array or a non-object, and the same
 * treatment of a path this row doesn't have — absent, not an error.
 *
 * Handles **both forms a JSON column arrives in**, which is per-dialect and not ignorable: Postgres
 * hands over verbatim text (the `PG_VERBATIM_TEXT_OIDS` overrides) and SQLite has no JSON type at all,
 * while mysql2 hands over a parsed object. Text that doesn't parse yields `undefined` rather than
 * throwing — a column that isn't really JSON is a misconfiguration to fall back from, not a reason to
 * fail a whole run.
 */
export function readPath(value: unknown, path: string): unknown {
  const segments = path.split('.').filter((segment) => segment.length > 0)
  if (segments.length === 0) return undefined

  let node: unknown = value
  if (typeof node === 'string') {
    try {
      node = JSON.parse(node)
    } catch {
      return undefined
    }
  }
  for (const segment of segments) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

function resolveParent(
  target: Record<string, unknown>,
  path: string
): { node: Record<string, unknown>; leaf: string } | undefined {
  const segments = path.split('.').filter((segment) => segment.length > 0)
  if (segments.length === 0) return undefined

  let node: Record<string, unknown> = target
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment]
    // Stop at anything that can't be descended into, including an array — consistent with arrays
    // being out of v1 scope.
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return undefined
    node = next as Record<string, unknown>
  }

  return { node, leaf: segments[segments.length - 1] }
}

/**
 * Replace a value only when its path exists; never invent keys on rows with a different shape.
 */
function overlayPath(
  target: Record<string, unknown>,
  path: string,
  produce: () => unknown
): boolean {
  const parent = resolveParent(target, path)
  if (!parent) return false
  const { node, leaf } = parent
  if (!(leaf in node)) return false
  node[leaf] = produce()
  return true
}

/**
 * Delete the key at a dot path, if it's there. Mirrors `overlayPath`'s navigation rules: it never
 * creates anything on the way, and a path this row doesn't have is simply a no-op.
 */
function deletePath(target: Record<string, unknown>, path: string): boolean {
  const parent = resolveParent(target, path)
  if (!parent) return false
  const { node, leaf } = parent
  if (!(leaf in node)) return false
  delete node[leaf]
  return true
}

/** Coerce a value to a finite number, or null if it isn't numeric. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Digits and the two letter cases, kept apart so a replacement stays in its own class. */
const DIGITS = '0123456789'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * A random character of the same class as `ch`, or `ch` itself when it belongs to no class.
 *
 * Class-preserving on purpose. A dash, a dot, an `@` or a space carries the value's *format*, not
 * its content — replacing those turns `ACE-2024-XY7781` into something that no longer parses, and a
 * column with a format CHECK would reject it outright. Keeping a digit a digit and a letter a letter
 * of the same case means the scrambled value still passes whatever read it before.
 *
 * Non-ASCII letters are deliberately left alone rather than mapped into ASCII: substituting `é` with
 * `k` would change the byte length of a UTF-8 value, which can overflow a column sized in bytes.
 */
function scrambleChar(ch: string, faker: Faker): string {
  const pool = DIGITS.includes(ch)
    ? DIGITS
    : LOWER.includes(ch)
      ? LOWER
      : UPPER.includes(ch)
        ? UPPER
        : ''
  if (!pool) return ch
  return pool[faker.number.int({ min: 0, max: pool.length - 1 })]
}

/**
 * Scramble the first or last `count` characters of a value, preserving each one's character class.
 *
 * **Seeded on the value itself**, not on the row — so two rows holding the same reference scramble
 * to the same output, and a join or a lookup on that column survives the dump. Seeding per row
 * would break that silently, and the column this rule suits (a reference, an account number) is
 * exactly the kind that gets joined on. The trade is the usual one for deterministic masking:
 * identical outputs reveal identical inputs.
 *
 * `count` is a floor on how much is hidden, so a value **shorter** than `count` is scrambled in
 * full rather than partially — never less than was asked for.
 *
 * Applies to text; a number or bigint is scrambled through its decimal form and returned as **text**
 * so no precision or range question arises (the digits still load into a numeric column, which
 * coerces an unquoted-looking literal). Anything else — null, a Buffer, a Date — is returned
 * untouched, like `jitter` does with a non-numeric value.
 */
function obfuscate(
  value: unknown,
  side: ObfuscateSide,
  count: number,
  column: string,
  ctx: AnonymizeContext
): unknown {
  if (value === null || value === undefined) return value
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    return value
  }

  const text = String(value)
  // Split into code points before measuring, not after: `.length` counts UTF-16 units, so an emoji
  // or any astral character would make the index arithmetic disagree with the array and scramble
  // the wrong run. The dump already goes to lengths to carry those characters intact (`utf8mb4`).
  const chars = [...text]
  if (chars.length === 0) return value

  ctx.faker.seed(seedInt(`${column}:${text}`))
  const n = Math.min(count, chars.length)
  const start = side === 'first' ? 0 : chars.length - n

  for (let i = start; i < start + n; i++) chars[i] = scrambleChar(chars[i], ctx.faker)
  return chars.join('')
}
