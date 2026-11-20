<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NRadio,
  NRadioGroup,
  NSelect,
  NText,
  useMessage,
  type FormInst,
  type FormRules
} from 'naive-ui'
import type { SelectionRuleInput } from '@shared/api'
import { rawWhereError } from '@shared/raw-where'
import type { ColumnInfo, MatchMode, SelectionRule, SelectionRulePreview } from '@shared/types'
import { columnFamily } from '@renderer/lib/conditions'
import {
  invalidRegex,
  toCondition,
  toDraft,
  type DraftCondition
} from '@renderer/lib/conditionDraft'
import ConditionEditor from '@renderer/components/ConditionEditor.vue'
import { useSelectionRulesStore } from '@renderer/stores/selectionRules'
import { useTableClassificationsStore } from '@renderer/stores/tableClassifications'
import { useDiscoveryStore } from '@renderer/stores/discovery'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * Create/edit-a-selection-rule modal (spec §6, v2 — docs/selection-rules-v2.md).
 *
 * The form mirrors the model's two axes: a **filter** (a flat condition list ANDed or ORed, or a
 * raw SQL predicate) and a **take** (all / random N / newest N). v1's four strategies were four
 * disjoint field sets; these two combine, which is the whole point — "20 recent users without a
 * work email" needs a filter *and* a limit at once.
 *
 * Operators are narrowed by the column's introspected type, so a date column offers "in the last N
 * days" and never "contains". Where discovery hasn't run the column select still accepts a typed
 * name and falls back to the text operators.
 */
const show = defineModel<boolean>('show', { required: true })
const props = defineProps<{ rule?: SelectionRule | null }>()

const isEdit = computed(() => props.rule != null)

const rules_ = useSelectionRulesStore()
const classifications = useTableClassificationsStore()
const discovery = useDiscoveryStore()
const workspace = useWorkspaceStore()
const message = useMessage()

/**
 * Suggest the transactional universe: every discovered table plus every explicitly-classified one,
 * minus those classified `reference`/`excluded` (selection rules only apply to transactional
 * tables). A discovered table with no classification row defaults to transactional, so it belongs
 * here. The select is `tag`, so any typed name is still accepted regardless.
 */
const tableOptions = computed(() => {
  const classByName = new Map(classifications.list.map((c) => [c.tableName, c.class]))
  const names = new Set<string>([
    ...discovery.tables,
    ...classifications.list.filter((c) => c.class === 'transactional').map((c) => c.tableName)
  ])
  return [...names]
    .filter((name) => {
      const klass = classByName.get(name)
      return !klass || klass === 'transactional' // absence = transactional default
    })
    .sort()
    .map((name) => ({ label: name, value: name }))
})

interface FormState {
  table: string
  match: MatchMode
  conditions: DraftCondition[]
  useRaw: boolean
  rawWhere: string
  takeKind: 'all' | 'sample' | 'top' | 'none'
  count: number | null
  orderBy: string
  dir: 'asc' | 'desc'
  anonymize: boolean
}

function blankForm(): FormState {
  return {
    table: '',
    match: 'all',
    conditions: [],
    useRaw: false,
    rawWhere: '',
    takeKind: 'sample',
    count: 500,
    orderBy: '',
    dir: 'desc',
    anonymize: true
  }
}

function fromRule(r: SelectionRule): FormState {
  return {
    table: r.table,
    match: r.match,
    conditions: r.where.map(toDraft),
    useRaw: !!r.rawWhere,
    rawWhere: r.rawWhere ?? '',
    takeKind: r.take.kind,
    // The count input is shared by `sample` and `top`; a take that carries no count keeps the
    // default so switching to one of those lands on something sensible rather than blank.
    count: r.take.kind === 'sample' || r.take.kind === 'top' ? r.take.count : 500,
    orderBy: r.take.kind === 'top' ? r.take.orderBy : '',
    dir: r.take.kind === 'top' ? r.take.dir : 'desc',
    anonymize: r.anonymize
  }
}

const model = reactive<FormState>(blankForm())
const formRef = ref<FormInst | null>(null)
const saving = ref(false)
const columns = ref<ColumnInfo[]>([])
const preview = ref<SelectionRulePreview | null>(null)
const previewing = ref(false)
const previewError = ref('')

watch(show, (open) => {
  if (open) {
    Object.assign(model, props.rule ? fromRule(props.rule) : blankForm())
    columns.value = []
    if (model.table) void loadColumns(model.table)
  }
  resetPreview()
})

/**
 * Introspected columns drive the operator lists; failure is non-fatal (free-text still works).
 *
 * Numbered so only the latest request lands: pick table A, then B while A is slow, and A would
 * otherwise resolve last and put its columns under B. The same guard covers the preview below.
 */
let columnsRequest = 0
async function loadColumns(table: string): Promise<void> {
  const request = ++columnsRequest
  if (!table || !discovery.sourceConnection) return
  try {
    const result = await discovery.loadColumns(table)
    if (request === columnsRequest) columns.value = result
  } catch {
    if (request === columnsRequest) columns.value = []
  }
}

watch(
  () => model.table,
  (table) => {
    columns.value = []
    void loadColumns(table)
  }
)

/** Columns that can order a `top` take — anything, but dates first since that's the common case. */
const orderByOptions = computed(() =>
  [...columns.value]
    .sort((a, b) => {
      const fa = columnFamily(a.dataType) === 'date' ? 0 : 1
      const fb = columnFamily(b.dataType) === 'date' ? 0 : 1
      return fa - fb || a.name.localeCompare(b.name)
    })
    .map((c) => ({ label: c.name, value: c.name }))
)

/** Assemble the persisted rule — the filter the form is actually using, plus the chosen take. */
function toInput(): Omit<SelectionRuleInput, 'workspaceId'> {
  const take =
    model.takeKind === 'all'
      ? ({ kind: 'all' } as const)
      : model.takeKind === 'none'
        ? ({ kind: 'none' } as const)
        : model.takeKind === 'sample'
          ? ({ kind: 'sample', count: model.count ?? 0 } as const)
          : ({
              kind: 'top',
              count: model.count ?? 0,
              orderBy: model.orderBy,
              dir: model.dir
            } as const)

  return {
    table: model.table.trim(),
    match: model.match,
    // One filter mechanism per rule — the repository enforces the same exclusivity on write.
    where: model.useRaw ? [] : model.conditions.map((c) => toCondition(c, columns.value)),
    rawWhere: model.useRaw ? model.rawWhere.trim() : undefined,
    take,
    anonymize: model.anonymize
  }
}

let previewRequest = 0
/** Clears the result *and* orphans any preview still in flight, so it can't land on newer inputs. */
function resetPreview(): void {
  previewRequest++
  preview.value = null
  previewError.value = ''
  previewing.value = false
}

watch(model, resetPreview, { deep: true })

/**
 * Count what the rule matches, against the live source. Also the validator for a raw predicate —
 * a fragment that counts is a fragment that parses.
 */
async function runPreview(): Promise<void> {
  const conn = discovery.sourceConnection
  if (!conn) {
    previewError.value = 'No source connection in this workspace.'
    return
  }
  if (!model.table.trim()) {
    previewError.value = 'Choose a table first.'
    return
  }
  const request = ++previewRequest
  previewing.value = true
  previewError.value = ''
  try {
    const result = await window.api.source.previewSelectionRule(conn.id, toInput())
    if (request === previewRequest) preview.value = result
  } catch (err) {
    if (request !== previewRequest) return
    preview.value = null
    previewError.value = (err as Error).message
  } finally {
    if (request === previewRequest) previewing.value = false
  }
}

/**
 * Validation for the fields the *current* shape of the form actually uses.
 *
 * Keys are added conditionally rather than set to `{}` when they don't apply: an empty rule
 * descriptor isn't "no rule" to async-validator, it's a rule that defaults to `type: 'string'`. That
 * made the disabled row-count input fail with "count is not a string" whenever the take was
 * *All matching rows*, because `model.count` holds a number the whole time.
 */
const rules = computed<FormRules>(() => {
  const r: FormRules = {
    table: { required: true, message: 'A table is required', trigger: ['blur', 'change'] }
  }
  if (model.takeKind === 'sample' || model.takeKind === 'top') {
    r.count = {
      type: 'number',
      validator: () => ((model.count ?? 0) > 0 ? true : new Error('Enter a positive row count')),
      trigger: ['blur', 'change']
    }
  }
  if (model.takeKind === 'top') {
    r.orderBy = {
      required: true,
      message: 'Choose a column to order by',
      trigger: ['blur', 'change']
    }
  }
  if (model.useRaw) {
    r.rawWhere = {
      validator: () => {
        const error = rawWhereError(model.rawWhere)
        return error ? new Error(error) : true
      },
      trigger: ['blur', 'input']
    }
  }
  return r
})

async function submit(): Promise<void> {
  if (!workspace.currentWorkspaceId) {
    message.error('Select a workspace first.')
    return
  }
  try {
    await formRef.value?.validate()
  } catch {
    return // inline errors shown
  }
  const bad = invalidRegex(model.conditions)
  if (bad) {
    message.error(bad)
    return
  }
  if (!model.useRaw && model.conditions.some((c) => !c.column.trim())) {
    message.error('Every condition needs a column.')
    return
  }

  saving.value = true
  try {
    if (isEdit.value && props.rule) {
      await rules_.update(props.rule.id, toInput())
      message.success(`Rule for "${model.table.trim()}" updated.`)
    } else {
      await rules_.create(toInput())
      message.success(`Rule for "${model.table.trim()}" added.`)
    }
    show.value = false
  } catch (err) {
    message.error(`Could not save rule: ${(err as Error).message}`)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="isEdit ? 'Edit selection rule' : 'New selection rule'"
    :style="{ width: '760px', maxWidth: '94vw' }"
    :mask-closable="!saving"
  >
    <!-- The form below shows the *leniently parsed* rule, which is not what was stored: whatever
         couldn't be read has already been dropped, and saving makes that permanent. Say so before
         they save rather than after. -->
    <n-alert v-if="rule?.invalid" type="warning" :bordered="false" class="invalid">
      This rule couldn't be read back in full — {{ rule.invalid }}. What's shown below is the part
      that could be read, and it may be broader than what you originally saved. Check it before
      saving; saving replaces the stored rule with exactly what's here.
    </n-alert>

    <n-form ref="formRef" :model="model" :rules="rules" label-placement="top">
      <n-form-item label="Table" path="table">
        <n-select
          v-model:value="model.table"
          filterable
          tag
          placeholder="e.g. users"
          :options="tableOptions"
        />
      </n-form-item>

      <!-- ── Filter ──────────────────────────────────────────────────────── -->
      <n-form-item v-if="!model.useRaw" label="Keep rows where">
        <ConditionEditor
          v-model:conditions="model.conditions"
          v-model:match="model.match"
          :columns="columns"
          empty-hint="No conditions — every row in the table qualifies."
        >
          <template #actions>
            <n-button size="small" text type="primary" @click="model.useRaw = true">
              Use raw SQL instead
            </n-button>
          </template>
        </ConditionEditor>
      </n-form-item>

      <n-form-item v-else label="Keep rows where (SQL predicate)" path="rawWhere">
        <div class="filter">
          <n-input
            v-model:value="model.rawWhere"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 6 }"
            placeholder="EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id)"
          />
          <div class="filter__actions">
            <n-text depth="3" class="hint">
              Enter the condition after WHERE, using this connection's SQL dialect. Leave out an
              outer SELECT, WHERE, ORDER BY, LIMIT, or semicolon; set the row count under Take.
              Preview before saving.
            </n-text>
            <n-button size="small" text type="primary" @click="model.useRaw = false">
              Back to the builder
            </n-button>
          </div>
        </div>
      </n-form-item>

      <!-- ── Take ────────────────────────────────────────────────────────── -->
      <n-form-item label="Take" path="count">
        <div class="take">
          <n-radio-group v-model:value="model.takeKind">
            <div class="take__row">
              <n-radio value="all">All matching rows</n-radio>
            </div>
            <div class="take__row">
              <n-radio value="sample">Random sample of</n-radio>
              <n-input-number
                v-model:value="model.count"
                size="small"
                :min="1"
                :show-button="false"
                :disabled="model.takeKind !== 'sample'"
                class="take__count"
              />
            </div>
            <div class="take__row">
              <n-radio value="top">{{ model.dir === 'desc' ? 'Newest' : 'Oldest' }}</n-radio>
              <n-input-number
                v-model:value="model.count"
                size="small"
                :min="1"
                :show-button="false"
                :disabled="model.takeKind !== 'top'"
                class="take__count"
              />
              <span class="take__by">by</span>
              <n-select
                v-model:value="model.orderBy"
                size="small"
                filterable
                tag
                class="take__order"
                placeholder="created_at"
                :disabled="model.takeKind !== 'top'"
                :options="orderByOptions"
              />
              <n-select
                v-model:value="model.dir"
                size="small"
                class="take__dir"
                :disabled="model.takeKind !== 'top'"
                :options="[
                  { label: 'newest first', value: 'desc' },
                  { label: 'oldest first', value: 'asc' }
                ]"
              />
            </div>
            <div class="take__row">
              <n-radio value="none">No rows — only set how matching rows are anonymized</n-radio>
            </div>
          </n-radio-group>

          <n-text v-if="model.takeKind === 'none'" depth="3" class="hint">
            This rule adds nothing to the dump. It changes the anonymization of matching rows that
            cascade or backfill already pulled in — so "preserve our staff" doesn't also drag in
            every record those staff ever touched.
          </n-text>
          <n-text v-else depth="3" class="hint">
            Seed rows. Following foreign keys may add more — see Backfill Management. A
            <em>newest N</em> take is reproducible across runs; a random sample isn't.
          </n-text>
        </div>
      </n-form-item>

      <!-- ── Preview ─────────────────────────────────────────────────────── -->
      <n-form-item :show-label="false">
        <div class="preview">
          <n-button size="small" :loading="previewing" @click="runPreview">Preview</n-button>
          <n-text v-if="preview && model.takeKind === 'none'" class="preview__result">
            Matched <strong>{{ preview.matched.toLocaleString() }}</strong> · adds no rows; re-flags
            whichever of those the subset already contains
          </n-text>
          <n-text v-else-if="preview" class="preview__result">
            Matched <strong>{{ preview.matched.toLocaleString() }}</strong> · keeping
            <strong>{{ preview.keeping.toLocaleString() }}</strong>
          </n-text>
          <n-text v-else-if="!previewError" depth="3" class="hint">
            Counts what this rule matches, without saving it.
          </n-text>
        </div>
      </n-form-item>

      <n-alert v-if="previewError" type="error" :bordered="false" class="preview__error">
        {{ previewError }}
      </n-alert>

      <!-- ── Anonymization ───────────────────────────────────────────────── -->
      <n-form-item label="Rows are" path="anonymize">
        <div class="anon">
          <n-radio-group v-model:value="model.anonymize">
            <n-radio :value="true">Anonymized</n-radio>
            <n-radio :value="false">Preserved as-is</n-radio>
          </n-radio-group>
          <n-text depth="3" class="hint">
            Preserve wins if a row also matches an anonymizing rule.
          </n-text>
          <!-- Preserve-wins is global, so a flag-only rule can only ever lower the flag. Set to
               Anonymized it does nothing at all, which is worth saying out loud rather than
               letting someone save a rule that silently never fires. -->
          <n-text v-if="model.takeKind === 'none' && model.anonymize" type="warning" class="hint">
            This rule will have no effect: it adds no rows, and preserve always wins — so it can
            preserve matching rows but never re-anonymize them. Choose <em>Preserved as-is</em>.
          </n-text>
        </div>
      </n-form-item>
    </n-form>

    <template #footer>
      <div class="footer">
        <n-button :disabled="saving" @click="show = false">Cancel</n-button>
        <n-button type="primary" :loading="saving" @click="submit">
          {{ isEdit ? 'Save changes' : 'Add rule' }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.grow {
  width: 100%;
}

.hint {
  font-size: 12px;
  line-height: 1.45;
}

.filter,
.take,
.anon {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.filter__actions {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.take__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
}

.take__count {
  width: 84px;
}

.take__by {
  font-size: 13px;
  opacity: 0.7;
}

.take__order {
  width: 150px;
}

.take__dir {
  width: 130px;
}

.preview {
  display: flex;
  align-items: center;
  gap: 12px;
}

.preview__result {
  font-size: 13px;
}

.preview__error {
  margin-bottom: 18px;
}

.invalid {
  margin-bottom: 18px;
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
