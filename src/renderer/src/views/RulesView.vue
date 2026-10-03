<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, useDialog, useMessage } from 'naive-ui'
import type { SelectionRule } from '@shared/types'
import { describeRule } from '@renderer/lib/conditions'
import { useSelectionRulesStore } from '@renderer/stores/selectionRules'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import SelectionRuleFormModal from '@renderer/components/SelectionRuleFormModal.vue'
import LoadErrorAlert from '@renderer/components/LoadErrorAlert.vue'
import AppIcon from '@renderer/components/ui/AppIcon.vue'
import EmptyState from '@renderer/components/ui/EmptyState.vue'
import MenuButton from '@renderer/components/ui/MenuButton.vue'
import TopBarActions from '@renderer/components/ui/TopBarActions.vue'
import UiBadge from '@renderer/components/ui/UiBadge.vue'
import UiPanel from '@renderer/components/ui/UiPanel.vue'

const rules = useSelectionRulesStore()
const workspace = useWorkspaceStore()
const dialog = useDialog()
const message = useMessage()

const hasWorkspace = computed(() => !!workspace.currentWorkspaceId)

const showModal = ref(false)
const editing = ref<SelectionRule | null>(null)

function openCreate(): void {
  editing.value = null
  showModal.value = true
}

function openEdit(rule: SelectionRule): void {
  editing.value = rule
  showModal.value = true
}

/** Rules grouped by table, tables alphabetical — a table can carry several rules (spec §6). */
const grouped = computed(() => {
  const byTable = new Map<string, SelectionRule[]>()
  for (const r of rules.list) {
    const arr = byTable.get(r.table) ?? []
    arr.push(r)
    byTable.set(r.table, arr)
  }
  return [...byTable.entries()].sort(([a], [b]) => a.localeCompare(b))
})

function onMenu(rule: SelectionRule, key: string): void {
  if (key === 'delete') void remove(rule)
}

async function remove(rule: SelectionRule): Promise<void> {
  dialog.warning({
    title: 'Delete rule',
    content: `Delete "${describeRule(rule)}" for "${rule.table}"?`,
    positiveText: 'Delete',
    negativeText: 'Cancel',
    onPositiveClick: async () => {
      try {
        await rules.remove(rule.id)
        message.success('Rule deleted.')
      } catch (err) {
        message.error(`Could not delete rule: ${(err as Error).message}`)
      }
    }
  })
}

/** Reload everything this screen reads; failures stay on each store's `loadError`. */
function retryLoad(): void {
  const id = workspace.currentWorkspaceId
  if (!id) return
  rules.loadForWorkspace(id).catch(() => {})
}
</script>

<template>
  <div class="page">
    <TopBarActions>
      <n-button size="small" secondary :disabled="!hasWorkspace" @click="openCreate">
        <template #icon><AppIcon name="plus" :size="14" /></template>
        Add rule
      </n-button>
    </TopBarActions>

    <header class="page-header">
      <h1 class="page-title">Selection Rules</h1>
      <p class="page-desc">
        Choose which rows are kept from each transactional table in
        <strong>{{ workspace.currentWorkspace?.name }}</strong> — and whether they're anonymized.
        Multiple rules per table merge; <em>preserve wins</em> on conflict.
      </p>
    </header>

    <LoadErrorAlert :errors="[rules.loadError]" @retry="retryLoad" />

    <EmptyState
      v-if="grouped.length === 0"
      icon="rules"
      title="No selection rules yet"
      description="Add one to subset a transactional table."
    >
      <n-button type="primary" size="small" :disabled="!hasWorkspace" @click="openCreate">
        Add a rule
      </n-button>
    </EmptyState>

    <div v-else class="groups">
      <UiPanel v-for="[table, tableRules] in grouped" :key="table">
        <template #header>
          <span class="mono group__name">{{ table }}</span>
          <span class="text-subtle num group__count">
            {{ tableRules.length }} rule{{ tableRules.length === 1 ? '' : 's' }}
          </span>
        </template>
        <div v-for="rule in tableRules" :key="rule.id" class="ui-row rule">
          <div class="rule__main">
            <span class="rule__desc">{{ describeRule(rule) }}</span>
            <!-- Shown, not silently repaired: what's rendered to the left is the *widened*
                 reading of a rule that couldn't be read back, and running it could dump a whole
                 table verbatim. Extracts refuse until it's opened and saved. -->
            <p v-if="rule.invalid" class="rule__problem">
              Can't be run — {{ rule.invalid }}. Edit it, check it reads the way you meant, and
              save.
            </p>
          </div>
          <UiBadge v-if="rule.invalid" tone="danger">needs fixing</UiBadge>
          <UiBadge :tone="rule.anonymize ? 'strat-fake' : 'strat-preserve'">
            {{ rule.anonymize ? 'anonymize' : 'preserve' }}
          </UiBadge>
          <span class="rule__actions">
            <n-button size="tiny" quaternary @click="openEdit(rule)">Edit</n-button>
            <MenuButton
              :items="[{ key: 'delete', label: 'Delete…', danger: true }]"
              label="More actions for this rule"
              @select="(key) => onMenu(rule, key)"
            />
          </span>
        </div>
      </UiPanel>
    </div>

    <SelectionRuleFormModal v-model:show="showModal" :rule="editing" />
  </div>
</template>

<style scoped>
.groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.group__name {
  font-weight: 500;
  color: rgb(var(--fg));
}

.group__count {
  font-size: 12px;
}

.rule__main {
  flex: 1;
  min-width: 0;
}

.rule__desc {
  font-size: 13px;
  word-break: break-word;
}

.rule__problem {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.45;
  color: rgb(var(--danger));
}

.rule__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
</style>
