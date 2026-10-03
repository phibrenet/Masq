import { homedir } from 'os'
import { isAbsolute, join, normalize } from 'path'
import { app } from 'electron'
import type { Workspace } from '@shared/types'

/**
 * Resolving a workspace's dump folder — the one place a configured path becomes a real one.
 *
 * A folder can be typed as well as picked (pasting a path from elsewhere is worth keeping), and
 * typed text is where the hazards are. A **relative** path like `dumps` resolves against
 * `process.cwd()`, which for a packaged app launched from Finder or the Start menu is not the
 * project directory and is often not writable — so the dump lands somewhere nobody would look, or
 * the run fails at the last step. A leading `~` is shell syntax, not filesystem syntax: Node would
 * create a directory *literally named* `~` in that same unpredictable place.
 *
 * So exactly one shorthand is supported and everything else must be absolute.
 */

/** The fallback: inside the app's own support directory. */
export function defaultDumpDir(): string {
  return join(app.getPath('userData'), 'dumps')
}

export interface NormalizedDumpDir {
  /** The absolute folder. Absent for blank input (which means "use the default") or a problem. */
  path?: string
  /** Why the input was rejected, phrased for the person who typed it. */
  problem?: string
}

/**
 * Turn configured text into an absolute path, or say why it can't be one.
 *
 * Blank is not an error — it's how "use the default" is stored (see migration 011).
 */
export function normalizeDumpDir(value: string | undefined): NormalizedDumpDir {
  const raw = value?.trim()
  if (!raw) return {}

  // `~` and `~/…` only. `~someone/…` is another user's home, which the shell resolves from the
  // password database and Node has no business guessing at.
  const expanded =
    raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
      ? join(homedir(), raw.slice(1))
      : raw

  if (!isAbsolute(expanded)) {
    return {
      problem:
        'Enter a full path (starting with / or a drive letter), or ~ for your home folder — ' +
        'a relative path is resolved against wherever the app happens to be running from.'
    }
  }
  return { path: normalize(expanded) }
}

/**
 * Where this workspace's dumps go: its own folder if it has a usable one, the default otherwise.
 *
 * The single place that decision is made — the pipeline picks the folder with it and the Runs screen
 * displays the folder with it, so what the button opens is always what the next run writes to.
 *
 * A stored value that *isn't* absolute falls back to the default rather than being resolved against
 * the working directory. Writing is only reachable through the repository, which rejects those, so
 * this only fires for a hand-edited config store — and the Runs screen reads through this same
 * function, so it shows the default too. Consistently wrong-but-visible beats silently writing
 * somewhere nobody can find.
 */
export function dumpDirectoryFor(workspace: Pick<Workspace, 'dumpOutputDir'>): string {
  return normalizeDumpDir(workspace.dumpOutputDir).path ?? defaultDumpDir()
}
