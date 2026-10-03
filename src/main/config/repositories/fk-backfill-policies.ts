import { randomUUID } from 'crypto'
import type { BackfillPolicyKind, FkBackfillPolicy } from '@shared/types'
import { getDb } from '../db'

/**
 * Per-edge backfill policies (migration 009): the declared exceptions to "parent backfill follows
 * every foreign key". One per (workspace, table, column); absence means `follow`.
 *
 * `setFkBackfillPolicy` upserts on the unique constraint so re-deciding an edge replaces rather than
 * errors, and `deleteFkBackfillPolicy` is how the UI resets an edge to the default — which is why
 * the table holds only deliberate exceptions rather than a row per edge in the schema. Mirrors
 * `table-identity-sources` and `table-locale-sources` deliberately: same shape of per-key declaration,
 * so the three read the same way.
 *
 * **Nullability is not validated here.** Whether a column can hold NULL lives in the *source* schema,
 * which this store has no connection to. The UI introspects and disables the option, and `run.ts`
 * re-checks at extract time and downgrades an unsafe policy to `follow` with a warning — so a policy
 * saved against a column that later became NOT NULL degrades instead of producing an unloadable dump.
 */

interface FkBackfillPolicyRow {
  id: string
  workspace_id: string
  table_name: string
  column_name: string
  policy: BackfillPolicyKind
}

function toFkBackfillPolicy(row: FkBackfillPolicyRow): FkBackfillPolicy {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tableName: row.table_name,
    columnName: row.column_name,
    policy: row.policy
  }
}

export type FkBackfillPolicyInput = Omit<FkBackfillPolicy, 'id'>

export function listFkBackfillPoliciesByWorkspace(workspaceId: string): FkBackfillPolicy[] {
  return (
    getDb()
      .prepare(
        'SELECT * FROM fk_backfill_policies WHERE workspace_id = ? ORDER BY table_name, column_name'
      )
      .all(workspaceId) as FkBackfillPolicyRow[]
  ).map(toFkBackfillPolicy)
}

export function setFkBackfillPolicy(input: FkBackfillPolicyInput): FkBackfillPolicy {
  const table = input.tableName.trim()
  const column = input.columnName.trim()
  // An edge is identified by both halves; a half-declared policy would silently apply to nothing.
  if (!table || !column) {
    throw new Error('A backfill policy needs both a table and a column.')
  }
  getDb()
    .prepare(
      `INSERT INTO fk_backfill_policies (id, workspace_id, table_name, column_name, policy)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, table_name, column_name)
         DO UPDATE SET policy = excluded.policy`
    )
    .run(randomUUID(), input.workspaceId, table, column, input.policy)
  const row = getDb()
    .prepare(
      'SELECT * FROM fk_backfill_policies WHERE workspace_id = ? AND table_name = ? AND column_name = ?'
    )
    .get(input.workspaceId, table, column) as FkBackfillPolicyRow
  return toFkBackfillPolicy(row)
}

export function deleteFkBackfillPolicy(id: string): void {
  getDb().prepare('DELETE FROM fk_backfill_policies WHERE id = ?').run(id)
}
