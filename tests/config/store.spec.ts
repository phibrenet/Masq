import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/main/config/db'
import { runMigrations } from '../../src/main/config/migrate'
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace
} from '../../src/main/config/repositories/workspaces'
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnectionsByWorkspace,
  updateConnection
} from '../../src/main/config/repositories/connections'
import {
  createSelectionRule,
  deleteSelectionRule,
  getSelectionRule,
  listSelectionRulesByWorkspace,
  updateSelectionRule
} from '../../src/main/config/repositories/selection-rules'
import {
  createFieldStrategy,
  deleteFieldStrategy,
  getFieldStrategy,
  listFieldStrategiesByWorkspace,
  updateFieldStrategy
} from '../../src/main/config/repositories/field-strategies'
import {
  applyFrameworkPresets,
  listTableClassificationsByWorkspace,
  setTableClassification
} from '../../src/main/config/repositories/table-classifications'
import { setTableLocaleSource } from '../../src/main/config/repositories/table-locale-sources'
import { setTableIdentitySource } from '../../src/main/config/repositories/table-identity-sources'
import { createMorphRelation } from '../../src/main/config/repositories/morph-relations'
import { setFkBackfillPolicy } from '../../src/main/config/repositories/fk-backfill-policies'
import {
  exportWorkspaceConfig,
  importWorkspaceConfig,
  parseWorkspaceTransfer
} from '../../src/main/config/workspace-transfer'

const userData = mkdtempSync(join(tmpdir(), 'masq-store-spec-'))
const previousUserData = process.env.MASQ_TEST_USERDATA
process.env.MASQ_TEST_USERDATA = userData

const MIGRATION_COUNT = 16

beforeAll(() => {
  runMigrations()
})

afterAll(() => {
  getDb().close()
  if (previousUserData === undefined) delete process.env.MASQ_TEST_USERDATA
  else process.env.MASQ_TEST_USERDATA = previousUserData
  rmSync(userData, { recursive: true, force: true })
})

function appliedVersions(): number[] {
  return (
    getDb().prepare('SELECT version FROM _migrations ORDER BY version').all() as {
      version: number
    }[]
  ).map((r) => r.version)
}

describe('config store migrations', () => {
  it('applies every migration exactly once', () => {
    expect(appliedVersions()).toEqual(Array.from({ length: MIGRATION_COUNT }, (_, i) => i + 1))
  })

  it('is idempotent on a second run', () => {
    const before = appliedVersions()
    runMigrations()

    expect(appliedVersions()).toEqual(before)
    expect(before).toHaveLength(MIGRATION_COUNT)
  })
})

describe('workspace CRUD', () => {
  it('round-trips with the documented default dump output mode', () => {
    const ws = createWorkspace({ name: 'Spec Workspace' })

    expect(ws.id).toBeTruthy()
    expect(ws.name).toBe('Spec Workspace')
    expect(ws.dumpOutputMode).toBe('combined')
    expect(ws.createdAt).toBeTruthy()
    expect(ws.updatedAt).toBeTruthy()
    expect(listWorkspaces()).toContainEqual(ws)
  })

  it('defaults dropping existing tables on, and lets a workspace turn it off', () => {
    // Migration 012 defaults the column to 1 rather than 0: a dump that cannot be loaded twice is
    // a bug in whichever workspace produced it, not a preference. Off is the opt-out, for a target
    // database holding data the recipient keeps.
    expect(createWorkspace({ name: 'Drops default' }).dropExistingTables).toBe(true)

    const off = createWorkspace({ name: 'Drops off', dropExistingTables: false })
    expect(off.dropExistingTables).toBe(false)
    expect(updateWorkspace(off.id, { dropExistingTables: true })!.dropExistingTables).toBe(true)
  })

  it('merges an update patch and reports undefined for a missing id', () => {
    const ws = createWorkspace({ name: 'Before', dumpOutputMode: 'combined' })

    const updated = updateWorkspace(ws.id, { name: 'After', dumpOutputMode: 'split' })

    expect(updated).toMatchObject({ id: ws.id, name: 'After', dumpOutputMode: 'split' })
    expect(updateWorkspace('no-such-id', { name: 'x' })).toBeUndefined()
  })

  it('treats a blank dump folder as unset, and lets one be cleared back to the default', () => {
    // Absent and blank must read identically, or a cleared text field would mean "write dumps to
    // `''`". And clearing has to be *possible*: a `patch.x ?? existing.x` merge would silently
    // refuse it, leaving no way back to the default once a folder had been chosen.
    const ws = createWorkspace({ name: 'Folders', dumpOutputDir: '  ' })
    expect(ws.dumpOutputDir).toBeUndefined()

    const folder = join(tmpdir(), 'masq-dumps')
    const set = updateWorkspace(ws.id, { dumpOutputDir: folder })!
    expect(set.dumpOutputDir).toBe(folder)

    const cleared = updateWorkspace(ws.id, { dumpOutputDir: '' })!
    expect(cleared.dumpOutputDir).toBeUndefined()

    // A patch that doesn't mention the folder leaves it alone.
    const reset = updateWorkspace(ws.id, { dumpOutputDir: folder })!
    expect(updateWorkspace(reset.id, { name: 'Renamed' })!.dumpOutputDir).toBe(folder)
  })

  it('stores only absolute dump folders, expanding ~ and rejecting relative paths', () => {
    // The column must hold paths that mean the same thing wherever the app is launched from. A
    // relative one would resolve against the packaged app's working directory — unpredictable, often
    // unwritable — and `~` is shell syntax Node would take literally.
    const ws = createWorkspace({ name: 'Paths', dumpOutputDir: '~/Desktop/masq' })
    expect(ws.dumpOutputDir).toBe(join(homedir(), 'Desktop/masq'))

    expect(() => updateWorkspace(ws.id, { dumpOutputDir: 'dumps' })).toThrow(/full path/i)
    expect(() => createWorkspace({ name: 'Bad', dumpOutputDir: '../escape' })).toThrow(/full path/i)
    // The rejected update left the stored value alone.
    expect(getWorkspace(ws.id)!.dumpOutputDir).toBe(join(homedir(), 'Desktop/masq'))
  })

  it('deletes a workspace and cascades to its connections', () => {
    expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1)

    const ws = createWorkspace({ name: 'Doomed' })
    const conn = createConnection({
      workspaceId: ws.id,
      label: 'Src',
      dialect: 'postgres',
      role: 'source',
      host: 'db.example.com',
      port: 5432,
      database: 'app',
      username: 'ro'
    })

    deleteWorkspace(ws.id)

    expect(getWorkspace(ws.id)).toBeUndefined()
    expect(listConnectionsByWorkspace(ws.id)).toEqual([])
    expect(getConnection(conn.id)).toBeUndefined()
  })
})

describe('migration 013 — the structure table class', () => {
  it('accepts every class including structure, and still rejects an unknown one', () => {
    // The rebuild widened a CHECK constraint, so the guard has to be shown still guarding.
    const ws = createWorkspace({ name: 'Classes' })
    for (const klass of ['transactional', 'reference', 'structure', 'excluded'] as const) {
      const saved = setTableClassification({
        workspaceId: ws.id,
        tableName: `t_${klass}`,
        class: klass
      })
      expect(saved.class).toBe(klass)
    }

    expect(() =>
      setTableClassification({
        workspaceId: ws.id,
        tableName: 'bad',
        // Deliberately outside `TableClass` — the CHECK is the last line of defence.
        class: 'archived' as never
      })
    ).toThrow(/constraint/i)
  })

  it('carries an existing classification through the table rebuild', () => {
    // 013 recreates `table_classifications`; nothing may be rewritten or lost on the way.
    const ws = createWorkspace({ name: 'Survives rebuild' })
    setTableClassification({ workspaceId: ws.id, tableName: 'users', class: 'reference' })

    runMigrations()

    expect(listTableClassificationsByWorkspace(ws.id)).toContainEqual(
      expect.objectContaining({ tableName: 'users', class: 'reference' })
    )
  })
})

describe('migration 014 — framework presets mean structure, not excluded', () => {
  it('repairs a preset table that was excluded, and leaves other exclusions alone', () => {
    // The tables the old preset button wrote `excluded` on are the ones to repair: they carry no
    // useful data, but the app writes to them on first use, so the dump has to create them.
    const ws = createWorkspace({ name: 'Preset repair' })
    setTableClassification({ workspaceId: ws.id, tableName: 'sessions', class: 'excluded' })
    setTableClassification({ workspaceId: ws.id, tableName: 'cache', class: 'excluded' })
    // Not a preset name — someone excluded this deliberately and must keep that choice.
    setTableClassification({ workspaceId: ws.id, tableName: 'legacy_audit', class: 'excluded' })
    // A preset name the user moved off `excluded` themselves: also not ours to rewrite.
    setTableClassification({ workspaceId: ws.id, tableName: 'jobs', class: 'transactional' })

    getDb().prepare('DELETE FROM _migrations WHERE version = 14').run()
    runMigrations()

    const byName = new Map(
      listTableClassificationsByWorkspace(ws.id).map((c) => [c.tableName, c.class])
    )
    expect(byName.get('sessions')).toBe('structure')
    expect(byName.get('cache')).toBe('structure')
    expect(byName.get('legacy_audit')).toBe('excluded')
    expect(byName.get('jobs')).toBe('transactional')
  })
})

describe('framework presets — provenance makes re-applying a repair', () => {
  it("classifies a framework's tables and tags where they came from", () => {
    const ws = createWorkspace({ name: 'Laravel presets', framework: 'laravel' })

    const result = applyFrameworkPresets(ws.id, 'laravel')

    const byName = new Map(listTableClassificationsByWorkspace(ws.id).map((c) => [c.tableName, c]))
    expect(result.skippedManual).toEqual([])
    expect(byName.get('sessions')).toMatchObject({ class: 'structure', source: 'preset:laravel' })
    // The migration ledger is `reference`, not `structure` — its rows are what tell the framework
    // the schema is already up to date.
    expect(byName.get('migrations')).toMatchObject({ class: 'reference', source: 'preset:laravel' })
  })

  it('never overwrites a hand-set classification, and names what it skipped', () => {
    const ws = createWorkspace({ name: 'Manual wins', framework: 'laravel' })
    setTableClassification({ workspaceId: ws.id, tableName: 'jobs', class: 'transactional' })

    const result = applyFrameworkPresets(ws.id, 'laravel')

    const jobs = listTableClassificationsByWorkspace(ws.id).find((c) => c.tableName === 'jobs')!
    expect(jobs).toMatchObject({ class: 'transactional', source: 'manual' })
    expect(result.skippedManual).toContain('jobs')
  })

  it('refreshes a row it wrote before when the catalogue has moved on', () => {
    // The drift this exists to fix: a preset list that gains a table, or changes a class, must be
    // able to reach workspaces that already ran it. Simulated by moving a preset row off its class
    // while leaving the provenance tag in place.
    const ws = createWorkspace({ name: 'Refresh', framework: 'laravel' })
    applyFrameworkPresets(ws.id, 'laravel')
    setTableClassification({
      workspaceId: ws.id,
      tableName: 'sessions',
      class: 'excluded',
      source: 'preset:laravel'
    })

    const result = applyFrameworkPresets(ws.id, 'laravel')

    const sessions = listTableClassificationsByWorkspace(ws.id).find(
      (c) => c.tableName === 'sessions'
    )!
    expect(sessions.class).toBe('structure')
    expect(result.refreshed).toBe(1)
  })

  it('is a no-op the second time nothing has changed', () => {
    const ws = createWorkspace({ name: 'Idempotent', framework: 'laravel' })
    applyFrameworkPresets(ws.id, 'laravel')

    expect(applyFrameworkPresets(ws.id, 'laravel')).toEqual({
      added: 0,
      refreshed: 0,
      skippedManual: []
    })
  })

  it("leaves another framework's preset rows alone", () => {
    // A database that genuinely hosts two frameworks, or a workspace someone re-pointed. Rows
    // tagged to a different framework are not this one's to rewrite.
    const ws = createWorkspace({ name: 'Two frameworks', framework: 'rails' })
    applyFrameworkPresets(ws.id, 'laravel')

    const result = applyFrameworkPresets(ws.id, 'rails')

    const sessions = listTableClassificationsByWorkspace(ws.id).find(
      (c) => c.tableName === 'sessions'
    )!
    expect(sessions.source).toBe('preset:laravel')
    expect(result.skippedManual).toContain('sessions')
  })

  it('rejects an unknown framework id rather than writing nothing quietly', () => {
    const ws = createWorkspace({ name: 'Bad framework' })

    expect(() => applyFrameworkPresets(ws.id, 'symfony' as never)).toThrow(/unknown framework/i)
    expect(() => createWorkspace({ name: 'Bad ws', framework: 'symfony' as never })).toThrow(
      /unknown framework/i
    )
  })

  it('round-trips the workspace framework, including clearing it', () => {
    const ws = createWorkspace({ name: 'Framework field', framework: 'rails' })
    expect(ws.framework).toBe('rails')

    expect(updateWorkspace(ws.id, { framework: 'django' })!.framework).toBe('django')
    // Clearing back to "no framework" has to be possible, like the dump folder.
    expect(updateWorkspace(ws.id, { framework: null })!.framework).toBeUndefined()
  })
})

describe('obfuscate field strategy', () => {
  it('round-trips side and count', () => {
    const ws = createWorkspace({ name: 'Obfuscate' })

    const created = createFieldStrategy({
      workspaceId: ws.id,
      tableName: 'users',
      columnName: 'reference',
      rule: { kind: 'obfuscate', side: 'first', count: 8 }
    })

    expect(created.rule).toEqual({ kind: 'obfuscate', side: 'first', count: 8 })
    expect(getFieldStrategy(created.id)!.rule).toEqual(created.rule)
  })

  it('raises a count below the minimum instead of storing it', () => {
    // The floor lives at the repository boundary rather than in a CHECK, so it has to hold for
    // every caller — including one that skips the form's own validation.
    const ws = createWorkspace({ name: 'Obfuscate floor' })

    const created = createFieldStrategy({
      workspaceId: ws.id,
      tableName: 'users',
      columnName: 'reference',
      rule: { kind: 'obfuscate', side: 'last', count: 2 }
    })

    expect(created.rule).toMatchObject({ count: 6 })
  })

  it("does not leave another kind's columns populated when the rule changes", () => {
    // The flat columns are shared across kinds; a stale `obfuscate_side` would resurface if the
    // strategy were later switched back without being cleared.
    const ws = createWorkspace({ name: 'Obfuscate switch' })
    const created = createFieldStrategy({
      workspaceId: ws.id,
      tableName: 'users',
      columnName: 'reference',
      rule: { kind: 'obfuscate', side: 'first', count: 9 }
    })

    const updated = updateFieldStrategy(created.id, { rule: { kind: 'redact' } })!
    expect(updated.rule).toEqual({ kind: 'redact' })

    const row = getDb()
      .prepare('SELECT obfuscate_side, obfuscate_count FROM field_strategies WHERE id = ?')
      .get(created.id) as { obfuscate_side: string | null; obfuscate_count: number | null }
    expect(row).toEqual({ obfuscate_side: null, obfuscate_count: null })
  })
})

describe('workspace transfer', () => {
  it('rejects an obfuscate rule that would hide less than the minimum', () => {
    // Rejected rather than clamped, unlike the repository: a shared file asking for 3 characters was
    // written by someone who believed 3 was enough, and importing it as 6 would hide that from them.
    const ws = createWorkspace({ name: 'Obfuscate transfer' })
    createFieldStrategy({
      workspaceId: ws.id,
      tableName: 'users',
      columnName: 'reference',
      rule: { kind: 'obfuscate', side: 'last', count: 7 }
    })
    const file = JSON.parse(JSON.stringify(exportWorkspaceConfig(ws.id)))

    expect(file.fieldStrategies[0].rule).toEqual({ kind: 'obfuscate', side: 'last', count: 7 })
    expect(() => parseWorkspaceTransfer(file)).not.toThrow()

    file.fieldStrategies[0].rule.count = 3
    expect(() => parseWorkspaceTransfer(file)).toThrow(/at least 6/i)

    file.fieldStrategies[0].rule.count = 7
    file.fieldStrategies[0].rule.side = 'middle'
    expect(() => parseWorkspaceTransfer(file)).toThrow(/side/i)
  })

  it('round-trips every portable setting with fresh IDs and no local or secret data', () => {
    const privateDumpDir = join(tmpdir(), 'private-dumps')
    const source = createWorkspace({
      name: 'Share me',
      dumpOutputMode: 'split',
      dumpOutputDir: privateDumpDir
    })
    const connection = createConnection({
      workspaceId: source.id,
      label: 'Production',
      dialect: 'mysql',
      role: 'source',
      host: 'private-db.example',
      username: 'private-user'
    })
    getDb()
      .prepare('INSERT INTO credentials (connection_id, encrypted_password) VALUES (?, ?)')
      .run(connection.id, Buffer.from('secret-credential'))
    setTableClassification({ workspaceId: source.id, tableName: 'logs', class: 'excluded' })
    createSelectionRule({
      workspaceId: source.id,
      table: 'users',
      match: 'all',
      where: [{ column: 'email', op: 'endsWith', value: '@example.com' }],
      take: { kind: 'none' },
      anonymize: false
    })
    createFieldStrategy({
      workspaceId: source.id,
      tableName: 'users',
      columnName: 'profile',
      rule: { kind: 'template', bindings: [{ path: 'address.city', generator: 'city' }] }
    })
    setTableLocaleSource({
      workspaceId: source.id,
      tableName: 'users',
      countryColumn: 'address',
      countryPath: 'country'
    })
    setTableIdentitySource({
      workspaceId: source.id,
      tableName: 'orders',
      identityColumn: 'user_id',
      identityTable: 'users'
    })
    createMorphRelation({
      workspaceId: source.id,
      tableName: 'model_has_roles',
      typeColumn: 'model_type',
      idColumn: 'model_id',
      cascadeDown: false,
      backfillUp: true,
      typeMap: [{ typeValue: 'App\\Models\\User', targetTable: 'users' }]
    })
    setFkBackfillPolicy({
      workspaceId: source.id,
      tableName: 'orders',
      columnName: 'actor_id',
      policy: 'null'
    })

    const file = JSON.parse(JSON.stringify(exportWorkspaceConfig(source.id)))
    const text = JSON.stringify(file)
    expect(text).not.toContain(source.id)
    expect(text).not.toContain('private-db.example')
    expect(text).not.toContain('private-user')
    expect(text).not.toContain('secret-credential')
    expect(text).not.toContain(JSON.stringify(privateDumpDir).slice(1, -1))
    expect(() => parseWorkspaceTransfer({ ...file, version: 2 })).toThrow(/version/i)
    expect(() => parseWorkspaceTransfer({ ...file, credentials: [] })).toThrow(/not supported/i)
    expect(() =>
      parseWorkspaceTransfer({
        ...file,
        selectionRules: [{ ...file.selectionRules[0], take: { kind: 'sample' } }]
      })
    ).toThrow(/count/i)

    const imported = importWorkspaceConfig(file, 'Shared copy')
    expect(imported.id).not.toBe(source.id)
    expect(listConnectionsByWorkspace(imported.id)).toEqual([])
    expect(exportWorkspaceConfig(imported.id)).toMatchObject({
      ...file,
      workspace: { name: 'Shared copy', dumpOutputMode: 'split' }
    })
    expect(importWorkspaceConfig.bind(null, file, 'Shared copy')).toThrow(/already exists/i)
  })

  it('rolls back a partial import when a later setting cannot be saved', () => {
    const source = createWorkspace({ name: 'Rollback source' })
    createFieldStrategy({
      workspaceId: source.id,
      tableName: 'users',
      columnName: 'email',
      rule: { kind: 'fake', generator: 'email' }
    })
    const file = exportWorkspaceConfig(source.id)
    getDb().exec(
      "CREATE TEMP TRIGGER block_transfer BEFORE INSERT ON field_strategies BEGIN SELECT RAISE(ABORT, 'blocked'); END"
    )
    try {
      expect(() => importWorkspaceConfig(file, 'Rolled back')).toThrow(/blocked/i)
      expect(listWorkspaces().some((w) => w.name === 'Rolled back')).toBe(false)
    } finally {
      getDb().exec('DROP TRIGGER block_transfer')
    }
  })

  it('carries the drop-tables choice, and imports a file exported before it existed', () => {
    const source = createWorkspace({ name: 'Drops carried', dropExistingTables: false })

    const file = JSON.parse(JSON.stringify(exportWorkspaceConfig(source.id)))
    expect(file.workspace.dropExistingTables).toBe(false)
    expect(importWorkspaceConfig(file, 'Drops copy').dropExistingTables).toBe(false)

    // A file written by a build that predates migration 012 has no such key. Rejecting it as
    // malformed would strand every config a team has already shared, so absent falls through to
    // the column default instead.
    delete file.workspace.dropExistingTables
    expect(importWorkspaceConfig(file, 'Legacy file').dropExistingTables).toBe(true)

    file.workspace.dropExistingTables = 'yes'
    expect(() => importWorkspaceConfig(file, 'Bad type')).toThrow(/true or false/i)
  })
})

describe('connection CRUD', () => {
  it('round-trips a Postgres connection including its raw search path', () => {
    const ws = createWorkspace({ name: 'PG Roundtrip' })

    const created = createConnection({
      workspaceId: ws.id,
      label: 'Replica',
      dialect: 'postgres',
      role: 'source',
      host: 'replica.internal',
      port: 5432,
      database: 'tenant_db',
      username: 'subsetter_ro',
      searchPath: '"tenant,archive", public'
    })

    expect(created).toEqual({
      id: created.id,
      workspaceId: ws.id,
      label: 'Replica',
      dialect: 'postgres',
      role: 'source',
      host: 'replica.internal',
      port: 5432,
      database: 'tenant_db',
      username: 'subsetter_ro',
      searchPath: '"tenant,archive", public',
      filePath: undefined
    })

    const patched = updateConnection(created.id, { label: 'Renamed' })
    expect(patched).toMatchObject({ label: 'Renamed', host: 'replica.internal', port: 5432 })
  })

  it('stores a file-based SQLite connection with server fields absent, not null', () => {
    const ws = createWorkspace({ name: 'SQLite Conn' })

    const conn = createConnection({
      workspaceId: ws.id,
      label: 'Snapshot',
      dialect: 'sqlite',
      role: 'source',
      filePath: '/tmp/snapshot.sqlite'
    })
    const read = getConnection(conn.id)!

    expect(read.dialect).toBe('sqlite')
    expect(read.filePath).toBe('/tmp/snapshot.sqlite')
    expect(read.host).toBeUndefined()
    expect(read.port).toBeUndefined()
    expect(read.database).toBeUndefined()
    expect(read.username).toBeUndefined()
    expect(read.searchPath).toBeUndefined()

    deleteConnection(conn.id)
    expect(getConnection(conn.id)).toBeUndefined()
  })
})

describe('selection-rule CRUD', () => {
  it('round-trips the two motivating rules, conditions and take intact', () => {
    const ws = createWorkspace({ name: 'Rules' })

    // "users with no work email, created in the last 90 days, take 20, anonymize" — the rule v1
    // could not express at all (docs/selection-rules-v2.md).
    const recent = createSelectionRule({
      workspaceId: ws.id,
      table: 'users',
      match: 'all',
      where: [
        { column: 'email', op: 'notContains', value: '@staff.example.com', includeNulls: true },
        { column: 'created_at', op: 'withinLast', value: { n: 90, unit: 'day' } }
      ],
      take: { kind: 'sample', count: 20 },
      anonymize: true
    })

    const read = getSelectionRule(recent.id)!
    expect(read.match).toBe('all')
    expect(read.where).toHaveLength(2)
    expect(read.where[0]).toEqual({
      column: 'email',
      op: 'notContains',
      value: '@staff.example.com',
      includeNulls: true
    })
    expect(read.where[1].value).toEqual({ n: 90, unit: 'day' })
    expect(read.take).toEqual({ kind: 'sample', count: 20 })
    expect(read.anonymize).toBe(true)

    const staff = createSelectionRule({
      workspaceId: ws.id,
      table: 'users',
      match: 'all',
      where: [{ column: 'email', op: 'contains', value: '@staff.example.com' }],
      take: { kind: 'all' },
      anonymize: false
    })
    expect(getSelectionRule(staff.id)!.anonymize).toBe(false)
    expect(listSelectionRulesByWorkspace(ws.id)).toHaveLength(2)
  })

  it('round-trips `in` values of mixed type, and the null-column PK sentinel', () => {
    const ws = createWorkspace({ name: 'Explicit Rules' })

    // What migration 010 rewrites a v1 `explicit` rule into: `column: null` = "the primary key",
    // resolved at extract time because the config store holds no schema.
    const rule = createSelectionRule({
      workspaceId: ws.id,
      table: 'orders',
      match: 'all',
      where: [{ column: null, op: 'in', value: ['REF-1', 42] }],
      take: { kind: 'all' },
      anonymize: true
    })
    const read = getSelectionRule(rule.id)!

    expect(read.where[0].column).toBeNull()
    expect(read.where[0].value).toEqual(['REF-1', 42])
  })

  it('round-trips a flag-only rule, which needs no migration of its own', () => {
    const ws = createWorkspace({ name: 'Flags' })

    // "Preserve our staff" without seeding all 282 of them — the take is stored in the same JSON
    // column as every other kind, so `none` costs no schema change.
    const rule = createSelectionRule({
      workspaceId: ws.id,
      table: 'users',
      match: 'all',
      where: [{ column: 'email', op: 'endsWith', value: '@staff.example.com' }],
      take: { kind: 'none' },
      anonymize: false
    })

    expect(getSelectionRule(rule.id)!.take).toEqual({ kind: 'none' })
  })

  it('keeps rawWhere and conditions mutually exclusive', () => {
    const ws = createWorkspace({ name: 'Raw' })

    // One filter mechanism per rule: storing a raw predicate drops the conditions rather than
    // leaving a stale list that nothing will ever read.
    const rule = createSelectionRule({
      workspaceId: ws.id,
      table: 'users',
      match: 'all',
      where: [{ column: 'email', op: 'contains', value: '@old.com' }],
      rawWhere: 'EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id)',
      take: { kind: 'all' },
      anonymize: true
    })

    expect(rule.where).toEqual([])
    expect(rule.rawWhere).toBe('EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id)')
  })

  it('replaces conditions and take wholesale on update', () => {
    const ws = createWorkspace({ name: 'Switching' })

    const rule = createSelectionRule({
      workspaceId: ws.id,
      table: 'users',
      match: 'all',
      where: [{ column: 'email', op: 'matches', value: '@old$' }],
      take: { kind: 'all' },
      anonymize: true
    })

    const switched = updateSelectionRule(rule.id, {
      where: [],
      take: { kind: 'top', count: 7, orderBy: 'created_at', dir: 'desc' }
    })!

    expect(switched.where).toEqual([])
    expect(switched.take).toEqual({ kind: 'top', count: 7, orderBy: 'created_at', dir: 'desc' })

    expect(listSelectionRulesByWorkspace(ws.id)).toHaveLength(1)
    deleteSelectionRule(rule.id)
    expect(listSelectionRulesByWorkspace(ws.id)).toHaveLength(0)
  })

  it('flags a rule it had to widen, instead of quietly broadening a preserve rule', () => {
    // The failure this guards: every repair the reader makes *widens* the rule, and a widened
    // `anonymize: false` rule means an entire table dumped with real data. It still opens (so it can
    // be fixed) but carries `invalid`, and `planRule` refuses to run it.
    const ws = createWorkspace({ name: 'Failing open' })
    const rule = createSelectionRule({
      workspaceId: ws.id,
      table: 'users',
      match: 'all',
      where: [{ column: 'email', op: 'endsWith', value: '@staff.example.com' }],
      take: { kind: 'none' },
      anonymize: false
    })

    getDb()
      .prepare('UPDATE selection_rules SET conditions_json = ?, take_json = ? WHERE id = ?')
      .run('[{"column":"email","op":"sounds_like","value":"x"}]', '{"kind":"whatever"}', rule.id)

    const read = getSelectionRule(rule.id)!
    // Read leniently — this is the dangerous reading: no filter at all, every row, preserved.
    expect(read.where).toEqual([])
    expect(read.take).toEqual({ kind: 'all' })
    expect(read.anonymize).toBe(false)
    // …and marked, which is what stops it being run.
    expect(read.invalid).toBeTruthy()
    expect(read.invalid).toContain('condition')
    expect(read.invalid).toContain('row limit')
  })

  it('clears the flag when the rule is saved again', () => {
    const ws = createWorkspace({ name: 'Repairable' })
    const rule = createSelectionRule({
      workspaceId: ws.id,
      table: 'users',
      match: 'all',
      where: [],
      take: { kind: 'all' },
      anonymize: true
    })
    getDb()
      .prepare('UPDATE selection_rules SET take_json = ? WHERE id = ?')
      .run('nonsense', rule.id)
    expect(getSelectionRule(rule.id)!.invalid).toBeTruthy()

    const repaired = updateSelectionRule(rule.id, { take: { kind: 'sample', count: 20 } })!

    expect(repaired.invalid).toBeUndefined()
    expect(repaired.take).toEqual({ kind: 'sample', count: 20 })
  })

  it('does not flag a rawWhere rule for having no conditions', () => {
    // A raw predicate legitimately stores `[]`, so an empty list there is normal, not damage.
    const ws = createWorkspace({ name: 'Raw is fine' })
    const rule = createSelectionRule({
      workspaceId: ws.id,
      table: 'users',
      match: 'all',
      where: [],
      rawWhere: 'id > 0',
      take: { kind: 'all' },
      anonymize: false
    })

    expect(getSelectionRule(rule.id)!.invalid).toBeUndefined()
  })

  it('drops a malformed condition rather than making the rules screen unopenable', () => {
    const ws = createWorkspace({ name: 'Malformed' })
    const rule = createSelectionRule({
      workspaceId: ws.id,
      table: 'users',
      match: 'all',
      where: [{ column: 'email', op: 'contains', value: 'x' }],
      take: { kind: 'all' },
      anonymize: true
    })

    // Simulates a hand-edited config or a rule written by a future version: an unknown operator and
    // a non-object entry. Both are dropped; the surviving condition still reads back.
    getDb()
      .prepare('UPDATE selection_rules SET conditions_json = ? WHERE id = ?')
      .run(
        JSON.stringify([{ column: 'email', op: 'sounds_like', value: 'x' }, 'nonsense', null]),
        rule.id
      )
    expect(getSelectionRule(rule.id)!.where).toEqual([])

    getDb().prepare('UPDATE selection_rules SET take_json = ? WHERE id = ?').run('{ oh no', rule.id)
    expect(getSelectionRule(rule.id)!.take).toEqual({ kind: 'all' })
  })
})

describe('migration 010 — v1 selection rules rewritten to filter + take', () => {
  /**
   * Inserts a v1-shaped row into the *current* schema is impossible (the columns are gone), so this
   * rebuilds the v1 table, seeds it, and replays the migration's INSERT … SELECT against a scratch
   * database. That keeps the rewrite itself under test — the part that silently changes what an
   * existing workspace selects.
   */
  function rewriteV1(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    const db = getDb()
    db.exec(`
      CREATE TEMP TABLE v1_rules (
        id TEXT PRIMARY KEY, workspace_id TEXT, table_name TEXT, strategy TEXT,
        anonymize INTEGER, "count" INTEGER, column_name TEXT, pattern TEXT, explicit_values TEXT
      )`)
    const insert = db.prepare(
      `INSERT INTO v1_rules VALUES (@id, @workspace_id, @table_name, @strategy, @anonymize,
         @count, @column_name, @pattern, @explicit_values)`
    )
    for (const r of rows) {
      insert.run({
        count: null,
        column_name: null,
        pattern: null,
        explicit_values: null,
        workspace_id: 'w',
        table_name: 'users',
        anonymize: 1,
        ...r
      })
    }
    const out = db
      .prepare(
        `SELECT id,
           CASE strategy
             WHEN 'pattern' THEN json_array(json_object('column', column_name, 'op', 'matches', 'value', pattern))
             WHEN 'explicit' THEN json_array(json_object('column', NULL, 'op', 'in', 'value', json(COALESCE(explicit_values, '[]'))))
             ELSE json_array()
           END AS conditions_json,
           CASE strategy
             WHEN 'random' THEN json_object('kind', 'sample', 'count', COALESCE("count", 0))
             ELSE json_object('kind', 'all')
           END AS take_json
         FROM v1_rules ORDER BY id`
      )
      .all() as Record<string, unknown>[]
    db.exec('DROP TABLE v1_rules')
    return out
  }

  it('maps all four strategies losslessly', () => {
    const [all, explicit, pattern, random] = rewriteV1([
      { id: 'a', strategy: 'all' },
      { id: 'b', strategy: 'explicit', explicit_values: '["REF-1",42]' },
      { id: 'c', strategy: 'pattern', column_name: 'email', pattern: '@staff\\.example\\.com$' },
      { id: 'd', strategy: 'random', count: 500 }
    ])

    expect(JSON.parse(random.take_json as string)).toEqual({ kind: 'sample', count: 500 })
    expect(JSON.parse(random.conditions_json as string)).toEqual([])

    expect(JSON.parse(pattern.conditions_json as string)).toEqual([
      { column: 'email', op: 'matches', value: '@staff\\.example\\.com$' }
    ])
    expect(JSON.parse(pattern.take_json as string)).toEqual({ kind: 'all' })

    // The PK sentinel, and values kept as a real JSON array rather than a quoted string.
    expect(JSON.parse(explicit.conditions_json as string)).toEqual([
      { column: null, op: 'in', value: ['REF-1', 42] }
    ])

    expect(JSON.parse(all.conditions_json as string)).toEqual([])
    expect(JSON.parse(all.take_json as string)).toEqual({ kind: 'all' })
  })
})

describe('field-strategy CRUD', () => {
  it('upserts on (workspace, table, column), replacing rather than erroring', () => {
    const ws = createWorkspace({ name: 'Upserts' })

    const first = createFieldStrategy({
      workspaceId: ws.id,
      tableName: 'users',
      columnName: 'email',
      rule: { kind: 'fake', generator: 'email' }
    })
    const second = createFieldStrategy({
      workspaceId: ws.id,
      tableName: 'users',
      columnName: 'email',
      rule: { kind: 'jitter', percent: 15 }
    })

    expect(second.id).toBe(first.id)
    expect(second.rule).toEqual({ kind: 'jitter', percent: 15 })
    expect(listFieldStrategiesByWorkspace(ws.id)).toHaveLength(1)
  })

  it('round-trips every rule kind through the flat columns', () => {
    const ws = createWorkspace({ name: 'Kinds' })

    const fake = createFieldStrategy({
      workspaceId: ws.id,
      tableName: 't',
      columnName: 'a',
      rule: { kind: 'fake', generator: 'streetAddress' }
    })
    const redact = createFieldStrategy({
      workspaceId: ws.id,
      tableName: 't',
      columnName: 'b',
      rule: { kind: 'redact' }
    })
    const preserve = createFieldStrategy({
      workspaceId: ws.id,
      tableName: 't',
      columnName: 'c',
      rule: { kind: 'preserve' }
    })

    expect(fake.rule).toEqual({ kind: 'fake', generator: 'streetAddress' })
    expect(redact.rule).toEqual({ kind: 'redact' })
    expect(preserve.rule).toEqual({ kind: 'preserve' })
    expect(getFieldStrategy(fake.id)!.rule).toEqual({ kind: 'fake', generator: 'streetAddress' })
  })

  it('persists template bindings and drops blank paths at write time', () => {
    const ws = createWorkspace({ name: 'Templates' })

    const strategy = createFieldStrategy({
      workspaceId: ws.id,
      tableName: 'audits',
      columnName: 'new_values',
      rule: {
        kind: 'template',
        bindings: [
          { path: 'password', action: 'remove' },
          { path: 'ip', action: 'redact' },
          { path: 'address1', generator: 'streetAddress' },
          { path: '   ', generator: 'city' }
        ]
      }
    })

    const read = getFieldStrategy(strategy.id)!
    expect(read.rule.kind).toBe('template')
    if (read.rule.kind !== 'template') throw new Error('unreachable')
    expect(read.rule.bindings.map((b) => b.path)).toEqual(['password', 'ip', 'address1'])
  })

  it('updates by id and deletes cleanly', () => {
    const ws = createWorkspace({ name: 'Strategy Edit' })

    const strategy = createFieldStrategy({
      workspaceId: ws.id,
      tableName: 'users',
      columnName: 'phone',
      rule: { kind: 'fake', generator: 'phone' }
    })

    const edited = updateFieldStrategy(strategy.id, {
      columnName: 'mobile',
      rule: { kind: 'redact' }
    })!

    expect(edited.columnName).toBe('mobile')
    expect(edited.rule).toEqual({ kind: 'redact' })

    deleteFieldStrategy(strategy.id)
    expect(getFieldStrategy(strategy.id)).toBeUndefined()
    expect(listFieldStrategiesByWorkspace(ws.id)).toHaveLength(0)
  })
})
