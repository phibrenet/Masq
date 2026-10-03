import {
  CONDITION_OPS,
  DURATION_UNIT_VALUES,
  FAKE_GENERATORS,
  OBFUSCATE_MIN_COUNT,
  type WorkspaceTransfer,
  type Workspace
} from '@shared/types'
import { isFrameworkId } from '@shared/frameworks'
import { getDb } from './db'
import { createWorkspace, getWorkspace, listWorkspaces } from './repositories/workspaces'
import {
  listTableClassificationsByWorkspace,
  setTableClassification
} from './repositories/table-classifications'
import { createSelectionRule, listSelectionRulesByWorkspace } from './repositories/selection-rules'
import {
  createFieldStrategy,
  listFieldStrategiesByWorkspace
} from './repositories/field-strategies'
import {
  listTableLocaleSourcesByWorkspace,
  setTableLocaleSource
} from './repositories/table-locale-sources'
import {
  listTableIdentitySourcesByWorkspace,
  setTableIdentitySource
} from './repositories/table-identity-sources'
import { createMorphRelation, listMorphRelationsByWorkspace } from './repositories/morph-relations'
import {
  listFkBackfillPoliciesByWorkspace,
  setFkBackfillPolicy
} from './repositories/fk-backfill-policies'

export const MAX_WORKSPACE_FILE_BYTES = 5 * 1024 * 1024

/** Keep IDs, credentials, paths, and run history out of the portable file. */
export function exportWorkspaceConfig(workspaceId: string): WorkspaceTransfer {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) throw new Error('Workspace not found.')
  const strip = <T extends { id: string; workspaceId: string }>(
    rows: T[]
  ): Omit<T, 'id' | 'workspaceId'>[] =>
    rows.map((row) => {
      const fields: Partial<T> = { ...row }
      delete fields.id
      delete fields.workspaceId
      return fields as Omit<T, 'id' | 'workspaceId'>
    })
  const selectionRules = listSelectionRulesByWorkspace(workspaceId)
  const badRule = selectionRules.find((rule) => rule.invalid)
  if (badRule)
    throw new Error(
      `Cannot export the damaged selection rule for "${badRule.table}": ${badRule.invalid}`
    )

  return {
    format: 'masq-workspace',
    version: 1,
    workspace: {
      name: workspace.name,
      dumpOutputMode: workspace.dumpOutputMode,
      dropExistingTables: workspace.dropExistingTables,
      framework: workspace.framework
    },
    tableClassifications: strip(listTableClassificationsByWorkspace(workspaceId)),
    selectionRules: strip(selectionRules).map((rule) => {
      const fields = { ...rule }
      delete fields.invalid
      return fields
    }),
    fieldStrategies: strip(listFieldStrategiesByWorkspace(workspaceId)),
    tableLocaleSources: strip(listTableLocaleSourcesByWorkspace(workspaceId)),
    tableIdentitySources: strip(listTableIdentitySourcesByWorkspace(workspaceId)),
    morphRelations: strip(listMorphRelationsByWorkspace(workspaceId)),
    fkBackfillPolicies: strip(listFkBackfillPoliciesByWorkspace(workspaceId))
  }
}

function object(
  value: unknown,
  label: string,
  required: string[],
  optional: string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`)
  const item = value as Record<string, unknown>
  for (const key of required)
    if (!Object.hasOwn(item, key)) throw new Error(`${label}.${key} is required.`)
  for (const key of Object.keys(item)) {
    if (!required.includes(key) && !optional.includes(key))
      throw new Error(`${label}.${key} is not supported.`)
  }
  return item
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${label} must be a non-empty string.`)
  return value
}

function choice(value: unknown, label: string, options: readonly string[]): void {
  if (!options.includes(value as string)) throw new Error(`${label} has an unsupported value.`)
}

function boolean(value: unknown, label: string): void {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`)
}

function number(value: unknown, label: string, positive = false): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (positive && (!Number.isInteger(value) || value < 1))
  ) {
    throw new Error(`${label} must be ${positive ? 'a positive integer' : 'a finite number'}.`)
  }
}

function list(value: unknown, label: string, check: (item: unknown, label: string) => void): void {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`)
  value.forEach((item, index) => check(item, `${label}[${index}]`))
}

function unique(rows: unknown, label: string, key: (row: Record<string, unknown>) => string): void {
  const seen = new Set<string>()
  for (const row of rows as Record<string, unknown>[]) {
    const value = key(row)
    if (seen.has(value)) throw new Error(`${label} has a duplicate setting for ${value}.`)
    seen.add(value)
  }
}

function condition(value: unknown, label: string): void {
  const c = object(value, label, ['column', 'op'], ['value', 'includeNulls'])
  if (c.column !== null) string(c.column, `${label}.column`)
  choice(c.op, `${label}.op`, CONDITION_OPS)
  if (c.includeNulls !== undefined) boolean(c.includeNulls, `${label}.includeNulls`)
  if (c.op === 'isNull' || c.op === 'notNull') {
    if ('value' in c) throw new Error(`${label}.value is not used by ${c.op}.`)
  } else if (c.op === 'in' || c.op === 'notIn') {
    list(c.value, `${label}.value`, (item, at) => {
      if (typeof item === 'string') return
      number(item, at)
    })
  } else if (c.op === 'withinLast' || c.op === 'olderThan') {
    const duration = object(c.value, `${label}.value`, ['n', 'unit'])
    number(duration.n, `${label}.value.n`, true)
    choice(duration.unit, `${label}.value.unit`, DURATION_UNIT_VALUES)
  } else {
    if (typeof c.value !== 'string' && typeof c.value !== 'number')
      throw new Error(`${label}.value must be text or a number.`)
    if (typeof c.value === 'number') number(c.value, `${label}.value`)
    if (c.op === 'matches') {
      string(c.value, `${label}.value`)
      try {
        new RegExp(c.value as string)
      } catch {
        throw new Error(`${label}.value is not a valid regular expression.`)
      }
    }
  }
}

function rule(value: unknown, label: string): void {
  const r = object(value, label, ['table', 'match', 'where', 'take', 'anonymize'], ['rawWhere'])
  string(r.table, `${label}.table`)
  choice(r.match, `${label}.match`, ['all', 'any'])
  list(r.where, `${label}.where`, condition)
  const take = object(r.take, `${label}.take`, ['kind'], ['count', 'orderBy', 'dir'])
  choice(take.kind, `${label}.take.kind`, ['all', 'none', 'sample', 'top'])
  if (take.kind === 'sample' || take.kind === 'top') number(take.count, `${label}.take.count`, true)
  else if ('count' in take) throw new Error(`${label}.take.count is not used by ${take.kind}.`)
  if (take.kind === 'top') {
    string(take.orderBy, `${label}.take.orderBy`)
    choice(take.dir, `${label}.take.dir`, ['asc', 'desc'])
  } else if ('orderBy' in take || 'dir' in take)
    throw new Error(`${label}.take has fields not used by ${take.kind}.`)
  boolean(r.anonymize, `${label}.anonymize`)
  if (r.rawWhere !== undefined) {
    string(r.rawWhere, `${label}.rawWhere`)
    if ((r.where as unknown[]).length)
      throw new Error(`${label} cannot combine rawWhere with conditions.`)
  }
}

function field(value: unknown, label: string): void {
  const f = object(value, label, ['tableName', 'columnName', 'rule'])
  string(f.tableName, `${label}.tableName`)
  string(f.columnName, `${label}.columnName`)
  const r = object(
    f.rule,
    `${label}.rule`,
    ['kind'],
    ['generator', 'percent', 'bindings', 'side', 'count']
  )
  choice(r.kind, `${label}.rule.kind`, [
    'preserve',
    'redact',
    'fake',
    'jitter',
    'template',
    'obfuscate'
  ])
  if (r.kind === 'fake') choice(r.generator, `${label}.rule.generator`, FAKE_GENERATORS)
  if (r.kind === 'jitter') number(r.percent, `${label}.rule.percent`)
  if (r.kind === 'obfuscate') {
    choice(r.side, `${label}.rule.side`, ['first', 'last'])
    number(r.count, `${label}.rule.count`, true)
    // Rejected rather than quietly raised to the floor: a shared file asking to hide 3 characters
    // was written by someone who believed 3 was enough, and importing it as 6 would hide that.
    if ((r.count as number) < OBFUSCATE_MIN_COUNT)
      throw new Error(
        `${label}.rule.count must be at least ${OBFUSCATE_MIN_COUNT} — ` +
          `scrambling fewer characters leaves the value re-identifiable.`
      )
  }
  if (r.kind === 'template')
    list(r.bindings, `${label}.rule.bindings`, (value, at) => {
      const b = object(value, at, ['path'], ['action', 'generator'])
      string(b.path, `${at}.path`)
      if (b.action !== undefined) choice(b.action, `${at}.action`, ['fake', 'redact', 'remove'])
      if (b.action === undefined || b.action === 'fake')
        choice(b.generator, `${at}.generator`, FAKE_GENERATORS)
      else if (b.generator !== undefined) choice(b.generator, `${at}.generator`, FAKE_GENERATORS)
    })
  if (r.kind !== 'fake' && 'generator' in r)
    throw new Error(`${label}.rule.generator is not used by ${r.kind}.`)
  if (r.kind !== 'jitter' && 'percent' in r)
    throw new Error(`${label}.rule.percent is not used by ${r.kind}.`)
  if (r.kind !== 'template' && 'bindings' in r)
    throw new Error(`${label}.rule.bindings is not used by ${r.kind}.`)
  for (const key of ['side', 'count'])
    if (r.kind !== 'obfuscate' && key in r)
      throw new Error(`${label}.rule.${key} is not used by ${r.kind}.`)
}

/** Reject malformed configuration rather than letting repository read fallbacks widen a rule. */
export function parseWorkspaceTransfer(value: unknown): WorkspaceTransfer {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > MAX_WORKSPACE_FILE_BYTES) {
    throw new Error('Workspace file is too large to import.')
  }
  const file = object(value, 'File', [
    'format',
    'version',
    'workspace',
    'tableClassifications',
    'selectionRules',
    'fieldStrategies',
    'tableLocaleSources',
    'tableIdentitySources',
    'morphRelations',
    'fkBackfillPolicies'
  ])
  if (file.format !== 'masq-workspace' || file.version !== 1)
    throw new Error('Unsupported Masq workspace file version.')
  // `dropExistingTables` is optional, not required: files exported before it existed predate the
  // key entirely, and rejecting them would strand every config already shared with a team.
  const workspace = object(
    file.workspace,
    'workspace',
    ['name', 'dumpOutputMode'],
    ['dropExistingTables', 'framework']
  )
  string(workspace.name, 'workspace.name')
  choice(workspace.dumpOutputMode, 'workspace.dumpOutputMode', ['combined', 'split'])
  if (workspace.dropExistingTables !== undefined)
    boolean(workspace.dropExistingTables, 'workspace.dropExistingTables')
  list(file.tableClassifications, 'tableClassifications', (value, at) => {
    // `source` is optional: files exported before provenance existed carry none, and a recipient
    // importing one gets `manual` — the reading that keeps their own presets from touching it.
    const row = object(value, at, ['tableName', 'class'], ['source'])
    string(row.tableName, `${at}.tableName`)
    choice(row.class, `${at}.class`, ['transactional', 'reference', 'structure', 'excluded'])
    if (row.source !== undefined) string(row.source, `${at}.source`)
  })
  unique(file.tableClassifications, 'tableClassifications', (r) => String(r.tableName))
  list(file.selectionRules, 'selectionRules', rule)
  list(file.fieldStrategies, 'fieldStrategies', field)
  unique(file.fieldStrategies, 'fieldStrategies', (r) => `${r.tableName}.${r.columnName}`)
  list(file.tableLocaleSources, 'tableLocaleSources', (value, at) => {
    const row = object(value, at, ['tableName', 'countryColumn'], ['countryPath'])
    string(row.tableName, `${at}.tableName`)
    string(row.countryColumn, `${at}.countryColumn`)
    if (row.countryPath !== undefined) string(row.countryPath, `${at}.countryPath`)
  })
  unique(file.tableLocaleSources, 'tableLocaleSources', (r) => String(r.tableName))
  list(file.tableIdentitySources, 'tableIdentitySources', (value, at) => {
    const row = object(value, at, ['tableName', 'identityColumn', 'identityTable'])
    for (const key of ['tableName', 'identityColumn', 'identityTable'])
      string(row[key], `${at}.${key}`)
  })
  unique(file.tableIdentitySources, 'tableIdentitySources', (r) => String(r.tableName))
  list(file.morphRelations, 'morphRelations', (value, at) => {
    const row = object(value, at, [
      'tableName',
      'typeColumn',
      'idColumn',
      'cascadeDown',
      'backfillUp',
      'typeMap'
    ])
    for (const key of ['tableName', 'typeColumn', 'idColumn']) string(row[key], `${at}.${key}`)
    boolean(row.cascadeDown, `${at}.cascadeDown`)
    boolean(row.backfillUp, `${at}.backfillUp`)
    list(row.typeMap, `${at}.typeMap`, (value, mapAt) => {
      const mapping = object(value, mapAt, ['typeValue', 'targetTable'])
      string(mapping.typeValue, `${mapAt}.typeValue`)
      string(mapping.targetTable, `${mapAt}.targetTable`)
    })
    unique(row.typeMap, `${at}.typeMap`, (r) => String(r.typeValue))
  })
  unique(file.morphRelations, 'morphRelations', (r) => `${r.tableName}.${r.typeColumn}`)
  list(file.fkBackfillPolicies, 'fkBackfillPolicies', (value, at) => {
    const row = object(value, at, ['tableName', 'columnName', 'policy'])
    string(row.tableName, `${at}.tableName`)
    string(row.columnName, `${at}.columnName`)
    choice(row.policy, `${at}.policy`, ['follow', 'null'])
  })
  unique(file.fkBackfillPolicies, 'fkBackfillPolicies', (r) => `${r.tableName}.${r.columnName}`)
  return value as WorkspaceTransfer
}

export function importWorkspaceConfig(value: unknown, name: string): Workspace {
  const file = parseWorkspaceTransfer(value)
  const trimmed = string(name, 'Workspace name').trim()
  return getDb().transaction(() => {
    if (listWorkspaces().some((w) => w.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`A workspace named "${trimmed}" already exists.`)
    }
    const workspace = createWorkspace({
      name: trimmed,
      dumpOutputMode: file.workspace.dumpOutputMode,
      // Absent in a pre-012 file; `createWorkspace` then applies the column default.
      dropExistingTables: file.workspace.dropExistingTables,
      // Unknown ids degrade to "no framework" rather than failing the import: a file shared from
      // a build whose catalogue has one more framework than this one must still import, and the
      // classifications it carries — the part that matters — stand on their own.
      framework: isFrameworkId(file.workspace.framework) ? file.workspace.framework : undefined
    })
    const workspaceId = workspace.id
    for (const row of file.tableClassifications) setTableClassification({ ...row, workspaceId })
    for (const row of file.selectionRules) createSelectionRule({ ...row, workspaceId })
    for (const row of file.fieldStrategies) createFieldStrategy({ ...row, workspaceId })
    for (const row of file.tableLocaleSources) setTableLocaleSource({ ...row, workspaceId })
    for (const row of file.tableIdentitySources) setTableIdentitySource({ ...row, workspaceId })
    for (const row of file.morphRelations) createMorphRelation({ ...row, workspaceId })
    for (const row of file.fkBackfillPolicies) setFkBackfillPolicy({ ...row, workspaceId })
    return workspace
  })()
}
