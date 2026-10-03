import type { ExtractApi } from '@shared/api'
import { registerHandlers } from './ipc-guard'
import { runExtract } from './extract/run'
import { inFlightRunIds, requestCancel } from './extract/cancel'
import { dumpDirectoryFor } from './dump-dir'
import { getWorkspace } from './config/repositories/workspaces'

/**
 * IPC surface for running an extract (spec §3). Kept separate from `config:*` and `source:*`
 * because a run spans the whole pipeline — config store, source DB, and the filesystem — and is
 * long-running. The renderer passes a connection id + workspace id; credentials are read from the
 * keychain inside the pipeline (via `withSourceAdapter`), never over IPC.
 */
const handlers: {
  [K in keyof ExtractApi]: (...args: Parameters<ExtractApi[K]>) => ReturnType<ExtractApi[K]>
} = {
  runExtract: async (connectionId, workspaceId) => runExtract(connectionId, workspaceId),
  // Deliberately synchronous work behind an async signature: aborting is setting a flag, and the
  // pipeline notices on its own schedule. Returning the ids signalled lets the caller distinguish
  // "stopped it" from "nothing was running".
  cancelRun: async (runId) => requestCancel(runId),
  runningRunIds: async () => inFlightRunIds(),
  // Resolved through the same helper the pipeline uses, so the folder the Runs screen opens is
  // always the folder the next run will write into. An unknown id falls back to the default rather
  // than throwing — the workspace form asks for this before the workspace exists.
  dumpDirectory: async (workspaceId) =>
    dumpDirectoryFor((workspaceId ? getWorkspace(workspaceId) : undefined) ?? {})
}

export function registerExtractIpc(): void {
  registerHandlers('extract', handlers)
}
