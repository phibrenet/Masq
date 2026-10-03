import { describe, expect, it } from 'vitest'
import {
  FRAMEWORKS,
  detectFramework,
  frameworkById,
  isFrameworkId,
  presetEntries
} from '../../src/shared/frameworks'

/**
 * The framework catalogue (src/shared/frameworks.ts). Detection is the part worth guarding: it
 * rewrites a workspace's framework, which decides which presets get offered, so a confident wrong
 * answer is far worse than no answer.
 */

describe('detectFramework', () => {
  it('recognises each framework from its own signature', () => {
    expect(detectFramework(['migrations', 'password_reset_tokens', 'users'])).toBe('laravel')
    expect(detectFramework(['schema_migrations', 'ar_internal_metadata', 'users'])).toBe('rails')
    expect(detectFramework(['django_migrations', 'django_content_type', 'auth_user'])).toBe(
      'django'
    )
  })

  it('refuses to call a bare `migrations` table Laravel', () => {
    // `migrations` is a name half the world uses — Phinx, Knex, and plenty of hand-rolled runners.
    // Laravel needs a companion table, or detection would fire on unrelated schemas.
    expect(detectFramework(['migrations', 'users', 'orders'])).toBeNull()
  })

  it('accepts any of the Laravel companion spellings, across versions', () => {
    // Laravel 5 shipped `password_resets`, 7+ `password_reset_tokens`; an app may have installed
    // neither and have only queues. All three have to count.
    expect(detectFramework(['migrations', 'password_resets'])).toBe('laravel')
    expect(detectFramework(['migrations', 'personal_access_tokens'])).toBe('laravel')
    expect(detectFramework(['migrations', 'failed_jobs'])).toBe('laravel')
  })

  it('needs every table in an `all` signature, not just one', () => {
    // Rails is identified by two tables together; `schema_migrations` alone is not Rails-specific
    // enough to act on.
    expect(detectFramework(['schema_migrations', 'users'])).toBeNull()
    expect(detectFramework(['django_migrations', 'users'])).toBeNull()
  })

  it('matches case-insensitively and returns null for an unknown schema', () => {
    expect(detectFramework(['Migrations', 'PASSWORD_RESET_TOKENS'])).toBe('laravel')
    expect(detectFramework(['customers', 'invoices'])).toBeNull()
    expect(detectFramework([])).toBeNull()
  })
})

describe('the catalogue itself', () => {
  it('never puts a table in both the reference and structure lists', () => {
    // The two lists say opposite things about the same rows; an overlap would make which one wins
    // an accident of lookup order.
    for (const f of FRAMEWORKS) {
      const overlap = f.referenceTables.filter((t) => f.structureTables.includes(t))
      expect({ framework: f.id, overlap }).toEqual({ framework: f.id, overlap: [] })
    }
  })

  it('keeps every migration ledger as reference, never structure', () => {
    // The failure this guards is quiet and expensive: an empty migration table tells the framework
    // nothing has run, so the next deploy re-applies every migration onto populated tables.
    const ledgers = ['migrations', 'schema_migrations', 'django_migrations']
    for (const f of FRAMEWORKS) {
      const asStructure = ledgers.filter((l) => f.structureTables.includes(l))
      expect({ framework: f.id, ledgersAsStructure: asStructure }).toEqual({
        framework: f.id,
        ledgersAsStructure: []
      })
    }
  })

  it('has disjoint signatures, so detection order cannot decide the answer', () => {
    // Each framework's own signature tables must identify only itself.
    for (const f of FRAMEWORKS) {
      const ownTables = [...f.signature.all, ...(f.signature.any?.slice(0, 1) ?? [])]
      expect({ framework: f.id, detected: detectFramework(ownTables) }).toEqual({
        framework: f.id,
        detected: f.id
      })
    }
  })

  it('uses lower-case table names throughout, which is what detection compares', () => {
    for (const f of FRAMEWORKS) {
      const wrongCase = presetEntries(f)
        .map((e) => e.tableName)
        .filter((t) => t !== t.toLowerCase())
      expect({ framework: f.id, wrongCase }).toEqual({ framework: f.id, wrongCase: [] })
    }
  })
})

describe('lookup helpers', () => {
  it('resolves a known id and rejects anything else', () => {
    expect(frameworkById('laravel')?.label).toBe('Laravel')
    expect(frameworkById(null)).toBeUndefined()
    expect(isFrameworkId('laravel')).toBe(true)
    expect(isFrameworkId('symfony')).toBe(false)
    expect(isFrameworkId(undefined)).toBe(false)
  })
})
