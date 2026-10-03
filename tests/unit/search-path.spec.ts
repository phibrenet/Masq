import { describe, expect, it } from 'vitest'
import { parseSearchPath } from '../../src/main/adapters/search-path'

describe('parseSearchPath', () => {
  it('falls back to public for missing, empty or unusable input', () => {
    expect(parseSearchPath()).toEqual(['public'])
    expect(parseSearchPath(undefined)).toEqual(['public'])
    expect(parseSearchPath('')).toEqual(['public'])
    expect(parseSearchPath('  ,  ')).toEqual(['public'])
  })

  it('parses a single schema and preserves list order', () => {
    expect(parseSearchPath('tenant')).toEqual(['tenant'])
    expect(parseSearchPath('tenant, public')).toEqual(['tenant', 'public'])
    expect(parseSearchPath('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('trims whitespace around unquoted entries', () => {
    expect(parseSearchPath('  tenant ,\n public\t')).toEqual(['tenant', 'public'])
  })

  it('lower-cases unquoted entries (Postgres identifier folding)', () => {
    expect(parseSearchPath('Tenant,PUBLIC')).toEqual(['tenant', 'public'])
  })

  it('keeps quoted entries verbatim — case, spaces and commas included', () => {
    expect(parseSearchPath('"My Schema", public')).toEqual(['My Schema', 'public'])
    expect(parseSearchPath('"tenant,archive", public')).toEqual(['tenant,archive', 'public'])
  })

  it('reads "" inside a quoted entry as one literal double quote', () => {
    expect(parseSearchPath('"we""ird"')).toEqual(['we"ird'])
  })

  it('resolves $user to the connection username whether quoted or not', () => {
    expect(parseSearchPath('$user, public', 'lloyd')).toEqual(['lloyd', 'public'])
    expect(parseSearchPath('"$user"', 'lloyd')).toEqual(['lloyd'])
  })

  it('drops an unresolvable $user and falls back when that empties the path', () => {
    expect(parseSearchPath('$user, public')).toEqual(['public'])
    expect(parseSearchPath('$user')).toEqual(['public'])
  })
})
