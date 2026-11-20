<script setup lang="ts">
import {
  NFormItem,
  NInput,
  NInputNumber,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NText
} from 'naive-ui'
import { OBFUSCATE_MIN_COUNT } from '@shared/types'
import { generatorOptions } from '@renderer/lib/generatorOptions'
import type { RuleDraft } from '@renderer/lib/ruleDraft'

/**
 * The settings of a non-template strategy: the generator for `fake`, the side and count or delimiter
 * for `obfuscate`, the percentage for `jitter`. Used for a strategy's main rule and for its
 * exception. Must sit inside the parent's `n-form`; `pathPrefix` points each item at its validation
 * rule (`''` for the main rule, `'exception.rule.'` for the exception).
 */
const draft = defineModel<RuleDraft>('draft', { required: true })
defineProps<{ pathPrefix: string }>()
</script>

<template>
  <n-form-item v-if="draft.kind === 'fake'" label="Generator" :path="`${pathPrefix}generator`">
    <n-select v-model:value="draft.generator" filterable :options="generatorOptions" />
  </n-form-item>

  <template v-if="draft.kind === 'obfuscate'">
    <n-form-item label="Scramble">
      <n-radio-group v-model:value="draft.obfuscateSide">
        <n-radio-button value="first" label="First characters" />
        <n-radio-button value="last" label="Last characters" />
        <n-radio-button value="before" label="Everything before…" />
      </n-radio-group>
    </n-form-item>
    <n-form-item
      v-if="draft.obfuscateSide === 'before'"
      label="Before the last"
      :path="`${pathPrefix}obfuscateDelimiter`"
    >
      <div class="obf">
        <n-input v-model:value="draft.obfuscateDelimiter" placeholder="@" class="obf__count" />
        <n-text depth="3" class="hint">
          Scrambles everything before the last
          <code>{{ draft.obfuscateDelimiter || '@' }}</code> and keeps the rest, so
          <code>jane.doe@acme.com</code> reads <code>qzkd.lmx@acme.com</code>. Letters stay letters
          and digits stay digits. A value without the delimiter is scrambled in full, and the same
          input always gives the same output.
        </n-text>
      </div>
    </n-form-item>
    <n-form-item v-else label="How many" :path="`${pathPrefix}obfuscateCount`">
      <div class="obf">
        <n-input-number
          v-model:value="draft.obfuscateCount"
          :min="OBFUSCATE_MIN_COUNT"
          :show-button="false"
          :placeholder="String(OBFUSCATE_MIN_COUNT)"
          class="obf__count"
        />
        <n-text depth="3" class="hint">
          Letters become random letters and digits random digits, so the value keeps its shape —
          <code>ACE-2024-XY7781</code> scrambled on the last 6 reads <code>ACE-2024-QM3419</code>.
          Dashes, dots and spaces are left alone. A value shorter than this is scrambled in full,
          and the same input always gives the same output so joins on the column survive.
        </n-text>
      </div>
    </n-form-item>
  </template>

  <n-form-item v-if="draft.kind === 'jitter'" label="Jitter %" :path="`${pathPrefix}percent`">
    <n-input-number
      v-model:value="draft.percent"
      :min="1"
      :max="100"
      :show-button="false"
      placeholder="10"
      class="grow"
    />
  </n-form-item>
</template>

<style scoped>
.obf {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.obf__count {
  width: 120px;
}

.grow {
  width: 100%;
}

.hint {
  display: block;
  font-size: 12px;
  line-height: 1.4;
}

code {
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgb(var(--surface-3));
}
</style>
