interface Statement {
  sql: string
  /** Unquoted words only: quoted names/literals cannot masquerade as DDL keywords. */
  words: string
}

/** pg_dump SQL boundaries, preserving literals, quoted identifiers and dollar-quoted bodies. */
function statements(sql: string): Statement[] {
  const result: Statement[] = []
  let start = 0
  let words: string[] = []
  let i = 0
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2)
      i = end < 0 ? sql.length : end + 1
    } else if (sql.startsWith('/*', i)) {
      let depth = 1
      i += 2
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) {
          depth++
          i += 2
        } else if (sql.startsWith('*/', i)) {
          depth--
          i += 2
        } else i++
      }
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++]
      const escape = quote === "'" && /(?:^|\W)[eE]$/.test(sql.slice(0, i - 1))
      while (i < sql.length) {
        if (escape && sql[i] === '\\') {
          i += 2
          continue
        }
        if (sql[i++] === quote) {
          if (sql[i] === quote) i++
          else break
        }
      }
    } else if (sql[i] === '$' && /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.test(sql.slice(i))) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))![0]
      const end = sql.indexOf(tag, i + tag.length)
      i = end < 0 ? sql.length : end + tag.length
    } else if (sql[i] === ';') {
      result.push({ sql: sql.slice(start, ++i).trim(), words: words.join(' ').toUpperCase() })
      start = i
      words = []
    } else if (/[A-Za-z_]/.test(sql[i])) {
      const word = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(sql.slice(i))![0]
      words.push(word)
      i += word.length
    } else i++
  }
  if (sql.slice(start).trim())
    result.push({ sql: sql.slice(start).trim(), words: words.join(' ').toUpperCase() })
  return result
}

/** Keep PKs/unique indexes/defaults with each table; defer objects needing other tables/functions. */
export function splitPostgresTableDdl(ddl: string): { tableDdl: string; deferredDdl: string[] } {
  const tableDdl: string[] = []
  const deferredDdl: string[] = []
  for (const statement of statements(ddl)) {
    const deferred =
      /^ALTER TABLE\b.*\bADD CONSTRAINT\b.*\bFOREIGN KEY\b/.test(statement.words) ||
      /^CREATE(?: OR REPLACE)?(?: CONSTRAINT)? TRIGGER\b/.test(statement.words) ||
      /^ALTER TABLE\b.*\b(?:ENABLE|DISABLE)(?: ALWAYS| REPLICA)? TRIGGER\b/.test(statement.words) ||
      /^COMMENT ON (?:TRIGGER|CONSTRAINT)\b/.test(statement.words)
    if (deferred) deferredDdl.push(statement.sql)
    else tableDdl.push(statement.sql)
  }
  return { tableDdl: tableDdl.join('\n\n'), deferredDdl }
}
