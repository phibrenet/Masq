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
import type { WorkspaceInput } from '@shared/api'
import type { DumpOutputMode, Workspace } from '@shared/types'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * Create/edit-a-workspace modal. Writes through the workspace store's `create`/`update`
 * actions (config store over IPC). `v-model:show` drives visibility so the parent owns
 * open/close state. Pass a `workspace` to edit it; omit it (or null) to create a new one.
 */
const show = defineModel<boolean>('show', { required: true })
const props = defineProps<{ workspace?: Workspace | null }>()

const isEdit = computed(() => props.workspace != null)

const workspaces = useWorkspaceStore()
const message = useMessage()

const outputModeOptions: { label: string; value: DumpOutputMode }[] = [
  { label: 'Combined — one .sql (schema + data)', value: 'combined' },
  { label: 'Split — separate schema + data files', value: 'split' }
]

interface FormState {
  name: string
  dumpOutputMode: DumpOutputMode
  /** Empty = use the default, which `defaultDir` shows as the placeholder. */
  dumpOutputDir: string
  dropExistingTables: boolean
}

function blankForm(): FormState {
  return { name: '', dumpOutputMode: 'combined', dumpOutputDir: '', dropExistingTables: true }
}

function fromWorkspace(w: Workspace): FormState {
  return {
    name: w.name,
    dumpOutputMode: w.dumpOutputMode,
    dumpOutputDir: w.dumpOutputDir ?? '',
    dropExistingTables: w.dropExistingTables
  }
}

const model = reactive<FormState>(blankForm())
const formRef = ref<FormInst | null>(null)
const saving = ref(false)
/** `<userData>/dumps` — only the main process knows it, and it differs dev vs packaged. */
const defaultDir = ref('')

// Seed the form each time the modal opens — from the workspace being edited, or blank.
watch(show, (open) => {
  if (!open) return
  Object.assign(model, props.workspace ? fromWorkspace(props.workspace) : blankForm())
  // Shown as the placeholder so "no folder set" reads as a real destination rather than a blank.
  void window.api.extract.dumpDirectory().then((dir) => {
    defaultDir.value = dir
  })
})

async function chooseFolder(): Promise<void> {
  const chosen = await window.api.system.chooseDirectory(model.dumpOutputDir || defaultDir.value)
  if (chosen) {
    model.dumpOutputDir = chosen
    folderProblem.value = ''
  }
}

/** Why the typed folder can't be used, if it can't. Empty while it's fine (or blank). */
const folderProblem = ref('')

/**
 * Rewrite the typed folder to the absolute path that will actually be stored, on blur.
 *
 * Showing the resolution rather than just accepting it: `~/Desktop/dumps` becomes
 * `/Users/you/Desktop/dumps` in the field, so what you'll get is what you can see. A path that
 * can't be resolved leaves the text alone and explains why, inline, instead of failing at save.
 */
async function normalizeFolder(): Promise<void> {
  const { path, problem } = await window.api.system.resolveDirectory(model.dumpOutputDir)
  folderProblem.value = problem ?? ''
  if (path) model.dumpOutputDir = path
}

const rules: FormRules = {
  name: { required: true, message: 'A name is required', trigger: ['blur', 'input'] },
  // Asked of the main process, which owns the rule the repository will enforce on write — so a
  // path that validates here cannot then be rejected on save.
  dumpOutputDir: {
    validator: async () => {
      const { problem } = await window.api.system.resolveDirectory(model.dumpOutputDir)
      folderProblem.value = problem ?? ''
      if (problem) throw new Error(problem)
    },
    trigger: ['blur']
  }
}

function toInput(): WorkspaceInput {
  return {
    name: model.name.trim(),
    dumpOutputMode: model.dumpOutputMode,
    // Always sent, including as `''` — that's how "reset to default" reaches the store, which
    // normalises blank to NULL. Omitting it would make clearing the field a no-op.
    dumpOutputDir: model.dumpOutputDir.trim(),
    dropExistingTables: model.dropExistingTables
  }
}

async function submit(): Promise<void> {
  try {
    await formRef.value?.validate()
  } catch {
    return // validation errors are shown inline
  }

  saving.value = true
  try {
    if (isEdit.value && props.workspace) {
      const updated = await workspaces.update(props.workspace.id, toInput())
      message.success(`Workspace "${updated?.name ?? model.name.trim()}" updated.`)
    } else {
      const created = await workspaces.create(toInput())
      message.success(`Workspace "${created.name}" created.`)
    }
    show.value = false
  } catch (err) {
    message.error(`Could not save workspace: ${(err as Error).message}`)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="isEdit ? 'Edit workspace' : 'New workspace'"
    :style="{ width: '460px', maxWidth: '92vw' }"
    :mask-closable="!saving"
  >
    <n-form ref="formRef" :model="model" :rules="rules" label-placement="top">
      <n-form-item label="Name" path="name">
        <n-input v-model:value="model.name" placeholder="e.g. Example Shop" />
      </n-form-item>
      <n-form-item label="Output mode" path="dumpOutputMode">
        <n-select v-model:value="model.dumpOutputMode" :options="outputModeOptions" />
      </n-form-item>
      <n-form-item label="Drop tables before creating them" path="dropExistingTables">
        <div class="drop">
          <n-switch v-model:value="model.dropExistingTables" />
          <n-text depth="3" class="drop__hint">
            Adds <code>DROP TABLE IF EXISTS</code> before each table, so the dump can be loaded over
            a previous load of itself. Turn it off if the target database holds other data you need
            to keep.
          </n-text>
        </div>
      </n-form-item>
      <n-form-item label="Dump folder" path="dumpOutputDir">
        <div class="folder">
          <div class="folder__row">
            <n-input
              v-model:value="model.dumpOutputDir"
              class="folder__path"
              :placeholder="defaultDir || 'Default'"
              clearable
              @blur="normalizeFolder"
              @update:value="folderProblem = ''"
            />
            <n-button @click="chooseFolder">Choose…</n-button>
          </div>
          <n-text v-if="folderProblem" type="error" class="folder__hint">
            {{ folderProblem }}
          </n-text>
          <n-text v-else depth="3" class="folder__hint">
            Leave empty to use the default. Use a full path, or <code>~</code> for your home folder.
            The folder is created if it doesn't exist yet.
          </n-text>
        </div>
      </n-form-item>
    </n-form>

    <template #footer>
      <div class="footer">
        <n-button :disabled="saving" @click="show = false">Cancel</n-button>
        <n-button type="primary" :loading="saving" @click="submit">
          {{ isEdit ? 'Save changes' : 'Create workspace' }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.drop {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
}

.drop__hint {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.4;
}

.folder {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.folder__row {
  display: flex;
  gap: 8px;
}

.folder__path {
  flex: 1;
  min-width: 0;
}

.folder__hint {
  font-size: 12px;
  line-height: 1.4;
}
</style>
