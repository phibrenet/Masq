import { app, shell, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { runMigrations } from './config/migrate'
import { markInterruptedRuns } from './config/repositories/runs'
import { seedIfEmpty } from './config/seed'
import { registerConfigIpc } from './ipc'
import { registerSourceIpc } from './source-ipc'
import { registerExtractIpc } from './extract-ipc'
import { registerSystemIpc } from './system-ipc'
import { isAppUrl } from './ipc-guard'
import { TITLE_BAR_COLORS, TITLE_BAR_HEIGHT } from './title-bar'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    // The Tables screen's four-way class selector has an intrinsic width; measured, the rows start
    // overflowing horizontally below ~860. Rows already wrap the controls under the table name
    // before that point, so this is only the floor at which wrapping stops being enough.
    minWidth: 880,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Frameless: the renderer draws its own 40px top bar (drag region + breadcrumb + actions), and
    // the OS keeps only its window controls — traffic lights on macOS, an overlay elsewhere. Colours
    // match the `--bg` token; `system:setTitleBarTheme` swaps them when the Appearance changes.
    backgroundColor: TITLE_BAR_COLORS.dark.color,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 12 } }
      : { titleBarOverlay: { ...TITLE_BAR_COLORS.dark, height: TITLE_BAR_HEIGHT } }),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The preload only needs `contextBridge` and `ipcRenderer`, both available sandboxed.
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Links leave the app for the user's browser, and only web links: `openExternal` hands a URL to
  // whatever the OS has registered for its scheme, which for `file:` or a custom scheme can mean
  // launching a program.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:/i.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // The window only ever shows the app. Anything else loaded into it would inherit the preload's
  // API, and with it the keychain and the source databases.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })

  // Electron ships no default context menu, so text inputs get no right-click
  // cut/copy/paste. Provide a minimal editing menu, driven by the target's edit
  // flags so items only appear when they apply (e.g. paste on editable fields).
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const { editFlags, isEditable, selectionText } = params
    const hasSelection = selectionText.trim().length > 0
    if (!isEditable && !hasSelection) return

    const template: MenuItemConstructorOptions[] = []
    if (isEditable) template.push({ role: 'cut', enabled: editFlags.canCut })
    template.push({ role: 'copy', enabled: editFlags.canCopy })
    if (isEditable) template.push({ role: 'paste', enabled: editFlags.canPaste })
    if (isEditable && editFlags.canSelectAll) {
      template.push({ type: 'separator' }, { role: 'selectAll' })
    }

    Menu.buildFromTemplate(template).popup({ window: mainWindow })
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// One process owns the config store: startup marks every `running` run as interrupted, which is
// only true if no other instance is mid-extract. A second launch hands over to the first and quits.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  app.whenReady().then(startApp)
}

function startApp(): void {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.masq.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Config store: apply migrations, seed on first run, then expose the IPC surface —
  // all before the first window loads so the renderer can query immediately.
  runMigrations()
  // Any run still marked `running` belongs to a previous session that died mid-extract — the
  // single-instance lock means this process owns the store, so nothing can legitimately be in
  // flight before the first window opens. Close them out or the history keeps a run that never ends.
  const interrupted = markInterruptedRuns()
  if (interrupted > 0) {
    console.log(`[config] closed ${interrupted} run(s) interrupted by a previous session`)
  }
  seedIfEmpty()
  registerConfigIpc()
  registerSourceIpc()
  registerExtractIpc()
  registerSystemIpc()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
