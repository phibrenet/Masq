<script setup lang="ts">
import { computed } from 'vue'
import {
  darkTheme,
  lightTheme,
  NConfigProvider,
  NDialogProvider,
  NGlobalStyle,
  NMessageProvider
} from 'naive-ui'
import AppShell from '@renderer/components/AppShell.vue'
import { useThemeStore } from '@renderer/stores/theme'
import { naiveOverrides } from '@renderer/theme/naive'

// Dark by default; `system` still tracks the OS. Lives in a store so the sidebar's switcher and this
// provider read one source of truth, and so the choice is resolved synchronously at first paint —
// deciding it here from an async source would flash the wrong theme.
const themeStore = useThemeStore()
const theme = computed(() => (themeStore.isDark ? darkTheme : lightTheme))

// Re-read whenever the theme flips: the store has already switched `<html data-theme>`, so the
// tokens resolve to the new set.
const themeOverrides = computed(() => {
  void themeStore.isDark
  return naiveOverrides()
})
</script>

<template>
  <n-config-provider :theme="theme" :theme-overrides="themeOverrides">
    <!--
      Paints the theme's background and text colour onto `body`. Without it naive-ui only themes its
      own components: the layout looked correct but `document.body` stayed white underneath, which
      shows as a white flash before Vue mounts and at scroll overscroll. Verified by asserting the
      computed body background is actually dark, not by trusting the switcher's label.
    -->
    <n-global-style />
    <n-message-provider>
      <n-dialog-provider>
        <!-- Inside the providers, so the shell (top bar Run button, sidebar) can use messages and dialogs. -->
        <AppShell />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
