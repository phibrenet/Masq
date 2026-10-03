import { useMessage } from 'naive-ui'
import type { Run } from '@shared/types'
import { useRunsStore } from '@renderer/stores/runs'

/** Total rows written across all tables in a run. */
export function totalRows(run: Run): number {
  if (!run.rowCounts) return 0
  return Object.values(run.rowCounts).reduce((sum, n) => sum + n, 0)
}

/**
 * Start an extract and report the outcome. Shared by the top bar's Run button and the Runs screen, so
 * both say the same thing whichever one started it.
 */
export function useRunExtract(): { runExtract: () => Promise<void> } {
  const runs = useRunsStore()
  const message = useMessage()

  async function runExtract(): Promise<void> {
    try {
      const result = await runs.run()
      if (result.status === 'completed') {
        message.success(`Dump complete — ${totalRows(result).toLocaleString()} rows written.`)
      } else if (result.errorMessage?.startsWith('Cancelled')) {
        message.info('Run stopped. No dump was written.')
      } else {
        message.error(`Run failed: ${result.errorMessage ?? 'unknown error'}`)
      }
    } catch (err) {
      message.error(`Could not run extract: ${(err as Error).message}`)
    }
  }

  return { runExtract }
}
