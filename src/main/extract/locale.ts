import {
  Faker,
  base,
  en,
  en_US,
  en_GB,
  nl,
  de,
  fr,
  es,
  it,
  type LocaleDefinition
} from '@faker-js/faker'

/**
 * Data-driven faker locale (spec §8): map a row's country-column value to a locale-appropriate
 * `Faker` instance, so fake postcodes/phones/addresses are formatted for that country. The country
 * column holds a direct value (ISO alpha-2 or country name) — NOT an FK id (confirmed with the
 * user, see decisions.md) — so we normalize the raw value and look it up directly.
 *
 * Each locale falls back through `en → base` so any generator the specific locale lacks still
 * produces a value. Unknown/blank values fall back to `en`. Extend `CHAINS`/`ALIASES` as needed.
 */
const CHAINS: Record<string, LocaleDefinition[]> = {
  GB: [en_GB, en, base],
  US: [en_US, en, base],
  NL: [nl, en, base],
  DE: [de, en, base],
  FR: [fr, en, base],
  ES: [es, en, base],
  IT: [it, en, base],
  EN: [en, base]
}

/** Country names / alternate codes → a `CHAINS` key. Keys are compared upper-cased and trimmed. */
const ALIASES: Record<string, string> = {
  UK: 'GB',
  'UNITED KINGDOM': 'GB',
  'GREAT BRITAIN': 'GB',
  ENGLAND: 'GB',
  SCOTLAND: 'GB',
  WALES: 'GB',
  USA: 'US',
  'UNITED STATES': 'US',
  'UNITED STATES OF AMERICA': 'US',
  NETHERLANDS: 'NL',
  HOLLAND: 'NL',
  GERMANY: 'DE',
  DEUTSCHLAND: 'DE',
  FRANCE: 'FR',
  SPAIN: 'ES',
  ESPANA: 'ES',
  ITALY: 'IT',
  ITALIA: 'IT'
}

/** Normalize a raw country value to a CHAINS key, defaulting to EN. */
export function localeKey(raw: unknown): string {
  if (raw == null) return 'EN'
  const norm = String(raw).trim().toUpperCase()
  if (norm in CHAINS) return norm
  if (norm in ALIASES) return ALIASES[norm]
  return 'EN'
}

const cache = new Map<string, Faker>()

/** A cached `Faker` instance for a raw country value (data-driven locale). */
export function fakerFor(rawCountry: unknown): Faker {
  const key = localeKey(rawCountry)
  let instance = cache.get(key)
  if (!instance) {
    instance = new Faker({ locale: CHAINS[key] })
    cache.set(key, instance)
  }
  return instance
}
