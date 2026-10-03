/**
 * Framework catalogue (spec §5). A workspace's source database usually belongs to a framework, and
 * a framework ships tables whose *rows* nobody wants locally but whose *schema* the app needs —
 * plus a few whose rows it very much does need. Naming those once per framework beats making every
 * workspace rediscover them by hand.
 *
 * Shared main/renderer. The catalogue is **code, not data**: adding a framework is an edit here, not
 * a migration. That is why neither `workspaces.framework` nor `table_classifications.source` carries
 * a CHECK constraint — an id set that grows with the code would otherwise need a 12-step SQLite
 * rebuild per framework. Validation lives at the repository boundary instead.
 */

export type FrameworkId = 'laravel' | 'rails' | 'django'

/**
 * How a framework is recognised from a source database's table names. `all` must every one be
 * present; `any`, when given, needs at least one match on top of that.
 *
 * Kept deliberately narrow — a signature exists to be *certain*, not to catch every variant. A
 * wrong guess silently reclassifies tables, so an undetected framework (the user picks it from the
 * dropdown) is a far better failure than a confident wrong one.
 */
export interface FrameworkSignature {
  all: readonly string[]
  any?: readonly string[]
}

export interface Framework {
  id: FrameworkId
  label: string
  signature: FrameworkSignature
  /**
   * Dumped **whole**, rows included (`reference`). These are the tables a framework reads to decide
   * what state the database is in: the migration ledger above all. A dump whose migration table is
   * empty tells the framework nothing has ever run, and the next deploy or `migrate` re-applies
   * every migration against an already-populated database.
   */
  referenceTables: readonly string[]
  /**
   * Schema dumped, rows never (`structure`). Runtime scratch — sessions, cache, queues, logs. No
   * useful developer data, but the app writes to them on first use, so the table has to exist.
   */
  structureTables: readonly string[]
}

export const FRAMEWORKS: readonly Framework[] = [
  {
    id: 'laravel',
    label: 'Laravel',
    // `migrations` alone is far too common a name to identify anything, so a Laravel-specific
    // companion is required alongside it. The three password/token spellings cover Laravel 5
    // through 11; `jobs`/`failed_jobs` cover an app that has never installed the others.
    signature: {
      all: ['migrations'],
      any: [
        'password_reset_tokens',
        'password_resets',
        'personal_access_tokens',
        'failed_jobs',
        'job_batches'
      ]
    },
    referenceTables: ['migrations'],
    structureTables: [
      'sessions',
      'password_reset_tokens',
      'password_resets',
      'personal_access_tokens',
      'failed_jobs',
      'jobs',
      'job_batches',
      'cache',
      'cache_locks',
      'telescope_entries',
      'telescope_entries_tags'
    ]
  },
  {
    id: 'rails',
    label: 'Rails',
    // Both tables are created by Rails itself and by nothing else, so `all` is enough on its own.
    signature: { all: ['schema_migrations', 'ar_internal_metadata'] },
    // `ar_internal_metadata` holds the environment name — Rails refuses to run against a database
    // whose recorded environment doesn't match, so an empty one is worse than useless.
    referenceTables: ['schema_migrations', 'ar_internal_metadata'],
    structureTables: [
      'sessions',
      'delayed_jobs',
      'good_jobs',
      'good_job_batches',
      'good_job_executions',
      'good_job_processes',
      'good_job_settings',
      'solid_queue_blocked_executions',
      'solid_queue_claimed_executions',
      'solid_queue_failed_executions',
      'solid_queue_jobs',
      'solid_queue_pauses',
      'solid_queue_processes',
      'solid_queue_ready_executions',
      'solid_queue_recurring_executions',
      'solid_queue_recurring_tasks',
      'solid_queue_scheduled_executions',
      'solid_queue_semaphores',
      'solid_cache_entries'
    ]
  },
  {
    id: 'django',
    label: 'Django',
    signature: { all: ['django_migrations', 'django_content_type'] },
    // `django_content_type` is referenced by `auth_permission` and by every generic foreign key, so
    // its rows are load-bearing rather than incidental.
    referenceTables: ['django_migrations', 'django_content_type'],
    structureTables: ['django_session', 'django_admin_log']
  }
]

export function frameworkById(id: FrameworkId | null | undefined): Framework | undefined {
  return FRAMEWORKS.find((f) => f.id === id)
}

export function isFrameworkId(value: unknown): value is FrameworkId {
  return FRAMEWORKS.some((f) => f.id === value)
}

/**
 * The framework a set of table names belongs to, or `null` when nothing matches with certainty.
 *
 * Case-insensitive, since a source may be stored in any case and the rest of the config model keys
 * tables on a bare lower-cased name. Returns the **first** match in catalogue order; the signatures
 * are disjoint by construction (no two frameworks share a migration-ledger name), so order only
 * decides the answer if a database genuinely hosts two frameworks — in which case either answer is
 * as defensible as the other and the user can override.
 */
export function detectFramework(tables: readonly string[]): FrameworkId | null {
  const present = new Set(tables.map((t) => t.toLowerCase()))
  for (const framework of FRAMEWORKS) {
    const { all, any } = framework.signature
    if (!all.every((t) => present.has(t))) continue
    if (any && any.length > 0 && !any.some((t) => present.has(t))) continue
    return framework.id
  }
  return null
}

/** Every table a framework's presets name, with the class each would get. */
export function presetEntries(
  framework: Framework
): { tableName: string; class: 'reference' | 'structure' }[] {
  return [
    ...framework.referenceTables.map((tableName) => ({ tableName, class: 'reference' as const })),
    ...framework.structureTables.map((tableName) => ({ tableName, class: 'structure' as const }))
  ]
}
