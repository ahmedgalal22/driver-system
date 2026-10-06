import { DateUtils } from '../dateUtils.js';
import {
  diagnoseHistoricalDriverDeposits,
  diagnoseVehicleLedgerDates,
} from './ledgerIntegrityDiagnostics.js';
import { ReadDataSource } from './readDataSource.js';

const LEDGER_STORE = 'vehicle_ledger';
const LEDGER_SOURCE = 'vehicle_ledger';

function _assertReadDataSource(readDataSource) {
  if (!readDataSource || typeof readDataSource.findByFields !== 'function') {
    throw new Error('[LedgerIntegrityDiagnosticService] readDataSource.findByFields is required.');
  }
}

function _assertDateUtils(dateUtils) {
  if (!dateUtils
    || typeof dateUtils.todayLocal !== 'function'
    || typeof dateUtils.nowLocal !== 'function') {
    throw new Error('[LedgerIntegrityDiagnosticService] dateUtils.todayLocal and dateUtils.nowLocal are required.');
  }
}

function _canonicalValue(value) {
  if (value === undefined) return { __ledger_integrity_type__: 'undefined' };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { __ledger_integrity_type__: 'number', value: 'NaN' };
    if (value === Infinity) return { __ledger_integrity_type__: 'number', value: 'Infinity' };
    if (value === -Infinity) return { __ledger_integrity_type__: 'number', value: '-Infinity' };
    if (Object.is(value, -0)) return { __ledger_integrity_type__: 'number', value: '-0' };
    return value;
  }
  if (typeof value === 'bigint') return { __ledger_integrity_type__: 'bigint', value: String(value) };
  if (Array.isArray(value)) return value.map(_canonicalValue);
  if (typeof value === 'object') {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = _canonicalValue(value[key]);
    }
    return normalized;
  }
  return { __ledger_integrity_type__: typeof value, value: String(value) };
}

function _stableRecordSerialization(record) {
  return JSON.stringify(_canonicalValue(record));
}

function _compareLedgerRecords(a, b) {
  const aId = Object.hasOwn(a || {}, 'id') ? `${typeof a.id}:${String(a.id)}` : 'undefined:';
  const bId = Object.hasOwn(b || {}, 'id') ? `${typeof b.id}:${String(b.id)}` : 'undefined:';
  if (aId < bId) return -1;
  if (aId > bId) return 1;

  const aSerialized = _stableRecordSerialization(a);
  const bSerialized = _stableRecordSerialization(b);
  if (aSerialized < bSerialized) return -1;
  if (aSerialized > bSerialized) return 1;
  return 0;
}

function _canonicalLedgerRecords(records) {
  if (!Array.isArray(records)) {
    throw new Error('[LedgerIntegrityDiagnosticService] ledger read must return an array.');
  }
  return records.slice().sort(_compareLedgerRecords);
}

function _canonicalLedgerSnapshot(records) {
  return JSON.stringify(records.map(_canonicalValue));
}

async function _readCanonicalLedgerRecords(readDataSource) {
  const records = await readDataSource.findByFields(
    LEDGER_STORE,
    {},
    { includeDeleted: true },
  );
  return _canonicalLedgerRecords(records);
}

function _runMetadata(dateUtils) {
  return {
    runAt: dateUtils.nowLocal(),
    source: LEDGER_SOURCE,
    today: dateUtils.todayLocal(),
  };
}

function _vehicleLedgerDateDiagnostic(records, metadata) {
  return {
    ...metadata,
    recordCount: records.length,
    ...diagnoseVehicleLedgerDates(records, metadata.today),
  };
}

function _historicalDriverDepositDiagnostic(records, metadata) {
  return {
    ...metadata,
    recordCount: records.length,
    ...diagnoseHistoricalDriverDeposits(records),
  };
}

function _verificationReadError(error, beforeCount) {
  const verificationError = new Error(
    '[LedgerIntegrityDiagnosticService] second ledger read failed; read-only verification could not be completed.',
  );
  verificationError.cause = error;
  verificationError.readOnlyVerification = Object.freeze({
    readOnlyVerified: false,
    beforeCount,
    afterCount: null,
    snapshotEqual: null,
  });
  return verificationError;
}

/**
 * Read-only application-service adapter for the pure ledger integrity
 * classifiers. Its only persistence dependency is the established
 * ReadDataSource boundary, so storage implementations may change underneath it.
 */
export function createLedgerIntegrityDiagnosticService({
  readDataSource = ReadDataSource,
  dateUtils = DateUtils,
} = {}) {
  _assertReadDataSource(readDataSource);
  _assertDateUtils(dateUtils);

  return Object.freeze({
    async getVehicleLedgerDateIntegrityDiagnostic() {
      const metadata = _runMetadata(dateUtils);
      const records = await _readCanonicalLedgerRecords(readDataSource);
      return _vehicleLedgerDateDiagnostic(records, metadata);
    },

    async getHistoricalDriverDepositIntegrityDiagnostic() {
      const metadata = _runMetadata(dateUtils);
      const records = await _readCanonicalLedgerRecords(readDataSource);
      return _historicalDriverDepositDiagnostic(records, metadata);
    },

    async getLedgerIntegrityDiagnosticSnapshot() {
      const metadata = _runMetadata(dateUtils);
      const beforeRecords = await _readCanonicalLedgerRecords(readDataSource);
      const beforeSnapshot = _canonicalLedgerSnapshot(beforeRecords);
      const vehicleLedgerDateIntegrity = _vehicleLedgerDateDiagnostic(beforeRecords, metadata);
      const historicalDriverDepositIntegrity = _historicalDriverDepositDiagnostic(beforeRecords, metadata);

      let afterRecords;
      try {
        afterRecords = await _readCanonicalLedgerRecords(readDataSource);
      } catch (error) {
        throw _verificationReadError(error, beforeRecords.length);
      }

      const afterSnapshot = _canonicalLedgerSnapshot(afterRecords);
      const snapshotEqual = beforeSnapshot === afterSnapshot;

      return {
        ...metadata,
        vehicleLedgerDateIntegrity,
        historicalDriverDepositIntegrity,
        readOnlyVerification: {
          readOnlyVerified: snapshotEqual,
          beforeCount: beforeRecords.length,
          afterCount: afterRecords.length,
          snapshotEqual,
        },
      };
    },
  });
}

export const LedgerIntegrityDiagnosticService = createLedgerIntegrityDiagnosticService();
