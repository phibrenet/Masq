<script setup lang="ts">
import { computed } from 'vue'
import { toneStyle, type Tone } from './tones'

/** Small status/category label. `soft` fills with the tone; `outline` only rings it. */
const props = withDefaults(defineProps<{ tone?: Tone; variant?: 'soft' | 'outline' }>(), {
  tone: 'muted',
  variant: 'soft'
})

const style = computed(() => toneStyle(props.tone))
</script>

<template>
  <span class="ui-badge" :class="`ui-badge--${variant}`" :style="style"><slot /></span>
</template>

<style scoped>
.ui-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 1px 6px;
  border-radius: var(--radius-badge);
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  white-space: nowrap;
  color: rgb(var(--tone));
  box-shadow: inset 0 0 0 1px rgb(var(--tone) / 0.3);
  font-variant-numeric: tabular-nums;
}

.ui-badge--soft {
  background: rgb(var(--tone) / 0.15);
}

.ui-badge--outline {
  background: transparent;
}
</style>
