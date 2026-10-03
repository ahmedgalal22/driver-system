// run.mjs — Read-only Phase 6C historical Driver Deposit integrity diagnostic.
// This test deliberately reads all ledger rows including historical soft-deleted
// records and never calls a mutation after fixture creation.
import { installIDB } from './idb-shim.mjs';
installIDB();

const { DB } = await import('./database.js');

const U = 'driver-deposit-integrity-tester';
const LEGACY_REF_TYPE = 'driver_deposit';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();

await DB.init();

const OWNER_A = uuid();
const OWNER_B = uuid();
const DRIVER_A = uuid();
const DRIVER_B = uuid();
const VEHICLE_A = uuid();
const VEHICLE_B = uuid();

const stateOf = (entry) => ({
  active: entry.is_reversed === false && entry.deleted_at === null,
  reversed: entry.is_reversed === true,
  deleted: entry.deleted_at !== null,
});

function isLegacyCandidate(entry) {
  return entry?.reference_type === LEGACY_REF_TYPE || entry?.type === LEGACY_REF_TYPE;
}

function isDriverLeg(entry) {
  return isLegacyCandidate(entry)
    && (entry.client_type === 'driver' || entry.type === LEGACY_REF_TYPE)
    && entry.type !== 'withdraw';
}

function isVehicleLeg(entry) {
  return isLegacyCandidate(entry) && entry.type === 'withdraw';
}

function detail(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    driver_id: entry.client_type === 'driver' ? entry.owner_id || null : null,
    vehicle_id: entry.vehicle_id || null,
    amount: entry.amount,
    date: entry.date || null,
    active: stateOf(entry).active,
    reversed: stateOf(entry).reversed,
    deleted: stateOf(entry).deleted,
    type: entry.type || null,
    client_type: entry.client_type || null,
  };
}

/**
 * Read-only diagnostic. It recognizes both the historically observed driver
 * type=deposit form and the older marker-style type=driver_deposit form, but
 * it requires a legacy marker before treating a withdrawal as a candidate.
 */
function diagnoseHistoricalDriverDeposits(records) {
  const candidates = records.filter(isLegacyCandidate);
  const groups = new Map();
  let invalidOrdinal = 0;

  for (const entry of candidates) {
    const rawReference = typeof entry.reference_id === 'string' ? entry.reference_id.trim() : '';
    const key = rawReference || `__invalid__${entry.id ?? ++invalidOrdinal}`;
    if (!groups.has(key)) groups.set(key, { reference_id: rawReference || null, entries: [] });
    groups.get(key).entries.push(entry);
  }

  const reports = [...groups.values()].map(group => {
    const driverLegs = group.entries.filter(isDriverLeg);
    const vehicleLegs = group.entries.filter(isVehicleLeg);
    const allActive = group.entries.every(entry => stateOf(entry).active);
    const hasInactive = group.entries.some(entry => !stateOf(entry).active);
    const hasActive = group.entries.some(entry => stateOf(entry).active);
    const flags = [];

    if (!group.reference_id) {
      flags.push('invalid_reference');
    } else {
      if (driverLegs.length === 0 && vehicleLegs.length > 0) flags.push('vehicle_only');
      if (vehicleLegs.length === 0 && driverLegs.length > 0) flags.push('driver_only');
      if (driverLegs.length > 1) flags.push('duplicate_driver');
      if (vehicleLegs.length > 1) flags.push('duplicate_vehicle');
    }

    const oneDriver = driverLegs.length === 1 ? driverLegs[0] : null;
    const oneVehicle = vehicleLegs.length === 1 ? vehicleLegs[0] : null;
    if (group.reference_id && oneDriver && oneVehicle) {
      const driverAmount = Number(oneDriver.amount);
      const vehicleAmount = Number(oneVehicle.amount);
      const malformed = oneDriver.client_type !== 'driver'
        || !String(oneDriver.owner_id || '').trim()
        || !String(oneDriver.vehicle_id || '').trim()
        || !String(oneVehicle.vehicle_id || '').trim()
        || !String(oneVehicle.owner_id || '').trim()
        || String(oneDriver.vehicle_id) !== String(oneVehicle.vehicle_id)
        || !Number.isFinite(driverAmount)
        || !Number.isFinite(vehicleAmount)
        || driverAmount <= 0
        || vehicleAmount <= 0
        || driverAmount !== vehicleAmount;
      if (malformed) flags.push('driver_vehicle_mismatch');
    }

    if (hasInactive) flags.push('reversed_or_deleted_history');

    const activeStructuralFlags = flags.filter(flag => flag !== 'reversed_or_deleted_history');
    const completeActive = allActive && activeStructuralFlags.length === 0
      && driverLegs.length === 1 && vehicleLegs.length === 1;
    const primary = completeActive
      ? 'complete'
      : !group.reference_id
        ? 'invalid_reference'
        : hasInactive
          ? 'reversed_or_deleted_history'
          : flags[0] || 'driver_vehicle_mismatch';

    return {
      reference_id: group.reference_id,
      primary,
      flags,
      active_problematic: hasActive && !completeActive,
      driver_legs: driverLegs.map(detail),
      vehicle_legs: vehicleLegs.map(detail),
    };
  }).sort((a, b) => String(a.reference_id || '').localeCompare(String(b.reference_id || '')));

  const count = (predicate) => reports.filter(predicate).length;
  return {
    total_candidate_reference_ids: reports.length,
    complete_pairs: count(report => report.primary === 'complete'),
    driver_only_pairs: count(report => report.flags.includes('driver_only')),
    vehicle_only_pairs: count(report => report.flags.includes('vehicle_only')),
    duplicate_driver_cases: count(report => report.flags.includes('duplicate_driver')),
    duplicate_vehicle_cases: count(report => report.flags.includes('duplicate_vehicle')),
    driver_vehicle_mismatch_cases: count(report => report.flags.includes('driver_vehicle_mismatch')),
    invalid_reference_cases: count(report => report.flags.includes('invalid_reference')),
    reversed_or_deleted_history_cases: count(report => report.flags.includes('reversed_or_deleted_history')),
    active_problematic_cases: count(report => report.active_problematic),
    reports,
  };
}

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
