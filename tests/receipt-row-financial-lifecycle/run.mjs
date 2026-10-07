// run.mjs — Receipt-row financial lifecycle: creation ≠ payment ≠ reversal.
import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');
const { DateUtils } = await import('./dateUtils.js');

const U = 'receipt-row-financial-lifecycle-tester';
const CREATION = 'receipt_row_company_charge';
const PAYMENT_COMPANY = 'receipt_row_payment_company';
const PAYMENT_VEHICLE = 'receipt_row_payment_vehicle';
const FINANCIAL_SRC = readFileSync('./financial.js', 'utf8');
const ALL_RECEIPTS_SRC = readFileSync('./allReceipts.js', 'utf8');
const ENTITIES_SRC = readFileSync('./entities.js', 'utf8');
const DASHBOARD_SRC = readFileSync('./dashboard.js', 'utf8');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const rejects = async fn => {
  try { await fn(); return false; } catch (_) { return true; }
};
const uuid = () => crypto.randomUUID();

await DB.init();
const OWNER_ID = uuid();
const OFFICE = { id: uuid(), username: U, name: 'شركة دورة الحياة', phone: null };
const V1 = { id: uuid(), username: U, plate: '111 أ ب', owner_id: OWNER_ID, owner_name: 'مالك دورة الحياة' };
const V2 = { id: uuid(), username: U, plate: '222 ج د', owner_id: OWNER_ID, owner_name: 'مالك دورة الحياة' };
await DB.add('offices', OFFICE, { username: U });
await ClientRepository.saveVehicle(V1, { username: U });
await ClientRepository.saveVehicle(V2, { username: U });

const today = DateUtils.todayLocal();
const mkRow = (overrides = {}) => ({
  _type: 'data',
  row_id: uuid(),
  owner_id: OWNER_ID,
  owner_name: 'مالك دورة الحياة',
  driver_id: null,
  vehicle_id: V1.id,
  vehicle_plate: V1.plate,
  driver_price: 0,
  driver_settlement_price: null,
  kartano: 'K-1',
  date: today,
  loading: 'طنطا',
  destination: 'القاهرة',
  office: OFFICE.name,
  advance: 0,
  net: 10,
  sarf: 2,
  weight: 0,
  weight2: 0,
  deficit: 0,
  officeAmount: 0,
  discount: 0,
  add: 0,
  ...overrides,
});
const payload = (rows, overrides = {}) => ({
  receipt_date: today,
  client_id: OWNER_ID,
  client_type: 'owner',
  client_name: 'مالك دورة الحياة',
  total: rows.reduce((sum, row) => sum + Number(row.net || 0), 0),
  rows,
  ...overrides,
});

const active = entries => entries.filter(entry => entry.is_reversed === false && entry.deleted_at === null);
const entriesFor = async rowId => DB.getByIndex('vehicle_ledger', 'by_reference_id', rowId);
const lifecycle = async rowId => {
  const entries = await entriesFor(rowId);
  const live = active(entries);
  return {
    all: entries,
    creation: live.filter(entry => entry.reference_type === CREATION && entry.effect === CREATION),
    company: live.filter(entry => entry.reference_type === PAYMENT_COMPANY && entry.effect === PAYMENT_COMPANY),
    vehicle: live.filter(entry => entry.reference_type === PAYMENT_VEHICLE && entry.effect === PAYMENT_VEHICLE),
  };
};
const vehicleCents = async vehicleId => Math.round((await FinancialService.rebuildVehicleBalance(vehicleId)).balance * 100);
const companyCents = async () => Math.round((await FinancialService.getOfficeBalance(OFFICE.id)).balance * 100);

function lifecycleShape(report) {
  return report.creation.length === 1 && report.company.length === 0 && report.vehicle.length === 0;
}

console.log('\n— creation lifecycle —');
const r1 = mkRow({ payment_status: 'paid' });
const created = await FinancialService.createReceipt(U, payload([r1]));
const receiptId = created.receipt.id;
const storedR1 = (await DB.findByFields('receipt_rows', { receipt_id: receiptId }))[0];
let state = await lifecycle(storedR1.row_id);
ok(storedR1.payment_status === 'unpaid', 'new receipt rows are forced to unpaid even when caller supplies paid');
ok(lifecycleShape(state)
  && state.creation[0].type === 'withdraw'
  && state.creation[0].amount === 1200
  && state.creation[0].vehicle_id === null
  && state.creation[0].reference_id === storedR1.row_id,
'new unpaid row has exactly one independent company creation charge (-net-sarf) and no payment effects');
ok((await companyCents()) === -1200 && (await vehicleCents(V1.id)) === 0,
'new unpaid row decreases company by net+sarf and leaves vehicle unchanged');

console.log('\n— payment lifecycle and repeated toggles —');
let result = await FinancialService.setReceiptRowPaymentStatus(U, storedR1.row_id, 'paid');
state = await lifecycle(storedR1.row_id);
ok(result.changed && result.vehicle_id === V1.id && result.office_id === OFFICE.id
  && state.creation.length === 1 && state.company.length === 1 && state.vehicle.length === 1,
'unpaid → paid returns authoritative affected identities and creates one complete independent payment pair');
ok(state.company[0].type === 'deposit' && state.company[0].amount === 1200 && state.company[0].vehicle_id === null
  && state.vehicle[0].type === 'deposit' && state.vehicle[0].amount === 1000 && state.vehicle[0].vehicle_id === V1.id,
'payment company leg is +net+sarf while payment vehicle leg is +net for the exact row vehicle');
ok((await companyCents()) === 0 && (await vehicleCents(V1.id)) === 1000,
'paid lifecycle nets company creation/payment to zero and increases vehicle by net only');
const firstPaymentIds = state.company.concat(state.vehicle).map(entry => entry.id).sort().join(',');
result = await FinancialService.setReceiptRowPaymentStatus(U, storedR1.row_id, 'paid');
ok(!result.changed && (await lifecycle(storedR1.row_id)).company.concat((await lifecycle(storedR1.row_id)).vehicle).map(entry => entry.id).sort().join(',') === firstPaymentIds,
'paid → paid is idempotent and creates no duplicate active payment effects');
result = await FinancialService.setReceiptRowPaymentStatus(U, storedR1.row_id, 'unpaid');
state = await lifecycle(storedR1.row_id);
ok(result.changed && lifecycleShape(state)
  && state.all.filter(entry => entry.reference_type === PAYMENT_COMPANY || entry.reference_type === PAYMENT_VEHICLE).every(entry => entry.is_reversed === true),
'paid → unpaid reverses only payment effects while the creation charge remains active');
ok((await companyCents()) === -1200 && (await vehicleCents(V1.id)) === 0,
'paid → unpaid restores the unpaid lifecycle balances without touching creation charge');
await FinancialService.setReceiptRowPaymentStatus(U, storedR1.row_id, 'paid');
await FinancialService.setReceiptRowPaymentStatus(U, storedR1.row_id, 'unpaid');
state = await lifecycle(storedR1.row_id);
ok(lifecycleShape(state) && state.all.filter(entry => entry.reference_type === PAYMENT_COMPANY || entry.reference_type === PAYMENT_VEHICLE).length === 4,
'unpaid → paid → unpaid → paid → unpaid leaves one active creation effect, no active payment effects, and auditable reversed payment history');

console.log('\n— stable row identity and edit lifecycle —');
const sameIdUnpaid = mkRow({ row_id: storedR1.row_id, net: 15, sarf: 3, vehicle_id: V1.id, vehicle_plate: V1.plate, payment_status: 'unpaid' });
await FinancialService.updateReceipt(U, receiptId, payload([sameIdUnpaid]));
let edited = (await DB.findByFields('receipt_rows', { receipt_id: receiptId }))[0];
state = await lifecycle(edited.row_id);
ok(edited.row_id === storedR1.row_id && edited.payment_status === 'unpaid'
  && lifecycleShape(state) && state.creation[0].amount === 1800,
'unpaid edit preserves row_id, reverses old creation charge, and creates only the new creation charge');
ok((await companyCents()) === -1800 && (await vehicleCents(V1.id)) === 0,
'net/sarf edit while unpaid changes only the independent company creation lifecycle');

await FinancialService.setReceiptRowPaymentStatus(U, edited.row_id, 'paid');
const sameIdPaid = mkRow({ row_id: edited.row_id, net: 20, sarf: 5, vehicle_id: V2.id, vehicle_plate: V2.plate, payment_status: 'paid' });
await FinancialService.updateReceipt(U, receiptId, payload([sameIdPaid]));
edited = (await DB.findByFields('receipt_rows', { receipt_id: receiptId }))[0];
state = await lifecycle(edited.row_id);
ok(edited.row_id === storedR1.row_id && edited.payment_status === 'paid'
  && state.creation.length === 1 && state.creation[0].amount === 2500
  && state.company.length === 1 && state.company[0].amount === 2500
  && state.vehicle.length === 1 && state.vehicle[0].amount === 2000 && state.vehicle[0].vehicle_id === V2.id,
'paid edit preserves row_id and independently rebuilds creation, company payment, and exact new-vehicle payment effects');
ok((await companyCents()) === 0 && (await vehicleCents(V1.id)) === 0 && (await vehicleCents(V2.id)) === 2000,
'paid edit reverses old vehicle effect and applies net only to the replacement row vehicle');

console.log('\n— payment-status and financial-field edit matrix —');
const editRow = mkRow({ net: 10, sarf: 2, vehicle_id: V1.id, vehicle_plate: V1.plate });
const editReceipt = await FinancialService.createReceipt(U, payload([editRow]));
let storedEdit = (await DB.findByFields('receipt_rows', { receipt_id: editReceipt.receipt.id }))[0];
let editState = await lifecycle(storedEdit.row_id);
const originalCreationId = editState.creation[0].id;
await FinancialService.updateReceipt(U, editReceipt.receipt.id, payload([{ ...editRow, row_id: storedEdit.row_id, payment_status: 'paid' }]));
storedEdit = (await DB.findByFields('receipt_rows', { receipt_id: editReceipt.receipt.id }))[0];
editState = await lifecycle(storedEdit.row_id);
ok(editState.creation.length === 1 && editState.creation[0].id === originalCreationId
  && editState.company.length === 1 && editState.vehicle.length === 1,
'unpaid → paid edit creates payment pair without reversing or recreating unchanged creation charge');
await FinancialService.updateReceipt(U, editReceipt.receipt.id, payload([{ ...editRow, row_id: storedEdit.row_id, payment_status: 'unpaid' }]));
storedEdit = (await DB.findByFields('receipt_rows', { receipt_id: editReceipt.receipt.id }))[0];
editState = await lifecycle(storedEdit.row_id);
ok(editState.creation.length === 1 && editState.creation[0].id === originalCreationId
  && editState.company.length === 0 && editState.vehicle.length === 0,
'paid → unpaid edit reverses payment pair only and leaves unchanged creation charge active');
await FinancialService.updateReceipt(U, editReceipt.receipt.id, payload([{ ...editRow, row_id: storedEdit.row_id, net: 11, payment_status: 'unpaid' }]));
storedEdit = (await DB.findByFields('receipt_rows', { receipt_id: editReceipt.receipt.id }))[0];
editState = await lifecycle(storedEdit.row_id);
ok(editState.creation[0].amount === 1300 && editState.creation[0].id !== originalCreationId
  && editState.company.length === 0 && editState.vehicle.length === 0,
'net edit while unpaid rebuilds only creation charge with the new net+sarf amount');
const netCreationId = editState.creation[0].id;
await FinancialService.updateReceipt(U, editReceipt.receipt.id, payload([{ ...editRow, row_id: storedEdit.row_id, net: 11, sarf: 4, payment_status: 'unpaid' }]));
storedEdit = (await DB.findByFields('receipt_rows', { receipt_id: editReceipt.receipt.id }))[0];
editState = await lifecycle(storedEdit.row_id);
ok(editState.creation[0].amount === 1500 && editState.creation[0].id !== netCreationId
  && editState.vehicle.length === 0,
'sarf edit while unpaid rebuilds only the company creation charge and never creates a vehicle effect');
const sarfCreationId = editState.creation[0].id;
await FinancialService.updateReceipt(U, editReceipt.receipt.id, payload([{ ...editRow, row_id: storedEdit.row_id, net: 11, sarf: 4, vehicle_id: V2.id, vehicle_plate: V2.plate, payment_status: 'unpaid' }]));
storedEdit = (await DB.findByFields('receipt_rows', { receipt_id: editReceipt.receipt.id }))[0];
editState = await lifecycle(storedEdit.row_id);
ok(editState.creation[0].id === sarfCreationId && editState.vehicle.length === 0,
'vehicle edit while unpaid leaves the independent company creation effect unchanged and creates no vehicle posting');
await FinancialService.updateReceipt(U, editReceipt.receipt.id, payload([{ ...editRow, row_id: storedEdit.row_id, net: 11, sarf: 4, vehicle_id: V2.id, vehicle_plate: V2.plate, payment_status: 'paid' }]));
storedEdit = (await DB.findByFields('receipt_rows', { receipt_id: editReceipt.receipt.id }))[0];
editState = await lifecycle(storedEdit.row_id);
ok(editState.company[0].amount === 1500 && editState.vehicle[0].amount === 1100 && editState.vehicle[0].vehicle_id === V2.id,
'paid edit applies company net+sarf and vehicle net to the authoritative edited vehicle ID');
const paidCreationId = editState.creation[0].id;
await FinancialService.updateReceipt(U, editReceipt.receipt.id, payload([{ ...editRow, row_id: storedEdit.row_id, net: 12, sarf: 4, vehicle_id: V2.id, vehicle_plate: V2.plate, payment_status: 'paid' }]));
storedEdit = (await DB.findByFields('receipt_rows', { receipt_id: editReceipt.receipt.id }))[0];
editState = await lifecycle(storedEdit.row_id);
ok(editState.creation[0].id !== paidCreationId && editState.company[0].amount === 1600 && editState.vehicle[0].amount === 1200,
'net edit while paid reverses old lifecycle effects and applies new company and vehicle payment values');
await FinancialService.updateReceipt(U, editReceipt.receipt.id, payload([{ ...editRow, row_id: storedEdit.row_id, net: 12, sarf: 5, vehicle_id: V2.id, vehicle_plate: V2.plate, payment_status: 'paid' }]));
storedEdit = (await DB.findByFields('receipt_rows', { receipt_id: editReceipt.receipt.id }))[0];
editState = await lifecycle(storedEdit.row_id);
ok(editState.company[0].amount === 1700 && editState.vehicle[0].amount === 1200,
'sarf edit while paid changes company lifecycle amount while vehicle payment remains net only');

console.log('\n— multiple vehicles, partial-state safety, rollback, and deletion policy —');
const r2 = mkRow({ vehicle_id: V1.id, vehicle_plate: V1.plate, net: 7, sarf: 1 });
const r3 = mkRow({ vehicle_id: V2.id, vehicle_plate: V2.plate, net: 9, sarf: 4 });
const receipt2 = await FinancialService.createReceipt(U, payload([r2, r3]));
const [storedR2, storedR3] = await DB.findByFields('receipt_rows', { receipt_id: receipt2.receipt.id });
await FinancialService.setReceiptRowPaymentStatus(U, storedR2.row_id, 'paid');
await FinancialService.setReceiptRowPaymentStatus(U, storedR3.row_id, 'paid');
ok((await vehicleCents(V1.id)) === 700 && (await vehicleCents(V2.id)) === 4100,
'multiple paid rows remain isolated by authoritative vehicle_id and accumulate only their own net amounts');

const partial = mkRow({ net: 6, sarf: 1 });
const partialReceipt = await FinancialService.createReceipt(U, payload([partial]));
const partialRow = (await DB.findByFields('receipt_rows', { receipt_id: partialReceipt.receipt.id }))[0];
await DB.add('vehicle_ledger', {
  username: U,
  owner_id: OFFICE.id,
  owner_name: OFFICE.name,
  client_id: OFFICE.id,
  client_type: 'office',
  vehicle_id: null,
  type: 'deposit',
  amount: 700,
  effect: PAYMENT_COMPANY,
  reference_type: PAYMENT_COMPANY,
  reference_id: partialRow.row_id,
  date: today,
  applied_at: `${today}T12:00:00`,
  is_reversed: false,
}, { username: U });
ok(await rejects(() => FinancialService.setReceiptRowPaymentStatus(U, partialRow.row_id, 'paid')),
'partial payment effects fail loudly and are never silently repaired');

const badOffice = mkRow({ net: 8, sarf: 1 });
const badReceipt = await FinancialService.createReceipt(U, payload([badOffice]));
const badRow = (await DB.findByFields('receipt_rows', { receipt_id: badReceipt.receipt.id }))[0];
await DB.update('receipt_rows', badRow.row_id, { office: 'شركة غير مسجلة' }, { username: U });
ok(await rejects(() => FinancialService.setReceiptRowPaymentStatus(U, badRow.row_id, 'paid'))
  && (await lifecycle(badRow.row_id)).company.length === 0
  && (await lifecycle(badRow.row_id)).vehicle.length === 0
  && (await DB.getById('receipt_rows', badRow.row_id)).payment_status === 'unpaid',
'failed payment target resolution rolls back with neither payment effect nor paid status');

ok(await rejects(() => FinancialService.deleteReceipt(U, receipt2.receipt.id)),
'paid receipt deletion is blocked pending the explicitly deferred paid-delete accounting decision');
await FinancialService.setReceiptRowPaymentStatus(U, storedR2.row_id, 'unpaid');
await FinancialService.setReceiptRowPaymentStatus(U, storedR3.row_id, 'unpaid');
await FinancialService.deleteReceipt(U, receipt2.receipt.id);
ok((await lifecycle(storedR2.row_id)).creation.length === 0 && (await lifecycle(storedR3.row_id)).creation.length === 0,
'unpaid receipt deletion reverses creation effects and leaves no active lifecycle effects');

console.log('\n— monthly report, Karta independence, and UI refresh contracts —');
const monthKey = today.slice(0, 7);
const monthly = await FinancialService.getVehicleMonthlyReport(V2.id, monthKey);
ok(monthly.breakdown.inflows.receiptRowPayment.count >= 1
  && monthly.movements.some(movement => movement.effect === PAYMENT_VEHICLE),
'monthly report classifies payment vehicle effects as receipt-payment inflows');
ok(!state.all.some(entry => entry.effect === 'karta_settlement_charge' || entry.type === 'driver_karta_payment'),
'receipt payment lifecycle creates no Karta settlement effect');
ok(FINANCIAL_SRC.includes("receipt_row_payment_company")
  && FINANCIAL_SRC.includes("receipt_row_payment_vehicle")
  && !FINANCIAL_SRC.includes("const PAYMENT_EFFECT   = 'receipt_row_payment'"),
'financial source exposes separate creation/payment namespaces without the old generic payment effect');
ok(ALL_RECEIPTS_SRC.includes("new CustomEvent('receipt-financial:changed'")
  && ALL_RECEIPTS_SRC.includes("new CustomEvent('receipts:changed'"),
'All Receipts emits post-commit financial and existing receipt refresh events');
ok(ENTITIES_SRC.includes("window.addEventListener('receipt-financial:changed'")
  && ENTITIES_SRC.includes('_vehicleDetailsRequestVersion'),
'Vehicle projections refresh from the post-commit event and guard against stale detail responses');
ok(DASHBOARD_SRC.includes('DOMAIN_EVENT.RECEIPTS_CHANGED')
  && ALL_RECEIPTS_SRC.includes("new CustomEvent('receipts:changed'"),
'Dashboard retains its existing receipts-change refresh path after a committed payment transition');

console.log(failures === 0
  ? '\n✅ ALL RECEIPT-ROW-FINANCIAL-LIFECYCLE ASSERTIONS PASSED'
  : `\n❌ ${failures} RECEIPT-ROW-FINANCIAL-LIFECYCLE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
