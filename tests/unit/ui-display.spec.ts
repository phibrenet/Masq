import { describe, expect, it } from 'vitest'
import { looksLikePii, unhandledPiiColumns } from '../../src/renderer/src/lib/pii'
import {
  strategyExample,
  strategyLabel,
  templateMapping
} from '../../src/renderer/src/lib/strategyDisplay'

describe('looksLikePii', () => {
  it.each([
    'email',
    'user_email',
    'e-mail',
    'phone_number',
    'mobile',
    'ip_address',
    'first_name',
    'lastname',
    'surname',
    'billing_address',
    'postcode',
    'zip',
    'dob',
    'date_of_birth',
    'passport_no',
    'user_agent',
    'national_insurance'
  ])('flags %s', (name) => {
    expect(looksLikePii(name)).toBe(true)
  })

  it.each([
    'id',
    'status',
    'created_at',
    'total',
    'title',
    'description',
    'stripe_id',
    'unzipped',
    'email_verified_at'
  ])('ignores %s', (name) => {
    expect(looksLikePii(name)).toBe(false)
  })
})

describe('unhandledPiiColumns', () => {
  it('lists suspected columns without a strategy, tables sorted', () => {
    const handled = new Set(['users.email'])
    const found = unhandledPiiColumns(
      { users: ['id', 'email', 'phone'], orders: ['id', 'shipping_address'] },
      (t, c) => handled.has(`${t}.${c}`)
    )
    expect(found).toEqual([
      { table: 'orders', column: 'shipping_address' },
      { table: 'users', column: 'phone' }
    ])
  })
})

describe('strategyLabel', () => {
  it('uses the "Family · detail" format', () => {
    expect(strategyLabel({ kind: 'fake', generator: 'email' })).toBe('Fake · email')
    expect(strategyLabel({ kind: 'redact' })).toBe('Redact · null')
    expect(strategyLabel({ kind: 'preserve' })).toBe('Preserve')
    expect(
      strategyLabel({
        kind: 'template',
        bindings: [
          { path: 'a', generator: 'email' },
          { path: 'b', action: 'redact' }
        ]
      })
    ).toBe('Template · 2 fields')
  })

  it('lists the full template mapping rather than truncating it', () => {
    const bindings = Array.from({ length: 10 }, (_, i) => ({
      path: `p${i}`,
      action: 'remove' as const
    }))
    expect(templateMapping({ kind: 'template', bindings })).toHaveLength(10)
  })
})

describe('strategyExample', () => {
  it('keeps character classes when illustrating obfuscate', () => {
    const [before, after] = strategyExample({ kind: 'obfuscate', side: 'last', count: 6 })!
    expect(after).toHaveLength(before.length)
    expect(after.startsWith('ACE-2024-')).toBe(true)
    expect(after).toMatch(/^ACE-2024-[A-Z]{2}\d{4}$/)
    expect(after).not.toBe(before)
  })

  it('has nothing to show for an empty template', () => {
    expect(strategyExample({ kind: 'template', bindings: [] })).toBeNull()
  })
})
