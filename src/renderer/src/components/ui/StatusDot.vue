<script setup lang="ts">
import { computed } from 'vue'
import { toneStyle } from './tones'

/** A small coloured dot. `pulse` while something is in progress (e.g. a connection test). */
const props = withDefaults(
  defineProps<{ tone?: 'ok' | 'warn' | 'danger' | 'muted'; pulse?: boolean; label?: string }>(),
  { tone: 'muted', pulse: false, label: undefined }
)

const style = computed(() => toneStyle(props.tone))
</script>

<template>
  <span
    class="status-dot"
    :class="{ 'status-dot--pulse': pulse }"
    :style="style"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  />
</template>

<style scoped>
.status-dot {
  position: relative;
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgb(var(--tone));
}

.status-dot--pulse::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  background: rgb(var(--tone) / 0.45);
  animation: dot-pulse 1.2s ease-out infinite;
}

@keyframes dot-pulse {
  from {
    transform: scale(0.6);
    opacity: 1;
  }
  to {
    transform: scale(1.6);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .status-dot--pulse::after {
    animation: none;
  }
}
</style>
