<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton } from 'naive-ui'
import AppSidebar from '@renderer/components/AppSidebar.vue'
import LoadErrorAlert from '@renderer/components/LoadErrorAlert.vue'
import AppIcon from '@renderer/components/ui/AppIcon.vue'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { useRunsStore } from '@renderer/stores/runs'
import { useRunExtract } from '@renderer/composables/useRunExtract'

/**
 * The window layout: sidebar on the left, and on the right a 40px top bar over the scrolling page.
 *
 * The window is frameless (see `createWindow`), so the top bar is the drag handle. Everything
 * clickable in it opts out of dragging, and it leaves room for the OS window controls — the overlay
 * on the right on Windows/Linux, the traffic lights over the sidebar on macOS.
 */
const route = useRoute()
const router = useRouter()
const workspace = useWorkspaceStore()
const runs = useRunsStore()
const { runExtract } = useRunExtract()

const title = computed(() => (route.meta.title as string | undefined) ?? 'Masq')
const platform = window.api.platform

// Load workspaces from the config store on startup; setting the current workspace cascades
// to the connections store (its watcher loads that workspace's connections).
onMounted(() => {
  // A failure is kept on `workspace.loadError` and shown above the screen with a retry.
  workspace.load().catch(() => {})
})

/** The persistent Run button: go to the Runs screen, where progress shows, and start a run there. */
async function run(): Promise<void> {
  if (route.name !== 'runs') await router.push({ name: 'runs' })
  await runExtract()
}
</script>

<template>
  <div class="shell" :class="`shell--${platform}`">
    <aside class="shell__sidebar">
      <AppSidebar />
    </aside>
    <div class="shell__main">
      <header class="topbar">
        <nav class="topbar__crumbs" aria-label="Breadcrumb">
          <span class="topbar__workspace">{{ workspace.currentWorkspace?.name ?? 'Masq' }}</span>
          <AppIcon name="chevronRight" :size="14" class="topbar__sep" />
          <span class="topbar__page" aria-current="page">{{ title }}</span>
        </nav>
        <div class="topbar__actions">
          <!-- Pages teleport their own actions in here (see `ui/TopBarActions.vue`). -->
          <div id="topbar-actions" class="topbar__slot" />
          <n-button
            type="primary"
            size="small"
            :loading="runs.running"
            :disabled="!workspace.currentWorkspaceId || !runs.sourceConnection"
            :title="
              runs.sourceConnection ? 'Run an extract' : 'No source connection in this workspace'
            "
            @click="run"
          >
            <template #icon><AppIcon name="play" :size="14" /></template>
            {{ runs.running ? 'Running…' : 'Run' }}
          </n-button>
        </div>
      </header>
      <main class="shell__content">
        <LoadErrorAlert :errors="[workspace.loadError]" @retry="workspace.load().catch(() => {})" />
        <router-view />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  height: 100vh;
  background: rgb(var(--bg));
}

.shell__sidebar {
  min-height: 0;
  background: rgb(var(--bg));
  border-right: 1px solid rgb(var(--line) / 0.06);
}

.shell__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex: none;
  height: 40px;
  padding: 0 12px 0 28px;
  -webkit-app-region: drag;
}

/*
 * Windows/Linux draw their controls over the right of the bar. Window Controls Overlay reports the
 * free area through `titlebar-area-*`; where it doesn't, reserve roughly the controls' width.
 */
.shell--win32 .topbar,
.shell--linux .topbar {
  padding-right: max(
    12px,
    calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 140px)) + 8px)
  );
}

.topbar__crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
}

.topbar__workspace {
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgb(var(--fg-muted));
}

.topbar__sep {
  color: rgb(var(--fg-subtle));
}

.topbar__page {
  font-weight: 500;
  color: rgb(var(--fg));
}

.topbar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  -webkit-app-region: no-drag;
}

.topbar__slot {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topbar__slot:empty {
  display: none;
}

.shell__content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px 28px 32px;
}
</style>
