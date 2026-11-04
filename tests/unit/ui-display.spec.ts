import { describe, expect, it } from 'vitest'
import { looksLikePii, unhandledPiiColumns } from '../../src/renderer/src/lib/pii'
import {
  exceptionSummary,
  strategyExample,
  strategyLabel,
  templateMapping
} from '../../src/renderer/src/lib/strategyDisplay'
import { ruleDraftFrom, ruleFromDraft, blankRuleDraft } from '../../src/renderer/src/lib/ruleDraft'
import { toCondition, toDraft } from '../../src/renderer/src/lib/conditionDraft'
import type { ColumnInfo, Condition, ExceptionRule } from '@shared/types'
import {
  LEAVE_AS_IS,
  REDACT,
  REMOVE,
  bindingChoice,
  bindingFromChoice
} from '../../src/renderer/src/lib/templateBindings'

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

  it('illustrates obfuscate-before by keeping everything from the delimiter on', () => {
    const rule = { kind: 'obfuscate', side: 'before', delimiter: '@' } as const
    expect(strategyLabel(rule)).toBe('Obfuscate · before "@"')
    const [before, after] = strategyExample(rule)!
    expect(before).toBe('jane.doe@acme.com')
    expect(after).toMatch(/^[a-z]{4}\.[a-z]{3}@acme\.com$/)
    expect(after).not.toBe(before)
  })

  it('has nothing to show for an empty template', () => {
    expect(strategyExample({ kind: 'template', bindings: [] })).toBeNull()
  })
})

describe('template binding choices', () => {
  it('saves Redact and Remove as actions, never as a generator name', () => {
    // A sentinel stored as `generator` is skipped by the engine, which leaves the real value in place.
    expect(bindingFromChoice(' ip ', REDACT)).toEqual({ path: 'ip', action: 'redact' })
    expect(bindingFromChoice('password', REMOVE)).toEqual({ path: 'password', action: 'remove' })
    expect(bindingFromChoice('name', 'fullName')).toEqual({ path: 'name', generator: 'fullName' })
  })

  it('stores nothing for a path left as-is or with no path', () => {
    expect(bindingFromChoice('ip', LEAVE_AS_IS)).toBeNull()
    expect(bindingFromChoice('ip', undefined)).toBeNull()
    expect(bindingFromChoice('   ', 'fullName')).toBeNull()
  })

  it('round-trips every kind of binding through the dropdown value', () => {
    const bindings = [
      { path: 'ip', action: 'redact' as const },
      { path: 'password', action: 'remove' as const },
      { path: 'name', generator: 'fullName' as const }
    ]
    for (const b of bindings) expect(bindingFromChoice(b.path, bindingChoice(b))).toEqual(b)
  })
})

describe('rule drafts', () => {
  it('round-trips every non-template rule through the form', () => {
    const rules: ExceptionRule[] = [
      { kind: 'preserve' },
      { kind: 'redact' },
      { kind: 'fake', generator: 'userIdEmailKeepDomain' },
      { kind: 'jitter', percent: 15 },
      { kind: 'obfuscate', side: 'first', count: 8 },
      { kind: 'obfuscate', side: 'before', delimiter: ' <' }
    ]
    for (const rule of rules) expect(ruleFromDraft(ruleDraftFrom(rule))).toEqual(rule)
  })

  it('refuses to turn a template draft into some other rule', () => {
    expect(() => ruleFromDraft(blankRuleDraft('template'))).toThrow(/template/)
  })
})

describe('condition drafts', () => {
  const columns: ColumnInfo[] = [
    { name: 'email', dataType: 'varchar(255)', nullable: true, isPrimaryKey: false },
    { name: 'created_at', dataType: 'datetime', nullable: false, isPrimaryKey: false }
  ]

  it('round-trips each value shape through the form', () => {
    const conditions: Condition[] = [
      { column: 'email', op: 'endsWith', value: '@acme.com' },
      { column: 'email', op: 'notIn', value: ['a@b.com', 'c@d.com'], includeNulls: false },
      { column: 'created_at', op: 'withinLast', value: { n: 30, unit: 'day' } },
      { column: 'email', op: 'isNull' }
    ]
    for (const c of conditions) expect(toCondition(toDraft(c), columns)).toEqual(c)
  })
})

describe('exceptionSummary', () => {
  it('reads as the rule followed by its conditions', () => {
    expect(
      exceptionSummary({
        match: 'any',
        conditions: [
          { column: 'email', op: 'endsWith', value: '@acme.com' },
          { column: 'role', op: 'eq', value: 'admin' }
        ],
        rule: { kind: 'fake', generator: 'userIdEmailKeepDomain' }
      })
    ).toMatch(/^Fake · userIdEmailKeepDomain where email .*"@acme\.com" or role .*"admin"$/)
  })
})
