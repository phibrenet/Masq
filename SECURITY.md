# Security

Masq is an alpha. Security fixes target the current development branch; there are no supported
release builds yet. Read [THREAT_MODEL.md](THREAT_MODEL.md) for controls and known limitations.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting form](https://github.com/phibrenet/Masq/security/advisories/new).
Do not disclose vulnerabilities or sensitive reproduction data in public issues or pull requests.
If the form is unavailable, private reporting has not been enabled or you do not have access; do not
post the details publicly. Repository maintainers must enable private reporting before publication: in repository Settings,
open Code security and enable Private vulnerability reporting. Confirm that the reporting form is
available before making the repository public.

Include the affected commit/version, operating system, database dialect/version, reproduction steps
using synthetic data, expected versus actual behavior and likely impact. Never send production
credentials, production dumps or a real config database. An anonymization bypass or a source-write
path is a security issue even without an attacker. Reports will be reviewed as maintainer capacity
allows; no response-time guarantee is currently offered.

## Using Masq safely

Use source credentials restricted to reads. Read-only sessions are an additional safeguard; raw SQL
predicates and imported rules must be trusted and reviewed. Columns without strategies, reference
data and preserve rules may leave original data in the output. The PII warning is a name heuristic.
Inspect dumps before sharing and restore only into a disposable database. Workspace exports, logs
and connection details may also contain sensitive information. Passwords are encrypted with Electron
`safeStorage`, with protection dependent on the OS account and key store.
