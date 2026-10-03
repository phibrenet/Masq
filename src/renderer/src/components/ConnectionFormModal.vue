<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  NButton,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  useMessage,
  type FormInst,
  type FormRules
} from 'naive-ui'
import type { ConnectionInput } from '@shared/api'
import type { Connection, ConnectionRole, Dialect } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * Create/edit-a-connection modal. Binds to the config store over IPC via the connections
 * store's `create`/`update` actions; the password (server dialects only) is passed
 * separately and never becomes part of the `Connection` shape. `v-model:show` drives
 * visibility so the parent owns the open/close state. Pass a `connection` to edit it;
 * omit it (or pass null) to create a new one.
 */
const show = defineModel<boolean>('show', { required: true })
const props = defineProps<{ connection?: Connection | null }>()

const isEdit = computed(() => props.connection != null)

const connections = useConnectionsStore()
const workspace = useWorkspaceStore()
const message = useMessage()

/**
 * SQL Server isn't offered for new connections: its adapter isn't built, so every attempt would
 * fail. It stays in the list only when editing a connection already saved as SQL Server, so that
 * one still shows its dialect instead of a bare value.
 */
const dialectOptions = computed<{ label: string; value: Dialect }[]>(() => [
  { label: 'MySQL', value: 'mysql' },
  { label: 'PostgreSQL', value: 'postgres' },
  { label: 'SQLite', value: 'sqlite' },
  ...(props.connection?.dialect === 'mssql'
    ? [{ label: 'SQL Server (not supported yet)', value: 'mssql' as const }]
    : [])
])

const roleOptions: { label: string; value: ConnectionRole }[] = [
  { label: 'Source (read from)', value: 'source' },
  { label: 'Target', value: 'target' }
]

/** Default port per server dialect, filled in when the dialect changes and left blank. */
const defaultPort: Partial<Record<Dialect, number>> = {
  mysql: 3306,
  postgres: 5432,
  mssql: 1433
}

interface FormState {
  label: string
  dialect: Dialect
  role: ConnectionRole
  host: string
  port: number | null
  database: string
  username: string
  password: string
  searchPath: string
  filePath: string
}

function blankForm(): FormState {
  return {
    label: '',
    dialect: 'mysql',
    role: 'source',
    host: '',
    port: defaultPort.mysql ?? null,
    database: '',
    username: '',
    password: '',
    searchPath: '',
    filePath: ''
  }
}

/** Populate the form from an existing connection. Password stays blank — it lives in the
 * keychain and is only re-sent if the user types a new one. */
function fromConnection(c: Connection): FormState {
  return {
    label: c.label,
    dialect: c.dialect,
    role: c.role,
    host: c.host ?? '',
    port: c.port ?? defaultPort[c.dialect] ?? null,
    database: c.database ?? '',
    username: c.username ?? '',
    password: '',
    searchPath: c.searchPath ?? '',
    filePath: c.filePath ?? ''
  }
}

const model = reactive<FormState>(blankForm())
const formRef = ref<FormInst | null>(null)
const saving = ref(false)

const isFileBased = computed(() => model.dialect === 'sqlite')
/** Search path is a Postgres-only concept — MySQL's schema *is* its database. */
const isPostgres = computed(() => model.dialect === 'postgres')

// Seed the form each time the modal opens — from the connection being edited, or blank.
watch(show, (open) => {
  if (open) Object.assign(model, props.connection ? fromConnection(props.connection) : blankForm())
})

// When the dialect changes, drop the new default port in — but keep a custom or loaded
// port that the user hasn't left at the previous dialect's default.
watch(
  () => model.dialect,
  (dialect, prev) => {
    const prevDefault = prev ? (defaultPort[prev] ?? null) : null
    if (model.port === null || model.port === prevDefault) {
      model.port = defaultPort[dialect] ?? null
    }
  }
)

const rules = computed<FormRules>(() => ({
  label: { required: true, message: 'A name is required', trigger: ['blur', 'input'] },
  filePath: isFileBased.value
    ? { required: true, message: 'A file path is required', trigger: ['blur', 'input'] }
    : {},
  host: isFileBased.value
    ? {}
    : { required: true, message: 'A host is required', trigger: ['blur', 'input'] },
  database: isFileBased.value
    ? {}
    : { required: true, message: 'A database is required', trigger: ['blur', 'input'] }
}))

/** Assemble the persisted `Connection` shape — only the fields relevant to the dialect. */
function toInput(workspaceId: string): ConnectionInput {
  const base = {
    workspaceId,
    label: model.label.trim(),
    dialect: model.dialect,
    role: model.role
  }
  if (isFileBased.value) {
    return { ...base, filePath: model.filePath.trim() }
  }
  return {
    ...base,
    host: model.host.trim(),
    port: model.port ?? undefined,
    database: model.database.trim(),
    username: model.username.trim() || undefined,
    // Only persisted for Postgres; blank stays undefined so the engine falls back to `public`.
    searchPath: isPostgres.value ? model.searchPath.trim() || undefined : undefined
  }
}

async function submit(): Promise<void> {
  const workspaceId = workspace.currentWorkspaceId
  if (!workspaceId) {
    message.error('Select a workspace first.')
    return
  }
  try {
    await formRef.value?.validate()
  } catch {
    return // validation errors are shown inline
  }

  saving.value = true
  try {
    const password = isFileBased.value ? undefined : model.password || undefined
    if (isEdit.value && props.connection) {
      const updated = await connections.update(props.connection.id, toInput(workspaceId), password)
      message.success(`Connection "${updated?.label ?? model.label.trim()}" updated.`)
    } else {
      const created = await connections.create(toInput(workspaceId), password)
      message.success(`Connection "${created.label}" saved.`)
    }
    show.value = false
  } catch (err) {
    message.error(`Could not save connection: ${(err as Error).message}`)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="isEdit ? 'Edit connection' : 'New connection'"
    :style="{ width: '520px', maxWidth: '92vw' }"
    :mask-closable="!saving"
  >
    <n-form ref="formRef" :model="model" :rules="rules" label-placement="top">
      <n-form-item label="Name" path="label">
        <n-input v-model:value="model.label" placeholder="e.g. Production (read replica)" />
      </n-form-item>

      <div class="row">
        <n-form-item label="Dialect" path="dialect" class="row__item">
          <n-select v-model:value="model.dialect" :options="dialectOptions" />
        </n-form-item>
        <n-form-item label="Role" path="role" class="row__item">
          <n-select v-model:value="model.role" :options="roleOptions" />
        </n-form-item>
      </div>

      <template v-if="isFileBased">
        <n-form-item label="File path" path="filePath">
          <n-input v-model:value="model.filePath" placeholder="/path/to/database.sqlite3" />
        </n-form-item>
      </template>

      <template v-else>
        <div class="row">
          <n-form-item label="Host" path="host" class="row__host">
            <n-input v-model:value="model.host" placeholder="127.0.0.1" />
          </n-form-item>
          <n-form-item label="Port" path="port" class="row__port">
            <n-input-number v-model:value="model.port" :show-button="false" placeholder="3306" />
          </n-form-item>
        </div>
        <n-form-item label="Database" path="database">
          <n-input v-model:value="model.database" placeholder="app_production" />
        </n-form-item>
        <n-form-item v-if="isPostgres" label="Search path" path="searchPath">
          <n-input v-model:value="model.searchPath" placeholder="public" />
          <template #feedback>
            The schema(s) to read, in order — Laravel's <code>DB_SEARCH_PATH</code>. Comma-separate
            a list (<code>tenant, public</code>). Leave blank for <code>public</code>.
          </template>
        </n-form-item>
        <div class="row">
          <n-form-item label="Username" path="username" class="row__item">
            <n-input v-model:value="model.username" placeholder="readonly" />
          </n-form-item>
          <n-form-item label="Password" path="password" class="row__item">
            <n-input
              v-model:value="model.password"
              type="password"
              show-password-on="click"
              :placeholder="isEdit ? 'Leave blank to keep current' : 'Stored in the OS keychain'"
            />
          </n-form-item>
        </div>
      </template>
    </n-form>

    <template #footer>
      <div class="footer">
        <n-button :disabled="saving" @click="show = false">Cancel</n-button>
        <n-button type="primary" :loading="saving" @click="submit">
          {{ isEdit ? 'Save changes' : 'Save connection' }}
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
}

.row__host {
  flex: 3;
}

.row__port {
  flex: 1;
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
