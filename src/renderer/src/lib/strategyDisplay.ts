import type { FakeGenerator, FieldStrategyKind, FieldStrategyRule } from '@shared/types'

/**
 * How a field strategy reads on screen: a short label for its badge, the full detail for a tooltip,
 * and a representative `before → after` example.
 *
 * The examples are illustrative, not samples: producing a real one would mean reading the source
 * database from the renderer. They show what *kind* of value the strategy writes.
 */

const KIND_LABEL: Record<FieldStrategyKind, string> = {
  preserve: 'Preserve',
  redact: 'Redact',
  fake: 'Fake',
  obfuscate: 'Obfuscate',
  jitter: 'Jitter',
  template: 'Template'
}

/** `Fake · email`, `Redact · null`, `Template · 10 fields`. */
export function strategyLabel(rule: FieldStrategyRule): string {
  const kind = KIND_LABEL[rule.kind]
  switch (rule.kind) {
    case 'fake':
      return `${kind} · ${rule.generator}`
    case 'redact':
      return `${kind} · null`
    case 'jitter':
      return `${kind} · ±${rule.percent}%`
    case 'obfuscate':
      return `${kind} · ${rule.side} ${rule.count}`
    case 'template': {
      const n = rule.bindings.length
      return `${kind} · ${n} field${n === 1 ? '' : 's'}`
    }
    default:
      return kind
  }
}

/** One line per template binding (`path → action`), in full. Empty for other kinds. */
export function templateMapping(rule: FieldStrategyRule): string[] {
  if (rule.kind !== 'template') return []
  return rule.bindings.map((b) => {
    const action = b.action ?? 'fake'
    if (action === 'redact') return `${b.path} → null`
    if (action === 'remove') return `${b.path} → removed`
    return `${b.path} → ${b.generator}`
  })
}

const FAKE_EXAMPLES: Record<FakeGenerator, [string, string]> = {
  firstName: ['Jane', 'Marcus'],
  lastName: ['Doe', 'Okafor'],
  fullName: ['Jane Doe', 'Marcus Okafor'],
  email: ['jane@acme.com', 'k.morris@example.net'],
  phone: ['07700 900123', '01632 960555'],
  streetAddress: ['12 High St', '48 Willow Lane'],
  secondaryAddress: ['Flat 2', 'Apt. 914'],
  city: ['Leeds', 'Bristol'],
  state: ['Yorkshire', 'Somerset'],
  zipCode: ['LS1 4AP', 'BS8 2QT'],
  country: ['United Kingdom', 'Portugal'],
  countryCode: ['GB', 'PT'],
  creditCardNumber: ['4111 1111 1111 1111', '5425 2334 3010 9903'],
  creditCardCVV: ['123', '871'],
  iban: ['GB29NWBK60161331926819', 'GB82WEST12345698765432'],
  companyName: ['Acme Ltd', 'Hartley & Sons'],
  loremWords: ['Quarterly review', 'vitae sed dolor'],
  loremSentence: ['Call me back re: order', 'Tempora cum soluta nobis.'],
  loremParagraph: ['Customer said…', 'Lorem ipsum dolor sit…'],
  dateOfBirth: ['1984-03-12', '1991-11-07'],
  avatarUrl: ['…/me.jpg', '…/avatars/42.jpg'],
  url: ['https://jane.dev', 'https://example.net/']
}

/** A representative `[before, after]` for a rule, or `null` when there's nothing useful to show. */
export function strategyExample(rule: FieldStrategyRule): [string, string] | null {
  switch (rule.kind) {
    case 'fake':
      return FAKE_EXAMPLES[rule.generator] ?? null
    case 'redact':
      return ['jane@acme.com', 'NULL']
    case 'preserve':
      return ['jane@acme.com', 'jane@acme.com']
    case 'jitter':
      // A value inside the ±percent band — half the maximum shift upwards.
      return ['1000.00', (1000 * (1 + rule.percent / 200)).toFixed(2)]
    case 'obfuscate': {
      // Character class is preserved (letter → letter, digit → digit), so the example does the same.
      const before = 'ACE-2024-XY7781'
      const scrambled = 'QMRV3419KT'
      const chars = [...before]
      let replaced = 0
      const order = rule.side === 'last' ? [...chars.keys()].reverse() : [...chars.keys()]
      for (const i of order) {
        if (replaced >= rule.count) break
        const c = chars[i]
        if (/[A-Z]/.test(c)) chars[i] = scrambled[replaced % 4]
        else if (/\d/.test(c)) chars[i] = scrambled[4 + (replaced % 4)]
        else continue
        replaced++
      }
      return [before, chars.join('')]
    }
    case 'template': {
      const n = rule.bindings.length
      return n === 0 ? null : ['{ … }', `{ … } ${n} path${n === 1 ? '' : 's'} rewritten`]
    }
    default:
      return null
  }
}
