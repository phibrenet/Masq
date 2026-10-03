import { defineStore } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'

/** What the user chose. `system` follows the OS; the other two override it. */
export type ThemePreference = 'dark' | 'light' | 'system'

/**
 * The default. **Dark, not `system`** — a deliberate product choice: Masq is a developer tool that
 * sits alongside a terminal and an editor, and dark is the expected surface there. `system` remains
 * available for anyone who wants the app to track their OS.
 */
const DEFAULT_PREFERENCE: ThemePreference = 'dark'

/**
 * `localStorage`, not the config store. This is a per-machine UI preference, not project data: it
 * isn't workspace-scoped, nobody shares it with a teammate, and putting it in `config.sqlite3` would
 * mean a migration, a repository, an IPC channel and a store for one enum. It also has to be readable
 * *synchronously* at first paint — an async IPC round-trip would show a flash of the wrong theme.
 */
const STORAGE_KEY = 'masq.theme'

function readStored(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'dark' || raw === 'light' || raw === 'system') return raw
  } catch {
    // Private-mode / disabled storage: fall through to the default rather than failing to boot.
  }
  return DEFAULT_PREFERENCE
}

/**
 * Light/dark preference for the app shell. Exposes `isDark`, which is what `App.vue` feeds to naive-ui,
 * and resolves `system` against `prefers-color-scheme` reactively so a mid-session OS switch is
 * picked up.
 */
export const useThemeStore = defineStore('theme', () => {
  const preference = ref<ThemePreference>(readStored())

  // One media-query listener for the store's lifetime, regardless of preference — cheaper than
  // attaching and detaching it as the choice changes, and it keeps `systemPrefersDark` always valid.
  const systemPrefersDark = ref(false)
  let mq: MediaQueryList | undefined
  const onSystemChange = (e: MediaQueryListEvent): void => {
    systemPrefersDark.value = e.matches
  }
  if (typeof window !== 'undefined' && window.matchMedia) {
    mq = window.matchMedia('(prefers-color-scheme: dark)')
    systemPrefersDark.value = mq.matches
    mq.addEventListener('change', onSystemChange)
  }
  onUnmounted(() => mq?.removeEventListener('change', onSystemChange))

  const isDark = computed(() =>
    preference.value === 'system' ? systemPrefersDark.value : preference.value === 'dark'
  )

  // The CSS tokens switch on `<html data-theme>`, and naive-ui's overrides are read from them — so the
  // attribute must change *before* anything re-reads them. `sync` makes it land in the same tick as
  // the preference change; the native window controls follow asynchronously.
  watch(
    isDark,
    (dark) => {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      window.api?.system.setTitleBarTheme(dark).catch(() => {})
    },
    { immediate: true, flush: 'sync' }
  )

  function setPreference(next: ThemePreference): void {
    preference.value = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Not fatal — the choice just won't survive a restart.
    }
  }

  return { preference, isDark, systemPrefersDark, setPreference }
})
