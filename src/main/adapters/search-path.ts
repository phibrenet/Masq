/** Fallback when a connection names no usable search path — Postgres' own default, and Laravel's. */
export const DEFAULT_SCHEMA = 'public'

/** The placeholder Postgres substitutes with the connected role's own schema. */
const USER_PLACEHOLDER = '$user'

interface Entry {
  name: string
  /** Quoted identifiers are verbatim; unquoted ones fold to lower case (Postgres' rule). */
  quoted: boolean
}

/**
 * Split a search-path string into entries, respecting double-quoted identifiers.
 *
 * Splitting on every comma is wrong: `"tenant,archive", public` is **two** schemas, not three. Only
 * a comma outside quotes separates entries. Inside quotes, `""` is an escaped double quote and
 * whitespace is significant, so quoted content is taken exactly as written.
 */
function tokenize(raw: string): Entry[] {
  const entries: Entry[] = []
  let i = 0

  while (i < raw.length) {
    while (i < raw.length && (raw[i] === ',' || /\s/.test(raw[i]))) i++
    if (i >= raw.length) break

    if (raw[i] === '"') {
      i++ // opening quote
      let name = ''
      while (i < raw.length) {
        if (raw[i] === '"') {
          if (raw[i + 1] === '"') {
            name += '"' // "" is one literal quote
            i += 2
            continue
          }
          i++ // closing quote
          break
        }
        name += raw[i++]
      }
      if (name.length > 0) entries.push({ name, quoted: true })
      // Ignore anything between the closing quote and the next separator.
      while (i < raw.length && raw[i] !== ',') i++
    } else {
      let name = ''
      while (i < raw.length && raw[i] !== ',') name += raw[i++]
      const trimmed = name.trim()
      if (trimmed.length > 0) entries.push({ name: trimmed, quoted: false })
    }
  }

  return entries
}

/**
 * Parse a Postgres search path into an ordered list of concrete schema names.
 *
 * Accepts the same text a `postgresql.conf` / Laravel `DB_SEARCH_PATH` value holds: one schema or a
 * comma-separated list, entries optionally double-quoted (`"My Schema", public`). Order is
 * significant — Postgres resolves an unqualified name against the first schema on the path that has
 * it, and `CREATE TABLE` lands in the first entry — so it's preserved. Unquoted entries are
 * lower-cased, matching Postgres' identifier folding, so introspection scopes to the schema the
 * session will actually resolve.
 *
 * `$user` (quoted or not — Postgres treats it as a placeholder either way) resolves to `username`,
 * the role we connect as, which is what Postgres substitutes. It's the leading entry of Postgres'
 * stock `"$user", public` default, and on a per-role-schema setup silently rewriting it to `public`
 * would read the wrong same-named tables or miss tables entirely. With no `username` to substitute
 * it is dropped, since an unresolved placeholder can't scope an `information_schema` query.
 *
 * Empty input, or input that resolves to nothing, yields `['public']` so callers always get at least
 * one schema.
 */
export function parseSearchPath(raw?: string, username?: string): string[] {
  const schemas: string[] = []

  for (const { name, quoted } of tokenize(raw ?? '')) {
    const resolved = quoted ? name : name.toLowerCase()
    if (resolved === USER_PLACEHOLDER) {
      if (username) schemas.push(username)
      continue
    }
    schemas.push(resolved)
  }

  return schemas.length > 0 ? schemas : [DEFAULT_SCHEMA]
}
