import type { ConnectionInput, ConnectionSecrets } from '@shared/api'
import type { Connection } from '@shared/types'
import { getDb } from './db'
import { createConnection, updateConnection } from './repositories/connections'
import { setPassword, setSshSecret } from './credentials'

function validateSecrets(secrets?: ConnectionSecrets): void {
  for (const value of [secrets?.password, secrets?.sshSecret]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 32768)) {
      throw new Error('Connection secrets must be strings of at most 32768 characters.')
    }
  }
}

/** A keyring failure rolls back settings and both encrypted secrets together. */
export function createConnectionWithSecrets(
  input: ConnectionInput,
  secrets?: ConnectionSecrets
): Connection {
  validateSecrets(secrets)
  return getDb().transaction(() => {
    const connection = createConnection(input)
    if (secrets?.password !== undefined) setPassword(connection.id, secrets.password)
    if (connection.sshEnabled && secrets?.sshSecret !== undefined)
      setSshSecret(connection.id, secrets.sshSecret)
    return connection
  })()
}

export function updateConnectionWithSecrets(
  id: string,
  patch: Partial<ConnectionInput>,
  secrets?: ConnectionSecrets
): Connection | undefined {
  validateSecrets(secrets)
  return getDb().transaction(() => {
    const connection = updateConnection(id, patch)
    if (!connection) return undefined
    if (secrets?.password !== undefined) setPassword(id, secrets.password)
    if (connection.sshEnabled && secrets?.sshSecret !== undefined)
      setSshSecret(id, secrets.sshSecret)
    return connection
  })()
}
