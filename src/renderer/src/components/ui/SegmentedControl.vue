<script setup lang="ts" generic="K extends string">
import { ref } from 'vue'
import { TONES, type Tone } from './tones'

/**
 * A compact radio group. Each option can carry its own `tone`, so e.g. every table class selects in
 * its own colour; without one the selected option is a neutral raised chip. `mutedText` keeps the
 * selected label muted — used for "excluded", which should read as switched off, not highlighted.
 *
 * Keyboard: one tab stop (the selected option); arrow keys move the selection, as a native radio
 * group does.
 */
export interface SegmentOption<T extends string> {
  key: T
  label: string
  tone?: Tone
  mutedText?: boolean
  title?: string
}

const props = defineProps<{
  options: SegmentOption<K>[]
  modelValue: K | null
  label?: string
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: K] }>()

const buttons = ref<HTMLButtonElement[]>([])

function select(key: K): void {
  if (props.disabled || key === props.modelValue) return
  emit('update:modelValue', key)
}

function onKeydown(event: KeyboardEvent, index: number): void {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
  if (!step) return
  event.preventDefault()
  const next = (index + step + props.options.length) % props.options.length
  select(props.options[next].key)
  buttons.value[next]?.focus()
}

function optionStyle(option: SegmentOption<K>): Record<string, string> | undefined {
  return option.tone ? { '--tone': TONES[option.tone] } : undefined
}
</script>

<template>
  <div class="seg" role="radiogroup" :aria-label="label" :aria-disabled="disabled || undefined">
    <button
      v-for="(option, i) in options"
      :key="option.key"
      ref="buttons"
      type="button"
      role="radio"
      class="seg__opt"
      :class="{
        'seg__opt--on': option.key === modelValue,
        'seg__opt--toned': !!option.tone,
        'seg__opt--muted': option.mutedText
      }"
      :style="optionStyle(option)"
      :aria-checked="option.key === modelValue"
      :tabindex="option.key === modelValue || (modelValue === null && i === 0) ? 0 : -1"
      :disabled="disabled"
      :title="option.title"
      @click="select(option.key)"
      @keydown="onKeydown($event, i)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex;
  flex: none;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-control);
  background: rgb(var(--surface-2));
}

.seg__opt {
  padding: 3px 10px;
  border: 0;
  border-radius: var(--radius-badge);
  background: transparent;
  box-shadow: inset 0 0 0 1px transparent;
  color: rgb(var(--fg-muted));
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 150ms,
    color 150ms,
    box-shadow 150ms;
}

.seg__opt:hover:not(:disabled):not(.seg__opt--on) {
  color: rgb(var(--fg));
  background: rgb(var(--line) / 0.04);
}

.seg__opt:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.seg__opt:focus-visible {
  outline: 2px solid rgb(var(--accent) / 0.6);
  outline-offset: 1px;
}

.seg__opt--on {
  background: rgb(var(--surface-3));
  color: rgb(var(--fg));
}

.seg__opt--on.seg__opt--toned {
  background: rgb(var(--tone) / 0.15);
  color: rgb(var(--tone));
  box-shadow: inset 0 0 0 1px rgb(var(--tone) / 0.4);
}

.seg__opt--on.seg__opt--toned.seg__opt--muted {
  background: rgb(var(--tone) / 0.2);
  color: rgb(var(--fg-muted));
}
</style>
