import { afterEach, describe, expect, it } from 'vitest'
import type { Knex } from 'knex'
import type { Connection } from '@shared/types'
import { createKnex } from '../../src/main/adapters/knex-factory'

/**
 * The session statements every pooled source connection runs as it opens. Driven through the
 * pool's `afterCreate` with a fake connection, so no server is needed.
 */

type AfterCreate = (
  conn: { query: (sql: string, cb: (err: Error | null) => void) => void },
  done: (err: Error | null, conn: unknown) => void
) => void

const mysqlSource: Connection = {
  id: 'c1',
  workspaceId: 'w1',
  label: 'source',
  dialect: 'mysql',
  role: 'source',
  host: '127.0.0.1',
  port: 3306,
  database: 'app',
  username: 'reader'
}

let db: Knex | undefined
afterEach(async () => {
  await db?.destroy()
  db = undefined
})

/** Run `afterCreate` against a fake connection; `failOn` makes that statement error. */
function openSession(failOn?: string): Promise<{ ran: string[]; err: Error | null }> {
  db = createKnex(mysqlSource, 'pw')
  const afterCreate = (db.client.config as Knex.Config).pool?.afterCreate as AfterCreate
  const ran: string[] = []
  return new Promise((resolve) =>
    afterCreate(
      {
        query: (sql, cb) => {
          ran.push(sql)
          cb(sql === failOn ? new Error('refused') : null)
        }
      },
      (err) => resolve({ ran, err })
    )
  )
}

describe('MySQL source session', () => {
  it('is read-only first, then reads TIMESTAMPs in UTC to match the dump', async () => {
    // `dateStrings` returns a TIMESTAMP as text in the session zone, and the dump declares
    // `+00:00`. Under a London session a stored `12:00` UTC would be read as `13:00` and loaded
    // an hour late.
    const { ran, err } = await openSession()

    expect(err).toBeNull()
    expect(ran).toEqual(['SET SESSION TRANSACTION READ ONLY', "SET SESSION time_zone = '+00:00'"])
  })

  it('stops at the first failing statement and keeps the connection out of the pool', async () => {
    // A connection that could not be made read-only must never be handed out.
    const { ran, err } = await openSession('SET SESSION TRANSACTION READ ONLY')

    expect(err?.message).toBe('refused')
    expect(ran).toEqual(['SET SESSION TRANSACTION READ ONLY'])
  })
})
