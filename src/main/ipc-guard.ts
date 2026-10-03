import { join } from 'path'
import { pathToFileURL } from 'url'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'

/**
 * Is `url` the app's own renderer document? The dev server in development, the bundled
 * `index.html` when packaged — hash routing keeps every screen on that one document.
 */
export function isAppUrl(url: string): boolean {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devUrl) return new URL(url).origin === new URL(devUrl).origin
  const indexUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href
  return url === indexUrl || url.startsWith(`${indexUrl}#`)
}

/**
 * Register a namespace of `ipcMain.handle` channels, refusing any caller that isn't the app's own
 * top-level document. These channels read the keychain and reach production databases, so a frame
 * or page that ended up in the window some other way (an iframe, a navigation the window didn't
 * block) must not be able to use them.
 */
export function registerHandlers(prefix: string, handlers: object): void {
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`${prefix}:${name}`, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const frame = event.senderFrame
      if (!frame || frame !== event.sender.mainFrame || !isAppUrl(frame.url)) {
        throw new Error(`Refused ${prefix}:${name} from an unexpected sender.`)
      }
      return (handler as (...a: unknown[]) => unknown)(...args)
    })
  }
}
