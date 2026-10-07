// run.mjs — Phase 7A Vehicle Monthly Report read-model contract verification.
import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');

const U = 'vehicle-monthly-report-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const rejects = async (fn) => {
  try { await fn(); return false; } catch (_) { return true; }
};
const uuid = () => crypto.randomUUID();
const ENTITIES_SRC = readFileSync('./entities.js', 'utf8');
const STYLES_SRC = readFileSync('./styles.css', 'utf8');
const MONTHLY_UI_SRC = ENTITIES_SRC.slice(ENTITIES_SRC.indexOf('const _vehicleMonthlyReportState'), ENTITIES_SRC.indexOf('function _maintenanceSearchHaystack'));

await DB.init();

const OWNER = uuid();
const VEHICLE_A = uuid();
const VEHICLE_B = uuid();
const EMPTY_VEHICLE = uuid();
const NEGATIVE_VEHICLE = uuid();
const KARTA_ROW_ID = uuid();

async function addLedger({
  vehicle_id = VEHICLE_A,
  type = 'deposit',
  amount = 100,
  date,
  applied_at = '2026-09-01T10:00:00',
  effect = null,
  reference_type = 'fixture',
  reference_id = uuid(),
  maintenance_type = undefined,
  note = 'حركة اختبار',
}) {
  return DB.add('vehicle_ledger', {
    username: U,
    owner_id: OWNER,
    owner_name: 'مالك اختبار',
    client_id: OWNER,
    client_type: 'owner',
    vehicle_id,
    vehicle_plate: vehicle_id === VEHICLE_A ? '111 أ ب' : '222 ج د',
    type,
    amount,
    ...(date !== undefined ? { date } : {}),
    applied_at,
    ...(effect ? { effect } : {}),
    reference_type,
    reference_id,
    ...(maintenance_type ? { maintenance_type } : {}),
    is_reversed: false,
    note,
  }, { username: U });
}

console.log('\n— seed deterministic monthly Vehicle Ledger fixture —');

// Opening balance = 10,000 - 3,000 = 7,000 cents.
await addLedger({ type: 'deposit', amount: 10000, date: '2026-08-01', reference_type: 'prior_deposit' });
await addLedger({ type: 'withdraw', amount: 3000, date: '2026-08-20', effect: 'manual_vehicle_balance', reference_type: 'manual_vehicle_balance' });

// September inflows = 3,910 cents.
await addLedger({ type: 'deposit', amount: 2000, date: '2026-09-01', effect: 'receipt_row_payment_vehicle', reference_type: 'receipt_row_payment_vehicle', reference_id: uuid(), applied_at: '2026-09-01T09:00:00' });
await addLedger({ type: 'deposit', amount: 1000, date: '2026-09-02', effect: 'manual_vehicle_balance', reference_type: 'manual_vehicle_balance', reference_id: uuid() });
await addLedger({ type: 'deposit', amount: 500, date: '2026-09-03', reference_type: 'driver_deposit', reference_id: 'legacy-deposit' });
await addLedger({ type: 'deposit', amount: 300, date: '2026-09-04', reference_type: 'other-deposit' });
const tieA = await addLedger({ type: 'deposit', amount: 50, date: '2026-09-08', applied_at: '2026-09-08T09:00:00', reference_type: 'tie-a' });
const tieB = await addLedger({ type: 'deposit', amount: 60, date: '2026-09-08', applied_at: '2026-09-08T10:00:00', reference_type: 'tie-b' });
const tieC = await addLedger({ type: 'deposit', amount: 0, date: '2026-09-08', applied_at: '2026-09-08T10:00:00', reference_type: 'tie-c' });

// Current mutable receipt price intentionally differs from immutable ledger amount.
await DB.add('receipt_rows', {
  row_id: KARTA_ROW_ID,
  receipt_id: uuid(),
  driver_id: uuid(),
  vehicle_id: VEHICLE_A,
  vehicle_plate: '111 أ ب',
  driver_settlement_price: 999999,
}, { username: U });

// September outflows = 6,890 cents.
await addLedger({ type: 'withdraw', amount: 4000, date: '2026-09-05', effect: 'karta_settlement_charge', reference_type: 'receipt_row', reference_id: KARTA_ROW_ID, note: 'تسوية كارتة' });
await addLedger({ type: 'withdraw', amount: 1500, date: '2026-09-05', effect: 'manual_vehicle_balance', reference_type: 'manual_vehicle_balance', reference_id: uuid(), maintenance_type: 'زيت', applied_at: '2026-09-05T10:00:00' });
await addLedger({ type: 'withdraw', amount: 1000, date: '2026-09-06', effect: 'manual_vehicle_balance', reference_type: 'manual_vehicle_balance', reference_id: uuid() });
await addLedger({ type: 'withdraw', amount: 200, date: '2026-09-06', reference_type: 'driver_deposit', reference_id: 'legacy-withdraw' });
await addLedger({ type: 'withdraw', amount: 100, date: '2026-09-07', reference_type: 'other-withdraw' });
const lastDay = await addLedger({ type: 'withdraw', amount: 90, date: '2026-09-30', reference_type: 'last-day' });

// Valid future row: outside September, inside October.
const future = await addLedger({ type: 'deposit', amount: 333, date: '2999-10-01', reference_type: 'future-october' });

// Invalid active rows are excluded from all arithmetic but reported.
const missing = await addLedger({ type: 'deposit', amount: 999, date: undefined, reference_type: 'missing-date' });
const empty = await addLedger({ type: 'withdraw', amount: 888, date: '', reference_type: 'empty-date' });
const invalidFormat = await addLedger({ type: 'deposit', amount: 777, date: '2026/09/10', reference_type: 'invalid-format' });
const invalidCalendar = await addLedger({ type: 'withdraw', amount: 666, date: '2026-02-30', reference_type: 'invalid-calendar' });
const invalidType = await addLedger({ type: 'deposit', amount: 555, date: 20260910, reference_type: 'invalid-type' });

// Exclusions: reversed, deleted, other vehicle, driver-only, custom tracking leg.
const reversed = await addLedger({ type: 'deposit', amount: 99999, date: '2026-09-10', reference_type: 'reversed' });
await DB.update('vehicle_ledger', reversed.id, { is_reversed: true, reversed_at: '2026-09-11T10:00:00', reversed_by: U }, { username: U });
const deleted = await addLedger({ type: 'withdraw', amount: 99999, date: '2026-09-10', reference_type: 'deleted' });
await DB.delete('vehicle_ledger', deleted.id, { username: U });
await addLedger({ vehicle_id: VEHICLE_B, type: 'deposit', amount: 88888, date: '2026-09-10', reference_type: 'other-vehicle' });
await addLedger({ vehicle_id: NEGATIVE_VEHICLE, type: 'withdraw', amount: 500, date: '2026-09-10', reference_type: 'negative-balance' });
await addLedger({ vehicle_id: null, type: 'deposit', amount: 77777, date: '2026-09-10', effect: 'manual_driver_balance', reference_type: 'manual_driver_balance' });
await addLedger({ vehicle_id: VEHICLE_A, type: 'driver_karta_payment', amount: -4000, date: '2026-09-05', reference_type: 'receipt_row', reference_id: KARTA_ROW_ID });

const before = await DB.findByFields('vehicle_ledger', {}, { includeDeleted: true });

console.log('\n— strict month validation —');
for (const invalidMonth of ['2026', '2026-1', '2026/09', '2026-13', 'abcd-09']) {
  ok(await rejects(() => FinancialService.getVehicleMonthlyReport(VEHICLE_A, invalidMonth)), `invalid monthKey ${invalidMonth} is rejected`);
}
ok(await rejects(() => FinancialService.getVehicleMonthlyReport('', '2026-09')), 'missing vehicleId is rejected');

console.log('\n— September accounting contract —');
const september = await FinancialService.getVehicleMonthlyReport(VEHICLE_A, '2026-09');
ok(september.monthStart === '2026-09-01' && september.nextMonthStart === '2026-10-01',
  'month boundaries are calendar-safe and use exclusive next-month start');
ok(september.openingBalanceCents === 7000, 'opening balance uses valid active rows before the month only');
ok(september.monthlyInflowsCents === 3910 && september.inflowTransactionCount === 7,
  'monthly inflows include all and only valid active September deposits');
ok(september.monthlyOutflowsCents === 6890 && september.outflowTransactionCount === 6,
  'monthly outflows include Karta, maintenance, manual, legacy, other, and last-day withdrawals');
ok(september.closingBalanceCents === 4020
  && september.closingBalanceCents === september.openingBalanceCents + september.monthlyInflowsCents - september.monthlyOutflowsCents,
  'opening + inflows - outflows equals the deterministic closing balance');
ok(september.movementCount === 13
  && september.reconciliation.isReconciled
  && september.reconciliation.finalRunningBalanceCents === september.closingBalanceCents,
  'movement count, cumulative cross-check, and final running balance reconcile');

console.log('\n— category contract and immutable Karta ledger amount —');
ok(september.breakdown.inflows.receiptRowPayment.amountCents === 2000
  && september.breakdown.inflows.manualVehicleDeposit.amountCents === 1000
  && september.breakdown.inflows.historicalDriverDeposit.amountCents === 500
  && september.breakdown.inflows.other.amountCents === 410,
  'inflow category totals reconcile to receipt/manual/historical/other sources');
ok(september.breakdown.outflows.kartaSettlement.amountCents === 4000
  && september.breakdown.outflows.maintenance.amountCents === 1500
  && september.breakdown.outflows.manualVehicleWithdrawal.amountCents === 1000
  && september.breakdown.outflows.historicalDriverDeposit.amountCents === 200
  && september.breakdown.outflows.other.amountCents === 190,
  'outflow category totals reconcile to Karta/maintenance/manual/historical/other sources');
ok(Object.values(september.breakdown.inflows).reduce((sum, item) => sum + item.amountCents, 0) === september.monthlyInflowsCents
  && Object.values(september.breakdown.outflows).reduce((sum, item) => sum + item.amountCents, 0) === september.monthlyOutflowsCents,
  'breakdown category totals reconcile exactly with monthly inflow/outflow totals');
const kartaMovement = september.movements.find(movement => movement.referenceId === KARTA_ROW_ID);
ok(kartaMovement?.amountCents === 4000
  && kartaMovement.category === 'karta_settlement'
  && kartaMovement.amountCents !== 999999,
  'Karta financial outflow uses immutable vehicle_ledger.amount, never current receipt-row settlement price');

console.log('\n— deterministic movement order and boundaries —');
const septemberRefs = september.movements.map(movement => movement.referenceType);
const tieRefs = september.movements.filter(movement => movement.date === '2026-09-08').map(movement => movement.referenceType);
ok(tieRefs.join(',') === 'tie-a,tie-b,tie-c',
  'same-date rows sort by applied_at and then stable ledger creation/id ordering');
ok(september.movements[0].date === '2026-09-01'
  && september.movements.at(-1).id === lastDay.id,
  'monthStart and last calendar day are included in ascending movement order');
ok(!septemberRefs.includes('future-october')
  && !septemberRefs.includes('reversed')
  && !septemberRefs.includes('deleted')
  && !septemberRefs.includes('other-vehicle'),
  'next-month, reversed, deleted, and different-vehicle rows are excluded from September arithmetic');

console.log('\n— integrity and future metadata —');
ok(september.integrity.hasInvalidDates
  && !september.integrity.isFinanciallyComplete
  && september.integrity.invalidDateCount === 5
  && september.integrity.invalidDepositCount === 3
  && september.integrity.invalidWithdrawCount === 2
  && september.integrity.invalidDepositAmountCents === 2331
  && september.integrity.invalidWithdrawAmountCents === 1554
  && september.integrity.invalidNetEffectCents === 777,
  'invalid active date metadata exposes excluded count and monetary effect without changing arithmetic');
ok(september.integrity.invalidRows.map(row => row.id).sort().join(',') === [
  missing.id, empty.id, invalidFormat.id, invalidCalendar.id, invalidType.id,
].sort().join(','), 'invalid-date metadata contains every excluded active report row');
ok(september.future.count === 1
  && september.future.depositAmountCents === 333
  && september.future.withdrawAmountCents === 0
  && september.future.rows[0]?.id === future.id,
  'valid future dates are surfaced separately rather than marked invalid');
ok(september.excludedActiveVehicleCustomTypeCount === 1,
  'vehicle-linked driver_karta_payment is excluded from vehicle report arithmetic');

console.log('\n— future month, empty month, and vehicle isolation —');
const october = await FinancialService.getVehicleMonthlyReport(VEHICLE_A, '2999-10');
ok(october.openingBalanceCents === 4020
  && october.monthlyInflowsCents === 333
  && october.monthlyOutflowsCents === 0
  && october.closingBalanceCents === 4353,
  'valid future-date row is included normally when its own future month is selected');
const july = await FinancialService.getVehicleMonthlyReport(VEHICLE_A, '2026-07');
ok(july.openingBalanceCents === 0 && july.movementCount === 0 && july.closingBalanceCents === 0,
  'empty month with no prior valid activity returns deterministic zero opening/closing');
const emptyVehicle = await FinancialService.getVehicleMonthlyReport(EMPTY_VEHICLE, '2026-09');
ok(emptyVehicle.openingBalanceCents === 0
  && emptyVehicle.monthlyInflowsCents === 0
  && emptyVehicle.monthlyOutflowsCents === 0
  && emptyVehicle.closingBalanceCents === 0
  && emptyVehicle.movementCount === 0,
  'vehicle with no history returns deterministic empty report');
const negativeVehicle = await FinancialService.getVehicleMonthlyReport(NEGATIVE_VEHICLE, '2026-09');
ok(negativeVehicle.closingBalanceCents === -500
  && negativeVehicle.monthlyOutflowsCents === 500,
  'negative vehicle closing balances remain valid and are not rejected');

const after = await DB.findByFields('vehicle_ledger', {}, { includeDeleted: true });
ok(JSON.stringify(after) === JSON.stringify(before),
  'monthly report service is read-only and leaves every logical ledger record unchanged');

console.log('\n— Phase 7B UI integration contract —');
ok(ENTITIES_SRC.includes('vehicleDetailsTabMonthly')
  && ENTITIES_SRC.includes('التقرير الشهري')
  && ENTITIES_SRC.includes('vehicleMonthlyReportMonth')
  && ENTITIES_SRC.includes('FinancialService.getVehicleMonthlyReport(vehicleId, monthKey)'),
  'Vehicle Details monthly tab renders and consumes the read-only report service');
ok(ENTITIES_SRC.includes('openingBalanceCents')
  && ENTITIES_SRC.includes('monthlyInflowsCents')
  && ENTITIES_SRC.includes('monthlyOutflowsCents')
  && ENTITIES_SRC.includes('closingBalanceCents')
  && ENTITIES_SRC.includes('runningBalanceCents'),
  'monthly UI renders service-supplied summary and running-balance DTO fields');
ok(ENTITIES_SRC.includes('integrity.hasInvalidDates')
  && ENTITIES_SRC.includes('invalidDateCount')
  && ENTITIES_SRC.includes('future.count')
  && ENTITIES_SRC.includes('تفاصيل الحركات ذات التاريخ غير الصالح'),
  'monthly UI surfaces invalid-date warnings and separate future-date notice');
ok(STYLES_SRC.includes('.vehicle-monthly-report-panel')
  && STYLES_SRC.includes('.vehicle-monthly-report__table')
  && STYLES_SRC.includes('@media (max-width: 620px)'),
  'monthly report styles are scoped and include responsive table/card behavior');
ok(!MONTHLY_UI_SRC.includes('FinancialService.create')
  && !MONTHLY_UI_SRC.includes('FinancialService.update')
  && !MONTHLY_UI_SRC.includes('FinancialService.delete'),
  'monthly UI introduces no financial write call');

console.log('\n— Phase 7C.1 integrity and accessibility polish contract —');
ok(MONTHLY_UI_SRC.includes('integrity.isFinanciallyComplete === false')
  && MONTHLY_UI_SRC.includes('الحركات ذات التاريخ الصالح متطابقة')
  && MONTHLY_UI_SRC.includes('التقرير غير مكتمل'),
  'invalid-date reports label reconciliation as valid-date-only rather than fully complete');
ok(MONTHLY_UI_SRC.includes('تدخل الحركة في الحساب فقط إذا كانت تقع داخل الشهر المحدد')
  && MONTHLY_UI_SRC.includes('الحركات خارج فترة الشهر فلا تدخل'),
  'future-date notice distinguishes in-month inclusion from out-of-period exclusion');
ok(ENTITIES_SRC.includes('aria-controls="vehicleDetailsTabMonthly"')
  && MONTHLY_UI_SRC.includes('aria-labelledby="vehicleDetailsTabBtnMonthly"')
  && MONTHLY_UI_SRC.includes("aria-busy=\"${_vehicleMonthlyReportState.loading ? 'true' : 'false'}\""),
  'monthly tab and panel expose linked tabpanel semantics and loading state');
const primaryStatusCount = (MONTHLY_UI_SRC.match(/role=\"status\"/g) || []).length;
ok(primaryStatusCount === 1
  && MONTHLY_UI_SRC.includes('role="alert"')
  && MONTHLY_UI_SRC.includes('restoreFocus')
  && MONTHLY_UI_SRC.includes('focus({ preventScroll: true })'),
  'successful report load has one primary polite status announcement while integrity warnings/errors remain alerts');
ok(ENTITIES_SRC.includes('const vehicleDetailsFocus = _captureVehicleDetailsFocus(page)')
  && ENTITIES_SRC.includes('_restoreVehicleDetailsFocus(vehicleDetailsFocus)')
  && MONTHLY_UI_SRC.includes('page.contains(active)')
  && MONTHLY_UI_SRC.includes("!target.disabled && !target.closest('.hidden')"),
  'full Vehicle Details rerender restores valid in-page focus without stealing focus from outside or hidden controls');
ok(STYLES_SRC.includes('.vehicle-monthly-report__reconciliation--conditional')
  && STYLES_SRC.includes('.vehicle-monthly-report-panel :is(input, button, summary):focus-visible'),
  'conditional reconciliation and scoped keyboard-focus styles are present');

console.log(failures === 0
  ? '\n✅ ALL VEHICLE-MONTHLY-REPORT ASSERTIONS PASSED'
  : `\n❌ ${failures} VEHICLE-MONTHLY-REPORT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
