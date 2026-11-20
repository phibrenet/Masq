<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NCheckbox, NInput, NInputNumber, NSelect, NText } from 'naive-ui'
import type { ColumnInfo, ConditionOp, MatchMode } from '@shared/types'
import { DURATION_UNITS, isNegativeOp, operatorsFor, valueKindOf } from '@renderer/lib/conditions'
import { blankCondition, familyOf, type DraftCondition } from '@renderer/lib/conditionDraft'

/**
 * A list of row conditions plus match all/any — the filter editor shared by selection rules and a
 * field strategy's exception. Edits the draft list in place; the parent turns it into `Condition`s
 * with `toCondition`.
 *
 * Operators are narrowed by the column's introspected type, so a date column offers "in the last N
 * days" and never "contains". Where discovery hasn't run the column select still accepts a typed
 * name and falls back to the text operators.
 */
const conditions = defineModel<DraftCondition[]>('conditions', { required: true })
const match = defineModel<MatchMode>('match', { required: true })
const props = defineProps<{
  columns: ColumnInfo[]
  /** What an empty list means where this editor is used. */
  emptyHint: string
}>()

const matchOptions: { label: string; value: MatchMode }[] = [
  { label: 'Match all', value: 'all' },
  { label: 'Match any', value: 'any' }
]

const columnOptions = computed(() =>
  props.columns.map((c) => ({ label: c.name, value: c.name, dataType: c.dataType }))
)

function operatorOptionsFor(name: string): { label: string; value: ConditionOp }[] {
  return operatorsFor(familyOf(props.columns, name)).map((o) => ({ label: o.label, value: o.op }))
}

function valueKindFor(c: DraftCondition): ReturnType<typeof valueKindOf> {
  return valueKindOf(c.op, familyOf(props.columns, c.column))
}

/**
 * Whether to offer the include-empty checkbox: a negative operator on a column that can hold NULL.
 * On a NOT NULL column there is nothing to decide, so it's hidden rather than shown disabled.
 */
function showsNullChoice(c: DraftCondition): boolean {
  const info = props.columns.find((col) => col.name === c.column)
  return isNegativeOp(c.op) && (info?.nullable ?? true)
}

/** Keep the operator legal when the column's type changes underneath it. */
function onColumnChange(c: DraftCondition): void {
  const allowed = operatorsFor(familyOf(props.columns, c.column))
  if (!allowed.some((o) => o.op === c.op)) c.op = allowed[0]?.op ?? 'eq'
}

function addCondition(): void {
  const draft = blankCondition()
  const first = columnOptions.value[0]
  if (first) {
    draft.column = first.value
    onColumnChange(draft)
  }
  conditions.value.push(draft)
}

function removeCondition(index: number): void {
  conditions.value.splice(index, 1)
}
</script>

<template>
  <div class="filter">
    <div class="filter__head">
      <n-select
        v-model:value="match"
        class="filter__match"
        size="small"
        :options="matchOptions"
        :disabled="conditions.length < 2"
      />
      <n-text depth="3" class="hint">
        {{
          conditions.length === 0
            ? emptyHint
            : match === 'all'
              ? 'A row must satisfy every condition.'
              : 'A row need satisfy only one condition.'
        }}
      </n-text>
    </div>

    <div v-for="(c, i) in conditions" :key="i" class="cond">
      <n-select
        v-model:value="c.column"
        class="cond__column"
        size="small"
        filterable
        tag
        placeholder="column"
        :options="columnOptions"
        @update:value="onColumnChange(c)"
      />
      <n-select
        v-model:value="c.op"
        class="cond__op"
        size="small"
        :options="operatorOptionsFor(c.column)"
      />

      <n-input
        v-if="valueKindFor(c) === 'text'"
        v-model:value="c.text"
        class="cond__value"
        size="small"
        :placeholder="c.op === 'matches' ? 'JS regex' : 'value'"
      />
      <n-input
        v-else-if="valueKindFor(c) === 'list'"
        v-model:value="c.listText"
        class="cond__value"
        size="small"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 4 }"
        placeholder="one per line, or comma-separated"
      />
      <div v-else-if="valueKindFor(c) === 'duration'" class="cond__value cond__duration">
        <n-input-number
          v-model:value="c.n"
          size="small"
          :min="1"
          :show-button="false"
          class="grow"
        />
        <n-select
          v-model:value="c.unit"
          size="small"
          class="cond__unit"
          :options="DURATION_UNITS"
        />
      </div>
      <div v-else class="cond__value cond__value--empty" />

      <n-checkbox
        v-if="showsNullChoice(c)"
        v-model:checked="c.includeNulls"
        size="small"
        class="cond__nulls"
      >
        include empty
      </n-checkbox>
      <span v-else class="cond__nulls" />

      <n-button size="tiny" quaternary type="error" @click="removeCondition(i)">✕</n-button>
    </div>

    <div class="filter__actions">
      <n-button size="small" @click="addCondition">+ Add condition</n-button>
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.grow {
  width: 100%;
}

.hint {
  font-size: 12px;
  line-height: 1.45;
}

.filter {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.filter__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.filter__match {
  width: 130px;
  flex: none;
}

.cond {
  display: grid;
  grid-template-columns: 1.1fr 1.1fr 1.4fr auto auto;
  align-items: start;
  gap: 8px;
}

.cond__duration {
  display: flex;
  gap: 6px;
}

.cond__unit {
  width: 110px;
  flex: none;
}

.cond__value--empty {
  height: 0;
}

.cond__nulls {
  display: inline-flex;
  align-items: center;
  min-width: 104px;
  font-size: 12px;
}

.filter__actions {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
</style>
