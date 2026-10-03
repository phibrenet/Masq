<script setup lang="ts">
import { computed } from 'vue'
import type { Dialect } from '@shared/types'

/**
 * A database-engine mark: a tinted cylinder with the engine's short name. Generic on purpose — no
 * vendor logos — but distinct enough per engine to recognise at a glance.
 */
const props = defineProps<{ dialect: Dialect }>()

const ENGINES: Record<Dialect, { label: string; short: string; tone: string }> = {
  postgres: { label: 'PostgreSQL', short: 'Pg', tone: 'var(--c-transactional)' },
  mysql: { label: 'MySQL', short: 'My', tone: 'var(--s-fake)' },
  sqlite: { label: 'SQLite', short: 'Lt', tone: 'var(--s-template)' },
  mssql: { label: 'SQL Server', short: 'MS', tone: 'var(--danger)' }
}

const engine = computed(() => ENGINES[props.dialect])
</script>

<template>
  <span
    class="engine"
    :style="{ '--tone': engine.tone }"
    role="img"
    :aria-label="engine.label"
    :title="engine.label"
  >
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
    >
      <ellipse cx="12" cy="6" rx="7" ry="2.6" />
      <path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6" />
    </svg>
    <span class="engine__short">{{ engine.short }}</span>
  </span>
</template>

<style scoped>
.engine {
  position: relative;
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: rgb(var(--tone) / 0.12);
  color: rgb(var(--tone));
}

.engine__short {
  position: absolute;
  bottom: 7px;
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
</style>
