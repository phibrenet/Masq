import { stat } from 'fs/promises'
import { BrowserWindow, clipboard, dialog, shell } from 'electron'
import type { SystemApi } from '@shared/api'
import { registerHandlers } from './ipc-guard'
import { normalizeDumpDir } from './dump-dir'
import { TITLE_BAR_COLORS, TITLE_BAR_HEIGHT } from './title-bar'

/**
 * IPC for the things only the OS can do: the clipboard, the file manager, and a native folder
 * picker. Separate from `config:*`, `source:*` and `extract:*` because none of it touches a
 * database — it's the desktop shell, and grouping it keeps those three about data.
 *
 * Why the clipboard goes through IPC at all, rather than `navigator.clipboard` in the renderer:
 * that API needs a secure context, which a packaged app loading over `file://` is not guaranteed to
 * be. Electron's `clipboard` works identically in dev and packaged, so a copy button can't work on
 * one and silently fail on the other.
 */
const handlers: {
  [K in keyof SystemApi]: (...args: Parameters<SystemApi[K]>) => ReturnType<SystemApi[K]>
} = {
  copyText: async (text) => {
    clipboard.writeText(text)
  },

  /**
   * Open a **directory** in the OS file manager.
   *
   * Directories only, and checked rather than trusted: `shell.openPath` on a file asks the OS to
   * *open* it with its default handler, which for a `.exe`/`.command` means executing it. Nothing
   * in this app passes anything but a dump folder, so the guard costs nothing — but "the renderer
   * can ask the main process to launch an arbitrary path" is the kind of gap that only needs to be
   * true once. Use `showItemInFolder` for files; it reveals, never runs.
   */
  openPath: async (path) => {
    try {
      const info = await stat(path)
      if (!info.isDirectory()) return 'That path is not a folder.'
    } catch {
      return "That folder doesn't exist yet — it's created when a dump is written."
    }
    // Returns '' on success and an error string otherwise, which is already the contract here.
    return shell.openPath(path)
  },

  showItemInFolder: async (path) => {
    shell.showItemInFolder(path)
  },

  /**
   * Native folder picker, resolving to the chosen path or `null` if dismissed.
   *
   * Modal to the focused window so it can't be lost behind the app. `defaultPath` seeds it at the
   * current setting, so re-picking starts where the last choice left off rather than at home.
   */
  chooseDirectory: async (current) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      properties: ['openDirectory', 'createDirectory'] as Array<
        'openDirectory' | 'createDirectory'
      >,
      ...(current ? { defaultPath: current } : {})
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  },

  // Same function the workspace repository enforces on write, so what the form previews is exactly
  // what will be stored — there is no second implementation to drift.
  resolveDirectory: async (input) => normalizeDumpDir(input),

  /**
   * Recolour the window-controls overlay to match the Appearance. macOS draws traffic lights over
   * any background and has no overlay to recolour, so it's a no-op there.
   */
  setTitleBarTheme: async (dark) => {
    if (process.platform === 'darwin') return
    const colors = dark ? TITLE_BAR_COLORS.dark : TITLE_BAR_COLORS.light
    for (const window of BrowserWindow.getAllWindows()) {
      window.setTitleBarOverlay({ ...colors, height: TITLE_BAR_HEIGHT })
      window.setBackgroundColor(colors.color)
    }
  }
}

export function registerSystemIpc(): void {
  registerHandlers('system', handlers)
}
