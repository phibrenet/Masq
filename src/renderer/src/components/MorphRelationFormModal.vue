<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  NButton,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSwitch,
  NText,
  useMessage,
  type FormInst,
  type FormRules
} from 'naive-ui'
import type { MorphRelationInput } from '@shared/api'
import type { ColumnInfo, MorphCandidate, MorphRelation } from '@shared/types'
import { useMorphRelationsStore } from '@renderer/stores/morphRelations'
import { useDiscoveryStore } from '@renderer/stores/discovery'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * Declare / edit a polymorphic relation (docs/polymorphic-cascade.md). Follows the other form
 * modals' conventions: `v-model:show`, mutations through the store, save upserts on
 * (table, type column).
 *
 * Three ways in, which is why both props are optional:
 * - `relation` — edit an existing declaration.
 * - `candidate` — confirm a detected suggestion; every field arrives prefilled, including the
 *   guessed type→table map. This is the intended path, and the reason the map editor is
 *   confirm-and-correct rather than type-it-all.
 * - neither — declare one by hand.
 */
const show = defineModel<boolean>('show', { required: true })
const props = defineProps<{
  relation?: MorphRelation | null
  candidate?: MorphCandidate | null
}>()

const isEdit = computed(() => props.relation != null)

const morphs = useMorphRelationsStore()
const discovery = useDiscoveryStore()
const workspace = useWorkspaceStore()
const message = useMessage()

/** Every discovered table is a valid morph target — a morph can point anywhere, by definition. */
const tableOptions = computed(() =>
  [...discovery.tables].sort().map((name) => ({ label: name, value: name }))
)

interface MappingRow {
  typeValue: string
  targetTable: string
}

interface FormState {
  tableName: string
  typeColumn: string
  idColumn: string
  cascadeDown: boolean
  backfillUp: boolean
  typeMap: MappingRow[]
}

function blankForm(): FormState {
  // Defaults match the migration's: down off (it changes the dump's size), up on (integrity).
  return {
    tableName: '',
    typeColumn: '',
    idColumn: '',
    cascadeDown: false,
    backfillUp: true,
    typeMap: []
  }
}

function fromRelation(r: MorphRelation): FormState {
  // Persisted mappings, then any type value detection found that this relation has no mapping for
  // (see the store's `unmappedValuesFor`). Editing is where config drift gets closed: the source can
  // start writing a new type value long after the relation was declared, and an unmapped value makes
  // the engine log-and-skip that edge — so without merging these in, the fix would be invisible here
  // and the reference would quietly dangle. Empty when no detection has run this session.
  const detected = morphs.unmappedValuesFor(r).map((v) => ({
    typeValue: v.typeValue,
    targetTable: v.guessedTable ?? ''
  }))
  return {
    tableName: r.tableName,
    typeColumn: r.typeColumn,
    idColumn: r.idColumn,
    cascadeDown: r.cascadeDown,
    backfillUp: r.backfillUp,
    typeMap: [...r.typeMap.map((m) => ({ ...m })), ...detected]
  }
}

function fromCandidate(c: MorphCandidate): FormState {
  return {
    ...blankForm(),
    tableName: c.tableName,
    typeColumn: c.typeColumn,
    idColumn: c.idColumn,
    // A value the guesser couldn't resolve arrives blank, so the row shows but saves nothing until
    // the user picks a target (the repo drops blank targets).
    typeMap: c.typeValues.map((v) => ({
      typeValue: v.typeValue,
      targetTable: v.guessedTable ?? ''
    }))
  }
}

const model = reactive<FormState>(blankForm())
const formRef = ref<FormInst | null>(null)
const saving = ref(false)

/** Columns of the chosen table, to drive the type/id column dropdowns. */
const columns = ref<ColumnInfo[]>([])
const loadingColumns = ref(false)

const columnOptions = computed(() =>
  columns.value.map((c) => ({ label: `${c.name} — ${c.dataType}`, value: c.name }))
)

/**
 * Same degradation as the field-strategy modal: no source, or a failure, falls back to free text.
 * Same request numbering too, so only the table currently chosen can fill the dropdowns.
 */
let columnsRequest = 0
async function refreshColumns(table: string): Promise<void> {
  const request = ++columnsRequest
  const name = table.trim()
  if (!name || !discovery.sourceConnection) {
    columns.value = []
    loadingColumns.value = false
    return
  }
  loadingColumns.value = true
  try {
    const result = await discovery.loadColumns(name)
    if (request === columnsRequest) columns.value = result
  } catch (err) {
    if (request !== columnsRequest) return
    columns.value = []
    message.error(`Could not load columns for "${name}": ${(err as Error).message}`)
  } finally {
    if (request === columnsRequest) loadingColumns.value = false
  }
}

/**
 * Fill the id column from the type column by Laravel's own convention (`documentable_type` →
 * `documentable_id`) when the user hasn't set one. Saves the common case without preventing an
 * unconventional pairing.
 */
watch(
  () => model.typeColumn,
  (typeColumn) => {
    if (model.idColumn) return
    const base = typeColumn.trim().replace(/_type$/, '')
    if (base && base !== typeColumn.trim()) model.idColumn = `${base}_id`
  }
)

watch(show, (open) => {
  if (!open) return
  if (props.relation) Object.assign(model, fromRelation(props.relation))
  else if (props.candidate) Object.assign(model, fromCandidate(props.candidate))
  else Object.assign(model, blankForm())
})

watch(
  () => model.tableName,
  (table) => {
    void refreshColumns(table)
  }
)

function addMapping(): void {
  model.typeMap.push({ typeValue: '', targetTable: '' })
}

function removeMapping(index: number): void {
  model.typeMap.splice(index, 1)
}

const unmappedCount = computed(
  () => model.typeMap.filter((m) => m.typeValue.trim() && !m.targetTable).length
)

const rules = computed<FormRules>(() => ({
  tableName: { required: true, message: 'A table is required', trigger: ['blur', 'change'] },
  typeColumn: { required: true, message: 'A type column is required', trigger: ['blur', 'change'] },
  idColumn: { required: true, message: 'An id column is required', trigger: ['blur', 'change'] }
}))

function toInput(): Omit<MorphRelationInput, 'workspaceId'> {
  return {
    tableName: model.tableName.trim(),
    typeColumn: model.typeColumn.trim(),
    idColumn: model.idColumn.trim(),
    cascadeDown: model.cascadeDown,
    backfillUp: model.backfillUp,
    // Blank rows are dropped here as well as in the repo — no point sending them over IPC.
    typeMap: model.typeMap
      .map((m) => ({ typeValue: m.typeValue.trim(), targetTable: m.targetTable }))
      .filter((m) => m.typeValue && m.targetTable)
  }
}

async function submit(): Promise<void> {
  if (!workspace.currentWorkspaceId) {
    message.error('Select a workspace first.')
    return
  }
  try {
    await formRef.value?.validate()
  } catch {
    return
  }

  saving.value = true
  try {
    const label = `${model.tableName.trim()}.${model.typeColumn.trim()}`
    if (isEdit.value && props.relation) {
      await morphs.update(props.relation.id, toInput())
      message.success(`Morph relation "${label}" updated.`)
    } else {
      await morphs.create(toInput())
      message.success(`Morph relation "${label}" declared.`)
    }
    show.value = false
  } catch (err) {
    message.error(`Could not save relation: ${(err as Error).message}`)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="isEdit ? 'Edit morph relation' : 'Declare morph relation'"
    :style="{ width: '620px', maxWidth: '94vw' }"
    :mask-closable="!saving"
  >
    <n-form ref="formRef" :model="model" :rules="rules" label-placement="top">
      <n-form-item label="Table" path="tableName">
        <n-select
          v-model:value="model.tableName"
          filterable
          tag
          placeholder="e.g. documents"
          :options="tableOptions"
        />
      </n-form-item>

      <div class="row">
        <n-form-item label="Type column" path="typeColumn" class="row__item">
          <n-select
            v-model:value="model.typeColumn"
            filterable
            tag
            :loading="loadingColumns"
            :options="columnOptions"
            placeholder="e.g. documentable_type"
          />
        </n-form-item>
        <n-form-item label="Id column" path="idColumn" class="row__item">
          <n-select
            v-model:value="model.idColumn"
            filterable
            tag
            :loading="loadingColumns"
            :options="columnOptions"
            placeholder="e.g. documentable_id"
          />
        </n-form-item>
      </div>

      <div class="row">
        <n-form-item label="Pull owned rows (down)" class="row__item">
          <div class="toggle">
            <n-switch v-model:value="model.cascadeDown" />
            <n-text depth="3" class="hint">
              Keep an entity → also keep the rows it owns here. Grows the dump.
            </n-text>
          </div>
        </n-form-item>
        <n-form-item label="Backfill targets (up)" class="row__item">
          <div class="toggle">
            <n-switch v-model:value="model.backfillUp" />
            <n-text depth="3" class="hint">
              A kept row's target must also be kept. Prevents dangling references.
            </n-text>
          </div>
        </n-form-item>
      </div>

      <n-form-item label="Type → table map">
        <div class="map">
          <n-text depth="3" class="hint">
            One entry per type value in the data. A value with no entry is logged and skipped at
            extract time, never silently dropped.
          </n-text>
          <div v-for="(mapping, i) in model.typeMap" :key="i" class="map__row">
            <n-input
              v-model:value="mapping.typeValue"
              placeholder="App\Models\User"
              class="map__value"
            />
            <span class="map__arrow">→</span>
            <n-select
              v-model:value="mapping.targetTable"
              filterable
              tag
              clearable
              placeholder="target table"
              :options="tableOptions"
              :status="mapping.typeValue.trim() && !mapping.targetTable ? 'warning' : undefined"
              class="map__target"
            />
            <n-button quaternary size="small" @click="removeMapping(i)">Remove</n-button>
          </div>
          <div class="map__actions">
            <n-button size="small" dashed @click="addMapping">Add mapping</n-button>
            <n-text v-if="unmappedCount > 0" depth="3" class="hint">
              {{ unmappedCount }} value{{ unmappedCount === 1 ? '' : 's' }} still need a target —
              those won't be saved.
            </n-text>
          </div>
        </div>
      </n-form-item>
    </n-form>

    <template #footer>
      <div class="footer">
        <n-button :disabled="saving" @click="show = false">Cancel</n-button>
        <n-button type="primary" :loading="saving" @click="submit">
          {{ isEdit ? 'Save changes' : 'Declare relation' }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.row {
  display: flex;
  gap: 14px;
}

.row__item {
  flex: 1;
  min-width: 0;
}

.toggle {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hint {
  display: block;
  font-size: 12px;
  line-height: 1.4;
}

.map {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.map__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.map__value {
  flex: 1.2;
  min-width: 0;
}

.map__target {
  flex: 1;
  min-width: 0;
}

.map__arrow {
  opacity: 0.5;
}

.map__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
