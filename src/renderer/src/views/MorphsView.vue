<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, useDialog, useMessage } from 'naive-ui'
import type { MorphCandidate, MorphRelation } from '@shared/types'
import MorphRelationFormModal from '@renderer/components/MorphRelationFormModal.vue'
import { useMorphRelationsStore } from '@renderer/stores/morphRelations'
import { useDiscoveryStore } from '@renderer/stores/discovery'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import LoadErrorAlert from '@renderer/components/LoadErrorAlert.vue'
import AppIcon from '@renderer/components/ui/AppIcon.vue'
import EmptyState from '@renderer/components/ui/EmptyState.vue'
import MenuButton from '@renderer/components/ui/MenuButton.vue'
import SkeletonRows from '@renderer/components/ui/SkeletonRows.vue'
import TopBarActions from '@renderer/components/ui/TopBarActions.vue'
import UiBadge from '@renderer/components/ui/UiBadge.vue'
import UiPanel from '@renderer/components/ui/UiPanel.vue'

/**
 * Polymorphic relations screen (docs/polymorphic-cascade.md). Two halves, in the order the workflow
 * runs:
 *
 * 1. **Declared** — what this workspace has opted into. Only declared relations affect a dump.
 * 2. **Detected** — suggestions from introspection that aren't declared yet, each one click from
 *    being confirmed with its guessed type→table map prefilled.
 *
 * Nothing here changes extract behaviour on its own: the engine reads these in stages 2–3 of the
 * plan. Declaring is safe and inert until then.
 */
const morphs = useMorphRelationsStore()
const discovery = useDiscoveryStore()
const workspace = useWorkspaceStore()
const message = useMessage()
const dialog = useDialog()

const showModal = ref(false)
const editing = ref<MorphRelation | null>(null)
const confirming = ref<MorphCandidate | null>(null)

const hasWorkspace = computed(() => !!workspace.currentWorkspaceId)
const hasSource = computed(() => !!discovery.sourceConnection)

/** Declared relations grouped by table, so a table with two morphs reads as one block. */
const grouped = computed(() => {
  const byTable = new Map<string, MorphRelation[]>()
  for (const relation of morphs.list) {
    const arr = byTable.get(relation.tableName) ?? []
    arr.push(relation)
    byTable.set(relation.tableName, arr)
  }
  return [...byTable.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tableName, relations]) => ({
      tableName,
      // `unmapped` is resolved once here rather than called from the template, which would re-run it
      // for every tag on every render.
      entries: relations.map((relation) => ({
        relation,
        unmapped: morphs.unmappedValuesFor(relation)
      }))
    }))
})

function openCreate(): void {
  editing.value = null
  confirming.value = null
  showModal.value = true
}

function openEdit(relation: MorphRelation): void {
  editing.value = relation
  confirming.value = null
  showModal.value = true
}

function openConfirm(candidate: MorphCandidate): void {
  editing.value = null
  confirming.value = candidate
  showModal.value = true
}

async function detect(): Promise<void> {
  try {
    const found = await morphs.detect()
    message.success(
      found === 0
        ? 'No polymorphic column pairs found in the source.'
        : `Found ${found} polymorphic relation${found === 1 ? '' : 's'} in the source.`
    )
  } catch (err) {
    message.error(`Detection failed: ${(err as Error).message}`)
  }
}

function confirmDelete(relation: MorphRelation): void {
  dialog.warning({
    title: 'Remove morph relation',
    content: `Stop following ${relation.tableName}.${relation.typeColumn}? Its type map will be deleted too, and the relation goes back to being ignored by extracts.`,
    positiveText: 'Remove',
    negativeText: 'Cancel',
    onPositiveClick: async () => {
      try {
        await morphs.remove(relation.id)
        message.success('Morph relation removed.')
      } catch (err) {
        message.error(`Could not remove relation: ${(err as Error).message}`)
      }
    }
  })
}

function onMenu(relation: MorphRelation, key: string): void {
  if (key === 'delete') confirmDelete(relation)
}

/** Toggle one direction from the list without opening the modal — the map is left untouched. */
async function toggle(relation: MorphRelation, key: 'cascadeDown' | 'backfillUp'): Promise<void> {
  try {
    await morphs.update(relation.id, { [key]: !relation[key] })
  } catch (err) {
    message.error(`Could not update relation: ${(err as Error).message}`)
  }
}

/** Reload everything this screen reads; failures stay on each store's `loadError`. */
function retryLoad(): void {
  const id = workspace.currentWorkspaceId
  if (!id) return
  morphs.loadForWorkspace(id).catch(() => {})
}
</script>

<template>
  <section class="page">
    <TopBarActions>
      <n-button size="small" secondary :disabled="!hasWorkspace" @click="openCreate">
        <template #icon><AppIcon name="plus" :size="14" /></template>
        Declare relation
      </n-button>
    </TopBarActions>

    <header class="page-header">
      <h1 class="page-title">Polymorphic relations</h1>
      <p class="page-desc">
        Some tables link to rows in several other tables, using one column to say which table
        (<code>*_type</code>) and another to say which row (<code>*_id</code>). The database has no
        foreign key for these links, so Masq can't follow them on its own. Declare the ones you want
        followed.
      </p>
    </header>

    <div class="toolbar">
      <n-button
        size="small"
        :disabled="!hasWorkspace || !hasSource"
        :loading="morphs.detecting"
        @click="detect"
      >
        <template #icon><AppIcon name="search" :size="14" /></template>
        Detect from source
      </n-button>
    </div>

    <LoadErrorAlert :errors="[morphs.loadError]" @retry="retryLoad" />

    <p v-if="!hasSource" class="note">
      <AppIcon name="info" :size="14" />
      This workspace has no source connection, so detection is unavailable — you can still declare a
      relation by hand.
    </p>

    <!-- Declared -->
    <h2 class="section-title">
      Declared <span class="num">({{ morphs.list.length }})</span>
    </h2>

    <SkeletonRows v-if="morphs.loading && grouped.length === 0" :rows="3" />

    <EmptyState
      v-else-if="grouped.length === 0"
      icon="morphs"
      title="No polymorphic relations declared"
      description="Extracts ignore every morph column until one is declared."
    >
      <n-button
        v-if="hasSource"
        type="primary"
        size="small"
        :loading="morphs.detecting"
        @click="detect"
      >
        Detect from source
      </n-button>
      <n-button size="small" :disabled="!hasWorkspace" @click="openCreate"
        >Declare by hand</n-button
      >
    </EmptyState>

    <div v-else class="groups">
      <UiPanel v-for="group in grouped" :key="group.tableName">
        <template #header>
          <span class="mono group__table">{{ group.tableName }}</span>
        </template>

        <div v-for="entry in group.entries" :key="entry.relation.id" class="ui-row relation">
          <div class="relation__main">
            <div class="relation__cols mono">
              <span>{{ entry.relation.typeColumn }}</span>
              <span class="text-subtle">+</span>
              <span>{{ entry.relation.idColumn }}</span>
              <button
                type="button"
                class="dir"
                :aria-pressed="entry.relation.cascadeDown"
                title="Follow this relation down (keep the rows it points at)"
                @click="toggle(entry.relation, 'cascadeDown')"
              >
                <UiBadge :tone="entry.relation.cascadeDown ? 'ok' : 'muted'" variant="outline">
                  down {{ entry.relation.cascadeDown ? 'on' : 'off' }}
                </UiBadge>
              </button>
              <button
                type="button"
                class="dir"
                :aria-pressed="entry.relation.backfillUp"
                title="Follow this relation up (backfill the rows pointing here)"
                @click="toggle(entry.relation, 'backfillUp')"
              >
                <UiBadge :tone="entry.relation.backfillUp ? 'ok' : 'muted'" variant="outline">
                  up {{ entry.relation.backfillUp ? 'on' : 'off' }}
                </UiBadge>
              </button>
              <UiBadge v-if="entry.relation.typeMap.length === 0" tone="warn">
                no mappings — resolves to nothing
              </UiBadge>
            </div>
            <div v-if="entry.relation.typeMap.length > 0" class="relation__map">
              <UiBadge v-for="mapping in entry.relation.typeMap" :key="mapping.typeValue">
                <span class="mono map">{{ mapping.typeValue }} → {{ mapping.targetTable }}</span>
              </UiBadge>
            </div>
            <!-- Config drift: values the source is writing that this relation doesn't map. The
                 engine logs and skips an unmapped edge, so the reference would dangle silently. -->
            <div v-if="entry.unmapped.length > 0" class="relation__drift">
              <span class="drift-note">
                {{ entry.unmapped.length }} new type value{{
                  entry.unmapped.length === 1 ? '' : 's'
                }}
                found in the source, not mapped — the extract will skip
                {{ entry.unmapped.length === 1 ? 'it' : 'them' }}:
              </span>
              <div class="relation__map">
                <UiBadge v-for="value in entry.unmapped" :key="value.typeValue" tone="warn">
                  <span class="mono map">
                    {{ value.typeValue }} → {{ value.guessedTable ?? 'pick a table' }}
                  </span>
                </UiBadge>
              </div>
            </div>
          </div>
          <span class="relation__actions">
            <n-button
              quaternary
              size="tiny"
              :type="entry.unmapped.length > 0 ? 'warning' : 'default'"
              @click="openEdit(entry.relation)"
            >
              Edit
            </n-button>
            <MenuButton
              :items="[{ key: 'delete', label: 'Remove…', danger: true }]"
              label="More actions for this relation"
              @select="(key) => onMenu(entry.relation, key)"
            />
          </span>
        </div>
      </UiPanel>
    </div>

    <!-- Detected but not declared -->
    <template v-if="morphs.undeclaredCandidates.length > 0">
      <div class="page-header">
        <h2 class="section-title">
          Detected in the source
          <span class="num">({{ morphs.undeclaredCandidates.length }} not declared)</span>
        </h2>
        <p class="page-desc">
          Suggestions only — these are ignored until declared. Target tables are best guesses,
          validated against the real table list.
        </p>
      </div>

      <UiPanel>
        <div
          v-for="candidate in morphs.undeclaredCandidates"
          :key="`${candidate.tableName}.${candidate.typeColumn}`"
          class="ui-row relation"
        >
          <div class="relation__main">
            <div class="relation__cols mono">
              <span class="group__table">{{ candidate.tableName }}</span>
              <span class="text-subtle">·</span>
              <span>{{ candidate.typeColumn }}</span>
              <span class="text-subtle">+</span>
              <span>{{ candidate.idColumn }}</span>
            </div>
            <div v-if="candidate.typeValues.length > 0" class="relation__map">
              <UiBadge
                v-for="value in candidate.typeValues"
                :key="value.typeValue"
                :tone="value.guessedTable ? 'muted' : 'warn'"
              >
                <span class="mono map">
                  {{ value.typeValue }} → {{ value.guessedTable ?? 'pick a table' }}
                </span>
              </UiBadge>
            </div>
            <span v-else class="empty-note">No type values present in the data yet.</span>
          </div>
          <span class="relation__actions">
            <n-button size="small" secondary @click="openConfirm(candidate)">Declare</n-button>
          </span>
        </div>
      </UiPanel>
    </template>

    <morph-relation-form-modal
      v-model:show="showModal"
      :relation="editing"
      :candidate="confirming"
    />
  </section>
</template>

<style scoped>
.note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-control);
  background: rgb(var(--surface-1));
  color: rgb(var(--fg-muted));
  font-size: 13px;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.group__table {
  font-weight: 500;
  color: rgb(var(--fg));
}

.relation {
  align-items: flex-start;
  padding-top: 10px;
  padding-bottom: 10px;
}

.relation__main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.relation__cols {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.relation__map {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.relation__drift {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.drift-note {
  font-size: 12px;
  color: rgb(var(--warn));
}

.empty-note {
  font-size: 12px;
  color: rgb(var(--fg-muted));
}

.map {
  font-size: 11.5px;
}

.dir {
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.relation__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
</style>
