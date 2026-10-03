<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import type { Run, RunStatus } from '@shared/types'
import { useRunsStore } from '@renderer/stores/runs'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { totalRows, useRunExtract } from '@renderer/composables/useRunExtract'
import LoadErrorAlert from '@renderer/components/LoadErrorAlert.vue'
import AppIcon from '@renderer/components/ui/AppIcon.vue'
import EmptyState from '@renderer/components/ui/EmptyState.vue'
import StatusDot from '@renderer/components/ui/StatusDot.vue'
import TopBarActions from '@renderer/components/ui/TopBarActions.vue'
import UiBadge from '@renderer/components/ui/UiBadge.vue'
import UiPanel from '@renderer/components/ui/UiPanel.vue'

const runs = useRunsStore()
const workspace = useWorkspaceStore()
const message = useMessage()

const hasWorkspace = computed(() => !!workspace.currentWorkspaceId)

const { runExtract } = useRunExtract()

const statusTone: Record<RunStatus, 'warn' | 'ok' | 'danger'> = {
  running: 'warn',
  completed: 'ok',
  failed: 'danger'
}

/** Non-zero per-table counts, largest first, as "table: n" chips. */
function tableCounts(run: Run): [string, number][] {
  if (!run.rowCounts) return []
  return Object.entries(run.rowCounts)
    .filter(([, n]) => n > 0)
    .sort(([, a], [, b]) => b - a)
}

/**
 * A run's warnings. These are the most important thing a run reports after the dump itself — each one
 * is a way the dump is quietly less complete than the selection rules imply (a reference that still
 * dangles, an FK constraint stripped from the DDL, an unmapped polymorphic type value). They used to
 * go to `console.warn` only, so nobody using the app ever saw them.
 */
function warnings(run: Run): string[] {
  return run.warnings ?? []
}

function outputPaths(run: Run): string[] {
  const f = run.outputFiles
  if (!f) return []
  return [f.combined, f.schema, f.data].filter((p): p is string => !!p)
}

/**
 * A run as plain text, for pasting into a ticket, a message, or a note.
 *
 * Everything the card shows, in the order it shows it — the point is that copying is equivalent to
 * reading, so nobody has to wonder whether the useful part came along. Row counts are capped at the
 * twenty largest tables because a real dump touches hundreds and the tail is noise in a paste.
 */
const TOP_TABLES_IN_SUMMARY = 20

function runSummary(run: Run): string {
  const lines = [
    `Run ${run.status} — ${formatTime(run.startedAt)}${duration(run) ? ` (${duration(run)})` : ''}`
  ]
  if (run.errorMessage) lines.push('', run.errorMessage)

  const counts = tableCounts(run)
  if (counts.length > 0) {
    lines.push('', `Rows: ${totalRows(run).toLocaleString()}`)
    for (const [table, n] of counts.slice(0, TOP_TABLES_IN_SUMMARY)) {
      lines.push(`  ${table}: ${n.toLocaleString()}`)
    }
    if (counts.length > TOP_TABLES_IN_SUMMARY) {
      lines.push(`  … and ${counts.length - TOP_TABLES_IN_SUMMARY} more tables`)
    }
  }

  const w = warnings(run)
  if (w.length > 0) lines.push('', `Warnings (${w.length}):`, ...w.map((text) => `  - ${text}`))

  const paths = outputPaths(run)
  if (paths.length > 0) lines.push('', 'Output:', ...paths.map((p) => `  ${p}`))

  return lines.join('\n')
}

/** Copy any text, reporting what was copied so the click has visible confirmation. */
async function copy(text: string, what: string): Promise<void> {
  try {
    await window.api.system.copyText(text)
    message.success(`${what} copied.`)
  } catch (err) {
    message.error(`Could not copy: ${(err as Error).message}`)
  }
}

/** Reveal one dump file in Finder / File Explorer, selected. */
async function reveal(path: string): Promise<void> {
  try {
    await window.api.system.showItemInFolder(path)
  } catch (err) {
    message.error(`Could not show the file: ${(err as Error).message}`)
  }
}

/** Where this workspace's dumps go — resolved in main, so it matches what the next run will use. */
const dumpDir = ref('')

/**
 * Resolve the active workspace's dump folder.
 *
 * The workspace is captured before the await *and re-checked after it*: switching workspaces fires
 * this again, and two in-flight requests can resolve out of order. Assigning unconditionally would
 * let the earlier one land last, leaving Copy and Open pointed at the previous workspace's folder
 * until something else refreshed it. Same guard the discovery store uses when caching per workspace.
 */
async function loadDumpDir(): Promise<void> {
  const id = workspace.currentWorkspaceId
  if (!id) {
    dumpDir.value = ''
    return
  }
  const resolved = await window.api.extract.dumpDirectory(id)
  if (workspace.currentWorkspaceId === id) dumpDir.value = resolved
}

/**
 * Open the dump folder in the OS file manager. A missing folder is reported rather than thrown:
 * before the first run there's genuinely nothing there yet, which is worth saying plainly.
 */
async function openDumpFolder(): Promise<void> {
  if (!dumpDir.value) return
  const problem = await window.api.system.openPath(dumpDir.value)
  if (problem) message.warning(problem)
}

function formatTime(iso?: string): string {
  if (!iso) return '—'
  // SQLite datetime('now') yields "YYYY-MM-DD HH:MM:SS" (UTC). Render as local time.
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function duration(run: Run): string {
  if (!run.finishedAt) return ''
  const start = new Date(run.startedAt.replace(' ', 'T') + 'Z').getTime()
  const end = new Date(run.finishedAt.replace(' ', 'T') + 'Z').getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return ''
  const secs = Math.max(0, Math.round((end - start) / 1000))
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
}

/**
 * Stop the run in flight. Cooperative, so the button stays in its "stopping" state until the
 * pipeline reaches its next source query or row and unwinds — which can take a moment if it's
 * inside one long query.
 */
async function stopRun(): Promise<void> {
  try {
    if (await runs.cancel()) message.info('Stopping — the run will stop at its next query.')
    else message.info('Nothing is running.')
  } catch (err) {
    message.error(`Could not stop the run: ${(err as Error).message}`)
  }
}

// A run belongs to the main process, not this component: reloading the renderer or arriving on this
// screen mid-run would otherwise show nothing in progress and offer no way to stop it.
onMounted(() => void runs.syncRunning())

// The folder follows the active workspace, and can change under us when one is edited — so it's
// re-resolved on switch rather than read once on mount.
watch(() => workspace.currentWorkspace, loadDumpDir, { immediate: true, deep: true })

/** Reload everything this screen reads; failures stay on each store's `loadError`. */
function retryLoad(): void {
  const id = workspace.currentWorkspaceId
  if (!id) return
  runs.loadForWorkspace(id).catch(() => {})
}
</script>

<template>
  <div class="page">
    <!-- Run itself is the top bar's persistent button; this screen adds what only applies here. -->
    <TopBarActions>
      <n-button
        v-if="runs.running"
        size="small"
        type="error"
        secondary
        :loading="runs.cancelling"
        @click="stopRun"
      >
        <template #icon><AppIcon name="stop" :size="12" /></template>
        Stop run
      </n-button>
      <n-button
        v-if="dumpDir"
        size="small"
        quaternary
        :disabled="!hasWorkspace"
        @click="openDumpFolder"
      >
        <template #icon><AppIcon name="folder" :size="14" /></template>
        Open dump folder
      </n-button>
    </TopBarActions>

    <header class="page-header">
      <h1 class="page-title">Runs</h1>
      <p class="page-desc">
        Generate an anonymized dump of <strong>{{ workspace.currentWorkspace?.name }}</strong> from
        its source connection, and review past runs.
      </p>
    </header>

    <!--
      Its own row, not part of the header's text column: that column shrinks while a run is going
      (the Stop and Running buttons widen the actions), which squeezed a long path into a thin strip.
    -->
    <div v-if="dumpDir" class="toolbar dumpdir">
      <span class="dumpdir__label">Dumps are written to</span>
      <code class="mono dumpdir__path" :title="dumpDir">{{ dumpDir }}</code>
      <n-button size="tiny" quaternary @click="copy(dumpDir, 'Folder path')">
        <template #icon><AppIcon name="copy" :size="12" /></template>
        Copy
      </n-button>
    </div>

    <LoadErrorAlert :errors="[runs.loadError]" @retry="retryLoad" />

    <!-- There's no progress reported from the main process, so the bar is indeterminate. -->
    <div v-if="runs.running" class="running" role="status">
      <div class="running__line">
        <StatusDot tone="warn" pulse />
        <span>Extract running…</span>
        <span class="text-subtle running__hint">You can keep working; Stop run cancels it.</span>
      </div>
      <div class="progress" aria-hidden="true"><span class="progress__bar" /></div>
    </div>

    <EmptyState
      v-if="runs.list.length === 0 && !runs.running"
      icon="runs"
      title="No runs yet"
      :description="
        runs.sourceConnection
          ? 'Run an extract to generate a dump.'
          : 'Add a source connection to this workspace, then run an extract.'
      "
    >
      <n-button
        type="primary"
        size="small"
        :disabled="!hasWorkspace || !runs.sourceConnection"
        @click="runExtract"
      >
        <template #icon><AppIcon name="play" :size="12" /></template>
        Run extract
      </n-button>
    </EmptyState>

    <UiPanel v-else-if="runs.list.length > 0">
      <article v-for="run in runs.list" :key="run.id" class="run">
        <div class="run__top">
          <StatusDot
            :tone="statusTone[run.status]"
            :pulse="run.status === 'running'"
            :label="run.status"
          />
          <span class="run__status" :class="`run__status--${run.status}`">{{ run.status }}</span>
          <span class="run__time num">{{ formatTime(run.startedAt) }}</span>
          <span v-if="duration(run)" class="text-muted num">· {{ duration(run) }}</span>
          <span v-if="run.status === 'completed'" class="text-muted num">
            · {{ totalRows(run).toLocaleString() }} rows
          </span>
          <UiBadge v-if="warnings(run).length" tone="warn">
            {{ warnings(run).length }} {{ warnings(run).length === 1 ? 'warning' : 'warnings' }}
          </UiBadge>
          <!-- Copies exactly what this row shows, so pasting is equivalent to reading it. -->
          <n-button
            size="tiny"
            quaternary
            class="run__copy"
            @click="copy(runSummary(run), 'Run details')"
          >
            <template #icon><AppIcon name="copy" :size="12" /></template>
            Copy details
          </n-button>
        </div>

        <p v-if="run.errorMessage" class="run__error">
          <span>{{ run.errorMessage }}</span>
          <n-button size="tiny" quaternary @click="copy(run.errorMessage, 'Error')">Copy</n-button>
        </p>

        <template v-if="warnings(run).length">
          <ul class="run__warnings">
            <li v-for="(w, i) in warnings(run)" :key="i" class="run__warning">{{ w }}</li>
          </ul>
          <div>
            <n-button size="tiny" secondary @click="copy(warnings(run).join('\n'), 'Warnings')">
              Copy {{ warnings(run).length === 1 ? 'warning' : 'all warnings' }}
            </n-button>
          </div>
        </template>

        <div v-if="tableCounts(run).length" class="run__counts">
          <span v-for="[table, n] in tableCounts(run)" :key="table" class="run__count">
            <span class="mono">{{ table }}</span>
            <span class="num text-muted">{{ n.toLocaleString() }}</span>
          </span>
        </div>

        <div v-if="outputPaths(run).length" class="run__files">
          <div v-for="p in outputPaths(run)" :key="p" class="run__filerow">
            <code class="mono run__file" :title="p">{{ p }}</code>
            <n-button size="tiny" quaternary @click="copy(p, 'Path')">Copy path</n-button>
            <!-- Reveal, not open: `showItemInFolder` selects the file in the file manager and
                 never hands a .sql to whatever the OS has associated with it. -->
            <n-button size="tiny" quaternary @click="reveal(p)">Show in folder</n-button>
          </div>
        </div>
      </article>
    </UiPanel>
  </div>
</template>

<style scoped>
.dumpdir {
  flex-wrap: nowrap;
  min-width: 0;
  font-size: 12px;
}

.dumpdir__label {
  flex: none;
  color: rgb(var(--fg-muted));
}

.dumpdir__path {
  min-width: 0;
  font-size: 12px;
  color: rgb(var(--fg-muted));
  /* One line; a path too long for the window is cut at the end (full path on hover, and Copy). */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.running {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius-panel);
  background: rgb(var(--surface-1));
}

.running__line {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 500;
}

.running__hint {
  font-size: 12px;
  font-weight: 400;
}

.progress {
  position: relative;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: rgb(var(--surface-3));
}

.progress__bar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 35%;
  border-radius: 2px;
  background: rgb(var(--accent));
  animation: progress-slide 1.4s ease-in-out infinite;
}

@keyframes progress-slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .progress__bar {
    width: 100%;
    animation: none;
    opacity: 0.6;
  }
}

.run {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
}

.run__top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.run__status {
  font-weight: 500;
  text-transform: capitalize;
}

.run__status--completed {
  color: rgb(var(--ok));
}

.run__status--failed {
  color: rgb(var(--danger));
}

.run__status--running {
  color: rgb(var(--warn));
}

.run__time {
  font-weight: 500;
}

.run__copy {
  margin-left: auto;
}

.run__error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  color: rgb(var(--danger));
  word-break: break-word;
}

.run__warnings {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
}

.run__warning {
  padding-left: 10px;
  border-left: 2px solid rgb(var(--warn));
  font-size: 12.5px;
  line-height: 1.45;
  color: rgb(var(--warn));
  word-break: break-word;
}

.run__counts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 12px;
}

.run__count {
  display: inline-flex;
  gap: 6px;
}

.run__count .mono {
  font-size: 12px;
}

.run__files {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.run__filerow {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* The path takes the slack; the two buttons keep their width so they line up down the column. */
.run__file {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: rgb(var(--fg-muted));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
