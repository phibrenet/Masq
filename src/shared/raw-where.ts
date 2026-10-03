/** Raw SQL is inserted inside `WHERE (<predicate>)`, not run as a standalone query. */
export function rawWhereError(raw: string): string | null {
  if (!raw.trim()) return 'Enter a SQL predicate.'
  if (/^\s*(?:SELECT|WITH|WHERE)\b/i.test(raw) || /;\s*$/.test(raw)) {
    return 'Enter only a WHERE predicate, without SELECT/WHERE at the start or a trailing semicolon. Set the row count under Take.'
  }
  // Any semicolon, even one inside a string literal: telling the two apart needs each dialect's
  // quoting rules, and a separator that slips through runs a second statement with the source's
  // credentials. A predicate that genuinely needs the character can write CHR(59) / CHAR(59).
  if (raw.includes(';')) {
    return 'A predicate can’t contain a semicolon. If you need one in a string, use CHAR(59) (MySQL) or CHR(59) (Postgres/SQLite).'
  }
  return null
}
