# Masq

Cross-platform desktop app (Electron + Vue 3 + TS) that connects to a production
database, selects a realistic **subset** of rows, **anonymizes** sensitive fields,
and emits portable SQL dump files — so developers get realistic local data without
ever touching production.

**General-purpose** — designed to work across many different projects and databases,
not tied to any one codebase. MySQL is the first dialect built out (and the Laravel
exclusion presets ship as editable defaults) because that's the environment it was
first proven against, but nothing about the design is app-specific. Dialect support:
MySQL, Postgres and SQLite are built for v1; SQL Server is a placeholder deferred to v2.

## Where things live

- **Threat model** — [THREAT_MODEL.md](THREAT_MODEL.md) — assets, trust boundaries, and the code
  that enforces each one. Read it before reviewing or changing anything security-relevant.
- **Full spec** — [docs/db-subsetter-spec.md](docs/db-subsetter-spec.md) — the source of
  truth for design (committed with the repo).
- **Project memory** — [.memory/](.memory/) — committed, team-shared context that
  grows as the project does:
  - [.memory/decisions.md](.memory/decisions.md) — why we chose what we chose (ADR-lite log)
  - [.memory/state.md](.memory/state.md) — what's built, what's in progress, what's next
  - [.memory/glossary.md](.memory/glossary.md) — domain terms used across code + spec

Read `.memory/` at the start of any non-trivial session — it's the fast path to
"what's the current state and why".

## Keeping memory updated

This is a shared brain, not a scratchpad. Keep it current as a normal part of doing
the work — not a separate chore at the end.

**`decisions.md`** — append an entry whenever you make a choice that a future reader
would otherwise have to reverse-engineer: a library swap, an architectural trade-off,
a "we tried X, it didn't work, so Y". One entry = date, the decision, and the _why_.
Never delete a decision; if it's reversed, add a new entry that supersedes it and link back.

**`state.md`** — update when the build status changes: a step from the build order
completed, a new area started, a known blocker discovered. This should always answer
"if I sat down right now, what would I work on?"

**`glossary.md`** — add a term the first time it appears in code or conversation and
isn't self-explanatory. Keep definitions to a sentence or two.

**`AGENTS.md`** (this file; `CLAUDE.md` just imports it) — only for durable, high-level orientation. If you're
tempted to put a dated fact or a detailed decision here, it belongs in `.memory/`
instead. Keep this file short enough that it's always worth reading.

**Rule of thumb:** if a fact is true only today, it goes in `state.md`. If it explains
a choice, it goes in `decisions.md`. If it defines a word, `glossary.md`. If it
orients a newcomer, here. When in doubt, prefer `.memory/` over this file.

## Tech stack (quick reference)

Electron (`electron-vite`, vue-ts) · Vue 3 + TS · Node main process · `knex` for
query execution · drivers `mysql2`/`pg`/`better-sqlite3` · `@faker-js/faker`
· `better-sqlite3` config store in `userData` · `electron-builder` packaging ·
`safeStorage` for credentials. Full rationale in spec §2 and `decisions.md`.

**Native-module gotcha:** `better-sqlite3` must be rebuilt against Electron's ABI.
Handled by the `postinstall: electron-builder install-app-deps` script (with
`npmRebuild: false`) — see `decisions.md`. Native `.node` files are unpacked from asar
via `asarUnpack` in `electron-builder.yml`.

## Reviewing a change (humans and CI agents)

Run `npm run lint`, `npm run typecheck` and `npm test` (tests run under Electron's Node, so a
`better-sqlite3` ABI error means `npx electron-builder install-app-deps` wasn't run). Then check the
diff against these rules. Breaking one is a finding even if the tests pass:

- **Never write to a source database.** Sessions are read-only (`adapters/knex-factory.ts`); SQL
  built from user input is bound, and raw predicates go through `shared/raw-where.ts`.
- **Nothing may bypass anonymization.** What a dump emits is decided by selection
  (`extract/run.ts`, `buildRowStream`), and every path that emits rows needs a test that a real
  value doesn't leak.
- **The Electron boundary stays narrow.** New IPC goes through `registerHandlers`
  (`main/ipc-guard.ts`), the preload exposes typed wrappers only, the renderer never gets a
  decrypted password, and there's no `v-html`.
- **Behaviour, data-model and IPC changes are deliberate.** Each one needs a `.memory/decisions.md`
  entry saying why. A change that moves a trust boundary also updates `THREAT_MODEL.md`.
- **Renderer colours come from design tokens** (`assets/tokens.css`) — no hex in components.
- Known, accepted weaknesses are listed in `THREAT_MODEL.md` §5: flag them only if a change makes
  them worse.
