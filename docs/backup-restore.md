# Backup and restore safety

## Backup format

Karta backup format version 2 records every active IndexedDB object store. It
contains a sorted `storeNames` list, a `recordCounts` entry for every store, and
key/value entries for every record. Empty stores are represented explicitly as
empty arrays with count zero.

The application exports all native active stores, not only canonical application
stores. This prevents preserved extra stores from being silently omitted.

Before download, the exact JSON representation is serialized, parsed, and
validated again. Backup v2 supports JSON-safe strings, booleans, `null`, finite
numbers, arrays, and plain objects. It rejects `undefined`, non-finite numbers,
Date objects, binary values, functions, symbols, bigint values, circular
objects, and unsupported primary-key types rather than silently changing them.

## Restore validation

Before a restore can be confirmed, Karta requires:

- format version 2;
- matching database name and database version;
- exact equality of metadata store names, payload store names, and active native
  database store names;
- all canonical `DB.STORES` stores present;
- array payloads and matching record counts for every store;
- plain-object records, valid key-path values, and no duplicate primary keys.

Legacy format version 1 backups are rejected. They do not carry the complete
restore-validation metadata required by the current restore policy.

## Restore safety

After validation and confirmation, Karta clears and writes every active store in
one IndexedDB readwrite transaction. A clear or put failure aborts that
transaction, so IndexedDB rolls back all transaction changes. Success is shown
only after transaction completion and post-restore count/content verification.

If transaction work fails, the UI reports transaction failure and does not show
success. If post-restore verification fails, the transaction has already
committed: the UI explicitly tells the operator to stop using the application,
reload it, and preserve the current state for investigation. It does not claim
that the pre-restore data remains intact and does not attempt automatic rollback.

A browser download is external to IndexedDB. Export success means the file was
prepared and browser download was requested; the operator must confirm the
browser completed the download.

Close other Karta tabs before restoring. The current restore flow holds an
exclusive operation guard before file parsing so competing imports in the same
tab cannot both reach a restore transaction. It does not provide cross-tab
locking.

## Native browser verification

`tests/backup-import/native-restore-harness.html` is destructive to the
`Operating System` database in its own browser origin. Run it only in a
dedicated disposable browser profile and disposable local origin, never in an
operator profile or real Karta origin.
