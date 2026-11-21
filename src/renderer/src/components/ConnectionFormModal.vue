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
  NSwitch,
  useMessage,
  type FormInst,
  type FormRules
} from 'naive-ui'
import type { ConnectionInput } from '@shared/api'
import type { Connection, ConnectionRole, Dialect, SshAuthMethod } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { sshSecretMatches } from '@shared/ssh'

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
  sshEnabled: boolean
  sshHost: string
  sshPort: number | null
  sshUsername: string
  sshAuthMethod: SshAuthMethod
  sshPrivateKeyPath: string
  sshSecret: string
  clearSshSecret: boolean
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
    filePath: '',
    sshEnabled: false,
    sshHost: '',
    sshPort: 22,
    sshUsername: '',
    sshAuthMethod: 'privateKey',
    sshPrivateKeyPath: '',
    sshSecret: '',
    clearSshSecret: false
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
    filePath: c.filePath ?? '',
    sshEnabled: c.sshEnabled ?? false,
    sshHost: c.sshHost ?? '',
    sshPort: c.sshPort ?? 22,
    sshUsername: c.sshUsername ?? '',
    sshAuthMethod: c.sshAuthMethod ?? 'privateKey',
    sshPrivateKeyPath: c.sshPrivateKeyPath ?? '',
    sshSecret: '',
    clearSshSecret: false
  }
}

const model = reactive<FormState>(blankForm())
const formRef = ref<FormInst | null>(null)
const saving = ref(false)
const savedSshSecret = ref(false)
const fingerprint = ref<string>()
const forgetFingerprint = ref(false)
const sshAuthOptions = [
  { label: 'Private key file', value: 'privateKey' },
  { label: 'Password', value: 'password' }
]
const sameSshIdentity = computed(() => {
  return sshSecretMatches(props.connection, {
    sshEnabled: model.sshEnabled,
    sshHost: model.sshHost.trim(),
    sshPort: model.sshPort ?? 22,
    sshUsername: model.sshUsername.trim(),
    sshAuthMethod: model.sshAuthMethod,
    sshPrivateKeyPath: model.sshPrivateKeyPath.trim()
  })
})
const keepSshSecret = computed(
  () => savedSshSecret.value && sameSshIdentity.value && !model.clearSshSecret
)

async function chooseKey(): Promise<void> {
  try {
    const path = await window.api.system.chooseSshPrivateKey()
    if (path) model.sshPrivateKeyPath = path
  } catch (err) {
    message.error((err as Error).message)
  }
}

const isFileBased = computed(() => model.dialect === 'sqlite')
/** Search path is a Postgres-only concept — MySQL's schema *is* its database. */
const isPostgres = computed(() => model.dialect === 'postgres')

// Seed the form each time the modal opens — from the connection being edited, or blank.
watch(show, async (open) => {
  if (!open) {
    model.password = ''
    model.sshSecret = ''
    return
  }
  Object.assign(model, props.connection ? fromConnection(props.connection) : blankForm())
  fingerprint.value = props.connection?.sshHostFingerprint
  forgetFingerprint.value = false
  savedSshSecret.value = false
  const id = props.connection?.id
  if (id) {
    try {
      const saved = await window.api.config.hasSshSecret(id)
      if (show.value && props.connection?.id === id) savedSshSecret.value = saved
    } catch (err) {
      message.error((err as Error).message)
    }
  }
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
  sshHost:
    !isFileBased.value && model.sshEnabled
      ? { required: true, message: 'An SSH host is required', trigger: ['blur', 'input'] }
      : {},
  sshUsername:
    !isFileBased.value && model.sshEnabled
      ? { required: true, message: 'An SSH username is required', trigger: ['blur', 'input'] }
      : {},
  sshPrivateKeyPath:
    !isFileBased.value && model.sshEnabled && model.sshAuthMethod === 'privateKey'
      ? { required: true, message: 'Choose the private key file', trigger: ['blur', 'input'] }
      : {},
  sshSecret:
    !isFileBased.value &&
    model.sshEnabled &&
    model.sshAuthMethod === 'password' &&
    !keepSshSecret.value
      ? { required: true, message: 'An SSH password is required', trigger: ['blur', 'input'] }
      : {},
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
    role: model.role,
    forgetSshHostKey: forgetFingerprint.value
  }
  if (isFileBased.value) {
    return { ...base, filePath: model.filePath.trim(), sshEnabled: false }
  }
  return {
    ...base,
    host: model.host.trim(),
    port: model.port ?? undefined,
    database: model.database.trim(),
    username: model.username.trim() || undefined,
    // Only persisted for Postgres; blank stays undefined so the engine falls back to `public`.
    searchPath: isPostgres.value ? model.searchPath.trim() || undefined : undefined,
    sshEnabled: model.sshEnabled,
    sshHost: model.sshHost.trim(),
    sshPort: model.sshPort ?? 22,
    sshUsername: model.sshUsername.trim(),
    sshAuthMethod: model.sshAuthMethod,
    sshPrivateKeyPath:
      model.sshAuthMethod === 'privateKey' ? model.sshPrivateKeyPath.trim() : undefined
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
    const secrets = {
      password: isFileBased.value ? undefined : model.password || undefined,
      sshSecret:
        isFileBased.value || !model.sshEnabled
          ? undefined
          : model.sshSecret || (model.clearSshSecret ? '' : undefined)
    }
    if (isEdit.value && props.connection) {
      const updated = await connections.update(props.connection.id, toInput(workspaceId), secrets)
      message.success(`Connection "${updated?.label ?? model.label.trim()}" updated.`)
    } else {
      const created = await connections.create(toInput(workspaceId), secrets)
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
    :style="{ width: '520px', maxWidth: '92vw', maxHeight: '90vh', overflowY: 'auto' }"
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
            <n-input-number
              v-model:value="model.port"
              :show-button="false"
              :min="1"
              :max="65535"
              :precision="0"
              placeholder="3306"
            />
          </n-form-item>
        </div>
        <p v-if="model.sshEnabled" class="hint">
          Database host and port are reached from the SSH server.
        </p>
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
        <n-form-item label="Connect over SSH">
          <n-switch v-model:value="model.sshEnabled" :disabled="model.dialect === 'mssql'" />
        </n-form-item>
        <template v-if="model.sshEnabled">
          <div class="row">
            <n-form-item label="SSH host" path="sshHost" class="row__host">
              <n-input v-model:value="model.sshHost" placeholder="bastion.example.com" />
            </n-form-item>
            <n-form-item label="SSH port" path="sshPort" class="row__port">
              <n-input-number
                v-model:value="model.sshPort"
                :show-button="false"
                :min="1"
                :max="65535"
                :precision="0"
                placeholder="22"
              />
            </n-form-item>
          </div>
          <n-form-item label="SSH username" path="sshUsername">
            <n-input v-model:value="model.sshUsername" placeholder="deploy" />
          </n-form-item>
          <n-form-item label="SSH authentication">
            <n-select
              v-model:value="model.sshAuthMethod"
              :options="sshAuthOptions"
              @update:value="model.sshSecret = ''"
            />
          </n-form-item>
          <n-form-item
            v-if="model.sshAuthMethod === 'privateKey'"
            label="Private key file"
            path="sshPrivateKeyPath"
          >
            <div class="key-picker">
              <n-input v-model:value="model.sshPrivateKeyPath" placeholder="~/.ssh/id_ed25519" />
              <n-button @click="chooseKey">Browse…</n-button>
            </div>
            <template #feedback
              >Choose the private key, not the .pub file. The public key belongs on the SSH
              server.</template
            >
          </n-form-item>
          <n-form-item
            :label="
              model.sshAuthMethod === 'password' ? 'SSH password' : 'Key passphrase (optional)'
            "
            path="sshSecret"
          >
            <n-input
              v-model:value="model.sshSecret"
              type="password"
              show-password-on="click"
              :placeholder="
                keepSshSecret
                  ? 'Leave blank to keep saved secret'
                  : 'Stored encrypted in the OS keychain'
              "
            />
          </n-form-item>
          <n-form-item
            v-if="savedSshSecret && sameSshIdentity && model.sshAuthMethod === 'privateKey'"
            label="Clear saved passphrase"
          >
            <n-switch v-model:value="model.clearSshSecret" />
          </n-form-item>
          <div v-if="fingerprint" class="hint">
            <p>
              Trusted SSH host key: <code>{{ fingerprint }}</code>
            </p>
            <p v-if="forgetFingerprint">The trusted host key will be forgotten when you save.</p>
            <n-button size="small" @click="forgetFingerprint = !forgetFingerprint">{{
              forgetFingerprint ? 'Keep trusted host key' : 'Forget trusted host key'
            }}</n-button>
          </div>
          <p v-else class="hint">
            On the first connection, compare and trust the server’s host key fingerprint.
          </p>
        </template>
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
  min-width: 0;
}

.row__host {
  flex: 3;
  min-width: 0;
}

.row__port {
  flex: 1;
  min-width: 0;
}

.key-picker {
  display: flex;
  gap: 8px;
  width: 100%;
}
.key-picker > :first-child {
  flex: 1;
  min-width: 0;
}
.hint {
  font-size: 12px;
  overflow-wrap: anywhere;
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
