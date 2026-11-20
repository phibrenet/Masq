import { faker as baseFaker } from '@faker-js/faker'
import { describe, expect, it } from 'vitest'
import type { FieldStrategyException, FieldStrategyRule, Row } from '@shared/types'
import { anonymizeRow, type AnonymizeContext } from '../../src/main/extract/anonymize'

/** `fake` and `template` behaviour: what gets generated, and what is deliberately left alone. */

function context(
  strategies: Record<string, FieldStrategyRule>,
  identityKey = 'users:1',
  unique: string[] = []
): AnonymizeContext {
  return {
    strategies: new Map(Object.entries(strategies)),
    identityKey,
    rowKey: identityKey,
    faker: baseFaker,
    uniqueColumns: new Set(unique),
    usedValues: new Map()
  }
}

function fakeOne(generator: 'exampleEmail' | 'ipAddress', identityKey: string): string {
  const ctx = context({ value: { kind: 'fake', generator } }, identityKey)
  return anonymizeRow({ value: 'real' } as Row, ctx).value as string
}

describe('fake', () => {
  it('leaves a NULL as NULL instead of inventing a value', () => {
    // A user with no phone keeps no phone. Filling it would add data the source never had.
    const ctx = context({ phone: { kind: 'fake', generator: 'phone' } })
    expect(anonymizeRow({ phone: null } as Row, ctx).phone).toBeNull()
  })

  it('leaves a NULL as NULL on a UNIQUE column too, without spending a unique value on it', () => {
    const ctx = context({ email: { kind: 'fake', generator: 'email' } }, 'users:1', ['email'])
    expect(anonymizeRow({ email: null } as Row, ctx).email).toBeNull()
    expect(ctx.usedValues!.get('email')?.size ?? 0).toBe(0)
  })

  it('still replaces a present value, including an empty string', () => {
    const ctx = context({ phone: { kind: 'fake', generator: 'phone' } })
    expect(anonymizeRow({ phone: '07700 900123' } as Row, ctx).phone).not.toBe('07700 900123')
    expect(anonymizeRow({ phone: '' } as Row, ctx).phone).not.toBe('')
  })

  it('exampleEmail only ever uses the reserved example.com / .org / .net domains', () => {
    const domains = new Set<string>()
    for (let i = 0; i < 300; i++) {
      const email = fakeOne('exampleEmail', `users:${i}`)
      expect(email).toMatch(/^[^@\s]+@example\.(com|org|net)$/)
      domains.add(email.split('@')[1])
    }
    expect(domains.size).toBe(3)
  })

  it('exampleEmail is stable for the same identity, like every other generator', () => {
    const first = fakeOne('exampleEmail', 'users:42')
    baseFaker.seed(999) // disturb the shared faker between calls
    expect(fakeOne('exampleEmail', 'users:42')).toBe(first)
    expect(fakeOne('exampleEmail', 'users:43')).not.toBe(first)
  })

  it('ipAddress produces a dotted-quad IPv4, stable per identity', () => {
    for (let i = 0; i < 300; i++) {
      const ip = fakeOne('ipAddress', `users:${i}`)
      const octets = ip.split('.')
      expect(octets).toHaveLength(4)
      for (const octet of octets) {
        expect(octet).toMatch(/^\d{1,3}$/)
        expect(Number(octet)).toBeLessThanOrEqual(255)
      }
    }
    expect(fakeOne('ipAddress', 'users:7')).toBe(fakeOne('ipAddress', 'users:7'))
  })
})

describe('template', () => {
  const rule: FieldStrategyRule = {
    kind: 'template',
    bindings: [
      { path: 'phone', generator: 'phone' },
      { path: 'ip', generator: 'ipAddress' },
      { path: 'token', action: 'redact' }
    ]
  }

  it('leaves a NULL leaf as NULL and still fakes the present ones', () => {
    const ctx = context({ payload: rule })
    const out = anonymizeRow(
      { payload: JSON.stringify({ phone: null, ip: '192.0.2.1', token: 'secret' }) } as Row,
      ctx
    ).payload as string
    const parsed = JSON.parse(out)

    expect(parsed.phone).toBeNull()
    expect(parsed.ip).not.toBe('192.0.2.1')
    expect(parsed.ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/)
    expect(parsed.token).toBeNull()
    expect(out).not.toContain('secret')
  })

  it('leaves a NULL column as NULL', () => {
    const ctx = context({ payload: rule })
    expect(anonymizeRow({ payload: null } as Row, ctx).payload).toBeNull()
  })
})

describe('ID-keyed emails', () => {
  function email(
    generator: 'userIdEmail' | 'userIdEmailKeepDomain',
    value: unknown,
    identityKey: string,
    unique = false
  ): AnonymizeContext & { out: unknown } {
    const ctx = context(
      { email: { kind: 'fake', generator } },
      identityKey,
      unique ? ['email'] : []
    )
    return { ...ctx, out: anonymizeRow({ email: value } as Row, ctx).email }
  }

  it('builds the address from the identity, so it is the same in every table', () => {
    expect(email('userIdEmail', 'jane@acme.com', 'users:1234').out).toBe('user1234@example.com')
    // A row cascaded from user 1234 carries that identity, whatever table it is in.
    const ctx = context({ contact: { kind: 'fake', generator: 'userIdEmail' } }, 'users:1234')
    expect(anonymizeRow({ contact: 'x@y.com' } as Row, ctx).contact).toBe('user1234@example.com')
  })

  it('keeps the original domain for the keep-domain variant', () => {
    expect(email('userIdEmailKeepDomain', 'jo.staff@acme.com', 'users:7').out).toBe(
      'user7@acme.com'
    )
    expect(email('userIdEmailKeepDomain', 'Jo <jo@acme.com>', 'users:7').out).toBe(
      'user7@example.com'
    )
    expect(email('userIdEmailKeepDomain', 'no-at-sign', 'users:7').out).toBe('user7@example.com')
  })

  it('makes a composite or UUID key safe for an email local part', () => {
    expect(email('userIdEmail', 'a@b.com', 'users:{"a":1,"b":2}').out).toMatch(
      /^user[A-Za-z0-9._-]+@example\.com$/
    )
    expect(email('userIdEmail', 'a@b.com', 'users:3f2a-9c').out).toBe('user3f2a-9c@example.com')
  })

  it('suffixes a repeat on a UNIQUE column instead of emitting a duplicate', () => {
    const ctx = context({ email: { kind: 'fake', generator: 'userIdEmail' } }, 'users:5', ['email'])
    const first = anonymizeRow({ email: 'a@b.com' } as Row, ctx).email
    const second = anonymizeRow({ email: 'c@d.com' } as Row, ctx).email
    expect(first).toBe('user5@example.com')
    expect(second).toBe('user5-1@example.com')
  })

  it('leaves a NULL email as NULL', () => {
    expect(email('userIdEmailKeepDomain', null, 'users:7').out).toBeNull()
  })
})

describe('exceptions', () => {
  const staff: FieldStrategyException = {
    match: 'all',
    conditions: [{ column: 'email', op: 'endsWith', value: '@acme.com' }],
    rule: { kind: 'fake', generator: 'userIdEmailKeepDomain' }
  }

  function withException(
    row: Row,
    exception: FieldStrategyException,
    strategies: Record<string, FieldStrategyRule> = {
      email: { kind: 'fake', generator: 'userIdEmail' }
    },
    exceptionColumn = 'email'
  ): Row {
    const ctx = context(strategies, `users:${row.id}`)
    ctx.exceptions = new Map([[exceptionColumn, exception]])
    ctx.pkColumn = 'id'
    ctx.now = new Date('2026-01-01T00:00:00Z')
    return anonymizeRow(row, ctx)
  }

  it('gives a matching row the exception and any other row the main rule', () => {
    expect(withException({ id: 2, email: 'jo.staff@ACME.com' }, staff).email).toBe('user2@ACME.com')
    expect(withException({ id: 1, email: 'jane@gmail.com' }, staff).email).toBe('user1@example.com')
  })

  it('tests the source values, even when another column was anonymized first', () => {
    // `email` runs before `name`, and the exception on `name` asks about the real email.
    const out = withException(
      { id: 2, email: 'jo.staff@acme.com', name: 'Jo Staff' },
      { ...staff, rule: { kind: 'redact' } },
      {
        email: { kind: 'fake', generator: 'userIdEmail' },
        name: { kind: 'fake', generator: 'fullName' }
      },
      'name'
    )
    expect(out.email).toBe('user2@example.com')
    expect(out.name).toBeNull()
  })

  it('honours match any across several conditions', () => {
    const either: FieldStrategyException = {
      match: 'any',
      conditions: [
        { column: 'email', op: 'endsWith', value: '@acme.com' },
        { column: 'role', op: 'eq', value: 'admin' }
      ],
      rule: { kind: 'redact' }
    }
    expect(withException({ id: 3, email: 'x@gmail.com', role: 'admin' }, either).email).toBeNull()
    expect(withException({ id: 4, email: 'x@gmail.com', role: 'user' }, either).email).toBe(
      'user4@example.com'
    )
  })

  it('ignores an exception with no conditions rather than applying it to every row', () => {
    const empty: FieldStrategyException = { ...staff, conditions: [], rule: { kind: 'preserve' } }
    expect(withException({ id: 1, email: 'jane@gmail.com' }, empty).email).toBe('user1@example.com')
  })
})
