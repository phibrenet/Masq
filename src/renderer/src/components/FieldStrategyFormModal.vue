<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  NButton,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpin,
  NTag,
  NText,
  useMessage,
  type FormInst,
  type FormRules,
  type SelectGroupOption
} from 'naive-ui'
import type { FieldStrategyInput } from '@shared/api'
import type {
  ColumnInfo,
  FakeGenerator,
  FieldStrategy,
  FieldStrategyKind,
  FieldStrategyRule,
  JsonPathInfo,
  ObfuscateSide,
  TemplateBinding
} from '@shared/types'
import { OBFUSCATE_MIN_COUNT } from '@shared/types'
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

/** "Leave as-is" is the default for every discovered path — a template only changes what you bind. */
const LEAVE_AS_IS = ''
/**
 * Sentinels for the two non-generator actions, so one dropdown per path covers every choice. They
 * can't collide with a `FakeGenerator` name, and `toRule` maps them back to a `TemplateAction`.
 */
const REDACT = '__redact__'
const REMOVE = '__remove__'

/** Generators grouped by category (spec §8 / the FakeGenerator ↔ faker mapping in types.ts). */
const generatorOptions: SelectGroupOption[] = [
  {
    type: 'group',
    label: 'Person',
    key: 'person',
    children: [
      { label: 'First name', value: 'firstName' },
      { label: 'Surname', value: 'lastName' },
      { label: 'Full name', value: 'fullName' }
    ]
  },
  {
    type: 'group',
    label: 'Contact',
    key: 'contact',
    children: [
      { label: 'Email', value: 'email' },
      { label: 'Phone', value: 'phone' }
    ]
  },
  {
    type: 'group',
    label: 'Address',
    key: 'address',
    children: [
      { label: 'Street address (line 1)', value: 'streetAddress' },
      { label: 'Address line 2', value: 'secondaryAddress' },
      { label: 'City', value: 'city' },
      { label: 'State / region', value: 'state' },
      { label: 'Postcode', value: 'zipCode' },
      { label: 'Country', value: 'country' },
      { label: 'Country code (GB, US, NL)', value: 'countryCode' }
    ]
  },
  {
    type: 'group',
    label: 'Finance',
    key: 'finance',
    children: [
      { label: 'Credit card number', value: 'creditCardNumber' },
      { label: 'Credit card CVV', value: 'creditCardCVV' },
      { label: 'IBAN', value: 'iban' }
    ]
  },
  {
    type: 'group',
    label: 'Company',
    key: 'company',
    children: [{ label: 'Company name', value: 'companyName' }]
  },
  {
    type: 'group',
    label: 'Text',
    key: 'text',
    children: [
      { label: 'Lorem words (short — titles)', value: 'loremWords' },
      { label: 'Lorem sentence (medium)', value: 'loremSentence' },
      { label: 'Lorem paragraph (long — text columns)', value: 'loremParagraph' }
    ]
  },
  {
    type: 'group',
    label: 'Web',
    key: 'web',
    children: [
      { label: 'Avatar / portrait image URL', value: 'avatarUrl' },
      { label: 'Website URL', value: 'url' }
    ]
  },
  {
    type: 'group',
    label: 'Dates',
    key: 'dates',
    children: [{ label: 'Date of birth (YYYY-MM-DD)', value: 'dateOfBirth' }]
  }
]

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

interface FormState {
  tableName: string
  columnName: string
  kind: FieldStrategyKind
  generator: FakeGenerator
  percent: number | null
  obfuscateSide: ObfuscateSide
  obfuscateCount: number | null
  /** path → generator, or `LEAVE_AS_IS`. Keyed by path so discovery and saved bindings merge cleanly. */
  bindings: Record<string, string>
  /** Paths typed by hand, for when discovery finds nothing (no source, empty column). */
  extraPaths: string[]
}

function blankForm(): FormState {
  return {
    tableName: '',
    columnName: '',
    kind: 'fake',
    generator: 'fullName',
    percent: 10,
    obfuscateSide: 'last',
    obfuscateCount: OBFUSCATE_MIN_COUNT,
    bindings: {},
    extraPaths: []
  }
}

function fromStrategy(s: FieldStrategy): FormState {
  const bindings: Record<string, string> = {}
  if (s.rule.kind === 'template') {
    for (const b of s.rule.bindings) {
      bindings[b.path] =
        b.action === 'redact' ? REDACT : b.action === 'remove' ? REMOVE : (b.generator ?? '')
    }
  }
  return {
    tableName: s.tableName,
    columnName: s.columnName,
    kind: s.rule.kind,
    generator: s.rule.kind === 'fake' ? s.rule.generator : 'fullName',
    percent: s.rule.kind === 'jitter' ? s.rule.percent : 10,
    obfuscateSide: s.rule.kind === 'obfuscate' ? s.rule.side : 'last',
    obfuscateCount: s.rule.kind === 'obfuscate' ? s.rule.count : OBFUSCATE_MIN_COUNT,
    bindings,
    // A saved binding whose path discovery doesn't return (different sample, or no source at all) must
    // still be visible and editable — otherwise saving would silently drop it.
    extraPaths: s.rule.kind === 'template' ? s.rule.bindings.map((b) => b.path) : []
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

const rules = computed<FormRules>(() => ({
  tableName: { required: true, message: 'A table is required', trigger: ['blur', 'change'] },
  columnName: { required: true, message: 'A column is required', trigger: ['blur', 'input'] },
  percent:
    model.kind === 'jitter'
      ? {
          validator: () =>
            (model.percent ?? 0) > 0 ? true : new Error('Enter a positive percentage'),
          trigger: ['blur', 'change']
        }
      : {},
  obfuscateCount:
    model.kind === 'obfuscate'
      ? {
          validator: () =>
            (model.obfuscateCount ?? 0) >= OBFUSCATE_MIN_COUNT
              ? true
              : new Error(
                  `Scramble at least ${OBFUSCATE_MIN_COUNT} characters — fewer leaves the value ` +
                    `re-identifiable by anyone holding the originals.`
                ),
          trigger: ['blur', 'change']
        }
      : {}
}))

/** Build the discriminated rule union from the flat form state. */
function toRule(): FieldStrategyRule {
  switch (model.kind) {
    case 'template': {
      // Only bound paths are persisted; "leave as-is" is the absence of a binding, not a stored value.
      const bindings: TemplateBinding[] = templateRows.value
        .filter(
          (r) => r.path.trim() && model.bindings[r.path] && model.bindings[r.path] !== LEAVE_AS_IS
        )
        .map((r) => ({ path: r.path.trim(), generator: model.bindings[r.path] as FakeGenerator }))
      return { kind: 'template', bindings }
    }
    case 'fake':
      return { kind: 'fake', generator: model.generator }
    case 'jitter':
      return { kind: 'jitter', percent: model.percent ?? 0 }
    case 'obfuscate':
      return {
        kind: 'obfuscate',
        side: model.obfuscateSide,
        count: model.obfuscateCount ?? OBFUSCATE_MIN_COUNT
      }
    case 'redact':
      return { kind: 'redact' }
    default:
      return { kind: 'preserve' }
  }
}

function toInput(): Omit<FieldStrategyInput, 'workspaceId'> {
  return { tableName: model.tableName.trim(), columnName: model.columnName.trim(), rule: toRule() }
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
    :style="{ width: '520px', maxWidth: '92vw' }"
    :mask-closable="!saving"
  >
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

      <n-form-item v-if="model.kind === 'fake'" label="Generator" path="generator">
        <n-select v-model:value="model.generator" :options="generatorOptions" />
      </n-form-item>

      <template v-if="model.kind === 'obfuscate'">
        <n-form-item label="Scramble">
          <n-radio-group v-model:value="model.obfuscateSide">
            <n-radio-button value="first" label="First characters" />
            <n-radio-button value="last" label="Last characters" />
          </n-radio-group>
        </n-form-item>
        <n-form-item label="How many" path="obfuscateCount">
          <div class="obf">
            <n-input-number
              v-model:value="model.obfuscateCount"
              :min="OBFUSCATE_MIN_COUNT"
              :show-button="false"
              :placeholder="String(OBFUSCATE_MIN_COUNT)"
              class="obf__count"
            />
            <n-text depth="3" class="hint">
              Letters become random letters and digits random digits, so the value keeps its shape —
              <code>ACE-2024-XY7781</code> scrambled on the last 6 reads
              <code>ACE-2024-QM3419</code>. Dashes, dots and spaces are left alone. A value shorter
              than this is scrambled in full, and the same input always gives the same output so
              joins on the column survive.
            </n-text>
          </div>
        </n-form-item>
      </template>

      <n-form-item v-if="model.kind === 'jitter'" label="Jitter %" path="percent">
        <n-input-number
          v-model:value="model.percent"
          :min="1"
          :max="100"
          :show-button="false"
          placeholder="10"
          class="grow"
        />
      </n-form-item>

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
.obf {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.obf__count {
  width: 120px;
}

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

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
