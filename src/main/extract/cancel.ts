import type { DbAdapter } from '../adapters'

/**
 * Run cancellation. An extract can take a long time — a rule that seeds a few hundred rows in a
 * well-connected schema cascades into most of the database — and until this existed the only way to
 * stop one was to quit the app, which stranded the `runs` row as `running` forever.
 *
 * **Cooperative, via one wrapper rather than a signal threaded through every stage.** Every
 * long-running thing the pipeline does goes through the `DbAdapter`, so `withCancellation` returns a
 * proxy that checks the signal before each call. That covers selection, cascade, backfill and the
 * dump writer without changing a single stage's signature — and it means cancellation lands within
 * one query rather than at some coarser checkpoint.
 *
 * **Two gaps the proxy alone can't close**, both of which are "one call, lots of work":
 *
 * 1. `streamRows` is checked when its iterator is *created*, then yields for as long as the table is
 *    big. The dump writer's row loop calls `throwIfCancelled` per row.
 * 2. The **internally chunked** methods (`getRowsReferencing`, `getReferencedIds`, `getExistingIds`
 *    and their morph variants) slice a large id set into `IN (…)` chunks and run one query per chunk
 *    inside a single call. A cascade over a few hundred thousand ids therefore issues *hundreds* of
 *    queries between two proxy checks — long enough that Stop looked broken. `withCancellation` sets
 *    `adapter.cancellationSignal` so those loops can check per chunk.
 */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled.')
    this.name = 'CancelledError'
  }
}

/** Controllers for runs currently in flight, keyed by run id. Normally holds zero or one. */
const inFlight = new Map<string, AbortController>()

/** Register a starting run and get the signal its pipeline should honour. */
export function registerRun(runId: string): AbortSignal {
  const controller = new AbortController()
  inFlight.set(runId, controller)
  return controller.signal
}

/** Drop a finished run's controller, however it finished. Always call this in a `finally`. */
export function unregisterRun(runId: string): void {
  inFlight.delete(runId)
}

/**
 * Ask a run to stop, or every in-flight run when `runId` is omitted. Returns the ids actually
 * signalled — empty means there was nothing running, which the caller reports rather than treating
 * as an error (a run that finished a moment ago is not a failure to cancel).
 *
 * Cancelling is a *request*: the pipeline stops at its next adapter call or row. It does not kill
 * an in-flight query, so a cancel during one long `ORDER BY RAND()` waits for that query to return.
 */
export function requestCancel(runId?: string): string[] {
  const targets = runId ? [runId] : [...inFlight.keys()]
  const cancelled: string[] = []
  for (const id of targets) {
    const controller = inFlight.get(id)
    if (!controller) continue
    controller.abort()
    cancelled.push(id)
  }
  return cancelled
}

/** Ids of runs currently in flight — what the renderer polls to decide whether to offer a Stop. */
export function inFlightRunIds(): string[] {
  return [...inFlight.keys()]
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError()
}

/**
 * Wrap an adapter so every method checks the signal first. See the module note: this is what makes
 * cancellation reach every stage without threading a parameter through all of them.
 */
export function withCancellation(adapter: DbAdapter, signal: AbortSignal): DbAdapter {
  // Set on the target as well as proxied: the chunked methods run many queries inside one call and
  // consult this directly, because the proxy only gets a look in between calls. `withSourceAdapter`
  // builds a fresh adapter per run, so this can't leak across runs.
  adapter.cancellationSignal = signal
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        throwIfCancelled(signal)
        // Bound to `target`, not the proxy: the adapters call their own private helpers
        // (`primaryKeyColumn`, the pk cache) internally, and routing those back through the proxy
        // would re-check pointlessly on every hop.
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    }
  })
}
