<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NButton } from 'naive-ui'

/**
 * Shown in place of a silent empty list when a screen's saved configuration couldn't be read.
 * Takes every store the screen depends on, so one alert covers the lot and one retry reloads them.
 */
const props = defineProps<{ errors: (string | null)[] }>()
const emit = defineEmits<{ retry: [] }>()

const messages = computed(() => [...new Set(props.errors.filter((e): e is string => !!e))])
</script>

<template>
  <n-alert
    v-if="messages.length > 0"
    type="error"
    title="Couldn't load this screen"
    class="load-error"
  >
    <p v-for="text in messages" :key="text" class="load-error__text">{{ text }}</p>
    <n-button size="small" @click="emit('retry')">Retry</n-button>
  </n-alert>
</template>

<style scoped>
.load-error {
  margin-bottom: 16px;
}

.load-error__text {
  margin: 0 0 8px;
}
</style>
