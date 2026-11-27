// run.mjs — Read-only Phase 6D active vehicle-ledger business-date diagnostic.
import { installIDB } from './idb-shim.mjs';
installIDB();

const { DB } = await import('./database.js');
const { DateUtils } = await import('./dateUtils.js');
const { classifyBusinessDate, diagnoseVehicleLedgerDates } = await import('./services/ledgerIntegrityDiagnostics.js');

const U = 'vehicle-ledger-date-integrity-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();

await DB.init();

const dateBoundaryToday = '2026-01-01';
ok(classifyBusinessDate('2024-02-29', dateBoundaryToday).category === 'valid_date'
  && classifyBusinessDate('2026-02-29', dateBoundaryToday).category === 'invalid_calendar_date'
  && classifyBusinessDate('2026-01-01', dateBoundaryToday).future === false
  && classifyBusinessDate('2026-01-02', dateBoundaryToday).future === true,
  'shared date classifier preserves leap-year, today, and future boundary behavior');
ok(classifyBusinessDate(null, dateBoundaryToday).category === 'missing_date'
  && classifyBusinessDate('', dateBoundaryToday).category === 'missing_date'
  && classifyBusinessDate('2026/01/01', dateBoundaryToday).category === 'invalid_format'
  && classifyBusinessDate(20260101, dateBoundaryToday).category === 'invalid_type',
  'shared date classifier preserves missing, malformed, and invalid-type boundaries');

const OWNER_ID = uuid();
const VEHICLE_ID = uuid();
const DRIVER_ID = uuid();

async function addLedger({
  vehicle_id = VEHICLE_ID,
  type = 'deposit',
  amount = 1000,
  date,
  effect = null,
  reference_type = 'fixture',
  reference_id = uuid(),
  maintenance_type = undefined,
}) {
  const payload = {
    username: U,
    owner_id: OWNER_ID,
    owner_name: 'مالك اختبار',
    client_id: OWNER_ID,
    client_type: 'owner',
    vehicle_id,
    vehicle_plate: '111 أ ب',
    type,
    amount,
    ...(effect ? { effect } : {}),
    reference_type,
    reference_id,
    ...(date !== undefined ? { date } : {}),
    applied_at: '2026-06-15T10:00:00',
    is_reversed: false,
    note: 'تاريخ تشخيصي',
    ...(maintenance_type ? { maintenance_type } : {}),
  };
  return DB.add('vehicle_ledger', payload, { username: U });
}

console.log('\n— seed deterministic active vehicle-ledger date fixture —');
const today = DateUtils.todayLocal();

// 1–12: active, vehicle-linked, balance-relevant rows.
const validNormalized = await addLedger({ type: 'deposit', amount: 1000, date: '2026-01-15', reference_type: 'valid_normalized' });
const missingDate = await addLedger({ type: 'deposit', amount: 1100, date: undefined, reference_type: 'missing_date' });
const emptyDate = await addLedger({ type: 'withdraw', amount: 1200, date: '', reference_type: 'empty_date' });
const invalidFormat = await addLedger({ type: 'deposit', amount: 1300, date: '2026/01/15', reference_type: 'invalid_format' });
const invalidCalendar = await addLedger({ type: 'withdraw', amount: 1400, date: '2026-02-30', reference_type: 'invalid_calendar' });
const invalidType = await addLedger({ type: 'deposit', amount: 1500, date: 20260115, reference_type: 'invalid_type' });
const historical = await addLedger({ type: 'deposit', amount: 1600, date: '2020-01-15', reference_type: 'historical' });
const currentPeriod = await addLedger({ type: 'withdraw', amount: 1700, date: today, reference_type: 'current_period' });
const future = await addLedger({ type: 'deposit', amount: 1800, date: '2999-01-01', reference_type: 'future_date' });
const kartaCharge = await addLedger({ type: 'withdraw', amount: 1900, date: '2026-06-10', effect: 'karta_settlement_charge', reference_type: 'receipt_row' });
const maintenance = await addLedger({ type: 'withdraw', amount: 2000, date: '2026-06-11', effect: 'manual_vehicle_balance', reference_type: 'manual_vehicle_balance', maintenance_type: 'زيت' });
const manualVehicle = await addLedger({ type: 'deposit', amount: 2100, date: '2026-06-12', effect: 'manual_vehicle_balance', reference_type: 'manual_vehicle_balance' });

// Reversed/deleted rows must not enter active report population.
const reversedInvalid = await addLedger({ type: 'withdraw', amount: 2200, date: 'bad-date', reference_type: 'reversed_invalid' });
await DB.update('vehicle_ledger', reversedInvalid.id, { is_reversed: true, reversed_at: '2026-06-15T10:00:00', reversed_by: U }, { username: U });
const deletedInvalid = await addLedger({ type: 'deposit', amount: 2300, date: 'also-bad', reference_type: 'deleted_invalid' });
await DB.delete('vehicle_ledger', deletedInvalid.id, { username: U });

// Driver-only and custom settlement rows are not vehicle-report arithmetic.
await addLedger({
  vehicle_id: null,
  type: 'deposit',
  amount: 2400,
  date: '2026-06-13',
  effect: 'manual_driver_balance',
  reference_type: 'manual_driver_balance',
  reference_id: uuid(),
});
await addLedger({
  vehicle_id: VEHICLE_ID,
  type: 'driver_karta_payment',
  amount: -2500,
  date: '2026-06-14',
  reference_type: 'receipt_row',
  reference_id: uuid(),
});

const before = await DB.findByFields('vehicle_ledger', {}, { includeDeleted: true });
const report = diagnoseVehicleLedgerDates(before, today);
const after = await DB.findByFields('vehicle_ledger', {}, { includeDeleted: true });

console.log('\n— read-only active vehicle-ledger date report —');
console.log(JSON.stringify({
  total_active_vehicle_ledger_rows: report.total_active_vehicle_ledger_rows,
  valid_dates: report.valid_dates,
  missing_dates: report.missing_dates,
  invalid_formats: report.invalid_formats,
  invalid_calendar_dates: report.invalid_calendar_dates,
  invalid_date_types: report.invalid_date_types,
  future_dated_rows: report.future_dated_rows,
  rows_by_type: report.rows_by_type,
  rows_by_effect: report.rows_by_effect,
  rows_by_reference_type: report.rows_by_reference_type,
}, null, 2));
console.log('problematic active rows:', JSON.stringify(report.problematic_active_rows, null, 2));
console.log('future rows:', JSON.stringify(report.future_rows, null, 2));

console.log('\n— classification and non-mutation assertions —');
ok(report.total_active_vehicle_ledger_rows === 12, 'diagnostic inspects exactly twelve active vehicle-linked deposit/withdraw rows');
ok(report.valid_dates === 7, 'seven active rows carry valid normalized business dates');
ok(report.missing_dates === 2, 'missing and empty dates are classified separately from valid dates');
ok(report.invalid_formats === 1, 'non-YYYY-MM-DD string is classified as invalid format');
ok(report.invalid_calendar_dates === 1, 'impossible calendar date is rejected without JavaScript coercion');
ok(report.invalid_date_types === 1, 'non-string date value is classified as invalid type');
ok(report.future_dated_rows === 1 && report.future_rows[0]?.id === future.id,
  'future date is reported separately while remaining a valid normalized business date');
ok(report.rows_by_type.deposit === 7 && report.rows_by_type.withdraw === 5,
  'active report population is counted correctly by deposit/withdraw type');
ok(report.rows_by_effect.karta_settlement_charge === 1
  && report.rows_by_effect.manual_vehicle_balance === 2,
  'Karta settlement, maintenance, and manual vehicle movements remain in report population');
ok(report.rows_by_reference_type.receipt_row === 1
  && report.rows_by_reference_type.manual_vehicle_balance === 2,
  'effect/reference classifications remain available for monthly report detail');
ok(report.problematic_active_rows.map(row => row.id).sort().join(',') === [
  missingDate.id, emptyDate.id, invalidFormat.id, invalidCalendar.id, invalidType.id,
].sort().join(','), 'problematic active rows include exactly missing/malformed/invalid business-date fixtures');
ok(report.excluded_active_vehicle_custom_type_rows.length === 1
  && report.excluded_active_vehicle_custom_type_rows[0].type === 'driver_karta_payment',
  'vehicle-linked driver_karta_payment is surfaced separately but excluded from vehicle-balance arithmetic');
ok(!report.problematic_active_rows.some(row => row.id === reversedInvalid.id || row.id === deletedInvalid.id),
  'reversed/deleted invalid-date rows are excluded from active report population');
ok(!report.problematic_active_rows.some(row => row.reference_type === 'manual_driver_balance'),
  'driver-only row with vehicle_id:null is excluded from vehicle-report population');
ok(JSON.stringify(after) === JSON.stringify(before),
  'diagnostic is read-only: every logical ledger record remains unchanged after reporting');
ok(validNormalized.id && historical.id && currentPeriod.id && kartaCharge.id && maintenance.id && manualVehicle.id,
  'fixture includes valid normalized, historical, current-period, Karta, maintenance, and manual movement rows');

console.log(failures === 0
  ? '\n✅ ALL VEHICLE-LEDGER-DATE-INTEGRITY ASSERTIONS PASSED'
  : `\n❌ ${failures} VEHICLE-LEDGER-DATE-INTEGRITY FAILURES`);
process.exit(failures === 0 ? 0 : 1);
