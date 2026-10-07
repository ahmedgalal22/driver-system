// run.mjs — Receipt-row payment-status public contract.
// Detailed lifecycle/edit/delete coverage lives in receipt-row-financial-lifecycle.
import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');
const { DateUtils } = await import('./dateUtils.js');

const U = 'payment-status-tester';
const CREATION = 'receipt_row_company_charge';
const COMPANY = 'receipt_row_payment_company';
const VEHICLE = 'receipt_row_payment_vehicle';
const FINANCIAL_SRC = readFileSync('./financial.js', 'utf8');
const ALL_RECEIPTS_SRC = readFileSync('./_src/allReceipts.js', 'utf8');
const RECEIPTS_SRC = readFileSync('./_src/receipts.js', 'utf8');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();
const active = entries => entries.filter(entry => entry.is_reversed === false && entry.deleted_at === null);

await DB.init();
const OWNER = uuid();
const OFFICE = { id: uuid(), username: U, name: 'شركة الحالة', phone: null };
const VEHICLE_REC = { id: uuid(), username: U, plate: '123 أ ب', owner_id: OWNER, owner_name: 'مالك اختبار' };
await DB.add('offices', OFFICE, { username: U });
await ClientRepository.saveVehicle(VEHICLE_REC, { username: U });
const row = {
  _type: 'data', row_id: uuid(), owner_id: OWNER, owner_name: 'مالك اختبار',
  driver_id: null, vehicle_id: VEHICLE_REC.id, vehicle_plate: VEHICLE_REC.plate,
  driver_price: 0, loading: 'طنطا', destination: 'القاهرة', office: OFFICE.name,
  advance: 0, net: 11, sarf: 75, date: DateUtils.todayLocal(), payment_status: 'paid',
};
const created = await FinancialService.createReceipt(U, {
  receipt_date: DateUtils.todayLocal(), client_id: OWNER, client_type: 'owner', client_name: 'مالك اختبار', total: 11, rows: [row],
});
const stored = (await DB.findByFields('receipt_rows', { receipt_id: created.receipt.id }))[0];
const entries = async () => DB.getByIndex('vehicle_ledger', 'by_reference_id', stored.row_id);
const effects = async () => {
  const all = await entries();
  return {
    all,
    creation: active(all).filter(entry => entry.effect === CREATION && entry.reference_type === CREATION),
    company: active(all).filter(entry => entry.effect === COMPANY && entry.reference_type === COMPANY),
    vehicle: active(all).filter(entry => entry.effect === VEHICLE && entry.reference_type === VEHICLE),
  };
};
const vehicleCents = async () => Math.round((await FinancialService.rebuildVehicleBalance(VEHICLE_REC.id)).balance * 100);
const companyCents = async () => Math.round((await FinancialService.getOfficeBalance(OFFICE.id)).balance * 100);

console.log('\n— creation contract —');
let state = await effects();
ok(stored.payment_status === 'unpaid', 'new receipt row is forced to unpaid');
ok(state.creation.length === 1 && state.creation[0].type === 'withdraw' && state.creation[0].amount === 8600
  && state.company.length === 0 && state.vehicle.length === 0,
'new row has one independent company creation charge and zero payment effects');
ok((await companyCents()) === -8600 && (await vehicleCents()) === 0,
'new unpaid row changes company by -net-sarf and leaves vehicle unchanged');

console.log('\n— paid state machine —');
let result = await FinancialService.setReceiptRowPaymentStatus(U, stored.row_id, 'paid');
state = await effects();
ok(result.changed && result.vehicle_id === VEHICLE_REC.id && result.office_id === OFFICE.id,
'paid transition returns authoritative row, vehicle, and office metadata after commit');
ok(state.creation.length === 1 && state.company.length === 1 && state.vehicle.length === 1
  && state.company[0].amount === 8600 && state.company[0].vehicle_id === null
  && state.vehicle[0].amount === 1100 && state.vehicle[0].vehicle_id === VEHICLE_REC.id,
'paid transition creates exactly one company payment and one exact-vehicle payment effect');
ok((await companyCents()) === 0 && (await vehicleCents()) === 1100,
'company creation/payment effects offset while vehicle increases by net only');
const paymentIds = state.company.concat(state.vehicle).map(entry => entry.id).sort().join(',');
result = await FinancialService.setReceiptRowPaymentStatus(U, stored.row_id, 'paid');
ok(!result.changed && (await effects()).company.concat((await effects()).vehicle).map(entry => entry.id).sort().join(',') === paymentIds,
'paid → paid is a no-op with no duplicate active payment effects');
result = await FinancialService.setReceiptRowPaymentStatus(U, stored.row_id, 'unpaid');
state = await effects();
ok(result.changed && state.creation.length === 1 && state.company.length === 0 && state.vehicle.length === 0,
'paid → unpaid reverses only payment effects and leaves creation charge active');
ok((await companyCents()) === -8600 && (await vehicleCents()) === 0,
'payment reversal restores the unpaid lifecycle balances');

console.log('\n— UI and namespace contract —');
ok(RECEIPTS_SRC.includes('data-action="set-row-payment-status"')
  && ALL_RECEIPTS_SRC.includes("new CustomEvent('receipt-financial:changed'")
  && ALL_RECEIPTS_SRC.includes('FinancialService.setReceiptRowPaymentStatus(username, rowId, target)'),
'All Receipts status UI delegates to FinancialService and emits refresh only after success');
ok(FINANCIAL_SRC.includes("receipt_row_company_charge")
  && FINANCIAL_SRC.includes("receipt_row_payment_company")
  && FINANCIAL_SRC.includes("receipt_row_payment_vehicle")
  && !FINANCIAL_SRC.includes("const PAYMENT_EFFECT   = 'receipt_row_payment'"),
'creation, payment-company, and payment-vehicle namespaces are explicitly separate');

console.log(failures === 0
  ? '\n✅ ALL PAYMENT-STATUS ASSERTIONS PASSED'
  : `\n❌ ${failures} PAYMENT-STATUS FAILURES`);
process.exit(failures === 0 ? 0 : 1);
