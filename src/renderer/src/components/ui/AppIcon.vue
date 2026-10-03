<script setup lang="ts">
import { computed } from 'vue'

/**
 * Minimal inline-SVG icon set — no icon-library dependency, same approach the sidebar always took.
 * 24×24 stroke icons; `currentColor`, so they take the surrounding text colour.
 */
const PATHS = {
  connections:
    'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  tables: 'M3 4h18v16H3zM3 10h18M3 15h18M9 4v16',
  rules: 'M4 6h10M4 12h16M4 18h7M17 4v4M20 14v4',
  fields: 'M12 2l3 4-3 4-3-4zM12 10v12M6 22h12',
  backfill: 'M12 20V5M12 5l-5 5M12 5l5 5M4 3h16',
  morphs:
    'M6 4a2 2 0 100 4 2 2 0 000-4zM18 16a2 2 0 100 4 2 2 0 000-4zM18 4a2 2 0 100 4 2 2 0 000-4zM8 6h8M8 6c0 6 4 12 8 12',
  runs: 'M8 5v14l11-7z',
  play: 'M8 5v14l11-7z',
  stop: 'M6 6h12v12H6z',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 118 0v3',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  zap: 'M13 3L4 14h7l-1 7 9-11h-7z',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3',
  alert:
    'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  info: 'M12 16v-4M12 8h.01M12 21a9 9 0 100-18 9 9 0 000 18z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  arrowRight: 'M5 12h14M13 6l6 6-6 6'
} as const

export type IconName = keyof typeof PATHS

const props = withDefaults(
  defineProps<{ name: IconName; size?: number | string; strokeWidth?: number }>(),
  { size: 16, strokeWidth: 1.8 }
)

const d = computed(() => PATHS[props.name])
</script>

<template>
  <svg
    class="app-icon"
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="d" />
  </svg>
</template>

<style scoped>
.app-icon {
  flex: none;
  display: block;
}
</style>
