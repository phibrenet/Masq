# SSH tunnelling for source connections — design plan

_Status: **PLANNED**, not built (captured 2026-08-20). No code exists yet; nothing in the config
store, the adapters, or the UI knows about SSH. This is the design record to build from._

Reach a production database that isn't directly routable — the normal case, not the exception. A
database that accepts connections from the open internet is a misconfiguration; the realistic
deployment has MySQL/Postgres bound to a private interface or a VPC, with SSH to a bastion as the
only way in. Right now Masq can only connect to what the desktop can already reach, which means the
tool whose entire purpose is "get realistic data out of production safely" cannot reach most
productions.

Applies to **server-based dialects only** (`mysql`, `postgres`, and `mssql` when it lands in v2).
SQLite is a local file — see [Out of scope](#out-of-scope).

## Why this is a small change

Every source-database access in the app funnels through **one function**: `withSourceAdapter` in
[src/main/adapters/index.ts:63](../src/main/adapters/index.ts#L63). It is the only caller of
`createKnex` in `src/`, and it already owns the pool's whole lifecycle:

```ts
const db = createKnex(connection, password)
try {
  return await fn(makeAdapter(connection, db, password))
} finally {
  await db.destroy()
}
```

A tunnel has exactly the same lifetime as that pool, so it opens on the line above and closes in the
same `finally`. Nothing else in the codebase needs to know a tunnel exists.

The long-running case is already correct too: `executePipeline` runs *inside* `withSourceAdapter`
([src/main/extract/run.ts:74](../src/main/extract/run.ts#L74)) precisely so the source pool stays open
for the whole stream. One extract = one tunnel, no special casing.

## Core idea — a local port forward

`ssh2` connects to the bastion, a `net.createServer` listens on `127.0.0.1:0` (an ephemeral port
chosen by the OS), and each incoming socket is piped through the SSH connection's `forwardOut` to the
real database host/port as seen *from the bastion*. knex then dials `127.0.0.1:<localPort>` and is
otherwise unchanged. This is what TablePlus, Sequel Ace and DBeaver all do.

```
knex pool ──▶ 127.0.0.1:54321 ──▶ [ssh2 forwardOut] ──▶ bastion ──▶ db-host:3306
pg_dump   ──▶ 127.0.0.1:54321 ──▶ (same forward)
```

### The rejected alternative, and why it fails here

`mysql2` and `pg` both accept a `stream` option, so the SSH channel could be handed straight to the
driver with no local port opened at all — marginally more secure (nothing else on the machine can
reach the forward) and no port to leak.

**It breaks Postgres.** `PostgresAdapter.getCreateTableStatement` shells out to `pg_dump`
([src/main/adapters/postgres.ts:232](../src/main/adapters/postgres.ts#L232)) — a subprocess that
authenticates on its own and needs a real TCP endpoint it can be pointed at with `-h`/`-p`. An
in-process duplex stream is invisible to it. A forwarded port serves knex and `pg_dump` identically,
which is worth more than the port-exposure saving. Bind the listener to `127.0.0.1` explicitly (never
`0.0.0.0`) and the exposure is limited to processes on the same machine as the user.

## Config model

Extends `Connection` in [src/shared/types.ts](../src/shared/types.ts) — a flat group of optional
fields, same treatment as the postgres-only `searchPath`:

```ts
export type SshAuthMethod = 'agent' | 'privateKey' | 'password'

export interface Connection {
  // …existing fields…

  /** Server-based dialects only. When false/absent, host/port are dialled directly. */
  sshEnabled?: boolean
  sshHost?: string
  /** Defaults to 22 when absent. */
  sshPort?: number
  sshUsername?: string
  /** Absent means `agent` — the right default for a developer machine. */
  sshAuthMethod?: SshAuthMethod
  /** For `privateKey`. A path, not the key material — the file stays where ssh keeps it. */
  sshPrivateKeyPath?: string
  /**
   * Pinned host key fingerprint (SHA256 base64, as `ssh-keygen -lf` prints it). Written on first
   * trust; a mismatch afterwards is a hard failure. See Host key verification.
   */
  sshHostFingerprint?: string
}
```

**`host`/`port` keep their existing meaning** — the database's address *as resolved from the bastion*.
So a DB bound to the bastion's own loopback is `host: 127.0.0.1`, and one elsewhere in the VPC is its
private name. This is the same mental model as `ssh -L`, and it means no field changes meaning
depending on `sshEnabled`.

**Deliberately not stored:** the key material itself. Reading `sshPrivateKeyPath` at connect time
keeps ssh's own file permissions as the guard and avoids Masq becoming a second, worse place a private
key lives.

## Storage + migration

**Migration `009_connection_ssh.sql`** — a plain `ALTER TABLE … ADD COLUMN` run, like 003, 006 and
007. No CHECK constraint changes on `connections`, so none of the table-rebuild dance migration 005
needed:

```sql
ALTER TABLE connections ADD COLUMN ssh_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connections ADD COLUMN ssh_host TEXT;
ALTER TABLE connections ADD COLUMN ssh_port INTEGER;
ALTER TABLE connections ADD COLUMN ssh_username TEXT;
ALTER TABLE connections ADD COLUMN ssh_auth_method TEXT;   -- 'agent' | 'privateKey' | 'password'
ALTER TABLE connections ADD COLUMN ssh_private_key_path TEXT;
ALTER TABLE connections ADD COLUMN ssh_host_fingerprint TEXT;
```

No CHECK on `ssh_auth_method` on purpose: adding one later is another rebuild, and the value is
already constrained by the form and read through a typed mapper. (If a CHECK is wanted, add it in the
same migration — not after.)

### The credentials wrinkle

`credentials` is keyed one-row-per-connection with a single `encrypted_password` blob
([src/main/config/credentials.ts](../src/main/config/credentials.ts)). SSH needs **a second secret**:
either an SSH password (`sshAuthMethod: 'password'`) or a passphrase for the private key
(`'privateKey'`). Both are mutually exclusive with each other but *not* with the DB password, which is
still needed.

Two options:

1. **Add a nullable column** — `ALTER TABLE credentials ADD COLUMN encrypted_ssh_secret BLOB`, with
   the auth method deciding whether it's a password or a passphrase. One column, no rebuild, and the
   `NOT NULL` on `encrypted_password` keeps working because the row already exists whenever a DB
   password was saved.
2. **Generalise to `(connection_id, kind, blob)`** with a composite PK. More honest as a model, but
   it's a table rebuild plus a rewrite of all four functions in `credentials.ts` and every caller.

**Recommendation: option 1.** The set of secrets per connection is closed and small (DB password + one
SSH secret), and `credentials.ts` grows two functions (`setSshSecret`/`getSshSecret`) rather than
changing shape. Note the one real cost: a connection with **no** DB password but an SSH passphrase has
no row to hang the secret on, because `encrypted_password` is `NOT NULL`. Either drop that `NOT NULL`
in the same migration (a rebuild — so do it deliberately) or store an encrypted empty string. Decide
before writing the migration; discovering it during implementation is how you end up with a 010.

## Auth methods

- **`agent` (default).** Reads `SSH_AUTH_SOCK`; on Windows, `ssh2` takes the literal string
  `'pageant'` or the OpenSSH named pipe `\\.\pipe\openssh-ssh-agent`. This is the method that needs no
  secret stored at all, which is why it's the default. Fails clearly when no agent is running rather
  than silently falling through to another method.
- **`privateKey`.** `readFileSync(sshPrivateKeyPath)` + optional passphrase from the keychain.
  Encrypted keys without a stored passphrase must fail with "this key needs a passphrase", not a
  generic auth error — `ssh2` reports these distinguishably.
- **`password`.** Present because some bastions still work this way. Stored via `safeStorage` like any
  other secret.

Explicitly **not** doing method fallback (try agent, then key, then password). Silent fallback makes a
failed connection unreadable and can lock an account out against a bastion with a retry limit.

## Host key verification — do not skip this

`ssh2` gives a `hostVerifier(key, callback)` hook and, if you don't implement it, **accepts any host
key**. For a tool that exists to reach production, blind-accept is a live MITM hole: whoever answers on
port 22 gets the DB password.

The design:

1. Compute the SHA256 fingerprint of the presented key.
2. If `sshHostFingerprint` is set on the connection, compare. Mismatch = **hard failure**, with both
   fingerprints in the message. No prompt, no override in the flow — an override belongs in the edit
   form, as a deliberate act.
3. If unset, also check `~/.ssh/known_hosts` for the host. A match there is a trust signal the user
   already gave; pin it and continue.
4. Otherwise prompt: show the fingerprint, "trust and remember" or cancel. On trust, write it to
   `ssh_host_fingerprint`.

Step 3 is what makes this pleasant rather than annoying — most users connecting to a bastion they
already `ssh` into daily will never see the prompt. It needs a `known_hosts` parser that handles
hashed hostnames (`|1|salt|hash`), which is the fiddliest part of this whole feature and the reason
step 3 could reasonably be dropped from a first cut (falling back to step 4's prompt every first
connect).

Rejected: a "don't verify host keys" checkbox. It would be ticked once, by everyone, forever.

## Lifecycle changes, concretely

One new module and one threading change.

**`src/main/adapters/ssh-tunnel.ts`** (new, ~150 lines):

```ts
export interface Tunnel {
  /** Always 127.0.0.1. */
  host: string
  /** The ephemeral local port the forward is listening on. */
  port: number
  close(): Promise<void>
}

export async function openTunnel(connection: Connection): Promise<Tunnel>
```

Resolves its own secrets from the keychain (main process only, same as `withSourceAdapter` does for the
DB password), sets `keepaliveInterval` so a long extract doesn't get dropped by an idle timeout, and
rejects with a message naming the *stage* that failed — DNS, TCP, host key, auth, or channel open. A
bare "All configured authentication methods failed" tells the user nothing about which of five fields
is wrong.

**[src/main/adapters/index.ts](../src/main/adapters/index.ts)** — `withSourceAdapter` resolves an
*effective* connection before building anything:

```ts
const tunnel = connection.sshEnabled ? await openTunnel(connection) : undefined
const effective = tunnel ? { ...connection, host: tunnel.host, port: tunnel.port } : connection
const db = createKnex(effective, password)
try {
  return await fn(makeAdapter(effective, db, password))
} finally {
  await db.destroy()
  await tunnel?.close()
}
```

`effective` must go to **both** calls. `makeAdapter` passes `host`/`port` into `PostgresAdapter` for
`pg_dump` ([index.ts:38-39](../src/main/adapters/index.ts#L38-L39)); hand it the original
`connection` and knex tunnels correctly while `pg_dump` dials the unroutable address directly and
fails — a bug that only shows up on Postgres, only at DDL generation time, i.e. minutes into a run.
**This is the single most likely thing to get wrong in the whole feature.**

Teardown order matters as written: destroy the pool first, then the tunnel. Closing the forward under a
live pool produces socket errors from the driver instead of a clean shutdown.

## Failure mid-extract

If the SSH connection drops during a long stream, the run must fail with a message that says so.
Left alone, the driver surfaces a generic `ECONNRESET`, which reads as a database problem.

`openTunnel` should track whether it closed unexpectedly and the pipeline should surface that through
the existing warning collector (`warn(warnings, 'ssh', …)`,
[run.ts:456](../src/main/extract/run.ts#L456)) so it lands on the run row via migration 006 and shows
on the Runs screen. `failRun` already keeps warnings accumulated before the failure
([run.ts:79](../src/main/extract/run.ts#L79)), which is exactly the behaviour needed here.

Not planned: automatic reconnect and resume. A dropped tunnel mid-dump means a partial output file,
and the honest answer is a failed run the user re-runs — resumable extracts are a much larger feature
than this one.

## UI

[ConnectionFormModal.vue](../src/renderer/src/components/ConnectionFormModal.vue) gets an SSH section
below the server fields, inside the existing `v-if="!isFileBased"` branch (`isFileBased` is at
[line 104](../src/renderer/src/components/ConnectionFormModal.vue#L104)) — SSH is meaningless for a
local SQLite file.

- An "Connect over SSH" switch. Everything below it renders only when on.
- SSH host / port (placeholder `22`) / username.
- Auth method select; the field below it switches — nothing for `agent`, a file picker + optional
  passphrase for `privateKey`, a password for `password`.
- Helper text on the existing Host field when SSH is on: *"as resolved from the SSH host"*. Without it,
  users will put the bastion's address in both fields.
- The pinned fingerprint shown read-only with a "forget" button, once one exists.

Validation mirrors the existing `isFileBased`/`isPostgres` conditional-rules pattern
([lines 127-156](../src/renderer/src/components/ConnectionFormModal.vue#L127-L156)): SSH host and
username required when the switch is on, key path required for `privateKey`.

No other screen changes. **Test** on the connection card already routes through
`testConnection` → `withSourceAdapter` ([source-ipc.ts:18](../src/main/source-ipc.ts#L18)), so it
exercises the tunnel for free — and it's the right place to surface the trust prompt, since that's
where a user expects a first connection to happen.

## Testing — and the trap that makes it worthless

The house rule applies with unusual force here: **if the test database is also reachable directly, a
tunnel test passes whether the tunnel works or not.** Connect to `127.0.0.1:3306` through a forward to
`127.0.0.1:3306` and every assertion passes with the tunnel code deleted. That's the same vacuous-pass
family as the SQLite nullability assertion that a constant `false` satisfied.

The fixture has to make the direct route **impossible**:

- Two containers on a private network: `sshd` with a known test key, and MySQL/Postgres bound to that
  network only. Only the sshd container publishes a port to the host.
- **Assert the precondition**: a direct connection attempt to the DB's address from the test process
  must *fail* before the tunnelled one is expected to succeed. Print it. If the direct connect
  succeeds, abort the harness — the fixture is lying.
- Then run the real pipeline through it, following the `scratchpad/sqlite-e2e-main.ts` shape (reuse the
  app's own IPC registrations, click Test → Discover → Run), and load the resulting dump.

Cases worth their own assertions: wrong fingerprint is rejected; encrypted key with no passphrase
gives the specific error; agent auth with no `SSH_AUTH_SOCK` fails clearly; a tunnel killed mid-stream
produces a failed run with an `ssh:` warning, not a silent truncated dump; and Postgres specifically,
because it's the only dialect where `pg_dump` takes a second path to the server.

## Out of scope

- **SQLite over SSH.** A remote file would have to be copied down first, which is a different feature
  (and `scp` of a live WAL database isn't safe anyway).
- **`ProxyJump` / multi-hop chains.** One bastion covers the realistic case.
- **Parsing `~/.ssh/config`** for `Host` aliases, so `masq-bastion` resolves to a real hostname, user
  and key. Genuinely nice, and reasonable as a follow-up once the plain fields work.
- **Remote port forwards / SOCKS.** Not needed to reach a database.
- **Reconnect-and-resume** after a dropped tunnel (see Failure mid-extract).
- **Kerberos / GSSAPI, and hardware-token keys** beyond whatever the agent already handles.

## Open decisions (settle before building)

1. **`credentials` shape** — nullable `encrypted_ssh_secret` column vs. a `(connection_id, kind)`
   rebuild, and what to do about `encrypted_password NOT NULL` for a connection whose only secret is an
   SSH passphrase. Recommendation above; it changes the migration, so decide first.
2. **`known_hosts` in the first cut** — include it (nicer, needs a hashed-hostname parser) or prompt on
   every first connect (simpler, mildly annoying).
3. **`ssh2`'s optional native deps.** `ssh2` is pure JS and works without them, but `cpu-features`
   builds natively when a toolchain is present. Confirm `electron-builder install-app-deps` either
   rebuilds it cleanly or that it's absent — this is exactly the ABI trap documented for
   `better-sqlite3` in CLAUDE.md, and it must be checked on all three target OSes before it's called
   done.

## Rough build order

1. `ssh-tunnel.ts` with `agent` auth only and no host-key verification (a `hostVerifier` that logs the
   fingerprint and accepts). Proves the forward against the two-container fixture. **Not shippable** —
   it's a scaffold to get an end-to-end connection first.
2. Migration 009 + types + `connections.ts` mapper + credentials change.
3. `withSourceAdapter` threading, including `makeAdapter` getting `effective`. Verify `pg_dump`
   explicitly, not by assuming.
4. Host-key verification: fingerprint pinning, hard-fail on mismatch, trust prompt. Replaces step 1's
   accept-anything. Do not merge steps 1–3 without this.
5. `privateKey` and `password` auth, with distinguishable errors per failure stage.
6. Form UI + validation + the fingerprint display.
7. Mid-stream failure handling and the `ssh:` run warning.
8. The full non-vacuous e2e harness, MySQL and Postgres.
