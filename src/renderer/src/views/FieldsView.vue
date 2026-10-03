<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NInput, NPopover, NSelect, NTooltip, useDialog, useMessage } from 'naive-ui'
import type { FieldStrategy, FieldStrategyKind } from '@shared/types'
import { strategyExample, strategyLabel, templateMapping } from '@renderer/lib/strategyDisplay'
import type { SuspectedColumn } from '@renderer/lib/pii'
import { useFieldStrategiesStore } from '@renderer/stores/fieldStrategies'
import { useLocaleSourcesStore } from '@renderer/stores/localeSources'
import { useIdentitySourcesStore } from '@renderer/stores/identitySources'
import { useDiscoveryStore } from '@renderer/stores/discovery'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import FieldStrategyFormModal from '@renderer/components/FieldStrategyFormModal.vue'
import LoadErrorAlert from '@renderer/components/LoadErrorAlert.vue'
import AppIcon from '@renderer/components/ui/AppIcon.vue'
import EmptyState from '@renderer/components/ui/EmptyState.vue'
import MenuButton from '@renderer/components/ui/MenuButton.vue'
import TopBarActions from '@renderer/components/ui/TopBarActions.vue'
import UiBadge from '@renderer/components/ui/UiBadge.vue'
import UiPanel from '@renderer/components/ui/UiPanel.vue'
import type { Tone } from '@renderer/components/ui/tones'
import { usePipelineStatusStore } from '@renderer/stores/pipelineStatus'

const strategies = useFieldStrategiesStore()
const localeSources = useLocaleSourcesStore()
const identitySources = useIdentitySourcesStore()
const discovery = useDiscoveryStore()
const workspace = useWorkspaceStore()
const pipeline = usePipelineStatusStore()
const dialog = useDialog()
const message = useMessage()

const hasWorkspace = computed(() => !!workspace.currentWorkspaceId)

const showModal = ref(false)
const editing = ref<FieldStrategy | null>(null)
/** Table and column to seed a new strategy with, when it's started from a suspected column. */
const seed = ref<SuspectedColumn | null>(null)

function openCreate(): void {
  editing.value = null
  seed.value = null
  showModal.value = true
}

function openEdit(strategy: FieldStrategy): void {
  editing.value = strategy
  seed.value = null
  showModal.value = true
}

function openForColumn(column: SuspectedColumn): void {
  editing.value = null
  seed.value = column
  showModal.value = true
}

/** Columns that look like personal data and have no strategy (from metadata already in hand). */
const suspected = computed(() => pipeline.unhandledPii)
const showSuspected = ref(false)

/**
 * Transactional discovered tables whose columns haven't been read this session — the part of the
 * schema the personal-data check can't see yet. Reading them is an explicit click, one table at a
 * time, through the same cached lookup the rest of the screen uses.
 */
const unscanned = computed(() =>
  discovery.tables.filter((t) => pipeline.isTransactional(t) && !(t in discovery.knownColumns))
)
const scanning = ref(false)

async function scanColumns(): Promise<void> {
  scanning.value = true
  // The table list belongs to the source that was active when the scan started. `loadColumns` reads
  // whichever source is active *now*, so a workspace switch or source edit mid-scan must end it —
  // otherwise the old source's table names are queried against, and cached under, the new one.
  const source = discovery.sourceKey
  const tables = [...unscanned.value]
  try {
    for (const table of tables) {
      if (discovery.sourceKey !== source) break
      await discovery.loadColumns(table)
    }
  } catch (err) {
    message.error(`Could not read columns: ${(err as Error).message}`)
  } finally {
    scanning.value = false
  }
}

/** Strategies grouped by table, tables alphabetical. */
const grouped = computed(() => {
  const byTable = new Map<string, FieldStrategy[]>()
  for (const s of strategies.list) {
    const arr = byTable.get(s.tableName) ?? []
    arr.push(s)
    byTable.set(s.tableName, arr)
  }
  return [...byTable.entries()].sort(([a], [b]) => a.localeCompare(b))
})

/**
 * Country-column dropdown options per displayed table. Read from the discovery store's cache, the
 * one authority for columns, so a workspace switch or an edited source can't leave another
 * database's columns here.
 */
const columnOptionsByTable = computed(() =>
  Object.fromEntries(
    grouped.value.map(([table]) => [
      table,
      discovery
        .cachedColumns(table)
        .map((c) => ({ label: `${c.name} — ${c.dataType}`, value: c.name }))
    ])
  )
)

// Warm the cache for each displayed table, one at a time (each read opens a source connection).
watch(
  [grouped, () => discovery.sourceKey],
  async ([groups]) => {
    for (const [table] of groups) {
      // No source connection / introspection failed — the country select stays free-text.
      await discovery.loadColumns(table).catch(() => [])
    }
  },
  { immediate: true }
)

/** Set or clear (empty value) a table's data-driven country column, keeping any configured path. */
async function onLocaleChange(table: string, column: string | null): Promise<void> {
  try {
    if (column && column.trim()) {
      await localeSources.setSource(table, column.trim(), localeSources.pathFor(table))
    } else {
      await localeSources.clearFor(table)
    }
  } catch (err) {
    message.error(`Could not update country column: ${(err as Error).message}`)
  }
}

/**
 * Set or clear the dot path *within* the country column's JSON. Only reachable once a column is
 * chosen — a path with nothing to read it out of would be meaningless.
 */
async function onLocalePathChange(table: string, path: string | null): Promise<void> {
  const column = localeSources.columnFor(table)
  if (!column) return
  try {
    await localeSources.setSource(table, column, path)
  } catch (err) {
    message.error(`Could not update country path: ${(err as Error).message}`)
  }
}

/**
 * Set or clear a table's declared identity source. Both halves are needed to name an entity, so the
 * source is only saved once column and table are both present; clearing either removes it and lets
 * the cascade's inference apply again.
 */
async function onIdentityChange(
  table: string,
  column: string | null,
  entityTable: string | null
): Promise<void> {
  try {
    if (column?.trim() && entityTable?.trim()) {
      await identitySources.setSource(table, column.trim(), entityTable.trim())
    } else {
      await identitySources.clearFor(table)
    }
  } catch (err) {
    message.error(`Could not update identity source: ${(err as Error).message}`)
  }
}

/** Each strategy family has one colour, used wherever it appears. */
const FAMILY_TONE: Record<FieldStrategyKind, Tone> = {
  preserve: 'strat-preserve',
  redact: 'strat-redact',
  fake: 'strat-fake',
  obfuscate: 'strat-obfuscate',
  jitter: 'strat-jitter',
  template: 'strat-template'
}

/** Whether a table's context (country / identity source) popover has anything set. */
function hasContext(table: string): boolean {
  return !!localeSources.columnFor(table) || !!identitySources.columnFor(table)
}

function onRowMenu(strategy: FieldStrategy, key: string): void {
  if (key === 'delete') void remove(strategy)
}

async function remove(strategy: FieldStrategy): Promise<void> {
  dialog.warning({
    title: 'Delete strategy',
    content: `Delete the ${strategy.rule.kind} strategy for "${strategy.tableName}.${strategy.columnName}"?`,
    positiveText: 'Delete',
    negativeText: 'Cancel',
    onPositiveClick: async () => {
      try {
        await strategies.remove(strategy.id)
        message.success('Strategy deleted.')
      } catch (err) {
        message.error(`Could not delete strategy: ${(err as Error).message}`)
      }
    }
  })
}

/** Reload everything this screen reads; failures stay on each store's `loadError`. */
function retryLoad(): void {
  const id = workspace.currentWorkspaceId
  if (!id) return
  strategies.loadForWorkspace(id).catch(() => {})
  localeSources.loadForWorkspace(id).catch(() => {})
  identitySources.loadForWorkspace(id).catch(() => {})
}
</script>

<template>
  <div class="page">
    <TopBarActions>
      <n-button size="small" secondary :disabled="!hasWorkspace" @click="openCreate">
        <template #icon><AppIcon name="plus" :size="14" /></template>
        Add strategy
      </n-button>
    </TopBarActions>

    <header class="page-header">
      <h1 class="page-title">Field Strategies</h1>
      <p class="page-desc">
        Per-column anonymization for <strong>{{ workspace.currentWorkspace?.name }}</strong> —
        preserve, redact, fake, obfuscate, jitter, or template (reaches inside a JSON column). Any
        column without a strategy is preserved as-is.
      </p>
    </header>

    <LoadErrorAlert
      :errors="[strategies.loadError, localeSources.loadError, identitySources.loadError]"
      @retry="retryLoad"
    />

    <!-- Personal data with no strategy. Only covers columns already read this session. -->
    <section v-if="suspected.length > 0" class="pii">
      <button
        type="button"
        class="pii__head"
        :aria-expanded="showSuspected"
        @click="showSuspected = !showSuspected"
      >
        <AppIcon name="alert" :size="16" />
        <span class="pii__title">
          <span class="num">{{ suspected.length }}</span>
          column{{ suspected.length === 1 ? '' : 's' }} look{{
            suspected.length === 1 ? 's' : ''
          }}
          like personal data but {{ suspected.length === 1 ? 'has' : 'have' }} no strategy
        </span>
        <AppIcon :name="showSuspected ? 'chevronDown' : 'chevronRight'" :size="14" />
      </button>
      <div v-if="showSuspected" class="pii__list">
        <div v-for="col in suspected" :key="`${col.table}.${col.column}`" class="pii__row">
          <span class="mono">
            <span class="text-muted">{{ col.table }}.</span>{{ col.column }}
          </span>
          <n-button size="tiny" secondary @click="openForColumn(col)">Add strategy</n-button>
        </div>
      </div>
    </section>

    <p v-if="unscanned.length > 0 && discovery.sourceConnection" class="scan text-muted">
      <AppIcon name="shield" :size="14" />
      The personal-data check has read columns for
      <span class="num">{{ Object.keys(discovery.knownColumns).length }}</span> table(s);
      <span class="num">{{ unscanned.length }}</span> discovered transactional table(s) haven't been
      read yet.
      <n-button text size="small" :loading="scanning" @click="scanColumns"
        >Read their columns</n-button
      >
    </p>

    <EmptyState
      v-if="grouped.length === 0"
      icon="fields"
      title="No field strategies yet"
      description="Add one to anonymize a sensitive column."
    >
      <n-button type="primary" size="small" :disabled="!hasWorkspace" @click="openCreate">
        Add a strategy
      </n-button>
    </EmptyState>

    <div v-else class="groups">
      <UiPanel v-for="[table, tableStrategies] in grouped" :key="table">
        <template #header>
          <span class="mono group__name">{{ table }}</span>
          <UiBadge v-if="localeSources.columnFor(table)" tone="muted" variant="outline">
            country:
            <span class="mono ctx"
              >{{ localeSources.columnFor(table)
              }}{{ localeSources.pathFor(table) ? `.${localeSources.pathFor(table)}` : '' }}</span
            >
          </UiBadge>
          <UiBadge v-if="identitySources.columnFor(table)" tone="muted" variant="outline">
            identity:
            <span class="mono ctx"
              >{{ identitySources.columnFor(table) }} →
              {{ identitySources.tableFor(table) ?? '?' }}</span
            >
          </UiBadge>
          <span class="toolbar__spacer" />
          <n-popover trigger="click" placement="bottom-end" :style="{ width: '380px' }">
            <template #trigger>
              <n-button size="tiny" quaternary :aria-label="`Context for ${table}`">
                <template #icon><AppIcon name="gear" :size="14" /></template>
                Context
                <span v-if="hasContext(table)" class="ctx-dot" aria-hidden="true" />
              </n-button>
            </template>
            <div class="context">
              <div class="context__field">
                <span class="context__label">Country from</span>
                <p class="context__help">
                  Data-driven faker locale — fake postcode/phone/address for each row are formatted
                  for the country in this column (e.g. GB → "SW1A 1AA", US → "90210").
                </p>
                <n-select
                  size="small"
                  clearable
                  filterable
                  tag
                  :value="localeSources.columnFor(table)"
                  :options="columnOptionsByTable[table] ?? []"
                  placeholder="none"
                  @update:value="(v: string | null) => onLocaleChange(table, v)"
                />
                <n-tooltip v-if="localeSources.columnFor(table)" trigger="hover">
                  <template #trigger>
                    <n-input
                      size="small"
                      clearable
                      :value="localeSources.pathFor(table)"
                      placeholder="json path (optional)"
                      @update:value="(v: string | null) => onLocalePathChange(table, v)"
                    />
                  </template>
                  Optional: the country lives at this dot path *inside* the column's JSON (e.g.
                  <code>country</code> for an address blob). Leave empty when the column's own value
                  is the country.
                </n-tooltip>
              </div>
              <div class="context__field">
                <span class="context__label">Identity from</span>
                <p class="context__help">
                  Which entity these rows belong to, for same-person fake values across tables.
                  Without it, identity follows the cascade graph — so comments would inherit the
                  post author's name rather than the commenter's. Pick the id column and the table
                  it points at.
                </p>
                <n-select
                  size="small"
                  clearable
                  filterable
                  tag
                  :value="identitySources.columnFor(table)"
                  :options="columnOptionsByTable[table] ?? []"
                  placeholder="none"
                  @update:value="
                    (v: string | null) =>
                      onIdentityChange(table, v, identitySources.tableFor(table))
                  "
                />
                <n-input
                  v-if="identitySources.columnFor(table)"
                  size="small"
                  clearable
                  :value="identitySources.tableFor(table)"
                  placeholder="entity table"
                  @update:value="
                    (v: string | null) =>
                      onIdentityChange(table, identitySources.columnFor(table), v)
                  "
                />
              </div>
            </div>
          </n-popover>
        </template>

        <div v-for="strategy in tableStrategies" :key="strategy.id" class="ui-row srow">
          <span class="mono srow__col" :title="strategy.columnName">{{ strategy.columnName }}</span>
          <span class="srow__rule">
            <n-tooltip
              v-if="strategy.rule.kind === 'template'"
              trigger="hover"
              placement="top-start"
            >
              <template #trigger>
                <UiBadge :tone="FAMILY_TONE[strategy.rule.kind]" tabindex="0">
                  {{ strategyLabel(strategy.rule) }}
                </UiBadge>
              </template>
              <div v-if="templateMapping(strategy.rule).length" class="mapping mono">
                <div v-for="line in templateMapping(strategy.rule)" :key="line">{{ line }}</div>
              </div>
              <span v-else>No paths bound — this template does nothing.</span>
            </n-tooltip>
            <UiBadge v-else :tone="FAMILY_TONE[strategy.rule.kind]">
              {{ strategyLabel(strategy.rule) }}
            </UiBadge>
          </span>
          <span
            class="mono srow__preview"
            title="Representative example of what this strategy writes — not read from your data"
          >
            <template v-if="strategyExample(strategy.rule)">
              {{ strategyExample(strategy.rule)![0] }}
              <span class="text-subtle">→</span>
              {{ strategyExample(strategy.rule)![1] }}
            </template>
          </span>
          <span class="srow__actions">
            <n-button size="tiny" quaternary @click="openEdit(strategy)">Edit</n-button>
            <MenuButton
              :items="[{ key: 'delete', label: 'Delete…', danger: true }]"
              :label="`More actions for ${strategy.columnName}`"
              @select="(key) => onRowMenu(strategy, key)"
            />
          </span>
        </div>
      </UiPanel>
    </div>

    <FieldStrategyFormModal
      v-model:show="showModal"
      :strategy="editing"
      :initial="seed && { tableName: seed.table, columnName: seed.column }"
    />
  </div>
</template>

<style scoped>
.pii {
  border-radius: var(--radius-panel);
  background: rgb(var(--warn) / 0.08);
  box-shadow: inset 0 0 0 1px rgb(var(--warn) / 0.2);
  overflow: hidden;
}

.pii__head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: 0;
  background: transparent;
  color: rgb(var(--warn));
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.pii__title {
  flex: 1;
  font-weight: 500;
}

.pii__list {
  display: flex;
  flex-direction: column;
  padding: 0 14px 8px 40px;
}

.pii__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 34px;
}

.pii__row + .pii__row {
  border-top: 1px solid rgb(var(--warn) / 0.12);
}

.scan {
  font-size: 12px;
  line-height: 20px;
}

.scan > :deep(svg) {
  display: inline-block;
  margin-right: 4px;
  vertical-align: -2px;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.group__name {
  font-weight: 500;
  color: rgb(var(--fg));
}

.ctx {
  font-size: 11px;
}

.ctx-dot {
  width: 5px;
  height: 5px;
  margin-left: 6px;
  border-radius: 50%;
  background: rgb(var(--fg-muted));
}

.context {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 2px;
}

.context__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.context__label {
  font-size: 12px;
  font-weight: 600;
}

.context__help {
  font-size: 12px;
  line-height: 1.45;
  color: rgb(var(--fg-muted));
}

.srow {
  display: grid;
  grid-template-columns: minmax(120px, 1.1fr) minmax(0, 1fr) minmax(0, 1.5fr) auto;
  gap: 12px;
}

.srow__col {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--fg));
}

.srow__rule {
  min-width: 0;
}

.srow__preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: rgb(var(--fg-muted));
}

.srow__actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.mapping {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}
</style>
