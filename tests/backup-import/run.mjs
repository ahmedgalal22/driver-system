import { installIDB } from './idb-shim.mjs';
import {
  BACKUP_FORMAT_VERSION,
  BackupRestoreError,
  createBackupSnapshot,
  createExclusiveOperationGuard,
  parseBackupJson,
  restoreAndVerifyBackup,
  restoreValidatedBackup,
  serializeBackupSnapshot,
  validateBackupSnapshot,
  verifyRestoredBackup,
} from './services/backupService.js';

installIDB();
const { DB } = await import('./database.js');
await DB.init();
const db = DB._db;
const canonical = Object.keys(DB.STORES).sort();
const USER = 'backup-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const clone = value => JSON.parse(JSON.stringify(value));
const expectReject = (fn, pattern, label) => Promise.resolve().then(fn).then(
  () => ok(false, label),
  err => ok(pattern.test(String(err?.message || err)), `${label}: ${err?.message || err}`),
);

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('transaction failed'));
  });
}
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('request failed'));
  });
}
async function write(recordsByStore) {
  const names = Object.keys(recordsByStore);
  const tx = db.transaction(names, 'readwrite');
  const done = txDone(tx);
  const pending = [];
  for (const [name, rows] of Object.entries(recordsByStore)) {
    const store = tx.objectStore(name);
    for (const row of rows) pending.push(req(store.put(row)));
  }
  await Promise.all(pending);
  await done;
}
function activeStores() {
  return Array.from(db.objectStoreNames).sort();
}
function assertSameSnapshot(left, right, label) {
  ok(JSON.stringify(left) === JSON.stringify(right), label);
}

// FakeDB permits schema creation outside upgrade transactions; use that solely
// to exercise the active-extra-store backup contract in isolated tests.
db.createObjectStore('legacy_extra', { keyPath: 'id', autoIncrement: false });

await write({
  users: [{ id: 1, username: USER, password_hash: 'fixture', role: 'admin', deleted_at: null }],
  vehicles: [{ id: 10, plate: 'TEST-10', deleted_at: null }],
  vehicle_ledger: [{ id: 100, amount: 1250, type: 'deposit', deleted_at: null, is_reversed: false }],
  offices: [{ id: 20, name: 'Office Test', deleted_at: null }],
  receipts: [{ id: 'receipt-1', total: 1250, deleted_at: null }],
  vehicleOwners: [{ id: 'owner-1', name: 'Owner Test', deleted_at: null }],
  drivers: [{ id: 30, name: 'Driver Test', deleted_at: null }],
  receipt_rows: [{ row_id: 'row-1', receipt_id: 'receipt-1', deleted_at: null }],
  mainCapitalTreasury: [{ id: 'capital-1', amount: 5000, deleted_at: null }],
  legacy_extra: [{ id: 'extra-1', value: 'preserve me' }],
});

console.log('\n— export v2 contract —');
const backup = await createBackupSnapshot(db, {
  canonicalStoreNames: canonical,
  exportedAt: '2026-01-01T00:00:00',
  exportedBy: USER,
});
ok(backup._meta.formatVersion === BACKUP_FORMAT_VERSION, 'export uses formatVersion 2');
ok(JSON.stringify(backup._meta.storeNames) === JSON.stringify(activeStores()), 'export includes every active store, including extra store');
ok(backup.stores.loadPrices.length === 0 && backup._meta.recordCounts.loadPrices === 0, 'explicit empty store is exported with zero count');
ok(backup.stores.legacy_extra[0].key === 'extra-1' && backup.stores.legacy_extra[0].value.value === 'preserve me', 'extra-store entry is exported as key/value data');
const validated = validateBackupSnapshot(db, clone(backup), { canonicalStoreNames: canonical });
ok(validated.storeNames.length === activeStores().length, 'complete v2 backup validates');
const serialized = serializeBackupSnapshot(db, backup, { canonicalStoreNames: canonical });
ok(serialized.json.includes('"formatVersion": 2') || serialized.json.includes('"formatVersion":2'), 'exact JSON backup representation validates before download');

const undefinedValue = structuredClone(backup);
undefinedValue.stores.loadPrices.push({ key: 'deleted-route', value: { id: 'deleted-route', canonical_route: undefined } });
undefinedValue._meta.recordCounts.loadPrices++;
await expectReject(() => Promise.resolve(serializeBackupSnapshot(db, undefinedValue, { canonicalStoreNames: canonical })), /contains undefined/, 'undefined property that JSON would omit rejects export');
const dateValue = structuredClone(backup);
dateValue.stores.loadPrices.push({ key: 'date-route', value: { id: 'date-route', created: new Date('2026-01-01') } });
dateValue._meta.recordCounts.loadPrices++;
await expectReject(() => Promise.resolve(serializeBackupSnapshot(db, dateValue, { canonicalStoreNames: canonical })), /unsupported object type/, 'Date value rejects export before download');
const binaryValue = structuredClone(backup);
binaryValue.stores.loadPrices.push({ key: 'binary-route', value: { id: 'binary-route', payload: new Uint8Array([1, 2]) } });
binaryValue._meta.recordCounts.loadPrices++;
await expectReject(() => Promise.resolve(serializeBackupSnapshot(db, binaryValue, { canonicalStoreNames: canonical })), /unsupported object type/, 'binary value rejects export before download');

console.log('\n— pre-destructive rejection rules —');
await expectReject(() => Promise.resolve(parseBackupJson('{not json')), /not valid JSON/, 'malformed JSON rejected');
const missingMetadata = clone(backup);
delete missingMetadata._meta.recordCounts;
await expectReject(() => Promise.resolve(validateBackupSnapshot(db, missingMetadata, { canonicalStoreNames: canonical })), /record counts are missing/, 'invalid metadata rejected');
const missingFormat = clone(backup);
delete missingFormat._meta.formatVersion;
await expectReject(() => Promise.resolve(validateBackupSnapshot(db, missingFormat, { canonicalStoreNames: canonical })), /unsupported backup format version/, 'missing format version rejected');
const missingCanonical = clone(backup);
delete missingCanonical.stores.users;
missingCanonical._meta.storeNames = missingCanonical._meta.storeNames.filter(name => name !== 'users');
delete missingCanonical._meta.recordCounts.users;
await expectReject(() => Promise.resolve(validateBackupSnapshot(db, missingCanonical, { canonicalStoreNames: canonical })), /store set/, 'missing canonical store rejected');

const missingExtra = clone(backup);
delete missingExtra.stores.legacy_extra;
missingExtra._meta.storeNames = missingExtra._meta.storeNames.filter(name => name !== 'legacy_extra');
delete missingExtra._meta.recordCounts.legacy_extra;
await expectReject(() => Promise.resolve(validateBackupSnapshot(db, missingExtra, { canonicalStoreNames: canonical })), /store set/, 'missing active extra store rejected');

const unknownStore = clone(backup);
unknownStore._meta.storeNames = [...unknownStore._meta.storeNames, 'unknown_store'].sort();
unknownStore._meta.recordCounts.unknown_store = 0;
unknownStore.stores.unknown_store = [];
unknownStore.stores = Object.fromEntries(Object.entries(unknownStore.stores).sort(([left], [right]) => left.localeCompare(right)));
unknownStore._meta.recordCounts = Object.fromEntries(Object.entries(unknownStore._meta.recordCounts).sort(([left], [right]) => left.localeCompare(right)));
await expectReject(() => Promise.resolve(validateBackupSnapshot(db, unknownStore, { canonicalStoreNames: canonical })), /store set/, 'unknown store rejected');

const duplicateStoreName = clone(backup);
duplicateStoreName._meta.storeNames = [...duplicateStoreName._meta.storeNames, 'users'].sort();
await expectReject(() => Promise.resolve(validateBackupSnapshot(db, duplicateStoreName, { canonicalStoreNames: canonical })), /duplicate/, 'duplicate metadata store name rejected');

const legacyV1 = clone(backup);
legacyV1._meta.formatVersion = 1;
await expectReject(() => Promise.resolve(validateBackupSnapshot(db, legacyV1, { canonicalStoreNames: canonical })), /legacy format version 1/, 'legacy v1 backup rejected');

const nonArray = clone(backup);
nonArray.stores.vehicles = {};
await expectReject(() => Promise.resolve(validateBackupSnapshot(db, nonArray, { canonicalStoreNames: canonical })), /must be an array/, 'non-array store payload rejected');

const countMismatch = clone(backup);
countMismatch._meta.recordCounts.users = 99;
await expectReject(() => Promise.resolve(validateBackupSnapshot(db, countMismatch, { canonicalStoreNames: canonical })), /count.*inconsistent/, 'record-count mismatch rejected');

const invalidRecord = clone(backup);
invalidRecord.stores.receipts[0].value = null;
await expectReject(() => Promise.resolve(validateBackupSnapshot(db, invalidRecord, { canonicalStoreNames: canonical })), /plain object/, 'invalid record rejected');

const missingKeyPath = clone(backup);
delete missingKeyPath.stores.receipts[0].value.id;
await expectReject(() => Promise.resolve(validateBackupSnapshot(db, missingKeyPath, { canonicalStoreNames: canonical })), /key-path/, 'missing key-path value rejected');

const duplicatePrimary = clone(backup);
duplicatePrimary.stores.receipts.push(clone(duplicatePrimary.stores.receipts[0]));
duplicatePrimary._meta.recordCounts.receipts++;
await expectReject(() => Promise.resolve(validateBackupSnapshot(db, duplicatePrimary, { canonicalStoreNames: canonical })), /duplicate primary key/, 'duplicate primary key rejected');

console.log('\n— complete restore and rollback —');
const beforeMutation = await createBackupSnapshot(db, { canonicalStoreNames: canonical, exportedBy: USER });
await write({
  users: [{ id: 1, username: USER, password_hash: 'changed', role: 'admin', deleted_at: null }],
  vehicles: [{ id: 10, plate: 'CHANGED', deleted_at: null }],
  legacy_extra: [{ id: 'extra-1', value: 'changed' }],
});
await restoreValidatedBackup(db, validateBackupSnapshot(db, clone(beforeMutation), { canonicalStoreNames: canonical }));
await verifyRestoredBackup(db, validateBackupSnapshot(db, clone(beforeMutation), { canonicalStoreNames: canonical }));
const afterRestore = await createBackupSnapshot(db, { canonicalStoreNames: canonical, exportedBy: USER });
assertSameSnapshot(beforeMutation.stores, afterRestore.stores, 'valid complete restore replaces every active store and preserves empty stores');

const beforeFailure = await createBackupSnapshot(db, { canonicalStoreNames: canonical, exportedBy: USER });
const writeFailure = clone(beforeFailure);
writeFailure.stores.users.push({
  key: 2,
  value: { id: 2, username: USER, password_hash: 'duplicate', role: 'admin', deleted_at: null },
});
writeFailure._meta.recordCounts.users++;
const validatedFailure = validateBackupSnapshot(db, writeFailure, { canonicalStoreNames: canonical });
await expectReject(() => restoreValidatedBackup(db, validatedFailure), /restore.*store|transaction/, 'injected unique-index failure rejects restore after clear scheduling');
const afterFailure = await createBackupSnapshot(db, { canonicalStoreNames: canonical, exportedBy: USER });
assertSameSnapshot(beforeFailure.stores, afterFailure.stores, 'failed restore abort rolls back clears and preserves original database');

let verificationPhaseError = null;
try {
  await restoreAndVerifyBackup(db, validateBackupSnapshot(db, clone(beforeMutation), { canonicalStoreNames: canonical }), {
    verify: async () => { throw new Error('forced post-commit verification mismatch'); },
  });
} catch (err) {
  verificationPhaseError = err;
}
ok(verificationPhaseError instanceof BackupRestoreError && verificationPhaseError.phase === 'verification', 'post-restore verification failure is classified separately from transaction failure');
const afterVerificationFailure = await createBackupSnapshot(db, { canonicalStoreNames: canonical, exportedBy: USER });
assertSameSnapshot(beforeMutation.stores, afterVerificationFailure.stores, 'verification-phase failure occurs after a committed restore and never claims rollback');

const guard = createExclusiveOperationGuard();
let restoreStarts = 0;
let releaseFirst;
const firstAttempt = (async () => {
  if (!guard.tryAcquire()) return false;
  restoreStarts++;
  await new Promise(resolve => { releaseFirst = resolve; });
  guard.release();
  return true;
})();
const secondAttempt = (async () => {
  if (!guard.tryAcquire()) return false;
  restoreStarts++;
  guard.release();
  return true;
})();
await Promise.resolve();
ok(restoreStarts === 1 && (await secondAttempt) === false, 'exclusive operation guard allows at most one concurrent restore attempt');
releaseFirst();
await firstAttempt;
ok(guard.active === false, 'exclusive operation guard releases after completion');

console.log(`\n${failures === 0 ? '✅ ALL BACKUP/IMPORT ASSERTIONS PASSED' : `❌ FAILURES: ${failures}`}`);
process.exitCode = failures ? 1 : 0;
