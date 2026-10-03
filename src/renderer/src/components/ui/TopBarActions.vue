<script setup lang="ts">
/**
 * Puts a page's actions into the app's top bar (right-hand side, before the Run button). `defer`
 * waits for the shell to have rendered the target, so it works on first load as well as navigation.
 */
</script>

<template>
  <Teleport to="#topbar-actions" defer>
    <slot />
  </Teleport>
</template>
