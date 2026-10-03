# Workspace export and import

## Goal

Share a workspace's extraction rules and anonymization settings as a portable file. A recipient
imports it as a new workspace, connects their own source database, and can review the settings before
running an extract. Import and export work offline; neither connects to the source database.

## Version 1 file

Use readable JSON with a format marker and version, for example:

```json
{
  "format": "masq-workspace",
  "version": 1,
  "workspace": { "name": "Example", "dumpOutputMode": "combined" },
  "tableClassifications": [],
  "selectionRules": [],
  "fieldStrategies": [],
  "tableLocaleSources": [],
  "tableIdentitySources": [],
  "morphRelations": [],
  "fkBackfillPolicies": []
}
```

Each array contains the existing API-shaped values without `id` or `workspaceId`. Morph relations
carry their `typeMap` inline; no separate relation IDs appear in the file. Preserve rules exactly,
including flag-only takes, raw SQL predicates, template bindings, and explicit table
classifications. An unclassified table still defaults to transactional.

Exclude connection details, passwords and encrypted credential blobs, source data, dumps, run history,
timestamps, and the local dump-output directory. Hostnames, usernames, and SQLite file paths can be
machine-specific or sensitive, so version 1 has the recipient create their own connection. Connection
profiles without passwords can be considered later if teams need that convenience.

The JSON may itself contain sensitive literals in selection conditions, raw SQL, or field templates.
The export UI should say this plainly before the file is shared.

## User flow

Put **Export** beside Edit/Delete for the active workspace and **Import** beside New workspace.
Export opens a native save dialog and writes one `.masq.json` file. Import opens a native file dialog,
shows the workspace name and counts of the settings found, then creates a **new** workspace and
switches to it. The recipient can then add a source connection and choose a local dump folder.
Import never overwrites an existing workspace. If the name already exists, offer an editable name in
the import dialog. There is no merge mode in version 1.

## Import boundary

Validate the whole file before changing the config database: marker/version, required objects and
arrays, known enum values, rule/strategy shapes, duplicate unique keys, and a reasonable file-size
limit. Reject unsupported versions and malformed content with a useful message; do not use the
repositories' lenient read fallbacks, which could widen a malformed selection rule. Keep raw SQL as
text and do not execute it during import.

Insert the workspace and all child settings in one SQLite transaction, generating fresh IDs for the
workspace, rows, and morph relations/type mappings. Any failure rolls back the entire import. Export
reads only the named workspace and serializes a stable, deterministic order, so a file diff shows
configuration changes rather than generated IDs.

## Implementation and checks

The service uses the existing config repositories and a single SQLite transaction for import. Tests
cover a round trip with every setting type, fresh IDs, no connection or credential data, unsupported
versions, malformed rules, and rollback on a forced write failure. The config IPC/preload contract
opens native file dialogs; the sidebar has Export and Import actions with a summary and editable name.
The full test suite, lint, typecheck, and production build pass. A throwaway Electron run also
exercised the built renderer, native dialog calls, preload/IPC, and successful import without touching
the real config database.

No config-store migration or new dependency is needed for version 1.
