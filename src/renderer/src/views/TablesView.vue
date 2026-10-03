<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput, NSelect, useMessage } from 'naive-ui'
import type {
  ClassificationSource,
  FrameworkId,
  TableClass,
  TableClassification
} from '@shared/types'
import { FRAMEWORKS, detectFramework, frameworkById, isFrameworkId } from '@shared/frameworks'
import { useTableClassificationsStore } from '@renderer/stores/tableClassifications'
import { useDiscoveryStore } from '@renderer/stores/discovery'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import LoadErrorAlert from '@renderer/components/LoadErrorAlert.vue'
import AppIcon from '@renderer/components/ui/AppIcon.vue'
import EmptyState from '@renderer/components/ui/EmptyState.vue'
import FilterChips, { type FilterChip } from '@renderer/components/ui/FilterChips.vue'
import SegmentedControl, { type SegmentOption } from '@renderer/components/ui/SegmentedControl.vue'
import SkeletonRows from '@renderer/components/ui/SkeletonRows.vue'
import UiPanel from '@renderer/components/ui/UiPanel.vue'
import type { Tone } from '@renderer/components/ui/tones'

const classifications = useTableClassificationsStore()
const discovery = useDiscoveryStore()
const workspace = useWorkspaceStore()
const message = useMessage()

const hasWorkspace = computed(() => !!workspace.currentWorkspaceId)

/**
 * The four classes, in segmented-control order: broadest processing → fully excluded (spec §5).
 *
 * This is the single source for both the segmented controls and the filter chips (whose tooltips
 * carry `use`), so the two can't drift apart. Each `use` names what the class is for *and* what becomes of the rows —
 * the distinction worth reading twice is `excluded` (no table at all, so the app fails on its first
 * write to it) against `structure` (table created, rows withheld).
 */
const CLASS_DEFINITIONS: { value: TableClass; label: string; use: string }[] = [
  {
    value: 'transactional',
    label: 'Transactional',
    use: 'Business data — a subset of rows, anonymized'
  },
  { value: 'reference', label: 'Reference', use: 'Lookups and ledgers — every row, untouched' },
  {
    value: 'structure',
    label: 'Structure',
    use: 'Sessions, cache, queues — table created, no rows'
  },
  {
    value: 'excluded',
    label: 'Excluded',
    use: "Left out of the dump entirely — another app's tables, oversized logs"
  }
]

/** Each class selects in its own colour; `excluded` reads as switched off rather than highlighted. */
const CLASS_TONE: Record<TableClass, Tone> = {
  transactional: 'cls-transactional',
  reference: 'cls-reference',
  structure: 'cls-structure',
  excluded: 'cls-excluded'
}

const classOptions: SegmentOption<TableClass>[] = CLASS_DEFINITIONS.map(
  ({ label, value, use }) => ({
    key: value,
    label,
    tone: CLASS_TONE[value],
    mutedText: value === 'excluded',
    title: use
  })
)

/**
 * "No framework" is a real choice — "this database isn't one of these" — not an empty state, so it
 * gets an option rather than a placeholder. It carries the sentinel `'none'` because naive-ui's
 * option value type doesn't admit `null`.
 */
const frameworkOptions = [
  { label: 'No framework', value: 'none' },
  ...FRAMEWORKS.map((f) => ({ label: f.label, value: f.id }))
]

const framework = computed<FrameworkId | null>(() => workspace.currentWorkspace?.framework ?? null)

/**
 * A framework the discovered tables look like but the workspace isn't set to. Offered rather than
 * applied: detection is a strong hint, and silently rewriting a workspace's framework because
 * someone clicked Discover would be a surprise.
 */
const detected = computed<FrameworkId | null>(() => {
  if (discovery.tables.length === 0) return null
  const found = detectFramework(discovery.tables)
  return found && found !== framework.value ? found : null
})

async function setFramework(id: string | null): Promise<void> {
  const ws = workspace.currentWorkspaceId
  if (!ws) return
  try {
    await workspace.update(ws, { framework: isFrameworkId(id) ? id : null })
  } catch (err) {
    message.error(`Could not set the framework: ${(err as Error).message}`)
  }
}

const classByName = computed(() => {
  const m = new Map<string, TableClassification>()
  for (const c of classifications.list) m.set(c.tableName, c)
  return m
})

interface DisplayRow {
  tableName: string
  class: TableClass
  classified: boolean // has an explicit row, vs. defaulting to transactional
  source?: ClassificationSource
  id?: string
}

/**
 * The displayed universe = union of discovered tables and explicitly-classified ones.
 * A discovered table with no classification row shows the `transactional` default without
 * persisting anything — changing its class is what creates the row (see the store's
 * "absence = default" model).
 */
const rows = computed<DisplayRow[]>(() => {
  const names = new Set<string>([
    ...discovery.tables,
    ...classifications.list.map((c) => c.tableName)
  ])
  return [...names].sort().map((name) => {
    const existing = classByName.value.get(name)
    return existing
      ? {
          tableName: name,
          class: existing.class,
          classified: true,
          source: existing.source,
          id: existing.id
        }
      : { tableName: name, class: 'transactional', classified: false }
  })
})

type ChipKey = TableClass | 'unclassified'

/** One field that both filters the list and, when nothing matches exactly, offers to add the name. */
const query = ref('')
const classFilter = ref<ChipKey | null>(null)

const chips = computed<FilterChip<ChipKey>[]>(() => {
  const counts = new Map<TableClass, number>()
  for (const r of rows.value) counts.set(r.class, (counts.get(r.class) ?? 0) + 1)
  const unclassified = rows.value.filter((r) => !r.classified).length
  return [
    ...CLASS_DEFINITIONS.map((c) => ({
      key: c.value as ChipKey,
      label: c.label,
      count: counts.get(c.value) ?? 0,
      tone: CLASS_TONE[c.value],
      title: c.use
    })),
    ...(unclassified > 0
      ? [
          {
            key: 'unclassified' as ChipKey,
            label: 'Unclassified',
            count: unclassified,
            tone: 'warn' as Tone,
            title: 'Discovered but never classified — treated as transactional until you choose'
          }
        ]
      : [])
  ]
})

const visibleRows = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return rows.value.filter((r) => {
    if (
      classFilter.value === 'unclassified'
        ? r.classified
        : classFilter.value && r.class !== classFilter.value
    ) {
      return false
    }
    return !needle || r.tableName.toLowerCase().includes(needle)
  })
})

/** The typed name, when it isn't already a listed table — what "Add" would create. */
const addable = computed(() => {
  const name = query.value.trim()
  return name && !rows.value.some((r) => r.tableName === name) ? name : null
})

async function addTable(): Promise<void> {
  const name = addable.value
  if (!name) return
  try {
    await classifications.setClass(name, 'transactional')
    query.value = ''
    message.success(`Added "${name}".`)
  } catch (err) {
    message.error(`Could not add table: ${(err as Error).message}`)
  }
}

/** A row the user classified by hand — the only kind Reset applies to. */
function isOverride(r: DisplayRow): boolean {
  return r.classified && r.source === 'manual'
}

async function changeClass(tableName: string, klass: TableClass): Promise<void> {
  try {
    await classifications.setClass(tableName, klass)
  } catch (err) {
    message.error(`Could not update classification: ${(err as Error).message}`)
  }
}

/** Revert an explicit classification back to the transactional default (deletes the row). */
async function resetRow(id: string, tableName: string): Promise<void> {
  try {
    await classifications.remove(id)
  } catch (err) {
    message.error(`Could not reset "${tableName}": ${(err as Error).message}`)
  }
}

async function discover(): Promise<void> {
  const conn = discovery.sourceConnection
  if (!conn) {
    message.error('No source connection in this workspace — add one on the Connections screen.')
    return
  }
  try {
    const count = await discovery.discover()
    message.success(`Discovered ${count} tables from "${conn.label}".`)
    // Only when the workspace has no framework yet: filling a blank is helpful, overwriting an
    // answer someone gave is not. A mismatch surfaces as the banner below instead.
    if (!framework.value) {
      const found = detectFramework(discovery.tables)
      if (found) {
        await setFramework(found)
        message.info(
          `Looks like ${frameworkById(found)?.label}. Set as this workspace's framework.`
        )
      }
    }
  } catch (err) {
    message.error(`Discovery failed: ${(err as Error).message}`)
  }
}

async function addPresets(): Promise<void> {
  const id = framework.value
  if (!id) return
  try {
    const { added, refreshed, skippedManual } = await classifications.applyFrameworkPresets(id)
    const label = frameworkById(id)?.label ?? id
    if (added === 0 && refreshed === 0) {
      message.info(`${label} presets are already applied.`)
    } else {
      const parts = [added && `classified ${added}`, refreshed && `updated ${refreshed}`].filter(
        Boolean
      )
      message.success(`${label} presets: ${parts.join(', ')}.`)
    }
    // Named rather than counted: the whole point of skipping is that someone chose those, and a
    // bare number would leave them wondering which.
    if (skippedManual.length > 0) {
      message.warning(
        `Left your own classification alone on: ${skippedManual.join(', ')}. ` +
          `Reset a table to let the presets manage it.`
      )
    }
  } catch (err) {
    message.error(`Could not apply presets: ${(err as Error).message}`)
  }
}

/** Reload everything this screen reads; failures stay on each store's `loadError`. */
function retryLoad(): void {
  const id = workspace.currentWorkspaceId
  if (!id) return
  classifications.loadForWorkspace(id).catch(() => {})
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1 class="page-title">Tables</h1>
      <p class="page-desc">
        Classify each table in <strong>{{ workspace.currentWorkspace?.name }}</strong> — it decides
        whether rows are subset, copied whole, left empty or left out.
      </p>
    </header>

    <div class="toolbar">
      <n-button
        size="small"
        :disabled="!discovery.sourceConnection"
        :loading="discovery.discovering"
        :title="discovery.sourceConnection ? undefined : 'No source connection in this workspace'"
        @click="discover"
      >
        <template #icon><AppIcon name="search" :size="14" /></template>
        Discover from source
      </n-button>
      <span class="toolbar__divider" aria-hidden="true" />
      <n-select
        class="framework"
        size="small"
        :value="framework ?? 'none'"
        :options="frameworkOptions"
        :disabled="!hasWorkspace"
        placeholder="Framework"
        @update:value="setFramework"
      />
      <n-button
        size="small"
        quaternary
        :disabled="!hasWorkspace || !framework"
        :title="framework ? undefined : 'Set this workspace\'s framework first'"
        @click="addPresets"
      >
        Apply presets
      </n-button>
    </div>

    <LoadErrorAlert :errors="[classifications.loadError]" @retry="retryLoad" />

    <p v-if="detected" class="detected">
      <AppIcon name="info" :size="14" />
      These tables look like {{ frameworkById(detected)?.label }}, but this workspace is set to
      {{ frameworkById(framework)?.label ?? 'no framework' }}.
      <n-button text type="warning" size="small" @click="setFramework(detected)">
        Switch to {{ frameworkById(detected)?.label }}
      </n-button>
    </p>

    <SkeletonRows v-if="rows.length === 0 && discovery.discovering" :rows="8" />

    <EmptyState
      v-else-if="rows.length === 0"
      icon="tables"
      title="No tables yet"
      description="Discover them from the source connection, add one by name, or apply the framework presets."
    >
      <n-button
        type="primary"
        size="small"
        :disabled="!discovery.sourceConnection"
        :loading="discovery.discovering"
        @click="discover"
      >
        Discover from source
      </n-button>
      <n-input
        v-model:value="query"
        size="small"
        class="empty-add"
        placeholder="Add table by name…"
        :disabled="!hasWorkspace"
        @keyup.enter="addTable"
      />
    </EmptyState>

    <template v-else>
      <div class="filterbar">
        <FilterChips v-model="classFilter" :chips="chips" label="Filter by class" />
        <div class="filterbar__field">
          <n-input
            v-model:value="query"
            size="small"
            clearable
            placeholder="Filter or add table…"
            :disabled="!hasWorkspace"
            @keyup.enter="addTable"
          >
            <template #prefix><AppIcon name="search" :size="14" class="text-subtle" /></template>
          </n-input>
          <n-button v-if="addable" size="small" secondary @click="addTable">
            <template #icon><AppIcon name="plus" :size="14" /></template>
            Add <span class="mono add-name">{{ addable }}</span>
          </n-button>
        </div>
      </div>

      <UiPanel v-if="visibleRows.length > 0">
        <div v-for="r in visibleRows" :key="r.tableName" class="ui-row trow">
          <span class="trow__lead">
            <span
              class="mono trow__name"
              :class="{ 'trow__name--excluded': r.class === 'excluded' }"
              :title="r.tableName"
              >{{ r.tableName }}</span
            >
            <span
              v-if="isOverride(r)"
              class="trow__override"
              role="img"
              :aria-label="framework ? 'Differs from preset' : 'Set by hand'"
              :title="framework ? 'Differs from preset' : 'Set by hand'"
            />
            <span
              v-else-if="!r.classified"
              class="trow__default"
              title="Not classified yet — treated as transactional"
            >
              default
            </span>
          </span>
          <n-button
            v-if="isOverride(r)"
            size="tiny"
            quaternary
            class="trow__reset"
            :title="`Reset ${r.tableName} to its default`"
            @click="resetRow(r.id!, r.tableName)"
          >
            Reset
          </n-button>
          <SegmentedControl
            :options="classOptions"
            :model-value="r.class"
            :label="`Class of ${r.tableName}`"
            @update:model-value="(v: TableClass) => changeClass(r.tableName, v)"
          />
        </div>
      </UiPanel>

      <p v-else class="no-match text-muted">
        No tables match.
        <template v-if="addable"
          >Press Enter to add <span class="mono">{{ addable }}</span
          >.</template
        >
      </p>
    </template>
  </div>
</template>

<style scoped>
.toolbar__divider {
  width: 1px;
  height: 18px;
  background: rgb(var(--line) / 0.08);
}

.framework {
  width: 160px;
}

.detected {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: var(--radius-control);
  background: rgb(var(--warn) / 0.08);
  color: rgb(var(--warn));
  font-size: 13px;
}

.empty-add {
  width: 200px;
}

/* Stays in view while a long table list scrolls under it. */
.filterbar {
  position: sticky;
  top: -16px;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin: -8px 0;
  padding: 8px 0;
  background: rgb(var(--bg));
}

.filterbar__field {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 360px;
  max-width: 100%;
}

.add-name {
  margin-left: 4px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trow {
  gap: 10px;
}

.trow__lead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.trow__name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgb(var(--fg));
}

.trow__name--excluded {
  color: rgb(var(--fg-muted));
  text-decoration: line-through;
  text-decoration-color: rgb(var(--fg-muted) / 0.4);
}

.trow__override {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgb(var(--accent));
}

.trow__default {
  font-size: 11px;
  color: rgb(var(--fg-subtle));
}

/* Only overridden rows have Reset, and it appears on hover or keyboard focus. */
.trow__reset {
  opacity: 0;
  transition: opacity 150ms;
}

.trow:hover .trow__reset,
.trow:focus-within .trow__reset {
  opacity: 1;
}

.no-match {
  padding: 16px 2px;
  font-size: 13px;
}
</style>
