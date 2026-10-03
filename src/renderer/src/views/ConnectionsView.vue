<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { NButton, useDialog, useMessage } from 'naive-ui'
import type { Connection } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useConnectionTestsStore, type ConnectionTestState } from '@renderer/stores/connectionTests'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import ConnectionFormModal from '@renderer/components/ConnectionFormModal.vue'
import LoadErrorAlert from '@renderer/components/LoadErrorAlert.vue'
import AppIcon from '@renderer/components/ui/AppIcon.vue'
import EngineIcon from '@renderer/components/ui/EngineIcon.vue'
import MenuButton from '@renderer/components/ui/MenuButton.vue'
import StatusDot from '@renderer/components/ui/StatusDot.vue'
import UiBadge from '@renderer/components/ui/UiBadge.vue'

const connections = useConnectionsStore()
const tests = useConnectionTestsStore()
const workspace = useWorkspaceStore()
const dialog = useDialog()
const message = useMessage()

const list = computed(() => connections.list)

const showForm = ref(false)
/** The connection being edited, or null when the form is in create mode. */
const editing = ref<Connection | null>(null)

function openCreate(): void {
  editing.value = null
  showForm.value = true
}

function openEdit(c: Connection): void {
  editing.value = c
  showForm.value = true
}

function confirmDelete(c: Connection): void {
  dialog.warning({
    title: 'Delete connection',
    content: `Delete "${c.label}"? This can't be undone.`,
    positiveText: 'Delete',
    negativeText: 'Cancel',
    onPositiveClick: async () => {
      try {
        await connections.remove(c.id)
        message.success(`Deleted "${c.label}".`)
      } catch (err) {
        message.error(`Could not delete connection: ${(err as Error).message}`)
      }
    }
  })
}

function onMenu(c: Connection, key: string): void {
  if (key === 'edit') openEdit(c)
  else if (key === 'delete') confirmDelete(c)
}

async function testConnection(c: Connection): Promise<void> {
  try {
    const result = await tests.test(c.id)
    if (result.ok) {
      message.success(`Connected to "${c.label}" — found ${result.tableCount ?? 0} tables.`)
    } else {
      message.error(`"${c.label}" failed: ${result.error}`)
    }
  } catch (err) {
    message.error(`Could not test "${c.label}": ${(err as Error).message}`)
  }
}

/** Server target, split so the address and the database can be styled apart. */
function target(c: Connection): { address: string; database?: string } {
  if (c.filePath) return { address: c.filePath }
  return {
    address: [c.host, c.port].filter(Boolean).join(':'),
    database: c.database || undefined
  }
}

// "tested 3 min ago" has to move on by itself, so relative times re-render on a slow tick.
const now = ref(Date.now())
const clock = window.setInterval(() => (now.value = Date.now()), 30_000)
onBeforeUnmount(() => window.clearInterval(clock))

function ago(at: number): string {
  const secs = Math.max(0, Math.round((now.value - at) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  return `${hours} h ago`
}

function statusLine(result: ConnectionTestState | undefined): string {
  if (!result) return 'Not tested this session'
  return result.ok
    ? `Connected · ${result.ms} ms · tested ${ago(result.testedAt)}`
    : `Failed · tested ${ago(result.testedAt)}`
}

function statusTone(c: Connection): 'ok' | 'danger' | 'muted' | 'warn' {
  if (tests.testing.has(c.id)) return 'warn'
  const result = tests.results[c.id]
  if (!result) return 'muted'
  return result.ok ? 'ok' : 'danger'
}

/** Reload everything this screen reads; failures stay on each store's `loadError`. */
function retryLoad(): void {
  const id = workspace.currentWorkspaceId
  if (!id) return
  connections.loadForWorkspace(id).catch(() => {})
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1 class="page-title">Connections</h1>
      <p class="page-desc">
        Source databases for <strong>{{ workspace.currentWorkspace?.name }}</strong
        >. Masq reads from these — it never writes back.
      </p>
    </header>

    <LoadErrorAlert :errors="[connections.loadError]" @retry="retryLoad" />

    <div class="grid">
      <article v-for="c in list" :key="c.id" class="conn">
        <div class="conn__head">
          <EngineIcon :dialect="c.dialect" />
          <div class="conn__title">
            <h2 class="conn__name">{{ c.label }}</h2>
            <p class="conn__target">
              <span class="mono">{{ target(c).address }}</span>
              <template v-if="target(c).database">
                <span class="conn__slash">/</span>
                <span class="mono conn__db">{{ target(c).database }}</span>
              </template>
            </p>
          </div>
          <MenuButton
            :items="[
              { key: 'edit', label: 'Edit…' },
              { key: 'd', divider: true },
              { key: 'delete', label: 'Delete…', danger: true }
            ]"
            :label="`Actions for ${c.label}`"
            @select="(key) => onMenu(c, key)"
          />
        </div>

        <div class="conn__meta">
          <span v-if="c.username" class="text-muted"
            >as <span class="mono">{{ c.username }}</span></span
          >
          <UiBadge :tone="c.role === 'source' ? 'ok' : 'warn'" variant="outline">{{
            c.role
          }}</UiBadge>
          <span class="conn__ro" title="Masq only ever reads from a connection">
            <AppIcon name="lock" :size="12" />
            Read-only
          </span>
        </div>

        <div class="conn__foot">
          <div class="conn__status" :title="tests.results[c.id]?.error">
            <StatusDot :tone="statusTone(c)" :pulse="tests.testing.has(c.id)" />
            <span class="num">{{
              tests.testing.has(c.id) ? 'Testing…' : statusLine(tests.results[c.id])
            }}</span>
            <span
              v-if="tests.results[c.id]?.ok && tests.results[c.id]?.tableCount !== undefined"
              class="text-subtle num"
            >
              · {{ tests.results[c.id]?.tableCount }} tables
            </span>
          </div>
          <n-button
            size="small"
            quaternary
            :loading="tests.testing.has(c.id)"
            @click="testConnection(c)"
          >
            <template #icon><AppIcon name="zap" :size="14" /></template>
            Test
          </n-button>
        </div>
      </article>

      <button
        type="button"
        class="add-tile"
        :disabled="!workspace.currentWorkspaceId"
        @click="openCreate"
      >
        <AppIcon name="plus" :size="18" />
        <span>Add connection</span>
        <span v-if="list.length === 0" class="add-tile__hint">
          No connections in this workspace yet.
        </span>
      </button>
    </div>

    <ConnectionFormModal v-model:show="showForm" :connection="editing" />
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
}

@media (min-width: 1024px) {
  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.conn {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 14px 10px;
  background: rgb(var(--surface-1));
  border-radius: var(--radius-panel);
}

.conn__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.conn__title {
  flex: 1;
  min-width: 0;
}

.conn__name {
  font-size: 15px;
  line-height: 20px;
  font-weight: 500;
  color: rgb(var(--fg));
}

.conn__target {
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--fg));
}

.conn__slash {
  margin: 0 6px;
  color: rgb(var(--fg-subtle));
}

.conn__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  font-size: 12px;
}

.conn__ro {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: rgb(var(--fg-muted));
}

.conn__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid rgb(var(--line) / 0.04);
}

.conn__status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  color: rgb(var(--fg-muted));
  white-space: nowrap;
  overflow: hidden;
}

.add-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 150px;
  border: 2px dashed rgb(var(--line) / 0.1);
  border-radius: var(--radius-panel);
  background: transparent;
  color: rgb(var(--fg-muted));
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition:
    border-color 150ms,
    color 150ms;
}

.add-tile:hover:not(:disabled) {
  border-color: rgb(var(--accent) / 0.5);
  color: rgb(var(--fg));
}

.add-tile:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.add-tile__hint {
  font-size: 12px;
  font-weight: 400;
  color: rgb(var(--fg-subtle));
}
</style>
