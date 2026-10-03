<script setup lang="ts">
import AppIcon, { type IconName } from './AppIcon.vue'

/** Icon, title, one sentence and (via the default slot) a primary action. */
defineProps<{ icon?: IconName; title: string; description?: string }>()
</script>

<template>
  <div class="empty-state">
    <div class="empty-state__icon"><AppIcon :name="icon ?? 'info'" :size="20" /></div>
    <p class="empty-state__title">{{ title }}</p>
    <p v-if="description" class="empty-state__desc">{{ description }}</p>
    <div v-if="$slots.default" class="empty-state__action"><slot /></div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 40px 24px;
  background: rgb(var(--surface-1));
  border-radius: var(--radius-panel);
}

.empty-state__icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  margin-bottom: 6px;
  border-radius: 10px;
  background: rgb(var(--surface-3));
  color: rgb(var(--fg-muted));
}

.empty-state__title {
  font-size: 14px;
  font-weight: 600;
  color: rgb(var(--fg));
}

.empty-state__desc {
  max-width: 440px;
  font-size: 13px;
  line-height: 19px;
  color: rgb(var(--fg-muted));
}

.empty-state__action {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
</style>
