# Masq threat model

What Masq protects, where the trust boundaries are, and which code enforces each one. Written from
the code as of 2026-09-27. When a change touches a boundary below, update this file in the same
change, and cite the file that enforces a control rather than describing it from memory.

**For a security reviewer:** read §3 (boundaries) and §4 (threats) against the diff. §5 lists known
weaknesses that are accepted or still open, so don't re-report them as new findings unless the diff
makes them worse. §6 lists what is out of scope.

---

## 1. What Masq is, in security terms

A desktop app (Electron). A developer points it at a **production** database. It reads a subset of
rows, rewrites sensitive columns, and writes `.sql` files to local disk. Its own database queries
are designed to read the source; read-only sessions are a safeguard, not a substitute for credentials
restricted to reads (see §5.1). There is no server, no account, no telemetry, and no network traffic
except to the databases the user configures.

The product's main promise is a security property: **configured anonymization must be applied
to every eligible emitted row.** Unconfigured columns, reference tables and preserve rules keep
original values; configuration is not automatic proof that a dump contains no personal data. A bug
that bypasses a configured email anonymization strategy is a security bug, even if no attacker
was involved.

## 2. Assets

| Asset                             | Where it lives                                                                                                           | Why it matters                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Source DB credentials (passwords) | Encrypted blob in `credentials` table of `config.sqlite3`, via Electron `safeStorage` (`src/main/config/credentials.ts`) | Usually credentials for production                                                    |
| Production row data               | In memory in the main process during a preview or run                                                                    | Contains real personal data                                                           |
| The anonymization guarantee       | `src/main/extract/anonymize.ts`, `run.ts` (`buildRowStream`)                                                             | A leak here defeats the product                                                       |
| Dump files                        | `<userData>/dumps` or the workspace's `dumpOutputDir` (`src/main/dump-dir.ts`)                                           | Often shared with a team. They hold whatever the config preserved                     |
| Workspace config                  | `config.sqlite3` in `userData`                                                                                           | Rule values and template paths can contain real identifiers (e.g. `email = 'jane@…'`) |
| Workspace export files            | Wherever the user saves them (`src/main/config/workspace-transfer.ts`)                                                   | Designed to be shared. They carry the same rule values                                |

## 3. Trust boundaries and their controls

### 3.1 Renderer → preload → main (Electron)

The renderer is treated as **less trusted** than main. It shows strings that come from the source
database (table and column names, error messages, run warnings) and may be compromised by a future
XSS or a dependency.

| Control                                                                                                                          | Enforced in                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `sandbox: true`, context isolation left at Electron's default (on)                                                               | `src/main/index.ts` (`createWindow`)                                   |
| Only a typed `window.api` crosses the bridge. No generic `ipcRenderer`, no `process` except the `platform` string                | `src/preload/index.ts`                                                 |
| Every IPC channel is registered through `registerHandlers`, which rejects any sender that isn't the app's own top-level document | `src/main/ipc-guard.ts`                                                |
| Navigation away from the app document is refused                                                                                 | `src/main/index.ts` (`will-navigate` + `isAppUrl`)                     |
| `window.open` is denied. Only `http(s)` URLs are passed to `shell.openExternal`                                                  | `src/main/index.ts` (`setWindowOpenHandler`)                           |
| CSP `default-src 'self'; script-src 'self'` (styles allow `'unsafe-inline'` for naive-ui)                                        | `src/renderer/index.html`                                              |
| No `v-html` / `innerHTML`. DB-derived strings render through Vue's escaped interpolation                                         | renderer-wide (check with `grep -rn "v-html\|innerHTML" src/renderer`) |
| Decrypted passwords never go to the renderer. It can only `setPassword` / `hasPassword`                                          | `src/shared/api.ts`, `src/main/ipc.ts`                                 |
| `openPath` only opens **directories** (a file could be executed). Files use `showItemInFolder`                                   | `src/main/system-ipc.ts`                                               |
| `runExtract` rejects a connection belonging to a different workspace than the rules it would apply                               | `src/main/extract/run.ts`                                              |
| One running instance owns the config store                                                                                       | `src/main/index.ts` (`requestSingleInstanceLock`)                      |

**Reviewer checks:**

- A new IPC channel must go through `registerHandlers`.
- A new preload export must be a narrow typed wrapper, never a generic bridge.
- New renderer code must not use `v-html`.
- Anything that opens a path or URL must keep the directory-only and `http(s)`-only rules.

### 3.2 Main → source database

| Control                                                                                                                                                                  | Enforced in                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Server connections open a **read-only session** on every pooled connection: MySQL `SET SESSION TRANSACTION READ ONLY`, Postgres `SET default_transaction_read_only = on` | `src/main/adapters/knex-factory.ts` (`readOnlyPool`)                                                   |
| SQLite sources open with `readonly: true` (so a mistyped path also can't create a file)                                                                                  | `src/main/adapters/knex-factory.ts`                                                                    |
| Structured selection conditions are bound parameters, never string-built                                                                                                 | `src/main/extract/conditions.ts`                                                                       |
| A raw predicate (`rawWhere`) is wrapped as `WHERE (<raw>)` and rejected if it starts with `SELECT`/`WITH`/`WHERE` or contains `;` anywhere                               | `src/shared/raw-where.ts`, applied in `src/main/extract/select.ts` and `conditions.ts` (`applyFilter`) |
| Imported workspaces are validated field by field and size-capped (5 MB) before anything is written                                                                       | `src/main/config/workspace-transfer.ts` (`parseWorkspaceTransfer`), `src/main/ipc.ts`                  |

The read-only session is the **backstop**. Raw predicates can arrive in an imported workspace, so
the database itself must refuse writes, not only Masq's own SQL. Least-privilege source credentials
are still the recommendation.

### 3.3 Main → `pg_dump` subprocess (Postgres DDL)

| Control                                                                                                | Enforced in                                                 |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `execFile` with an argument array, no shell. The table name is identifier-quoted                       | `src/main/adapters/postgres.ts` (`getCreateTableStatement`) |
| Password passed in `PGPASSWORD` in the child's environment, never on the command line                  | `src/main/adapters/postgres.ts` (`pgEnv`)                   |
| Output is filtered to DDL (drops `SET`, `set_config`, psql meta-commands) before it goes into the dump | `src/main/adapters/postgres.ts` (`stripPgDumpSessionLines`) |

`pg_dump` is found on `PATH` (see §5).

### 3.4 Credentials at rest

| Control                                                                                       | Enforced in                                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `safeStorage` (Keychain / DPAPI / libsecret). Refuses to save if encryption is unavailable    | `src/main/config/credentials.ts` (`assertAvailable`)              |
| On Linux, refuses to save under the `basic_text` backend (a fixed key, which only obfuscates) | `src/main/config/credentials.ts` (`assertProtected`)              |
| Workspace exports never include connections, passwords, dump files or local paths             | `src/main/config/workspace-transfer.ts` (`exportWorkspaceConfig`) |

### 3.5 Anonymization pipeline (data leaving production)

| Control                                                                                                                                                                  | Enforced in                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Selection decides what is emitted. A `keepAll` table streams unfiltered but drops any row the selection didn't record, so a row inserted mid-run can't skip its strategy | `src/main/extract/run.ts` (`buildRowStream`, `selectedOnly`)                                       |
| A rule that can't be read back (`invalid`) refuses to run instead of running a widened reading                                                                           | `src/main/extract/select.ts`                                                                       |
| Obfuscate keeps at least `OBFUSCATE_MIN_COUNT` characters. The repository raises lower counts and import rejects them                                                    | `src/shared/types.ts`, `src/main/config/repositories/field-strategies.ts`, `workspace-transfer.ts` |
| Dump write errors (including async stream errors) fail the run and clean up the partial file                                                                             | `src/main/extract/dump-writer.ts`, `run.ts`                                                        |
| Run warnings (dangling references, unmapped morph types, stripped FKs) are stored on the run and shown in the UI                                                         | `src/main/extract/run.ts`, `RunsView.vue`                                                          |

**By design, the dump is only as safe as the config:**

- A column with no strategy is **preserved**.
- Reference tables are copied **verbatim**.
- When rules conflict, **preserve wins**.

The Field Strategies screen flags columns whose names look like personal data and have no strategy
(`src/renderer/src/lib/pii.ts`). This is a name heuristic that only covers tables whose columns have
been read. It is a prompt, not a control.

## 4. Threats

| #   | Threat                                                                                                  | Mitigation                                                                                            | Residual                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | A malicious or careless **imported workspace** runs SQL against production through `rawWhere`           | Semicolons rejected, read-only session, field-level import validation                                 | See §5.1                                                                                                                                                                      |
| T2  | A **real value reaches a dump**: new row mid-run, a strategy not applied, a flag lookup miss            | `selectedOnly` filter, invalid rules refuse to run, pipeline tests in `tests/config/pipeline.spec.ts` | Config gaps (unstrategied PII, reference tables) are the user's call, and the heuristic only prompts                                                                          |
| T3  | A **compromised renderer** (XSS through DB-derived text, a bad dependency) reaches credentials or files | Sandbox, typed bridge, sender-checked IPC, no `v-html`, CSP, no password read-back                    | The IPC surface can still run extracts and read the source through the user's saved connections. Handler arguments are type-checked at compile time, not validated at runtime |
| T4  | **Credential theft** from disk                                                                          | `safeStorage`, refuses `basic_text`                                                                   | Any process running as the same OS user can ask the keychain (as with every desktop app)                                                                                      |
| T5  | **Dump or export shared** with personal data still in it                                                | Export warning tooltip. Export excludes connections and paths                                         | Rule literals and preserved columns travel with the file                                                                                                                      |
| T6  | **Command injection** through `pg_dump` arguments                                                       | `execFile` arg array, quoted identifiers                                                              | Binary resolved from `PATH`                                                                                                                                                   |
| T7  | **Opening a hostile path or URL** from the renderer                                                     | `openPath` is directory-only, `showItemInFolder` for files, `http(s)`-only `openExternal`             | —                                                                                                                                                                             |
| T8  | **Supply chain**: native module (`better-sqlite3`), DB drivers, faker, Electron                         | Lockfile committed, `npm audit` clean at the Electron 44 bump                                         | No signing and no Electron fuses yet (see §5.4)                                                                                                                               |

## 5. Known weaknesses and open items

Don't re-report these as new findings unless the change makes them worse.

1. **Raw predicate can close its own parenthesis.** `WHERE (<raw>)` stops a second statement (no
   `;`), not a predicate like `1=1) OR (1=1`, or a subquery that reads other tables. Worse on
   Postgres: a `SELECT` can call functions with side effects. For example,
   `set_config('default_transaction_read_only', 'off', false)` could switch off the read-only
   backstop for later queries on that pooled connection. It is still one statement with no DML
   of its own, but the backstop would no longer hold. **Unverified and unmitigated.** Defences:
   least-privilege source credentials, and reading imported raw predicates before running them.
   The 2026-09-23 review suggested disabling `rawWhere` until the database boundary holds.
2. **Runtime IPC argument validation** is limited to what each handler checks itself. The renderer
   is trusted to send well-typed arguments.
3. **`pg_dump` from `PATH`.** A same-user attacker who can put an earlier `pg_dump` on `PATH`
   already controls the account, so this is accepted.
4. **Release hardening not done** (see `.memory/state.md` "Next up: deployment"):
   - no code signing
   - no Electron fuses (`RunAsNode`, `EnableNodeCliInspectArguments`, asar integrity)
   - planned auto-update would start unsigned on macOS
5. **Electron boundary last verified end to end on Electron 39.** The app is on 44. Re-run the
   boundary checks (sandboxed preload, no `process`, refused navigation, second-instance exit)
   before a release.
6. **Postgres read-only session not exercised live** (no local Postgres in the 2026-09-23 review).
7. **The PII check is a name heuristic.** It misses PII in oddly named columns and JSON blobs.

8. **Packaging dependency advisory (2026-10-03).** `npm audit` reports eight high-severity entries
   propagated from `http-cache-semantics` GHSA-ch52-4w7c-c8xp through `cacheable-request`, `got`,
   `@electron/get` and electron-builder. This is the packaging download/cache dependency chain, not
   a demonstrated path from Masq's database data. A targeted in-range update and an audit-fix dry
   run left the reports unresolved. Recheck upstream fixes before distributing builds; the earlier
   audit-clean result in §4 is historical.

## 6. Out of scope

- An attacker who already runs code as the user's OS account (they can read the keychain, the
  config store and the dumps directly).
- The security of the source database server and the network path to it. SSH tunnelling is planned,
  not built: `docs/ssh-tunnel.md`.
- What people do with a dump after it's written, and the machines it's loaded onto.
- Stopping a user from preserving data they chose to preserve. Masq makes the choice visible, and
  enforcing policy on it is not a goal.
- SQL Server: a placeholder dialect that every connection attempt rejects (deferred to v2).

## 7. Where to look first in a review

- `src/main/ipc-guard.ts`, `src/preload/index.ts`, `src/main/index.ts` for any change to the bridge
  or window.
- `src/main/adapters/knex-factory.ts`, `src/shared/raw-where.ts`, `src/main/extract/conditions.ts`
  for anything that builds SQL.
- `src/main/extract/run.ts` (`buildRowStream`) and `anonymize.ts` for anything that decides what
  a dump contains.
- `src/main/config/workspace-transfer.ts` for anything imported from a file.
- `src/main/config/credentials.ts` for anything touching passwords.
- Past findings: `docs/project-review-2026-09-23.md`. Decisions and their reasons:
  `.memory/decisions.md`.
