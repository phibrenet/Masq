import { faker as baseFaker } from '@faker-js/faker'
import { describe, expect, it } from 'vitest'
import { OBFUSCATE_MIN_COUNT, type FieldStrategyRule, type Row } from '@shared/types'
import { anonymizeRow, type AnonymizeContext } from '../../src/main/extract/anonymize'

/**
 * The `obfuscate` rule: scramble the first or last N characters, leaving the rest intact.
 *
 * Its reason for existing is that the result must stay *recognisably the same kind of value* — a
 * reference still looks like a reference, an email still parses as one — so the assertions here are
 * mostly about what it does **not** touch.
 */

function run(value: unknown, rule: FieldStrategyRule, column = 'reference'): unknown {
  const ctx: AnonymizeContext = {
    strategies: new Map([[column, rule]]),
    identityKey: 'users:1',
    rowKey: 'users:1',
    faker: baseFaker
  }
  return anonymizeRow({ [column]: value } as Row, ctx)[column]
}

const last6: FieldStrategyRule = { kind: 'obfuscate', side: 'last', count: 6 }
const first6: FieldStrategyRule = { kind: 'obfuscate', side: 'first', count: 6 }

describe('obfuscate', () => {
  it('scrambles exactly the requested end and leaves the rest byte-identical', () => {
    const input = 'ACE-2024-XY7781'

    const tail = run(input, last6) as string
    expect(tail).toHaveLength(input.length)
    expect(tail.slice(0, -6)).toBe('ACE-2024-')
    expect(tail.slice(-6)).not.toBe('XY7781')

    const head = run(input, first6) as string
    expect(head.slice(6)).toBe(input.slice(6))
    expect(head.slice(0, 6)).not.toBe('ACE-20')
  })

  it('keeps each character in its own class, so the value keeps its shape', () => {
    // The whole point: a letter stays a letter of the same case, a digit stays a digit. A column
    // with a format CHECK, or a downstream parser, still accepts the result.
    const out = run('ACE-2024-XY7781', last6) as string

    expect(out).toMatch(/^ACE-2024-[A-Z]{2}\d{4}$/)
  })

  it('leaves punctuation and separators exactly where they were', () => {
    // An email has to survive as an email — replacing the `.` or the `@` would make it unparseable.
    const out = run('jane.doe@acme.co.uk', first6) as string

    expect(out).toHaveLength('jane.doe@acme.co.uk'.length)
    expect(out[4]).toBe('.')
    expect(out.slice(6)).toBe('oe@acme.co.uk')
    expect(out).toMatch(/^[a-z]{4}\.[a-z]oe@acme\.co\.uk$/)
  })

  it('scrambles a short value in full rather than partially', () => {
    // `count` is a floor on what is hidden. Scrambling only part of a 4-character value because 6
    // was asked for would hide less than the rule promised.
    const out = run('AB12', last6) as string

    expect(out).toHaveLength(4)
    expect(out).toMatch(/^[A-Z]{2}\d{2}$/)
    expect(out).not.toBe('AB12')
  })

  it('maps the same input to the same output, so joins on the column survive', () => {
    // Seeded on the value rather than the row. Two rows sharing a reference must still share it
    // after the dump, or a lookup that worked in production breaks in the copy.
    expect(run('ACE-2024-XY7781', last6)).toBe(run('ACE-2024-XY7781', last6))
    // And a different input gives a different output — otherwise the column would collapse.
    expect(run('ACE-2024-XY7782', last6)).not.toBe(run('ACE-2024-XY7781', last6))
  })

  it('is stable across runs, like every other strategy', () => {
    // Re-running an extract over unchanged source data must produce an identical dump.
    const first = run('CUSTOMER-99812345', last6)
    baseFaker.seed(12345) // disturb the shared faker between calls
    expect(run('CUSTOMER-99812345', last6)).toBe(first)
  })

  it('scrambles a number through its digits and hands back text', () => {
    // Returned as text so no precision or int64-range question arises; the digits still load into
    // a numeric column, which coerces the literal.
    const out = run(900112233445, last6)

    expect(typeof out).toBe('string')
    expect(out).toMatch(/^900112\d{6}$/)
  })

  it('leaves null and non-textual values untouched', () => {
    // Same contract as `jitter` with a non-numeric value: do nothing rather than invent something.
    expect(run(null, last6)).toBeNull()
    expect(run(undefined, last6)).toBeUndefined()
    const buffer = Buffer.from('abcdefgh')
    expect(run(buffer, last6)).toBe(buffer)
    expect(run('', last6)).toBe('')
  })

  it('counts astral characters as single characters', () => {
    // `.length` counts UTF-16 units, so an emoji would otherwise shift the scrambled run and split
    // a surrogate pair — producing a broken character in a dump that goes to lengths to carry them.
    const out = run('🎯🎯ABCDEFGH', last6) as string

    expect([...out]).toHaveLength(10)
    expect(out.startsWith('🎯🎯AB')).toBe(true)
    expect(out).toMatch(/^🎯🎯AB[A-Z]{6}$/)
  })

  it('exposes a minimum that the type and the UI share', () => {
    expect(OBFUSCATE_MIN_COUNT).toBe(6)
  })
})
