// run.mjs — Read-only Phase 6C historical Driver Deposit integrity diagnostic.
// This test deliberately reads all ledger rows including historical soft-deleted
// records and never calls a mutation after fixture creation.
import { installIDB } from './idb-shim.mjs';
installIDB();

const { DB } = await import('./database.js');
const { diagnoseHistoricalDriverDeposits, LEGACY_DRIVER_DEPOSIT_REFERENCE_TYPE } = await import('./services/ledgerIntegrityDiagnostics.js');

const U = 'driver-deposit-integrity-tester';
const LEGACY_REF_TYPE = LEGACY_DRIVER_DEPOSIT_REFERENCE_TYPE;
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();

await DB.init();

const emptyDiagnostic = diagnoseHistoricalDriverDeposits([]);
ok(emptyDiagnostic.total_candidate_reference_ids === 0
  && emptyDiagnostic.complete_pairs === 0
  && emptyDiagnostic.active_problematic_cases === 0,
  'shared Driver Deposit classifier handles an empty ledger deterministically');

const OWNER_A = uuid();
const OWNER_B = uuid();
const DRIVER_A = uuid();
const DRIVER_B = uuid();
const VEHICLE_A = uuid();
const VEHICLE_B = uuid();

async function addLegacy(entry) {
  return DB.add('vehicle_ledger', entry, { username: U });
}

function legacyDriver(reference_id, {
  amount = 5000,
  vehicle_id = VEHICLE_A,
  driver_id = DRIVER_A,
  type = 'deposit',
} = {}) {
  return {
    username: U,
    owner_id: driver_id,
    owner_name: 'سائق تاريخي',
    client_id: driver_id,
    client_type: 'driver',
    client_name: 'سائق تاريخي',
    vehicle_id,
    vehicle_plate: '111 أ ب',
    type,
    amount,
    reference_type: LEGACY_REF_TYPE,
    reference_id,
    date: '2025-01-10',
    applied_at: '2025-01-10T10:00:00',
    is_reversed: false,
    note: 'إيداع تاريخي للسائق',
  };
}

function legacyVehicle(reference_id, {
  amount = 5000,
  vehicle_id = VEHICLE_A,
  owner_id = OWNER_A,
} = {}) {
  return {
    username: U,
    owner_id,
    owner_name: 'مالك تاريخي',
    client_id: owner_id,
    client_type: 'owner',
    client_name: 'مالك تاريخي',
    vehicle_id,
    vehicle_plate: '111 أ ب',
    type: 'withdraw',
    amount,
    reference_type: LEGACY_REF_TYPE,
    reference_id,
    date: '2025-01-10',
    applied_at: '2025-01-10T10:00:00',
    is_reversed: false,
    note: 'إيداع تاريخي للسائق من المركبة',
  };
}

console.log('\n— seed deterministic legacy Driver Deposit fixture —');

// 1. Complete active pair using the actual historical type=deposit shape.
await addLegacy(legacyVehicle('complete-active'));
await addLegacy(legacyDriver('complete-active'));

// Additional historical marker variant: driver type=driver_deposit remains recognizable.
await addLegacy(legacyVehicle('complete-marker-type', { amount: 6100 }));
await addLegacy(legacyDriver('complete-marker-type', { amount: 6100, type: LEGACY_REF_TYPE }));

// 2–7. Structural problems.
await addLegacy(legacyDriver('driver-only'));
await addLegacy(legacyVehicle('vehicle-only'));
await addLegacy(legacyVehicle('duplicate-driver'));
await addLegacy(legacyDriver('duplicate-driver'));
await addLegacy(legacyDriver('duplicate-driver'));
await addLegacy(legacyDriver('duplicate-vehicle'));
await addLegacy(legacyVehicle('duplicate-vehicle'));
await addLegacy(legacyVehicle('duplicate-vehicle'));
await addLegacy(legacyDriver('driver-vehicle-mismatch', { amount: 5000, vehicle_id: VEHICLE_A, driver_id: DRIVER_A }));
await addLegacy(legacyVehicle('driver-vehicle-mismatch', { amount: 5100, vehicle_id: VEHICLE_B, owner_id: OWNER_B }));
await addLegacy(legacyDriver('', { amount: 7000 }));

// 8. Complete pair whose both legs are reversed.
const reversedVehicle = await addLegacy(legacyVehicle('both-reversed', { amount: 7100 }));
const reversedDriver = await addLegacy(legacyDriver('both-reversed', { amount: 7100 }));
await DB.update('vehicle_ledger', reversedVehicle.id, { is_reversed: true, reversed_at: '2025-01-11T10:00:00', reversed_by: U }, { username: U });
await DB.update('vehicle_ledger', reversedDriver.id, { is_reversed: true, reversed_at: '2025-01-11T10:00:00', reversed_by: U }, { username: U });

// 9. One side reversed/deleted remains visible as historical mixed state.
const mixedVehicle = await addLegacy(legacyVehicle('mixed-history', { amount: 7200 }));
const mixedDriver = await addLegacy(legacyDriver('mixed-history', { amount: 7200 }));
await DB.update('vehicle_ledger', mixedDriver.id, { is_reversed: true, reversed_at: '2025-01-11T10:00:00', reversed_by: U }, { username: U });
await DB.delete('vehicle_ledger', mixedVehicle.id, { username: U });

// 10–12. Unrelated modern rows must never become legacy candidates.
await addLegacy({
  ...legacyVehicle('manual-vehicle-reference'),
  reference_type: 'manual_vehicle_balance', effect: 'manual_vehicle_balance', amount: 9000,
});
await addLegacy({
  ...legacyDriver('manual-driver-reference'),
  vehicle_id: null, type: 'deposit', reference_type: 'manual_driver_balance', effect: 'manual_driver_balance', amount: 9100,
});
await addLegacy({
  ...legacyDriver('karta-reference'),
  type: 'driver_karta_payment', amount: -9200, reference_type: 'receipt_row', reference_id: 'receipt-row-1',
});
await addLegacy({
  ...legacyVehicle('karta-charge-reference'),
  effect: 'karta_settlement_charge', amount: 9200, reference_type: 'receipt_row', reference_id: 'receipt-row-1',
});
await addLegacy({
  ...legacyVehicle('receipt-payment-reference'),
  type: 'deposit', effect: 'receipt_row_payment', reference_type: 'receipt_row_payment', reference_id: 'receipt-row-2', amount: 9300,
});

const before = await DB.findByFields('vehicle_ledger', {}, { includeDeleted: true });
const report = diagnoseHistoricalDriverDeposits(before);
const after = await DB.findByFields('vehicle_ledger', {}, { includeDeleted: true });

console.log('\n— read-only Driver Deposit integrity report —');
console.log(JSON.stringify({
  total_candidate_reference_ids: report.total_candidate_reference_ids,
  complete_pairs: report.complete_pairs,
  driver_only_pairs: report.driver_only_pairs,
  vehicle_only_pairs: report.vehicle_only_pairs,
  duplicate_driver_cases: report.duplicate_driver_cases,
  duplicate_vehicle_cases: report.duplicate_vehicle_cases,
  driver_vehicle_mismatch_cases: report.driver_vehicle_mismatch_cases,
  invalid_reference_cases: report.invalid_reference_cases,
  reversed_or_deleted_history_cases: report.reversed_or_deleted_history_cases,
  active_problematic_cases: report.active_problematic_cases,
}, null, 2));
console.log('active problematic references:', JSON.stringify(report.reports
  .filter(item => item.active_problematic)
  .map(item => ({
    reference_id: item.reference_id,
    flags: item.flags,
    driver_legs: item.driver_legs,
    vehicle_legs: item.vehicle_legs,
  })), null, 2));

console.log('\n— classification and non-mutation assertions —');
ok(report.total_candidate_reference_ids === 10, 'diagnostic finds exactly ten legacy Driver Deposit reference groups');
ok(report.complete_pairs === 2, 'both historical driver type conventions form complete active pairs');
ok(report.driver_only_pairs === 1, 'driver-only historical reference is classified');
ok(report.vehicle_only_pairs === 1, 'vehicle-only historical reference is classified');
ok(report.duplicate_driver_cases === 1, 'duplicate driver-side legs are classified');
ok(report.duplicate_vehicle_cases === 1, 'duplicate vehicle-side legs are classified');
ok(report.driver_vehicle_mismatch_cases === 1, 'mismatched amount/vehicle pair is classified');
ok(report.invalid_reference_cases === 1, 'missing reference identity is classified as invalid');
ok(report.reversed_or_deleted_history_cases === 2, 'both-reversed and mixed historical pairs are reported separately');
ok(report.active_problematic_cases === 6,
  'active problematic cases exclude complete pairs and fully inactive historical references');

const complete = report.reports.find(item => item.reference_id === 'complete-active');
const historical = report.reports.find(item => item.reference_id === 'both-reversed');
const mixed = report.reports.find(item => item.reference_id === 'mixed-history');
ok(complete?.primary === 'complete' && complete.driver_legs.length === 1 && complete.vehicle_legs.length === 1,
  'complete active pair carries one driver deposit and one vehicle withdrawal');
ok(historical?.primary === 'reversed_or_deleted_history' && !historical.active_problematic,
  'fully reversed historical pair is visible but not treated as active financial inconsistency');
ok(mixed?.primary === 'reversed_or_deleted_history' && !mixed.active_problematic,
  'mixed reversed/deleted state is visible as inactive historical evidence without being treated as an active inconsistency');

const candidateRefs = new Set(report.reports.flatMap(item => [item.reference_id, ...item.driver_legs.map(leg => leg.id), ...item.vehicle_legs.map(leg => leg.id)]));
ok(!candidateRefs.has('manual-vehicle-reference')
  && !candidateRefs.has('manual-driver-reference')
  && !candidateRefs.has('receipt-row-1')
  && !candidateRefs.has('receipt-row-2'),
  'manual vehicle, manual driver, Karta, Karta charge, and receipt payment rows are not misclassified');
ok(JSON.stringify(after) === JSON.stringify(before),
  'diagnostic is read-only: every ledger record is logically unchanged after reporting');

console.log(failures === 0
  ? '\n✅ ALL DRIVER-DEPOSIT-INTEGRITY ASSERTIONS PASSED'
  : `\n❌ ${failures} DRIVER-DEPOSIT-INTEGRITY FAILURES`);
process.exit(failures === 0 ? 0 : 1);
