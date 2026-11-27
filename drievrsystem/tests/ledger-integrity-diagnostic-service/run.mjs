// run.mjs — Read-only Vehicle Ledger Date Integrity Diagnostic Service contract.
import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { createLedgerIntegrityDiagnosticService } = await import('./services/ledgerIntegrityDiagnosticService.js');
const { diagnoseVehicleLedgerDates } = await import('./services/ledgerIntegrityDiagnostics.js');

const U = 'ledger-integrity-diagnostic-service-tester';
const FINANCIAL_SRC = readFileSync('./financial.js', 'utf8');
const DIAGNOSTIC_SERVICE_SRC = readFileSync('./services/ledgerIntegrityDiagnosticService.js', 'utf8');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};

const FIXED_DATE_UTILS = Object.freeze({
  todayLocal: () => '2026-06-15',
  nowLocal: () => '2026-06-15T12:34:56',
});
const REMOVED_LEGACY_SNAPSHOT_FIELD = ['historical', 'Driver', 'Deposit', 'Integrity'].join('');
const cloneRecords = records => records.map(record => ({ ...record }));

function fixtureRecord(id, overrides = {}) {
  return {
    id,
    username: U,
    owner_id: 'owner-a',
    owner_name: 'مالك اختبار',
    client_id: 'owner-a',
    client_type: 'owner',
    vehicle_id: 'vehicle-a',
    vehicle_plate: '111 أ ب',
    type: 'deposit',
    amount: 1000,
    date: '2026-01-10',
    reference_type: 'fixture',
    reference_id: `fixture-${id}`,
    is_reversed: false,
    deleted_at: null,
    ...overrides,
  };
}

const FIXTURE_RECORDS = [
  fixtureRecord(4, { type: 'withdraw', amount: 1200, date: '2026/01/10', reference_type: 'invalid-format' }),
  fixtureRecord(1, { amount: 1100, date: '2026-01-01', reference_type: 'valid-date' }),
  fixtureRecord(6, { type: 'deposit', amount: 1600, date: '2999-01-01', reference_type: 'future-date' }),
  fixtureRecord(3, { type: 'withdraw', amount: 1400, date: '2026-02-30', is_reversed: true, reference_type: 'reversed-invalid' }),
  fixtureRecord(5, { type: 'driver_karta_payment', amount: -1500, date: '2026-01-11', reference_type: 'receipt_row' }),
  fixtureRecord(2, { type: 'deposit', amount: 1300, date: undefined, deleted_at: '2026-06-01T10:00:00', reference_type: 'deleted-missing' }),
];

function makeReadBoundary(responses) {
  const calls = [];
  let writeCalls = 0;
  let readIndex = 0;
  return {
    readDataSource: {
      async findByFields(...args) {
        calls.push(args);
        const response = responses[Math.min(readIndex, responses.length - 1)];
        readIndex++;
        if (response instanceof Error) throw response;
        return cloneRecords(response);
      },
      async add() { writeCalls++; throw new Error('write must not be called'); },
      async update() { writeCalls++; throw new Error('write must not be called'); },
      async delete() { writeCalls++; throw new Error('write must not be called'); },
      async transaction() { writeCalls++; throw new Error('write must not be called'); },
    },
    calls,
    getWriteCalls: () => writeCalls,
  };
}

console.log('\n— architecture and read-boundary contract —');
const diagnosticApiSource = FINANCIAL_SRC.slice(
  FINANCIAL_SRC.indexOf('async function getVehicleLedgerDateIntegrityDiagnostic'),
  FINANCIAL_SRC.indexOf('function _parseMonthlyReportMonthKey'),
);
ok(FINANCIAL_SRC.includes("import { LedgerIntegrityDiagnosticService } from './services/ledgerIntegrityDiagnosticService.js';")
  && diagnosticApiSource.includes('LedgerIntegrityDiagnosticService.getVehicleLedgerDateIntegrityDiagnostic()')
  && diagnosticApiSource.includes('LedgerIntegrityDiagnosticService.getLedgerIntegrityDiagnosticSnapshot()')
  && !diagnosticApiSource.includes('HistoricalDriverDeposit')
  && !diagnosticApiSource.includes('DB.'),
'FinancialService retains only date-integrity diagnostic delegation without direct database access');
ok(DIAGNOSTIC_SERVICE_SRC.includes("import { ReadDataSource } from './readDataSource.js';")
  && !DIAGNOSTIC_SERVICE_SRC.includes("from '../database.js'")
  && !/\bindexedDB\b|IDBTransaction|objectStore|\.open\(/.test(DIAGNOSTIC_SERVICE_SRC),
'diagnostic service uses the established ReadDataSource boundary with no IndexedDB-specific access');

const boundary = makeReadBoundary([FIXTURE_RECORDS, FIXTURE_RECORDS, FIXTURE_RECORDS, FIXTURE_RECORDS]);
const diagnosticService = createLedgerIntegrityDiagnosticService({
  readDataSource: boundary.readDataSource,
  dateUtils: FIXED_DATE_UTILS,
});
const dateDiagnostic = await diagnosticService.getVehicleLedgerDateIntegrityDiagnostic();
const snapshotDiagnostic = await diagnosticService.getLedgerIntegrityDiagnosticSnapshot();

ok(boundary.calls.every(args => args.length === 3
  && args[0] === 'vehicle_ledger'
  && JSON.stringify(args[1]) === '{}'
  && JSON.stringify(args[2]) === JSON.stringify({ includeDeleted: true })),
'all diagnostic reads request complete vehicle_ledger history through findByFields(includeDeleted:true)');
ok(boundary.getWriteCalls() === 0,
'diagnostic execution invokes no write-capable operation on the injected read boundary');

console.log('\n— date classifier and combined snapshot —');
const expectedDate = diagnoseVehicleLedgerDates(FIXTURE_RECORDS, FIXED_DATE_UTILS.todayLocal());
ok(dateDiagnostic.runAt === '2026-06-15T12:34:56'
  && dateDiagnostic.source === 'vehicle_ledger'
  && dateDiagnostic.today === '2026-06-15'
  && dateDiagnostic.recordCount === FIXTURE_RECORDS.length
  && dateDiagnostic.total_active_vehicle_ledger_rows === expectedDate.total_active_vehicle_ledger_rows
  && dateDiagnostic.invalid_formats === expectedDate.invalid_formats
  && dateDiagnostic.future_dated_rows === expectedDate.future_dated_rows
  && dateDiagnostic.excluded_active_vehicle_custom_type_rows.length === expectedDate.excluded_active_vehicle_custom_type_rows.length,
'vehicle-ledger date DTO preserves pure date-classifier aggregates and custom-type exclusion');
ok(snapshotDiagnostic.runAt === '2026-06-15T12:34:56'
  && snapshotDiagnostic.vehicleLedgerDateIntegrity.runAt === snapshotDiagnostic.runAt
  && snapshotDiagnostic.vehicleLedgerDateIntegrity.total_active_vehicle_ledger_rows === dateDiagnostic.total_active_vehicle_ledger_rows
  && snapshotDiagnostic.readOnlyVerification.readOnlyVerified === true
  && snapshotDiagnostic.readOnlyVerification.snapshotEqual === true
  && snapshotDiagnostic.readOnlyVerification.beforeCount === FIXTURE_RECORDS.length
  && snapshotDiagnostic.readOnlyVerification.afterCount === FIXTURE_RECORDS.length
  && !Object.hasOwn(snapshotDiagnostic, REMOVED_LEGACY_SNAPSHOT_FIELD),
'combined snapshot preserves date diagnostics and read-only verification without legacy Driver Deposit output');

console.log('\n— deterministic canonical ordering and verification failures —');
const reordered = [...FIXTURE_RECORDS].reverse();
const orderedSnapshot = await createLedgerIntegrityDiagnosticService({
  readDataSource: makeReadBoundary([FIXTURE_RECORDS, FIXTURE_RECORDS]).readDataSource,
  dateUtils: FIXED_DATE_UTILS,
}).getLedgerIntegrityDiagnosticSnapshot();
const reorderedSnapshot = await createLedgerIntegrityDiagnosticService({
  readDataSource: makeReadBoundary([reordered, reordered]).readDataSource,
  dateUtils: FIXED_DATE_UTILS,
}).getLedgerIntegrityDiagnosticSnapshot();
ok(JSON.stringify(orderedSnapshot) === JSON.stringify(reorderedSnapshot),
'same logical ledger records in different input order produce the same canonical date diagnostic snapshot');

const changedRecords = cloneRecords(FIXTURE_RECORDS);
changedRecords.find(record => record.id === 1).amount = 9999;
const changedSnapshot = await createLedgerIntegrityDiagnosticService({
  readDataSource: makeReadBoundary([FIXTURE_RECORDS, changedRecords]).readDataSource,
  dateUtils: FIXED_DATE_UTILS,
}).getLedgerIntegrityDiagnosticSnapshot();
ok(changedSnapshot.readOnlyVerification.readOnlyVerified === false
  && changedSnapshot.readOnlyVerification.snapshotEqual === false,
'a changed second read is reported as an unsuccessful read-only verification');

const secondReadFailure = new Error('second read failed');
let verificationFailure = null;
try {
  await createLedgerIntegrityDiagnosticService({
    readDataSource: makeReadBoundary([FIXTURE_RECORDS, secondReadFailure]).readDataSource,
    dateUtils: FIXED_DATE_UTILS,
  }).getLedgerIntegrityDiagnosticSnapshot();
} catch (error) {
  verificationFailure = error;
}
ok(verificationFailure?.cause === secondReadFailure
  && verificationFailure.readOnlyVerification?.readOnlyVerified === false
  && verificationFailure.readOnlyVerification?.snapshotEqual === null,
'a failed second read throws an explicit verification error and never reports success');

console.log('\n— real FinancialService adapter read-only contract —');
await DB.init();
for (const sourceRecord of FIXTURE_RECORDS) {
  const payload = { ...sourceRecord };
  delete payload.id;
  const isReversed = payload.is_reversed === true;
  const isDeleted = payload.deleted_at !== null;
  payload.is_reversed = false;
  payload.deleted_at = null;
  const saved = await DB.add('vehicle_ledger', payload, { username: U });
  if (isReversed) {
    await DB.update('vehicle_ledger', saved.id, {
      is_reversed: true,
      reversed_at: '2026-06-01T10:00:00',
      reversed_by: U,
    }, { username: U });
  }
  if (isDeleted) await DB.delete('vehicle_ledger', saved.id, { username: U });
}

const beforeDatabaseDiagnostic = await DB.findByFields('vehicle_ledger', {}, { includeDeleted: true });
const financialDateDiagnostic = await FinancialService.getVehicleLedgerDateIntegrityDiagnostic();
const financialSnapshotDiagnostic = await FinancialService.getLedgerIntegrityDiagnosticSnapshot();
const afterDatabaseDiagnostic = await DB.findByFields('vehicle_ledger', {}, { includeDeleted: true });
const expectedFinancialDate = diagnoseVehicleLedgerDates(beforeDatabaseDiagnostic, financialDateDiagnostic.today);
ok(financialDateDiagnostic.recordCount === beforeDatabaseDiagnostic.length
  && financialDateDiagnostic.total_active_vehicle_ledger_rows === expectedFinancialDate.total_active_vehicle_ledger_rows
  && financialDateDiagnostic.invalid_formats === expectedFinancialDate.invalid_formats
  && financialDateDiagnostic.future_dated_rows === expectedFinancialDate.future_dated_rows,
'FinancialService vehicle-ledger date API reads complete history and returns pure classifier aggregates');
ok(financialSnapshotDiagnostic.readOnlyVerification.readOnlyVerified === true
  && financialSnapshotDiagnostic.readOnlyVerification.beforeCount === beforeDatabaseDiagnostic.length
  && financialSnapshotDiagnostic.readOnlyVerification.afterCount === beforeDatabaseDiagnostic.length
  && !Object.hasOwn(financialSnapshotDiagnostic, REMOVED_LEGACY_SNAPSHOT_FIELD)
  && JSON.stringify(afterDatabaseDiagnostic) === JSON.stringify(beforeDatabaseDiagnostic),
'FinancialService date diagnostic snapshot is read-only and has no legacy Driver Deposit field');

console.log(failures === 0
  ? '\n✅ ALL LEDGER-INTEGRITY-DIAGNOSTIC-SERVICE ASSERTIONS PASSED'
  : `\n❌ ${failures} LEDGER-INTEGRITY-DIAGNOSTIC-SERVICE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
