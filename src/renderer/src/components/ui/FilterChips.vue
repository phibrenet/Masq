<script setup lang="ts" generic="K extends string">
import { TONES, type Tone } from './tones'

/**
 * A row of toggleable filter chips, each with a count. One chip is active at a time; clicking the
 * active one clears the filter (`null`).
 */
export interface FilterChip<T extends string> {
  key: T
  label: string
  count: number
  tone?: Tone
  title?: string
}

defineProps<{ chips: FilterChip<K>[]; modelValue: K | null; label?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: K | null] }>()
</script>

<template>
  <div class="chips" role="group" :aria-label="label">
    <button
      v-for="chip in chips"
      :key="chip.key"
      type="button"
      class="chip"
      :class="{ 'chip--on': chip.key === modelValue }"
      :style="chip.tone ? { '--tone': TONES[chip.tone] } : undefined"
      :aria-pressed="chip.key === modelValue"
      :title="chip.title"
      @click="emit('update:modelValue', chip.key === modelValue ? null : chip.key)"
    >
      <span v-if="chip.tone" class="chip__swatch" aria-hidden="true" />
      {{ chip.label }}
      <span class="chip__count num">{{ chip.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  --tone: var(--fg-muted);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 0;
  border-radius: 999px;
  background: rgb(var(--surface-2));
  box-shadow: inset 0 0 0 1px transparent;
  color: rgb(var(--fg-muted));
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background-color 150ms,
    color 150ms,
    box-shadow 150ms;
}

.chip:hover {
  color: rgb(var(--fg));
  background: rgb(var(--surface-3));
}

.chip--on,
.chip--on:hover {
  color: rgb(var(--tone));
  background: rgb(var(--tone) / 0.15);
  box-shadow: inset 0 0 0 1px rgb(var(--tone) / 0.4);
}

.chip__swatch {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgb(var(--tone));
}

.chip__count {
  color: rgb(var(--fg-subtle));
}

.chip--on .chip__count {
  color: inherit;
  opacity: 0.8;
}
</style>
