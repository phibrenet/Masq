<script setup lang="ts">
/** Placeholder rows shown inside a panel while its content loads (discovery, reading links). */
withDefaults(defineProps<{ rows?: number }>(), { rows: 6 })
</script>

<template>
  <div class="skeleton-rows" aria-busy="true" aria-label="Loading">
    <div v-for="i in rows" :key="i" class="skeleton-rows__row">
      <span class="skeleton" :style="{ width: `${28 + ((i * 37) % 40)}%` }" />
      <span class="skeleton skeleton-rows__end" />
    </div>
  </div>
</template>

<style scoped>
.skeleton-rows {
  background: rgb(var(--surface-1));
  border-radius: var(--radius-panel);
  overflow: hidden;
}

.skeleton-rows__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 40px;
  padding: 0 14px;
}

.skeleton-rows__row + .skeleton-rows__row {
  border-top: 1px solid rgb(var(--line) / 0.04);
}

.skeleton {
  height: 10px;
}

.skeleton-rows__end {
  width: 120px;
}
</style>
