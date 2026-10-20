# IndexedDB migration verification

## Scope

The application database is named `Operating System`. Version 17 is the first
safe lifecycle release and supports only these source states:

| Source version | Result |
| --- | --- |
| `0` | Create the complete v17 schema for a fresh database. |
| `16` | Validate the frozen v16 schema without mutating stores, indexes, or records. |
| `1`–`15` | Abort safely as unsupported. |
| `>17` | Browser rejects the older application version; use a matching build. |

A v16-to-v17 upgrade never deletes or recreates an existing store/index, clears
a store, or rewrites a record. Required schema differences and any extra index
on a canonical store abort the native versionchange transaction. Extra object
stores are left untouched and reported in the console.

## Native-browser harness

`tests/indexeddb-migration/native-upgrade-harness.html` is a manual native
IndexedDB test harness. It must be served from a **dedicated disposable browser
profile and origin**. It uses the production database name, so it must never be
opened in an operator profile or an origin containing Karta data.

One minimal way to serve the repository root is:

```bash
python3 -m http.server 4173
```

Then open:

```text
http://127.0.0.1:4173/tests/indexeddb-migration/native-upgrade-harness.html
```

The harness deletes only its disposable-origin database between scenarios. It
verifies fresh creation, canonical v16 upgrade preservation and financial
projections, incompatible-schema rollback, extra-store preservation,
extra-index rejection, unsupported-version preservation, blocked upgrade
behavior, and versionchange handling.

## Required evidence

Record, for the browser run:

```text
browser name and version
origin used
confirmation of disposable profile
oldVersion/newVersion observed for v16 → v17
harness result report
```

The Node IndexedDB shim is useful for ordinary regression tests only. It does
not prove native upgrade, blocked, versionchange, or upgrade-rollback behavior.
