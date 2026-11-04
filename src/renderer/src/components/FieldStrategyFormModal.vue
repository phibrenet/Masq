<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NCheckbox,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpin,
  NTag,
  NText,
  useMessage,
  type FormInst,
  type FormRules
} from 'naive-ui'
import type { FieldStrategyInput } from '@shared/api'
import type {
  ColumnInfo,
  FieldStrategy,
  FieldStrategyException,
  FieldStrategyKind,
  FieldStrategyRule,
  JsonPathInfo,
  MatchMode,
  TemplateBinding
} from '@shared/types'
import {
  blankRuleDraft,
  ruleDraftFrom,
  ruleDraftRules,
  ruleFromDraft,
  type RuleDraft
} from '@renderer/lib/ruleDraft'
import {
  invalidRegex,
  toCondition,
  toDraft,
  type DraftCondition
} from '@renderer/lib/conditionDraft'
import { generatorOptions } from '@renderer/lib/generatorOptions'
import ConditionEditor from '@renderer/components/ConditionEditor.vue'
import RuleOptionFields from '@renderer/components/RuleOptionFields.vue'
import {
  LEAVE_AS_IS,
  REDACT,
  REMOVE,
  bindingChoice,
  bindingFromChoice
} from '@renderer/lib/templateBindings'
import { useFieldStrategiesStore } from '@renderer/stores/fieldStrategies'
import { useTableClassificationsStore } from '@renderer/stores/tableClassifications'
import { useDiscoveryStore } from '@renderer/stores/discovery'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * Create/edit-a-field-strategy modal (spec §8). Mirrors the selection-rule modal's conventions:
 * `v-model:show`, mutations through the store, and the `kind` select switches the field set
 * (fake → generator; jitter → percent; preserve/redact → none). Pass a `strategy` to edit it;
 * omit it to create one. Create upserts on (table, column); edit updates by id.
 */
const show = defineModel<boolean>('show', { required: true })
const props = defineProps<{
  strategy?: FieldStrategy | null
  /** Seeds a new strategy's table and column (e.g. from the "looks like personal data" list). */
  initial?: { tableName: string; columnName: string } | null
}>()

const isEdit = computed(() => props.strategy != null)

const strategies = useFieldStrategiesStore()
const classifications = useTableClassificationsStore()
const discovery = useDiscoveryStore()
const workspace = useWorkspaceStore()
const message = useMessage()

const kindOptions: { label: string; value: FieldStrategyKind }[] = [
  { label: 'Preserve (keep as-is)', value: 'preserve' },
  { label: 'Redact (null it out)', value: 'redact' },
  { label: 'Fake (generate realistic)', value: 'fake' },
  { label: 'Obfuscate (scramble part of it)', value: 'obfuscate' },
  { label: 'Jitter (perturb amount)', value: 'jitter' },
  { label: 'Template (anonymize inside JSON)', value: 'template' }
]

/** An exception can be any kind but a template, which has its own path builder. */
const exceptionKindOptions = kindOptions.filter((o) => o.value !== 'template')

/** Transactional universe — same rationale as the selection-rule modal's table picker. */
const tableOptions = computed(() => {
  const classByName = new Map(classifications.list.map((c) => [c.tableName, c.class]))
  const names = new Set<string>([
    ...discovery.tables,
    ...classifications.list.filter((c) => c.class === 'transactional').map((c) => c.tableName)
  ])
  return [...names]
    .filter((name) => {
      const klass = classByName.get(name)
      return !klass || klass === 'transactional'
    })
    .sort()
    .map((name) => ({ label: name, value: name }))
})

/** The exception being edited. `on` is the checkbox; nothing is saved while it's off. */
interface ExceptionDraft {
  on: boolean
  match: MatchMode
  conditions: DraftCondition[]
  rule: RuleDraft
}

/** The main rule's settings sit flat on the form (it is a `RuleDraft`), next to the template ones. */
interface FormState extends RuleDraft {
  tableName: string
  columnName: string
  /** path → generator, or `LEAVE_AS_IS`. Keyed by path so discovery and saved bindings merge cleanly. */
  bindings: Record<string, string>
  /** Paths typed by hand, for when discovery finds nothing (no source, empty column). */
  extraPaths: string[]
  exception: ExceptionDraft
}

/** Staff-domain emails are the motivating case, so a new exception starts on keep-domain emails. */
function blankException(): ExceptionDraft {
  return {
    on: false,
    match: 'all',
    conditions: [],
    rule: { ...blankRuleDraft('fake'), generator: 'userIdEmailKeepDomain' }
  }
}

function blankForm(): FormState {
  return {
    ...blankRuleDraft('fake'),
    tableName: '',
    columnName: '',
    bindings: {},
    extraPaths: [],
    exception: blankException()
  }
}

function fromException(e: FieldStrategyException | undefined): ExceptionDraft {
  if (!e) return blankException()
  return {
    on: true,
    match: e.match,
    conditions: e.conditions.map(toDraft),
    rule: ruleDraftFrom(e.rule)
  }
}

function fromStrategy(s: FieldStrategy): FormState {
  const bindings: Record<string, string> = {}
  if (s.rule.kind === 'template') {
    for (const b of s.rule.bindings) bindings[b.path] = bindingChoice(b)
  }
  return {
    ...ruleDraftFrom(s.rule),
    tableName: s.tableName,
    columnName: s.columnName,
    bindings,
    // A saved binding whose path discovery doesn't return (different sample, or no source at all) must
    // still be visible and editable — otherwise saving would silently drop it.
    extraPaths: s.rule.kind === 'template' ? s.rule.bindings.map((b) => b.path) : [],
    exception: fromException(s.exception)
  }
}

const model = reactive<FormState>(blankForm())
const formRef = ref<FormInst | null>(null)
const saving = ref(false)

/** Discovered JSON paths for the chosen column, plus how many rows were sampled. */
const jsonPaths = ref<JsonPathInfo[]>([])
const sampledRows = ref(0)
const discoveringPaths = ref(false)

/**
 * Rows the builder shows: every discovered path, then any hand-added or previously-saved path that
 * discovery didn't return. Union rather than replace, so an existing binding can never be lost just
 * because this sample didn't happen to contain its key.
 */
const templateRows = computed<{ path: string; info?: JsonPathInfo }[]>(() => {
  const seen = new Set<string>()
  const rows: { path: string; info?: JsonPathInfo }[] = []
  for (const info of jsonPaths.value) {
    seen.add(info.path)
    rows.push({ path: info.path, info })
  }
  for (const path of model.extraPaths) {
    if (!path.trim() || seen.has(path)) continue
    seen.add(path)
    rows.push({ path })
  }
  return rows
})

const boundCount = computed(
  () =>
    templateRows.value.filter(
      (r) => model.bindings[r.path] && model.bindings[r.path] !== LEAVE_AS_IS
    ).length
)

/**
 * One dropdown covers all four outcomes for a path: leave it, null it, drop the key, or fake it.
 * `redact` and `remove` lead because they're what secrets need — a password hash has no useful fake.
 */
const bindingOptions = computed(() => [
  { label: 'Leave as-is', value: LEAVE_AS_IS },
  { label: 'Redact (set to null)', value: REDACT },
  { label: 'Remove (delete the key)', value: REMOVE },
  ...generatorOptions
])

/**
 * Sample the column and list its JSON paths. A failure (or no source connection) is not fatal — the
 * builder falls back to hand-typed paths, so the strategy stays usable offline.
 */
let pathsRequest = 0
async function refreshJsonPaths(): Promise<void> {
  // Numbered like `refreshColumns`: only the sample for the column currently chosen may land.
  const request = ++pathsRequest
  const table = model.tableName.trim()
  const column = model.columnName.trim()
  jsonPaths.value = []
  sampledRows.value = 0
  discoveringPaths.value = false
  if (model.kind !== 'template' || !table || !column || !discovery.sourceConnection) return
  discoveringPaths.value = true
  try {
    const sample = await window.api.source.discoverJsonPaths(
      discovery.sourceConnection.id,
      table,
      column
    )
    if (request !== pathsRequest) return
    jsonPaths.value = sample.paths
    sampledRows.value = sample.sampled
  } catch (err) {
    if (request !== pathsRequest) return
    message.error(`Could not sample "${table}.${column}": ${(err as Error).message}`)
  } finally {
    if (request === pathsRequest) discoveringPaths.value = false
  }
}

function addPath(): void {
  model.extraPaths.push('')
}

function renamePath(index: number, next: string): void {
  model.extraPaths[index] = next
}

/** Columns of the currently-selected table, introspected from the source (cached in the store). */
const columns = ref<ColumnInfo[]>([])
const loadingColumns = ref(false)

const columnOptions = computed(() =>
  columns.value.map((c) => ({
    label: `${c.name} — ${c.dataType}${c.isPrimaryKey ? ' (PK)' : ''}`,
    value: c.name
  }))
)

/**
 * Load the selected table's columns to drive the column dropdown. No source connection (or an
 * empty table) just clears the options — the `tag` select still accepts a hand-typed name, so a
 * missing/failed introspection degrades to free text rather than blocking the form.
 */
let columnsRequest = 0
async function refreshColumns(table: string): Promise<void> {
  // Numbered so a slow response for a table the user has since moved off can't replace the options
  // for the one they're on now.
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

watch(show, (open) => {
  if (open) {
    Object.assign(
      model,
      props.strategy ? fromStrategy(props.strategy) : { ...blankForm(), ...(props.initial ?? {}) }
    )
  }
})

// Reload the column dropdown whenever the chosen table changes (including when seeded on open).
watch(
  () => model.tableName,
  (table) => {
    void refreshColumns(table)
  }
)

// Re-sample whenever the target column or the kind changes — switching *to* template is what should
// trigger discovery, not opening the modal.
watch(
  () => [model.kind, model.tableName, model.columnName],
  () => {
    void refreshJsonPaths()
  }
)

const rules = computed<FormRules>(() => {
  const r: FormRules = {
    tableName: { required: true, message: 'A table is required', trigger: ['blur', 'change'] },
    columnName: { required: true, message: 'A column is required', trigger: ['blur', 'input'] },
    ...(model.kind === 'template' ? {} : ruleDraftRules(model))
  }
  if (model.exception.on) r.exception = { rule: ruleDraftRules(model.exception.rule) }
  return r
})

/** Build the discriminated rule union from the flat form state. */
function toRule(): FieldStrategyRule {
  if (model.kind !== 'template') return ruleFromDraft(model)
  // Only bound paths are persisted; "leave as-is" is the absence of a binding, not a stored value.
  const bindings = templateRows.value
    .map((r) => bindingFromChoice(r.path, model.bindings[r.path]))
    .filter((b): b is TemplateBinding => b !== null)
  return { kind: 'template', bindings }
}

/** The exception to save, or `null` to clear it (sent explicitly, so an edit removes a stored one). */
function toException(): FieldStrategyException | null {
  const e = model.exception
  if (!e.on) return null
  return {
    match: e.match,
    conditions: e.conditions.map((c) => toCondition(c, columns.value)),
    rule: ruleFromDraft(e.rule)
  }
}

/** What's wrong with the exception as drafted, checked on save; `null` when it can be saved. */
function exceptionProblem(): string | null {
  const e = model.exception
  if (!e.on) return null
  if (e.conditions.length === 0)
    return 'Add a condition to the exception, or untick it. An exception with none would apply to every row.'
  if (e.conditions.some((c) => !c.column.trim())) return 'Every exception condition needs a column.'
  return invalidRegex(e.conditions)
}

function toInput(): Omit<FieldStrategyInput, 'workspaceId'> {
  return {
    tableName: model.tableName.trim(),
    columnName: model.columnName.trim(),
    rule: toRule(),
    exception: toException()
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
  const problem = exceptionProblem()
  if (problem) {
    message.error(problem)
    return
  }

  saving.value = true
  try {
    const label = `${model.tableName.trim()}.${model.columnName.trim()}`
    if (isEdit.value && props.strategy) {
      await strategies.update(props.strategy.id, toInput())
      message.success(`Strategy for "${label}" updated.`)
    } else {
      await strategies.create(toInput())
      message.success(`Strategy for "${label}" saved.`)
    }
    show.value = false
  } catch (err) {
    message.error(`Could not save strategy: ${(err as Error).message}`)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="isEdit ? 'Edit field strategy' : 'New field strategy'"
    :style="{ width: model.exception.on ? '760px' : '520px', maxWidth: '94vw' }"
    :mask-closable="!saving"
  >
    <!-- What's shown is what could be read; saving replaces the stored strategy with it. -->
    <n-alert v-if="strategy?.invalid" type="warning" :bordered="false" class="invalid">
      This strategy's exception couldn't be read back — {{ strategy.invalid }}. Runs are refused
      until it's saved again. Check the exception below before saving; saving replaces it with
      exactly what's here.
    </n-alert>
    <n-form ref="formRef" :model="model" :rules="rules" label-placement="top">
      <div class="row">
        <n-form-item label="Table" path="tableName" class="row__item">
          <n-select
            v-model:value="model.tableName"
            filterable
            tag
            placeholder="e.g. users"
            :options="tableOptions"
          />
        </n-form-item>
        <n-form-item label="Column" path="columnName" class="row__item">
          <n-select
            v-model:value="model.columnName"
            filterable
            tag
            :loading="loadingColumns"
            :options="columnOptions"
            placeholder="e.g. email"
          />
        </n-form-item>
      </div>

      <n-form-item label="Strategy" path="kind">
        <n-select v-model:value="model.kind" :options="kindOptions" />
      </n-form-item>

      <RuleOptionFields v-if="model.kind !== 'template'" v-model:draft="model" path-prefix="" />

      <template v-if="model.kind === 'template'">
        <n-form-item label="JSON paths">
          <n-spin :show="discoveringPaths" class="tpl">
            <n-text depth="3" class="hint">
              Anonymizes values <em>inside</em> the JSON. Every path is left exactly as-is unless
              you bind it to a generator — so rows of differing shape all survive.
              <template v-if="sampledRows > 0">
                Sampled {{ sampledRows }} row{{ sampledRows === 1 ? '' : 's' }}.
              </template>
              <template v-else-if="!discovery.sourceConnection">
                No source connection — add paths by hand below.
              </template>
            </n-text>

            <div v-for="row in templateRows" :key="row.path" class="tpl__row">
              <div class="tpl__path">
                <code>{{ row.path }}</code>
                <n-tag
                  v-if="row.info && row.info.presentIn < sampledRows"
                  size="tiny"
                  type="warning"
                  :bordered="false"
                >
                  in {{ row.info.presentIn }}/{{ sampledRows }}
                </n-tag>
                <n-tag
                  v-if="row.info && !row.info.types.includes('string')"
                  size="tiny"
                  :bordered="false"
                  :type="
                    row.info.types.includes('array') || row.info.types.includes('object')
                      ? 'error'
                      : 'default'
                  "
                >
                  {{ row.info.types.join('/') }}
                </n-tag>
              </div>
              <n-select
                v-model:value="model.bindings[row.path]"
                filterable
                size="small"
                :options="bindingOptions"
                :placeholder="'Leave as-is'"
                class="tpl__gen"
              />
            </div>

            <div v-for="(path, i) in model.extraPaths" :key="`extra-${i}`" class="tpl__row">
              <n-input
                :value="path"
                size="small"
                placeholder="path.into.json"
                class="tpl__path-input"
                @update:value="renamePath(i, $event)"
              />
              <n-select
                v-model:value="model.bindings[path]"
                filterable
                size="small"
                :options="bindingOptions"
                placeholder="Leave as-is"
                class="tpl__gen"
              />
            </div>

            <div class="tpl__actions">
              <n-button size="small" dashed @click="addPath">Add path</n-button>
              <n-button
                v-if="discovery.sourceConnection"
                size="small"
                quaternary
                :loading="discoveringPaths"
                @click="refreshJsonPaths"
              >
                Re-sample
              </n-button>
              <n-text depth="3" class="hint">
                {{ boundCount }} path{{ boundCount === 1 ? '' : 's' }} bound
              </n-text>
            </div>

            <n-text v-if="templateRows.length === 0 && !discoveringPaths" depth="3" class="hint">
              No JSON paths found — the column may be empty, hold a JSON array (not supported in
              v1), or not be JSON at all.
            </n-text>
          </n-spin>
        </n-form-item>
      </template>

      <n-text v-if="model.kind === 'redact'" depth="3" class="hint">
        Redact replaces the column value with NULL on write.
      </n-text>
      <n-text v-else-if="model.kind === 'preserve'" depth="3" class="hint">
        Preserve copies the value unchanged — the default for any column without a strategy.
      </n-text>

      <!-- ── Exception ─────────────────────────────────────────────────── -->
      <section class="exc">
        <n-checkbox v-model:checked="model.exception.on">
          Use a different strategy for some rows
        </n-checkbox>
        <template v-if="model.exception.on">
          <n-text depth="3" class="hint">
            Rows matching these conditions get the strategy below instead. Conditions see the
            original values, before anything is anonymized — for example, email ends with
            <code>@acme.com</code> → Email from ID, keep domain.
          </n-text>
          <ConditionEditor
            v-model:conditions="model.exception.conditions"
            v-model:match="model.exception.match"
            :columns="columns"
            empty-hint="Add at least one condition."
          />
          <n-form-item label="Strategy for those rows">
            <n-select v-model:value="model.exception.rule.kind" :options="exceptionKindOptions" />
          </n-form-item>
          <RuleOptionFields v-model:draft="model.exception.rule" path-prefix="exception.rule." />
          <n-text v-if="model.exception.rule.kind === 'redact'" depth="3" class="hint">
            Those rows get NULL.
          </n-text>
          <n-text v-else-if="model.exception.rule.kind === 'preserve'" type="warning" class="hint">
            Those rows keep their real value in the dump.
          </n-text>
        </template>
      </section>
    </n-form>

    <template #footer>
      <div class="footer">
        <n-button :disabled="saving" @click="show = false">Cancel</n-button>
        <n-button type="primary" :loading="saving" @click="submit">
          {{ isEdit ? 'Save changes' : 'Save strategy' }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.tpl {
  display: block;
  width: 100%;
}

.tpl__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 3px 0;
}

.tpl__path {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.tpl__path-input {
  flex: 1;
  min-width: 0;
}

.tpl__gen {
  width: 240px;
  flex-shrink: 0;
}

.tpl__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 6px;
}

code {
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgb(var(--surface-3));
}

.row {
  display: flex;
  gap: 14px;
}

.row__item {
  flex: 1;
}

.grow {
  width: 100%;
}

.hint {
  display: block;
  font-size: 12px;
  line-height: 1.4;
}

.exc {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 6px;
  padding-top: 14px;
  border-top: 1px solid rgb(var(--line) / 0.06);
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
