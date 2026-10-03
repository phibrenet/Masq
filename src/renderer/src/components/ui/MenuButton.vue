<script setup lang="ts">
import { computed, h } from 'vue'
import { NDropdown, type DropdownOption } from 'naive-ui'
import AppIcon from './AppIcon.vue'

/**
 * A `⋯` button that opens a menu of actions. Destructive items render in the danger colour; a
 * `divider` item separates groups. Pass a `#trigger` slot to open the menu from something else.
 */
export interface MenuItem {
  key: string
  label?: string
  danger?: boolean
  disabled?: boolean
  divider?: boolean
  /** Marks the current choice in a list of choices (e.g. the active workspace). */
  checked?: boolean
  title?: string
}

const props = defineProps<{ items: MenuItem[]; label?: string; placement?: string }>()
const emit = defineEmits<{ select: [key: string] }>()

const options = computed<DropdownOption[]>(() =>
  props.items.map((item) =>
    item.divider
      ? { type: 'divider', key: item.key }
      : {
          key: item.key,
          disabled: item.disabled,
          icon:
            item.checked === undefined
              ? undefined
              : () =>
                  h(AppIcon, { name: 'check', size: 14, style: item.checked ? '' : 'opacity: 0' }),
          label: () =>
            h(
              'span',
              { class: item.danger ? 'menu-item--danger' : undefined, title: item.title },
              item.label
            )
        }
  )
)
</script>

<template>
  <n-dropdown
    trigger="click"
    :options="options"
    :placement="(placement as 'bottom-end') ?? 'bottom-end'"
    size="small"
    @select="(key: string) => emit('select', key)"
  >
    <slot name="trigger">
      <button type="button" class="menu-btn" :aria-label="label ?? 'More actions'" :title="label">
        <AppIcon name="more" :size="16" :stroke-width="3" />
      </button>
    </slot>
  </n-dropdown>
</template>

<style scoped>
.menu-btn {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: rgb(var(--fg-muted));
  cursor: pointer;
  transition:
    background-color 150ms,
    color 150ms;
}

.menu-btn:hover {
  background: rgb(var(--line) / 0.06);
  color: rgb(var(--fg));
}
</style>

<!-- The dropdown renders in a teleported layer, outside this component's scope. -->
<style>
.menu-item--danger {
  color: rgb(var(--danger));
}
</style>
