<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput, NPopover, NSwitch, NTooltip, useMessage } from 'naive-ui'
import type { ForeignKeyEdge } from '@shared/types'
import { useBackfillPoliciesStore } from '@renderer/stores/backfillPolicies'
import { useDiscoveryStore } from '@renderer/stores/discovery'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import LoadErrorAlert from '@renderer/components/LoadErrorAlert.vue'
import AppIcon from '@renderer/components/ui/AppIcon.vue'
import EmptyState from '@renderer/components/ui/EmptyState.vue'
import SkeletonRows from '@renderer/components/ui/SkeletonRows.vue'
import UiBadge from '@renderer/components/ui/UiBadge.vue'
import UiPanel from '@renderer/components/ui/UiPanel.vue'

/**
 * Backfill management (migration 009): which links Masq follows when it keeps a row.
 *
 * **The copy here deliberately leads with plain language and introduces the jargon second.** Someone
 * configuring an extract knows their own schema but needn't know what a foreign key or a "dangling
 * reference" is, and the original wording assumed both. So the page talks about *links* and *records*
 * in the header, names "backfill edge" once so the term in the docs and the run log is recognisable,
 * and puts the full mechanism behind a collapsed "How this works" rather than in the subtitle.
 *
 * Grouped by the table being linked *to*, and sorted by how many links point at it, because that's
 * the question this page answers: "a rule asked for 20 users and the dump has 74 — what brought the
 * rest in?"
 *
 * **Links that can't be turned off are hidden by default**, behind one toggle. On a real schema most
 * of the ~90 links are on non-nullable columns and therefore fixed, so listing them all buries the
 * handful you can actually act on. They're hidden rather than dropped — the toggle shows them, and
 * both the toolbar and each group header say how many are being held back, so nothing goes missing
 * silently.
 */
const policies = useBackfillPoliciesStore()
const discovery = useDiscoveryStore()
const workspace = useWorkspaceStore()
const message = useMessage()

const filter = ref('')
/** Show the links whose column can't be empty, which can never be turned off. Off by default. */
const showAlwaysOn = ref(false)

const hasWorkspace = computed(() => !!workspace.currentWorkspaceId)
const hasSource = computed(() => !!discovery.sourceConnection)
const turnedOffCount = computed(() => policies.list.filter((p) => p.policy === 'null').length)

/**
 * Links matching the text filter, before the always-on toggle is applied.
 *
 * The filter matches the whole link (`submissions.welded_by_user_id → users.id`) rather than one
 * field, so typing the name of the table being linked to narrows to everything pointing at it, and
 * typing the name of the table holding the column narrows to everything leaving it — the two ways
 * you'd come at this.
 *
 * Kept as its own step so the counts below and the grouping both read from one list: the number of
 * links the toggle is holding back has to agree with what's on screen, and deriving it back out of
 * the groups (which drop entirely when all their links are hidden) got that wrong.
 */
const matching = computed<ForeignKeyEdge[]>(() => {
  const needle = filter.value.trim().toLowerCase()
  if (!needle) return policies.edges
  return policies.edges.filter((edge) =>
    `${edge.table}.${edge.column} ${edge.referencedTable}.${edge.referencedColumn}`
      .toLowerCase()
      .includes(needle)
  )
})

/** How many links the toggle is holding back right now. */
const hiddenCount = computed(() =>
  showAlwaysOn.value ? 0 : matching.value.filter((edge) => !edge.nullable).length
)

/** Links grouped by the table they point at, most-linked-to first. */
const grouped = computed(() => {
  const byTarget = new Map<string, ForeignKeyEdge[]>()
  for (const edge of matching.value) {
    const arr = byTarget.get(edge.referencedTable) ?? []
    arr.push(edge)
    byTarget.set(edge.referencedTable, arr)
  }

  return (
    [...byTarget.entries()]
      .map(([targetTable, edges]) => {
        const sorted = [...edges].sort((a, b) =>
          `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`)
        )
        return {
          targetTable,
          // Counts every link into this table whether or not it's on screen, so the header stays an
          // honest answer to "how much can point at this" under either toggle state.
          total: sorted.length,
          alwaysOn: sorted.filter((e) => !e.nullable).length,
          edges: showAlwaysOn.value ? sorted : sorted.filter((e) => e.nullable),
          turnedOff: sorted.filter((e) => policies.policyFor(e.table, e.column) === 'null').length
        }
      })
      // A table linked to only by fixed columns has nothing to show while they're hidden.
      .filter((group) => group.edges.length > 0)
      // Ranked on `total` rather than what's visible, so toggling doesn't reshuffle the page under you.
      .sort((a, b) => b.total - a.total || a.targetTable.localeCompare(b.targetTable))
  )
})

/** Target tables whose group is folded shut. Open by default, so nothing is hidden until asked. */
const collapsed = ref<Set<string>>(new Set())

function toggleGroup(table: string): void {
  const next = new Set(collapsed.value)
  if (next.has(table)) next.delete(table)
  else next.add(table)
  collapsed.value = next
}

/** Proportions for a group's bar: followed, turned off, and fixed (can't be turned off). */
function proportions(group: { total: number; alwaysOn: number; turnedOff: number }): {
  on: number
  off: number
  fixed: number
} {
  const total = Math.max(1, group.total)
  const on = group.total - group.alwaysOn - group.turnedOff
  return {
    on: (on / total) * 100,
    off: (group.turnedOff / total) * 100,
    fixed: (group.alwaysOn / total) * 100
  }
}

/** A link is "on" when Masq brings the linked record in — the default for everything. */
function isOn(edge: ForeignKeyEdge): boolean {
  return policies.policyFor(edge.table, edge.column) !== 'null'
}

/**
 * Settings for links that aren't in the list currently on screen — either nothing has been read from
 * the database this session, or the column no longer exists. Shown regardless, so a setting is never
 * invisible just for having gone stale; an extract reports the stale ones as warnings.
 */
const unlistedSettings = computed(() => {
  const known = new Set(policies.edges.map((e) => `${e.table}.${e.column}`))
  return policies.list.filter((p) => !known.has(`${p.tableName}.${p.columnName}`))
})

async function loadEdges(): Promise<void> {
  try {
    const found = await policies.loadEdges()
    message.success(
      found === 0
        ? 'No links found between tables in this database.'
        : `Found ${found} link${found === 1 ? '' : 's'} between tables.`
    )
  } catch (err) {
    message.error(`Could not read the database: ${(err as Error).message}`)
  }
}

async function toggle(edge: ForeignKeyEdge, on: boolean): Promise<void> {
  try {
    await policies.setPolicy(edge.table, edge.column, on ? 'follow' : 'null')
  } catch (err) {
    message.error(`Could not save that change: ${(err as Error).message}`)
  }
}

async function turnBackOn(tableName: string, columnName: string): Promise<void> {
  try {
    await policies.setPolicy(tableName, columnName, 'follow')
  } catch (err) {
    message.error(`Could not remove that setting: ${(err as Error).message}`)
  }
}

/** Reload everything this screen reads; failures stay on each store's `loadError`. */
function retryLoad(): void {
  const id = workspace.currentWorkspaceId
  if (!id) return
  policies.loadForWorkspace(id).catch(() => {})
}
</script>

<template>
  <section class="page">
    <header class="page-header">
      <h1 class="page-title">Backfill management</h1>
      <p class="page-desc">
        When Masq keeps a record, it also keeps the records that one links to — otherwise your dump
        would point at things that aren't in it. Each link it follows is called a
        <strong>backfill edge</strong>, and this is where you manage them.
      </p>
    </header>

    <div class="toolbar">
      <n-button
        size="small"
        :disabled="!hasWorkspace || !hasSource"
        :loading="policies.loadingEdges"
        @click="loadEdges"
      >
        <template #icon><AppIcon name="search" :size="14" /></template>
        Read links from database
      </n-button>
      <n-popover trigger="click" placement="bottom-start" :style="{ maxWidth: '460px' }">
        <template #trigger>
          <n-button size="small" quaternary>
            <template #icon><AppIcon name="info" :size="14" /></template>
            How this works
          </n-button>
        </template>
        <div class="explainer">
          <p>
            <strong>Leaving a link on</strong> means the linked record is brought into your dump
            too. That's the default, and it's usually what you want — it's how a dump ends up
            complete rather than full of references to records that were left behind.
          </p>
          <p>
            <strong>Turning a link off</strong> means Masq leaves that record out and empties the
            link instead. Useful when the linked record isn't worth bringing along. Only rows
            pointing at something outside your dump are emptied — rows pointing at records you've
            already kept are left exactly as they are.
          </p>
          <p>
            <strong>Some links can't be turned off.</strong> If the column isn't allowed to be
            empty, there's nowhere for Masq to put the emptied link, so the linked record has to
            come along. Those are hidden by default — use <em>Show links that are always on</em> to
            see them.
          </p>
        </div>
      </n-popover>
      <n-input
        v-model:value="filter"
        placeholder="Filter by table or column (e.g. users)"
        clearable
        size="small"
        class="filter"
      >
        <template #prefix><AppIcon name="search" :size="14" class="text-subtle" /></template>
      </n-input>
      <span class="toolbar__spacer" />
      <label class="switch">
        <n-switch v-model:value="showAlwaysOn" size="small" />
        <span>Show links that are always on</span>
      </label>
      <UiBadge :tone="turnedOffCount > 0 ? 'warn' : 'muted'"
        >{{ turnedOffCount }} turned off</UiBadge
      >
      <UiBadge v-if="hiddenCount > 0" tone="muted" variant="outline"
        >{{ hiddenCount }} hidden</UiBadge
      >
    </div>

    <LoadErrorAlert :errors="[policies.loadError]" @retry="retryLoad" />

    <p v-if="!hasSource" class="note">
      <AppIcon name="info" :size="14" />
      This workspace has no source connection, so the links between tables can't be read. Any
      settings you've already made are still listed below.
    </p>

    <SkeletonRows
      v-if="policies.edges.length === 0 && (policies.loadingEdges || policies.loading)"
      :rows="8"
    />

    <EmptyState
      v-else-if="policies.edges.length === 0"
      icon="backfill"
      title="No links read yet"
      description="Read them from your database to choose which ones Masq follows."
    >
      <n-button
        v-if="hasSource"
        type="primary"
        size="small"
        :loading="policies.loadingEdges"
        @click="loadEdges"
      >
        Read links from database
      </n-button>
    </EmptyState>

    <!-- Links exist but none are on screen. Says which control is responsible, so an empty page
         never reads as "there is nothing here". -->
    <EmptyState
      v-else-if="grouped.length === 0"
      icon="search"
      title="Nothing to show"
      :description="
        hiddenCount > 0
          ? `Every matching link is one that can't be turned off (${hiddenCount} hidden).`
          : 'No links match that filter.'
      "
    >
      <n-button v-if="hiddenCount > 0" size="small" @click="showAlwaysOn = true">
        Show links that are always on
      </n-button>
    </EmptyState>

    <div v-else class="groups">
      <UiPanel v-for="group in grouped" :key="group.targetTable" class="group">
        <template #header>
          <button
            type="button"
            class="group__head"
            :aria-expanded="!collapsed.has(group.targetTable)"
            @click="toggleGroup(group.targetTable)"
          >
            <span class="mono group__table">{{ group.targetTable }}</span>
            <span class="group__meta num">
              {{ group.total }} link{{ group.total === 1 ? '' : 's' }}
              <template v-if="group.alwaysOn > 0"> · {{ group.alwaysOn }} always on</template>
              <template v-if="group.turnedOff > 0"> · {{ group.turnedOff }} turned off</template>
            </span>
            <span
              class="bar"
              role="img"
              :aria-label="`${group.total - group.alwaysOn - group.turnedOff} on, ${group.turnedOff} off, ${group.alwaysOn} always on`"
            >
              <span class="bar__on" :style="{ width: `${proportions(group).on}%` }" />
              <span class="bar__off" :style="{ width: `${proportions(group).off}%` }" />
              <span class="bar__fixed" :style="{ width: `${proportions(group).fixed}%` }" />
            </span>
            <AppIcon
              :name="collapsed.has(group.targetTable) ? 'chevronRight' : 'chevronDown'"
              :size="14"
              class="group__chev"
            />
          </button>
        </template>

        <template v-if="!collapsed.has(group.targetTable)">
          <div
            v-for="edge in group.edges"
            :key="`${edge.table}.${edge.column}`"
            class="ui-row edge"
          >
            <span class="mono edge__path">
              <span class="text-muted">{{ edge.table }}</span
              ><span class="edge__col">.{{ edge.column }}</span>
              <span class="text-muted">
                → {{ edge.referencedTable }}.{{ edge.referencedColumn }}</span
              >
            </span>
            <!-- Only on screen when the toggle is showing them. A lock rather than a disabled
                 switch, so "this one is fixed" reads at a glance. -->
            <n-tooltip v-if="!edge.nullable" trigger="hover">
              <template #trigger>
                <span class="edge__lock" tabindex="0" aria-label="Always on">
                  <AppIcon name="lock" :size="14" />
                </span>
              </template>
              This column isn't allowed to be empty, so the linked record has to be brought in.
            </n-tooltip>
            <n-switch
              v-else
              :value="isOn(edge)"
              size="small"
              :aria-label="`Follow ${edge.table}.${edge.column}`"
              @update:value="(on: boolean) => toggle(edge, on)"
            />
          </div>
        </template>
      </UiPanel>
    </div>

    <!-- Settings whose link isn't in the list on screen: either nothing has been read this
         session, or the column is gone. Never hide a setting just because it went stale. -->
    <template v-if="unlistedSettings.length > 0">
      <div class="page-header">
        <h2 class="section-title">
          Not in the list above <span class="num">({{ unlistedSettings.length }})</span>
        </h2>
        <p class="page-desc">
          These links are turned off but aren't among the ones read from the database. Read the
          links again to check they still exist — an extract warns about any that don't.
        </p>
      </div>

      <UiPanel>
        <div v-for="policy in unlistedSettings" :key="policy.id" class="ui-row edge">
          <span class="mono edge__path">
            <span class="text-muted">{{ policy.tableName }}</span
            ><span class="edge__col">.{{ policy.columnName }}</span>
          </span>
          <UiBadge tone="warn">turned off</UiBadge>
          <n-button
            quaternary
            size="small"
            @click="turnBackOn(policy.tableName, policy.columnName)"
          >
            Turn back on
          </n-button>
        </div>
      </UiPanel>
    </template>
  </section>
</template>

<style scoped>
.filter {
  width: 280px;
}

.switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: rgb(var(--fg-muted));
  cursor: pointer;
}

.explainer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px;
  font-size: 13px;
  line-height: 1.55;
}

.note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-control);
  background: rgb(var(--surface-1));
  color: rgb(var(--fg-muted));
  font-size: 13px;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* The header sticks while its group's links scroll past. */
.group :deep(.ui-panel__header) {
  position: sticky;
  top: -16px;
  z-index: 1;
  padding: 0;
  background: rgb(var(--surface-1));
}

.group {
  overflow: visible;
}

.group__head {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 44px;
  padding: 8px 14px;
  border: 0;
  border-radius: var(--radius-panel) var(--radius-panel) 0 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.group__table {
  font-weight: 500;
  color: rgb(var(--fg));
}

.group__meta {
  flex: 1;
  font-size: 12px;
  color: rgb(var(--fg-muted));
}

.group__chev {
  color: rgb(var(--fg-muted));
}

.bar {
  display: flex;
  flex: none;
  width: 96px;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: rgb(var(--surface-3));
}

.bar__on {
  background: rgb(var(--ok));
}

.bar__off {
  background: rgb(var(--warn));
}

.bar__fixed {
  background: rgb(var(--fg-subtle));
}

.edge {
  justify-content: space-between;
}

.edge__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.edge__col {
  color: rgb(var(--fg));
  font-weight: 500;
}

.edge__lock {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 20px;
  color: rgb(var(--fg-subtle));
  cursor: help;
}
</style>
