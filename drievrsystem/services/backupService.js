/**
 * backupService.js — JSON backup contract and native IndexedDB restore helpers.
 * This module deliberately owns no UI. Callers must validate a backup before
 * asking for confirmation and before opening a destructive write transaction.
 */

export const BACKUP_FORMAT_VERSION = 2;
export const BACKUP_ENTRY_FORMAT = 'key-value-v1';

export function createExclusiveOperationGuard() {
  let active = false;
  return Object.freeze({
    tryAcquire() {
      if (active) return false;
      active = true;
      return true;
    },
    release() {
      active = false;
    },
    get active() {
      return active;
    },
  });
}

export class BackupRestoreError extends Error {
  constructor(phase, cause) {
    super(cause?.message || String(cause || 'backup restore failed'));
    this.name = 'BackupRestoreError';
    this.phase = phase;
    this.cause = cause;
  }
}

export function parseBackupJson(text) {
  if (typeof text !== 'string') throw _error('backup file must be text.');
  try {
    return JSON.parse(text);
  } catch {
    throw _error('backup file is not valid JSON.');
  }
}

function _error(message) {
  return new Error(`[Backup] ${message}`);
}

function _isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function _sameStringSet(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function _sortedUniqueStoreNames(value, label, { requireSorted = true } = {}) {
  if (!Array.isArray(value)) throw _error(`${label} must be an array.`);
  const names = value.map(name => typeof name === 'string' ? name.trim() : '');
  if (names.some(name => !name)) throw _error(`${label} contains an invalid store name.`);
  const sorted = [...names].sort();
  if (new Set(sorted).size !== sorted.length) throw _error(`${label} contains duplicate store names.`);
  if (requireSorted && !_sameStringSet(names, sorted)) throw _error(`${label} must be sorted.`);
  return sorted;
}

function _keyPathValues(record, keyPath) {
  if (typeof keyPath === 'string') return [record[keyPath]];
  if (Array.isArray(keyPath)) return keyPath.map(path => record[path]);
  return null;
}

function _isValidJsonKey(value) {
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0 && value.every(_isValidJsonKey);
  return false;
}

function _sameKey(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function _keyToken(key) {
  return JSON.stringify(key);
}

function _stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(_stableJson).join(',')}]`;
  if (_isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${_stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function _assertJsonSafeValue(value, path, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw _error(`${path} contains a non-finite number.`);
    return;
  }
  if (value === undefined) throw _error(`${path} contains undefined, which JSON would omit.`);
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw _error(`${path} contains unsupported ${typeof value} data.`);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw _error(`${path} contains a circular array.`);
    seen.add(value);
    value.forEach((item, index) => _assertJsonSafeValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  if (_isPlainObject(value)) {
    if (seen.has(value)) throw _error(`${path} contains a circular object.`);
    seen.add(value);
    for (const key of Object.keys(value)) _assertJsonSafeValue(value[key], `${path}.${key}`, seen);
    seen.delete(value);
    return;
  }
  throw _error(`${path} contains an unsupported object type.`);
}

/**
 * Validate the actual JSON representation that will be downloaded. JSON-safe
 * primitive values, arrays, and plain objects are supported; undefined,
 * non-finite, binary, Date, and other structured-clone-only values are not.
 */
export function serializeBackupSnapshot(db, backup, { canonicalStoreNames } = {}) {
  validateBackupSnapshot(db, backup, { canonicalStoreNames });
  _assertJsonSafeValue(backup, 'backup');
  const json = JSON.stringify(backup);
  const parsed = parseBackupJson(json);
  validateBackupSnapshot(db, parsed, { canonicalStoreNames });
  return Object.freeze({ backup: parsed, json });
}

function _requestResult(request, context) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(_error(`${context}: ${request.error?.message || 'request failed'}`));
  });
}

function _transactionResult(tx, context) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_error(`${context}: ${tx.error?.message || 'transaction failed'}`));
    tx.onabort = () => reject(_error(`${context}: ${tx.error?.message || 'transaction aborted'}`));
  });
}

export function getActiveStoreNames(db, canonicalStoreNames) {
  if (!db?.objectStoreNames) throw _error('database connection is required.');
  const active = Array.from(db.objectStoreNames).sort();
  const canonical = _sortedUniqueStoreNames(canonicalStoreNames, 'canonical store names');
  const missingCanonical = canonical.filter(name => !active.includes(name));
  if (missingCanonical.length > 0) {
    throw _error(`active database is missing canonical store(s): ${missingCanonical.join(', ')}.`);
  }
  return active;
}

function _entryFromKeyAndValue(key, value) {
  return { key, value };
}

export async function createBackupSnapshot(db, {
  canonicalStoreNames,
  exportedAt,
  exportedBy,
} = {}) {
  const storeNames = getActiveStoreNames(db, canonicalStoreNames);
  const tx = db.transaction(storeNames, 'readonly');
  const transactionDone = _transactionResult(tx, 'backup export');
  const reads = storeNames.map(async (storeName) => {
    const store = tx.objectStore(storeName);
    const [keys, values] = await Promise.all([
      _requestResult(store.getAllKeys(), `export ${storeName} keys`),
      _requestResult(store.getAll(), `export ${storeName} records`),
    ]);
    if (keys.length !== values.length) {
      throw _error(`export ${storeName} key/value count mismatch.`);
    }
    return [storeName, keys.map((key, index) => _entryFromKeyAndValue(key, values[index]))];
  });

  const storeEntries = await Promise.all(reads);
  await transactionDone;
  const stores = Object.fromEntries(storeEntries);
  const recordCounts = Object.fromEntries(storeNames.map(name => [name, stores[name].length]));

  return {
    _meta: {
      formatVersion: BACKUP_FORMAT_VERSION,
      entryFormat: BACKUP_ENTRY_FORMAT,
      databaseName: db.name,
      databaseVersion: db.version,
      exportedAt: exportedAt || new Date().toISOString(),
      exportedBy: exportedBy || 'unknown',
      storeNames,
      recordCounts,
    },
    stores,
  };
}

export function validateBackupSnapshot(db, backup, { canonicalStoreNames } = {}) {
  if (!_isPlainObject(backup)) throw _error('backup root must be an object.');
  if (!_isPlainObject(backup._meta)) throw _error('backup metadata is missing or invalid.');
  if (!_isPlainObject(backup.stores)) throw _error('backup stores are missing or invalid.');

  const meta = backup._meta;
  if (meta.formatVersion !== BACKUP_FORMAT_VERSION) {
    if (meta.formatVersion === 1 || meta.version === 1) {
      throw _error('legacy format version 1 is not supported because it lacks complete restore-validation metadata.');
    }
    throw _error(`unsupported backup format version: ${String(meta.formatVersion)}.`);
  }
  if (meta.entryFormat !== BACKUP_ENTRY_FORMAT) throw _error('backup entry format is unsupported.');
  if (meta.databaseName !== db.name) throw _error('backup database name does not match the active database.');
  if (!Number.isInteger(meta.databaseVersion) || meta.databaseVersion !== db.version) {
    throw _error('backup database version does not match the active database.');
  }

  const activeStoreNames = getActiveStoreNames(db, canonicalStoreNames);
  const metadataStoreNames = _sortedUniqueStoreNames(meta.storeNames, 'backup metadata store names');
  const payloadStoreNames = _sortedUniqueStoreNames(Object.keys(backup.stores), 'backup payload store names', { requireSorted: false });
  if (!_sameStringSet(metadataStoreNames, activeStoreNames)) {
    throw _error('backup store set does not exactly match the active database store set.');
  }
  if (!_sameStringSet(payloadStoreNames, activeStoreNames)) {
    throw _error('backup payload store set does not exactly match the active database store set.');
  }
  if (!_isPlainObject(meta.recordCounts)) throw _error('backup record counts are missing or invalid.');
  const countStoreNames = _sortedUniqueStoreNames(Object.keys(meta.recordCounts), 'backup record-count store names', { requireSorted: false });
  if (!_sameStringSet(countStoreNames, activeStoreNames)) {
    throw _error('backup record-count store set does not exactly match the active database store set.');
  }

  const schemaTx = db.transaction(activeStoreNames, 'readonly');
  const storeSchemas = new Map(activeStoreNames.map(name => {
    const store = schemaTx.objectStore(name);
    return [name, { keyPath: store.keyPath }];
  }));

  const normalizedStores = {};
  for (const storeName of activeStoreNames) {
    const entries = backup.stores[storeName];
    const declaredCount = meta.recordCounts[storeName];
    if (!Array.isArray(entries)) throw _error(`backup store "${storeName}" must be an array.`);
    if (!Number.isInteger(declaredCount) || declaredCount < 0 || declaredCount !== entries.length) {
      throw _error(`backup record count for store "${storeName}" is invalid or inconsistent.`);
    }

    const seenKeys = new Set();
    const keyPath = storeSchemas.get(storeName).keyPath;
    normalizedStores[storeName] = entries.map((entry, index) => {
      if (!_isPlainObject(entry) || !Object.prototype.hasOwnProperty.call(entry, 'key') || !Object.prototype.hasOwnProperty.call(entry, 'value')) {
        throw _error(`backup entry ${index} in store "${storeName}" is invalid.`);
      }
      if (!_isPlainObject(entry.value)) throw _error(`backup record ${index} in store "${storeName}" must be a plain object.`);
      if (!_isValidJsonKey(entry.key)) throw _error(`backup key ${index} in store "${storeName}" is invalid.`);

      const inlineKeyValues = _keyPathValues(entry.value, keyPath);
      if (inlineKeyValues !== null) {
        if (inlineKeyValues.some(value => !_isValidJsonKey(value))) {
          throw _error(`backup record ${index} in store "${storeName}" lacks a valid key-path value.`);
        }
        const inlineKey = typeof keyPath === 'string' ? inlineKeyValues[0] : inlineKeyValues;
        if (!_sameKey(entry.key, inlineKey)) {
          throw _error(`backup key ${index} in store "${storeName}" does not match its key-path value.`);
        }
      }

      const token = _keyToken(entry.key);
      if (seenKeys.has(token)) throw _error(`backup store "${storeName}" contains duplicate primary key values.`);
      seenKeys.add(token);
      return { key: entry.key, value: entry.value };
    });
  }

  return Object.freeze({
    storeNames: activeStoreNames,
    stores: normalizedStores,
    recordCounts: Object.fromEntries(activeStoreNames.map(name => [name, meta.recordCounts[name]])),
  });
}

export async function restoreValidatedBackup(db, validatedBackup) {
  const storeNames = validatedBackup?.storeNames;
  if (!Array.isArray(storeNames) || storeNames.length === 0) throw _error('validated backup is required.');

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, 'readwrite');
    let settled = false;
    const fail = (message, requestError = null) => {
      if (settled) return;
      try { tx.abort(); } catch (_) {}
      settled = true;
      reject(_error(`${message}${requestError?.message ? `: ${requestError.message}` : ''}`));
    };

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    tx.onerror = () => fail('restore transaction failed', tx.error);
    tx.onabort = () => {
      if (settled) return;
      settled = true;
      reject(_error(`restore transaction aborted${tx.error?.message ? `: ${tx.error.message}` : ''}`));
    };

    for (const storeName of storeNames) {
      const store = tx.objectStore(storeName);
      const clearRequest = store.clear();
      clearRequest.onerror = () => fail(`failed to clear store "${storeName}"`, clearRequest.error);

      const keyPath = store.keyPath;
      for (const entry of validatedBackup.stores[storeName]) {
        const putRequest = keyPath === null
          ? store.put(entry.value, entry.key)
          : store.put(entry.value);
        putRequest.onerror = () => fail(`failed to restore store "${storeName}"`, putRequest.error);
      }
    }
  });
}

export async function restoreAndVerifyBackup(db, validatedBackup, { verify = verifyRestoredBackup } = {}) {
  try {
    await restoreValidatedBackup(db, validatedBackup);
  } catch (err) {
    throw new BackupRestoreError('transaction', err);
  }
  try {
    await verify(db, validatedBackup);
  } catch (err) {
    throw new BackupRestoreError('verification', err);
  }
}

export async function verifyRestoredBackup(db, validatedBackup) {
  const storeNames = validatedBackup.storeNames;
  const tx = db.transaction(storeNames, 'readonly');
  const transactionDone = _transactionResult(tx, 'post-restore verification');
  const checks = storeNames.map(async (storeName) => {
    const store = tx.objectStore(storeName);
    const [keys, values] = await Promise.all([
      _requestResult(store.getAllKeys(), `verify ${storeName} keys`),
      _requestResult(store.getAll(), `verify ${storeName} records`),
    ]);
    const expected = validatedBackup.stores[storeName];
    if (keys.length !== expected.length || values.length !== expected.length) {
      throw _error(`post-restore count mismatch for store "${storeName}".`);
    }
    const actualByKey = new Map(keys.map((key, index) => [_keyToken(key), values[index]]));
    for (const entry of expected) {
      const actual = actualByKey.get(_keyToken(entry.key));
      if (actual === undefined || _stableJson(actual) !== _stableJson(entry.value)) {
        throw _error(`post-restore content mismatch for store "${storeName}".`);
      }
    }
  });
  await Promise.all(checks);
  await transactionDone;
}
