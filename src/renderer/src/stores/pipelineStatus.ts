import { defineStore } from 'pinia'
import { computed } from 'vue'
import { unhandledPiiColumns, type SuspectedColumn } from '@renderer/lib/pii'
import { useBackfillPoliciesStore } from '@renderer/stores/backfillPolicies'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useConnectionTestsStore } from '@renderer/stores/connectionTests'
import { useDiscoveryStore } from '@renderer/stores/discovery'
import { useFieldStrategiesStore } from '@renderer/stores/fieldStrategies'
import { useMorphRelationsStore } from '@renderer/stores/morphRelations'
import { useRunsStore } from '@renderer/stores/runs'
import { useSelectionRulesStore } from '@renderer/stores/selectionRules'
import { useTableClassificationsStore } from '@renderer/stores/tableClassifications'

/**
 * Per-step status for the sidebar's pipeline. Computed from what the other stores already hold — no
 * persistence and no extra queries. A step whose data isn't in hand reports `unknown` and shows no
 * indicator, rather than guessing.
 */
export type StepKey = 'connections' | 'tables' | 'rules' | 'backfill' | 'fields' | 'morphs' | 'runs'

export type StepStatus =
  | { state: 'done' }
  | { state: 'attention'; count: number | '!'; hint: string }
  | { state: 'todo' }
  | { state: 'unknown' }

export const usePipelineStatusStore = defineStore('pipelineStatus', () => {
  const connections = useConnectionsStore()
  const tests = useConnectionTestsStore()
  const discovery = useDiscoveryStore()
  const classifications = useTableClassificationsStore()
  const rules = useSelectionRulesStore()
  const backfill = useBackfillPoliciesStore()
  const strategies = useFieldStrategiesStore()
  const morphs = useMorphRelationsStore()
  const runs = useRunsStore()

  const classByName = computed(
    () => new Map(classifications.list.map((c) => [c.tableName, c.class]))
  )

  /** Absence of a classification row means the transactional default (the store's model). */
  function isTransactional(table: string): boolean {
    const klass = classByName.value.get(table)
    return !klass || klass === 'transactional'
  }

  /** Discovered tables with no explicit class — they fall back to transactional unreviewed. */
  const unclassifiedTables = computed(() =>
    discovery.tables.filter((t) => !classByName.value.has(t))
  )

  /**
   * Columns that look like personal data, have no strategy, and sit in a transactional table (the only
   * class strategies apply to). Only tables whose columns are already known this session are checked.
   */
  const unhandledPii = computed<SuspectedColumn[]>(() => {
    const handled = new Set(strategies.list.map((s) => `${s.tableName}.${s.columnName}`))
    const known = Object.fromEntries(
      Object.entries(discovery.knownColumns).filter(([table]) => isTransactional(table))
    )
    return unhandledPiiColumns(known, (table, column) => handled.has(`${table}.${column}`))
  })

  const steps = computed<Record<StepKey, StepStatus>>(() => {
    const conns = connections.list
    const results = conns.map((c) => tests.results[c.id]).filter((r) => !!r)
    const failed = results.filter((r) => !r.ok).length

    const lastRun = runs.list[0]

    return {
      connections:
        failed > 0
          ? { state: 'attention', count: failed, hint: `${failed} failed connection test(s)` }
          : conns.length > 0 && results.length > 0 && results.every((r) => r.ok)
            ? { state: 'done' }
            : { state: 'todo' },

      tables:
        discovery.tables.length === 0
          ? // Nothing discovered this session, so "every table has a class" can't be judged.
            { state: 'unknown' }
          : unclassifiedTables.value.length > 0
            ? {
                state: 'attention',
                count: unclassifiedTables.value.length,
                hint: `${unclassifiedTables.value.length} unclassified table(s)`
              }
            : { state: 'done' },

      rules: rules.list.some((r) => isTransactional(r.table))
        ? { state: 'done' }
        : { state: 'todo' },

      backfill: backfill.edgesLoaded ? { state: 'done' } : { state: 'todo' },

      fields:
        Object.keys(discovery.knownColumns).length === 0
          ? // No column metadata in hand yet — nothing to judge against.
            { state: 'unknown' }
          : unhandledPii.value.length > 0
            ? {
                state: 'attention',
                count: unhandledPii.value.length,
                hint: `${unhandledPii.value.length} column(s) look like personal data with no strategy`
              }
            : { state: 'done' },

      morphs:
        morphs.list.length > 0 || (morphs.detected && morphs.candidates.length === 0)
          ? { state: 'done' }
          : { state: 'todo' },

      runs: !lastRun
        ? { state: 'todo' }
        : lastRun.status === 'completed'
          ? { state: 'done' }
          : lastRun.status === 'failed'
            ? { state: 'attention', count: '!', hint: 'The last run failed' }
            : { state: 'todo' }
    }
  })

  return { steps, unhandledPii, unclassifiedTables, isTransactional }
})
