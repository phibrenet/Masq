<script setup lang="ts">
/**
 * The one container for lists: a raised surface whose direct children render as divided rows.
 * Prefer one panel with many rows over one bordered card per item.
 */
defineProps<{ flush?: boolean }>()
</script>

<template>
  <section class="ui-panel">
    <header v-if="$slots.header" class="ui-panel__header">
      <slot name="header" />
    </header>
    <div class="ui-panel__body" :class="{ 'ui-panel__body--flush': flush }">
      <slot />
    </div>
  </section>
</template>

<!-- Not scoped: the divider applies to slotted rows, which scoped styles can't reach by structure. -->
<style>
.ui-panel {
  background: rgb(var(--surface-1));
  border-radius: var(--radius-panel);
  overflow: clip;
}

.ui-panel__header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 8px 14px;
  border-bottom: 1px solid rgb(var(--line) / 0.06);
}

.ui-panel__body > * + * {
  border-top: 1px solid rgb(var(--line) / 0.04);
}

/* A standard row inside a panel. Views add their own layout on top. */
.ui-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding: 6px 14px;
  transition: background-color 150ms;
}

.ui-row:hover {
  background: rgb(var(--line) / 0.02);
}
</style>
