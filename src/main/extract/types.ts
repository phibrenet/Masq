/**
 * Extract-engine domain shapes (spec §6–§9). The engine is a pipeline of pure-ish stages over a
 * `DbAdapter`: selection resolution → FK cascade → anonymize → dump. These types are the values
 * passed between stages.
 */

/**
 * A primary-key value. Single-column PKs only for now (see the adapter's PK caveat, spec §4).
 *
 * **Invariant: a value is only usable as a selection key if the driver produced it from the column
 * that keys that selection.** These end up as `Map` keys, which compare with `===`, so `42` and `'42'`
 * are different rows — and both representations really do occur (node-pg returns `int4` as a number
 * and `int8` as a string; config values are always JSON). A mistyped key is *silent*: the dump
 * writer's `WHERE pk IN (…)` is evaluated by the database, which coerces, so the row is still
 * selected and still passes every integrity check — only the anonymize lookup misses, and the row is
 * emitted with **real data**. Route ids through `getExistingIds` rather than trusting a value read
 * off an FK column or out of config. See the 2026-07-30 decisions entry.
 */
export type PkValue = string | number

/**
 * The rows kept from one table, with each row's anonymize flag. Produced by selection resolution
 * (direct rule matches) and grown by FK cascade (rows pulled in as children of kept parents).
 *
 * `ids` maps a kept PK value → its anonymize flag. Merge precedence is **preserve wins** (spec §6):
 * once any rule/cascade marks a row `false` (preserve), it stays `false` even if another match
 * says `true`. Use `mergeKeep` to enforce this rather than writing the map directly.
 */
export interface TableSelection {
  table: string
  pkColumn: string
  /** Kept PK value → anonymize flag (false = preserve, and preserve wins on conflict). */
  ids: Map<PkValue, boolean>
  /**
   * Kept PK value → the **identity of the entity the row belongs to** (`"users:42"`), for rows that
   * belong to something other than themselves. This is what makes `payments.cardholder_name` match
   * `users.name` for the same person (spec §7: a cascaded child's fake fields "are seeded from the
   * parent's identity, not its own row ID").
   *
   * A **partial overlay on `ids`**, deliberately: an absent entry means "this row is its own entity",
   * which is true of every row a selection *rule* matched and every row backfill pulled up. Only the
   * downward cascade writes here, so the common case costs nothing and the fallback in `run.ts`
   * (`identities.get(id) ?? "table:pk"`) is the pre-existing behaviour unchanged.
   *
   * Never key jitter off this — jitter must stay per-row (`rowKey`), or every row of one entity would
   * be perturbed identically. Use `mergeIdentity` to write, which is first-write-wins.
   */
  identities: Map<PkValue, string>
  /** An `all` rule matched: the dump writer may stream the whole table without a `WHERE … IN`. */
  keepAll: boolean
}

/** The identity string for a row that is its own entity. The one place this format is defined. */
export function ownIdentity(table: string, id: PkValue): string {
  return `${table}:${String(id)}`
}

/**
 * Record which entity a kept row belongs to, **first write wins**.
 *
 * First-write-wins rather than last, because a child can be reached from more than one kept parent (a
 * pivot row, or two FKs onto the same table) and the fake values must not depend on which edge was
 * walked last. Cascade's traversal order is deterministic — it is what already makes a re-run
 * byte-identical — so taking the first arrival is stable across runs.
 *
 * There is no "preserve wins" analogue here: unlike the anonymize flag, one identity is not safer
 * than another, so any deterministic choice is as correct as any other.
 */
export function mergeIdentity(
  identities: Map<PkValue, string>,
  id: PkValue,
  identity: string
): void {
  if (!identities.has(id)) identities.set(id, identity)
}

/**
 * Merge a kept row into a selection map with preserve-wins precedence: `false` (preserve) always
 * beats `true` (anonymize). A brand-new id takes the incoming flag; a seen id ANDs the two, so it
 * flips to preserve the moment any source preserves it and never flips back.
 */
export function mergeKeep(ids: Map<PkValue, boolean>, id: PkValue, anonymize: boolean): void {
  const existing = ids.get(id)
  ids.set(id, existing === undefined ? anonymize : existing && anonymize)
}
