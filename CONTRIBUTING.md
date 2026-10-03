# Contributing to Masq

Masq is an experimental desktop database subsetter. Small, focused fixes, documentation improvements
and synthetic database fixtures are welcome. Read [AGENTS.md](AGENTS.md) for project conventions and
[THREAT_MODEL.md](THREAT_MODEL.md) before changing security-sensitive paths.

## Setup

Use Node.js 22.12 or newer (CI uses Node.js 22), npm and git. Follow the prerequisites in the
[README](README.md#getting-started), then run:

```bash
npm ci
npm run dev
```

Installation rebuilds `better-sqlite3` for Electron's ABI. If tests report a native ABI mismatch,
run `npx electron-builder install-app-deps`. Tests intentionally run under Electron's Node through
`scripts/run-vitest.mjs`; running Vitest directly under system Node can load the wrong native module.

## Before opening a pull request

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

CI runs these checks on Linux, macOS and Windows. It does not publish installers or verify live
server restores. For changes to a dialect, describe any synthetic source/restore fixtures used and
which server versions were exercised. For Electron boundary changes, check the built app's bridge,
navigation restrictions and single-instance behavior. Add regression coverage for data leaks,
source writes and meaningful correctness fixes.

Keep pull requests focused. Explain the problem, resulting behavior and validation. Follow the
existing adapter/repository/store boundaries, keep the preload API narrow, and use renderer design
tokens. Update project memory for decisions and build status; update the threat model if a trust
boundary changes. Do not change database migrations that may already have run; add a new migration.

## Issues and test data

Report ordinary bugs in GitHub Issues with the app commit/version, OS, database dialect/version,
steps to reproduce and expected behavior. Use synthetic data and redact credentials, internal
hostnames, personal information and sensitive rule values from logs or screenshots. Never attach
production dumps or real config databases. Security reports belong in the private channel described
in [SECURITY.md](SECURITY.md).

Contributions are distributed under the repository's [MIT license](LICENSE).
