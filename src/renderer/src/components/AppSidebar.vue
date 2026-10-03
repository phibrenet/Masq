<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { NButton, NFormItem, NInput, NModal, NText, useDialog, useMessage } from 'naive-ui'
import type { DumpOutputMode, Workspace, WorkspaceTransfer } from '@shared/types'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import logoUrl from '@renderer/assets/logo.svg'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useThemeStore, type ThemePreference } from '@renderer/stores/theme'
import { usePipelineStatusStore, type StepKey } from '@renderer/stores/pipelineStatus'
import WorkspaceFormModal from '@renderer/components/WorkspaceFormModal.vue'
import AppIcon, { type IconName } from '@renderer/components/ui/AppIcon.vue'
import MenuButton, { type MenuItem } from '@renderer/components/ui/MenuButton.vue'
import SegmentedControl, { type SegmentOption } from '@renderer/components/ui/SegmentedControl.vue'

const route = useRoute()
const workspace = useWorkspaceStore()
const connections = useConnectionsStore()
const theme = useThemeStore()
const pipeline = usePipelineStatusStore()
const dialog = useDialog()
const message = useMessage()

/** Appearance choices. Dark first — it is the default. */
const THEME_OPTIONS: SegmentOption<ThemePreference>[] = [
  { key: 'dark', label: 'Dark' },
  { key: 'light', label: 'Light' },
  { key: 'system', label: 'System', title: 'Follow the operating system' }
]

const OUTPUT_OPTIONS: SegmentOption<DumpOutputMode>[] = [
  { key: 'combined', label: 'Combined', title: 'One .sql file with schema and data' },
  { key: 'split', label: 'Split', title: 'Separate schema and data files' }
]

async function setOutputMode(mode: DumpOutputMode): Promise<void> {
  const id = workspace.currentWorkspaceId
  if (!id) return
  try {
    await workspace.update(id, { dumpOutputMode: mode })
  } catch (err) {
    message.error(`Could not change the output mode: ${(err as Error).message}`)
  }
}

const showForm = ref(false)
/** The workspace being edited, or null when the form is in create mode. */
const editing = ref<Workspace | null>(null)
// IPC needs a plain JSON object; a deep Vue proxy cannot be cloned by Electron.
const importing = shallowRef<WorkspaceTransfer | null>(null)
const importName = ref('')
const transferBusy = ref(false)

function openCreate(): void {
  editing.value = null
  showForm.value = true
}

function openEdit(): void {
  if (!workspace.currentWorkspace) return
  editing.value = workspace.currentWorkspace
  showForm.value = true
}

async function exportCurrent(): Promise<void> {
  const current = workspace.currentWorkspace
  if (!current) return
  transferBusy.value = true
  try {
    if (await window.api.config.exportWorkspace(current.id)) message.success('Workspace exported.')
  } catch (err) {
    message.error(`Could not export workspace: ${(err as Error).message}`)
  } finally {
    transferBusy.value = false
  }
}

async function chooseImport(): Promise<void> {
  transferBusy.value = true
  try {
    const file = await window.api.config.chooseWorkspaceImport()
    if (!file) return
    importing.value = file
    importName.value = file.workspace.name
    while (
      workspace.workspaces.some((w) => w.name.toLowerCase() === importName.value.toLowerCase())
    ) {
      importName.value += ' (imported)'
    }
  } catch (err) {
    message.error(`Could not read workspace file: ${(err as Error).message}`)
  } finally {
    transferBusy.value = false
  }
}

async function importChosen(): Promise<void> {
  if (!importing.value || !importName.value.trim()) return
  transferBusy.value = true
  try {
    const created = await window.api.config.importWorkspace(importing.value, importName.value)
    await workspace.load()
    workspace.select(created.id)
    importing.value = null
    message.success(`Workspace "${created.name}" imported. Add a source connection to use it.`)
  } catch (err) {
    message.error(`Could not import workspace: ${(err as Error).message}`)
  } finally {
    transferBusy.value = false
  }
}

function confirmDelete(): void {
  const target = workspace.currentWorkspace
  if (!target) return
  const count = connections.list.length
  const extra =
    count > 0 ? ` Its ${count} connection${count === 1 ? '' : 's'} will be deleted too.` : ''
  dialog.warning({
    title: 'Delete workspace',
    content: `Delete "${target.name}"? This can't be undone.${extra}`,
    positiveText: 'Delete',
    negativeText: 'Cancel',
    onPositiveClick: async () => {
      try {
        await workspace.remove(target.id)
        message.success(`Deleted "${target.name}".`)
      } catch (err) {
        message.error(`Could not delete workspace: ${(err as Error).message}`)
      }
    }
  })
}

/**
 * The workspace menu: switch → create → manage → delete. Everything that used to be a row of small
 * buttons under the selector lives here, grouped so the destructive action sits alone at the end.
 */
const workspaceMenu = computed<MenuItem[]>(() => {
  const hasCurrent = !!workspace.currentWorkspace
  return [
    ...workspace.workspaces.map((w) => ({
      key: `ws:${w.id}`,
      label: w.name,
      checked: w.id === workspace.currentWorkspaceId
    })),
    { key: 'new', label: 'New workspace…' },
    { key: 'd1', divider: true },
    { key: 'edit', label: 'Edit workspace…', disabled: !hasCurrent },
    {
      key: 'export',
      label: 'Export…',
      disabled: !hasCurrent || transferBusy.value,
      title: 'The file may contain values from rules and templates. Review it before sharing.'
    },
    { key: 'import', label: 'Import workspace…', disabled: transferBusy.value },
    { key: 'd2', divider: true },
    { key: 'delete', label: 'Delete workspace…', danger: true, disabled: !hasCurrent }
  ]
})

function onWorkspaceMenu(key: string): void {
  if (key.startsWith('ws:')) return workspace.select(key.slice(3))
  if (key === 'new') return openCreate()
  if (key === 'edit') return openEdit()
  if (key === 'export') return void exportCurrent()
  if (key === 'import') return void chooseImport()
  if (key === 'delete') return confirmDelete()
}

/** The pipeline, in workflow order: connect → classify → select → relate → anonymize → run. */
const STEPS: { key: StepKey; label: string; icon: IconName }[] = [
  { key: 'connections', label: 'Connections', icon: 'connections' },
  { key: 'tables', label: 'Tables', icon: 'tables' },
  { key: 'rules', label: 'Selection Rules', icon: 'rules' },
  { key: 'backfill', label: 'Backfill Management', icon: 'backfill' },
  { key: 'fields', label: 'Field Strategies', icon: 'fields' },
  { key: 'morphs', label: 'Polymorphic', icon: 'morphs' },
  { key: 'runs', label: 'Runs', icon: 'runs' }
]

const activeKey = computed(() => route.name as string)
</script>

<template>
  <div class="sidebar">
    <div class="sidebar__brand">
      <img class="sidebar__mark" :src="logoUrl" alt="" />
      <span class="sidebar__name">Masq</span>
    </div>

    <div class="sidebar__section">
      <span class="sidebar__label">Workspace</span>
      <MenuButton
        :items="workspaceMenu"
        placement="bottom-start"
        label="Workspace menu"
        @select="onWorkspaceMenu"
      >
        <template #trigger>
          <button type="button" class="ws-trigger" aria-haspopup="menu">
            <span class="ws-trigger__name">
              {{ workspace.currentWorkspace?.name ?? 'No workspace' }}
            </span>
            <AppIcon name="chevronDown" :size="14" class="ws-trigger__chev" />
          </button>
        </template>
      </MenuButton>
    </div>

    <WorkspaceFormModal v-model:show="showForm" :workspace="editing" />
    <n-modal
      :show="!!importing"
      preset="card"
      title="Import workspace"
      :style="{ width: '440px', maxWidth: '92vw' }"
      :mask-closable="!transferBusy"
      :close-on-esc="!transferBusy"
      @update:show="
        (open: boolean) => {
          if (!open) importing = null
        }
      "
    >
      <n-text depth="3">
        {{ importing?.tableClassifications.length }} table settings ·
        {{ importing?.selectionRules.length }} selection rules ·
        {{ importing?.fieldStrategies.length }} field strategies ·
        {{ importing?.morphRelations.length }} morph relations
      </n-text>
      <div class="import-name">
        <n-form-item label="Workspace name">
          <n-input v-model:value="importName" placeholder="Workspace name" />
        </n-form-item>
      </div>
      <n-text depth="3"
        >Connections, passwords, dump files, and local paths are not included.</n-text
      >
      <template #footer>
        <div class="import-actions">
          <n-button :disabled="transferBusy" @click="importing = null">Cancel</n-button>
          <n-button
            type="primary"
            :loading="transferBusy"
            :disabled="!importName.trim()"
            @click="importChosen"
            >Import</n-button
          >
        </div>
      </template>
    </n-modal>

    <nav class="steps" aria-label="Pipeline">
      <span class="sidebar__label sidebar__label--nav">Pipeline</span>
      <RouterLink
        v-for="step in STEPS"
        :key="step.key"
        :to="{ name: step.key }"
        class="step"
        :class="{ 'step--active': activeKey === step.key }"
        :aria-current="activeKey === step.key ? 'page' : undefined"
      >
        <span class="step__icon"><AppIcon :name="step.icon" :size="16" /></span>
        <span class="step__label">{{ step.label }}</span>
        <template v-if="pipeline.steps[step.key].state === 'done'">
          <span class="step__done" role="img" aria-label="Done" title="Done" />
        </template>
        <template v-else-if="pipeline.steps[step.key].state === 'attention'">
          <span
            class="step__badge num"
            :title="(pipeline.steps[step.key] as { hint: string }).hint"
            :aria-label="(pipeline.steps[step.key] as { hint: string }).hint"
          >
            {{ (pipeline.steps[step.key] as { count: number | '!' }).count }}
          </span>
        </template>
      </RouterLink>
    </nav>

    <div class="sidebar__footer">
      <div class="sidebar__setting">
        <span class="sidebar__label">Output mode</span>
        <SegmentedControl
          :options="OUTPUT_OPTIONS"
          :model-value="workspace.currentWorkspace?.dumpOutputMode ?? null"
          :disabled="!workspace.currentWorkspace"
          label="Output mode"
          @update:model-value="setOutputMode"
        />
      </div>
      <div class="sidebar__setting">
        <span class="sidebar__label">Appearance</span>
        <SegmentedControl
          :options="THEME_OPTIONS"
          :model-value="theme.preference"
          label="Appearance"
          @update:model-value="theme.setPreference"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.import-name {
  display: grid;
  gap: 6px;
  margin: 18px 0;
}

.import-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0 10px 12px;
  overflow-y: auto;
}

/* The brand row doubles as a drag handle for the frameless window, level with the top bar. */
.sidebar__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  height: 52px;
  padding: 0 8px;
  -webkit-app-region: drag;
}

/* macOS puts the traffic lights here; the brand sits below them. */
:global(.shell--darwin) .sidebar__brand {
  height: 72px;
  padding-top: 28px;
}

.sidebar__mark {
  width: 26px;
  height: 26px;
}

.sidebar__name {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: rgb(var(--fg));
}

.sidebar__section {
  padding: 4px 6px 14px;
}

.sidebar__label {
  display: block;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgb(var(--fg-subtle));
}

.sidebar__label--nav {
  padding: 0 8px;
  margin-top: 4px;
}

.ws-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--radius-control);
  background: rgb(var(--surface-2));
  color: rgb(var(--fg));
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background-color 150ms;
}

.ws-trigger:hover {
  background: rgb(var(--surface-3));
}

.ws-trigger__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-trigger__chev {
  color: rgb(var(--fg-muted));
}

.steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  padding-top: 4px;
}

.step {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--radius-control);
  color: rgb(var(--fg-muted));
  font-size: 13px;
  text-decoration: none;
  transition:
    background-color 150ms,
    color 150ms;
}

.step:hover {
  background: rgb(var(--line) / 0.03);
  color: rgb(var(--fg));
}

.step--active,
.step--active:hover {
  background: rgb(var(--accent) / 0.1);
  color: rgb(var(--fg));
  font-weight: 500;
}

.step--active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 2px;
  background: rgb(var(--accent));
}

.step:focus-visible {
  outline: 2px solid rgb(var(--accent) / 0.6);
  outline-offset: -2px;
}

.step__icon {
  position: relative;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
}

.step--active .step__icon {
  color: rgb(var(--accent));
}

/* The dashed connector from each step's icon down to the next one's. */
.step:not(:last-child) .step__icon::after {
  content: '';
  position: absolute;
  left: 50%;
  top: calc(100% + 2px);
  height: 12px;
  border-left: 1px dashed rgb(var(--line) / 0.1);
}

.step__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step__done {
  width: 6px;
  height: 6px;
  margin-right: 4px;
  border-radius: 50%;
  background: rgb(var(--ok));
}

.step__badge {
  min-width: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgb(var(--warn) / 0.15);
  color: rgb(var(--warn));
  font-size: 11px;
  line-height: 18px;
  font-weight: 600;
  text-align: center;
}

.sidebar__footer {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 6px 2px;
  border-top: 1px solid rgb(var(--line) / 0.06);
}
</style>
