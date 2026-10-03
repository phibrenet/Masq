/**
 * Column names that usually hold personal data. A heuristic, not a classifier: it only drives the
 * "looks like personal data but has no strategy" prompt on the Field Strategies screen and the
 * matching sidebar badge, so a false positive costs a glance and a false negative costs nothing new.
 */
export const PII_COLUMN_PATTERN =
  /(e[-_]?mail|phone|mobile|ip(_address)?|first_?name|last_?name|full_?name|surname|address|postcode|zip|dob|birth|ssn|national_insurance|passport|user_agent)/i

/**
 * The short tokens in the pattern above also occur inside ordinary words — `ip` in `description` and
 * `stripe_id`, `zip` in `unzipped` — so they only count as a whole name segment (split on `_`/`-`).
 */
const SHORT_TOKEN = /(^|[_-])(ip|zip|dob|ssn)([_-]|$)/i
const SHORT_ONLY = /^(ip|zip|dob|ssn)$/i

/** Timestamps *about* a value (`email_verified_at`) aren't the value itself. */
const TIMESTAMP_SUFFIX = /_(at|on)$/i

export function looksLikePii(columnName: string): boolean {
  if (TIMESTAMP_SUFFIX.test(columnName)) return false
  const match = columnName.match(new RegExp(PII_COLUMN_PATTERN.source, 'gi')) ?? []
  // Every match is a short token found mid-word: not a hit unless one stands as its own segment.
  if (match.length > 0 && match.every((m) => SHORT_ONLY.test(m))) {
    return SHORT_TOKEN.test(columnName)
  }
  return match.length > 0
}

export interface SuspectedColumn {
  table: string
  column: string
}

/**
 * Columns whose names look like personal data and that have no strategy. `columnsByTable` is only
 * the metadata already known (introspected this session); tables absent from it aren't checked.
 */
export function unhandledPiiColumns(
  columnsByTable: Record<string, string[]>,
  hasStrategy: (table: string, column: string) => boolean
): SuspectedColumn[] {
  const found: SuspectedColumn[] = []
  for (const table of Object.keys(columnsByTable).sort()) {
    for (const column of columnsByTable[table]) {
      if (looksLikePii(column) && !hasStrategy(table, column)) found.push({ table, column })
    }
  }
  return found
}
