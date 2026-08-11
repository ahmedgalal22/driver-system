// run.mjs — Receipt-row company charge lifecycle verification.
import { installIDB } from './idb-shim.mjs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');
const { ReceiptRepository } = await import('./services/receiptRepository.js');

const U = 'receipt-row-company-charge-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();
const CHARGE = { reference_type: 'receipt_row_company_charge', effect: 'receipt_row_company_charge' };

await DB.init();

const OWNER_ID = uuid();
const OFFICE_A = { id: uuid(), username: U, name: 'شركة أ', phone: null };
const OFFICE_B = { id: uuid(), username: U, name: 'شركة ب', phone: null };
const V1 = { id: uuid(), username: U, plate: '111 أ ب', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
const V2 = { id: uuid(), username: U, plate: '222 ج د', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
await DB.add('offices', OFFICE_A, { username: U });
await DB.add('offices', OFFICE_B, { username: U });
await ClientRepository.saveVehicle(V1, { username: U });
await ClientRepository.saveVehicle(V2, { username: U });

const mkRow = (over = {}) => ({
  _type: 'data',
  row_id: uuid(),
  owner_id: OWNER_ID,
  owner_name: 'مالك اختبار',
  driver_id: null,
  vehicle_id: V1.id,
  vehicle_plate: V1.plate,
  driver_price: 0,
  loading: 'طنطا',
  destination: 'القاهرة',
  office: OFFICE_A.name,
  advance: 0,
  net: 0,
  sarf: 0,
  ...over,
});
const mkReceipt = (rows) => ({
  receipt_date: '2026-08-10',
  client_id: OWNER_ID,
  client_type: 'owner',
  client_name: 'مالك اختبار',
  total: rows.reduce((sum, row) => sum + (Number(row.net) || 0), 0),
  rows,
});
const officeBalanceCents = async (id) => Math.round((await FinancialService.getOfficeBalance(id)).balance * 100);
const vehicleBalanceCents = async (id) => Math.round((await FinancialService.rebuildVehicleBalance(id)).balance * 100);
const chargesFor = async (rowId, activeOnly = true) =>
  (await DB.getByIndex('vehicle_ledger', 'by_reference_id', rowId)).filter(entry =>
    entry.reference_type === CHARGE.reference_type
    && entry.effect === CHARGE.effect
    && (!activeOnly || entry.is_reversed === false)
  );

console.log('\n— one row / creation charge —');
const row1 = mkRow({ kartano: 'A-1', net: 100, sarf: 20 });
const receipt1 = await FinancialService.createReceipt(U, mkReceipt([row1]));
ok(!!receipt1.receipt?.id, 'receipt persists through the real receipt creation path');
const row1Charge = (await chargesFor(row1.row_id))[0];
ok(!!row1Charge
  && row1Charge.type === 'withdraw'
  && row1Charge.amount === 12000
  && row1Charge.client_type === 'office'
  && row1Charge.client_id === OFFICE_A.id
  && row1Charge.owner_id === OFFICE_A.id
  && row1Charge.vehicle_id === null
  && !('vehicle_plate' in row1Charge)
  && row1Charge.reference_id === row1.row_id,
  'receipt creation creates exactly one company-only withdrawal of net+sarf linked to the row UUID');
ok((await officeBalanceCents(OFFICE_A.id)) === -12000,
  'company balance decreases by net+sarf after receipt-row creation');
ok((await vehicleBalanceCents(V1.id)) === 0,
  'company-only receipt charge does not affect vehicle balance');

console.log('\n— payment-status independence —');
await FinancialService.setReceiptRowPaymentStatus(U, row1.row_id, 'paid');
ok((await chargesFor(row1.row_id)).length === 1 && (await chargesFor(row1.row_id))[0].id === row1Charge.id,
  'unpaid → paid does not create a second receipt-row company charge');
ok((await officeBalanceCents(OFFICE_A.id)) === 0,
  'existing payment-status company deposit offsets the independent receipt-created withdrawal while paid');
await FinancialService.setReceiptRowPaymentStatus(U, row1.row_id, 'unpaid');
ok((await chargesFor(row1.row_id)).length === 1 && (await chargesFor(row1.row_id))[0].is_reversed === false,
  'paid → unpaid does not reverse the independent receipt-row company charge');
ok((await officeBalanceCents(OFFICE_A.id)) === -12000,
  'after payment reversal the receipt-created company deduction remains active');

console.log('\n— multiple rows and companies —');
const row2 = mkRow({ kartano: 'A-2', net: 80, sarf: 10 });
const row3 = mkRow({ kartano: 'B-1', vehicle_id: V2.id, vehicle_plate: V2.plate, office: OFFICE_B.name, net: 50, sarf: 5 });
await FinancialService.createReceipt(U, mkReceipt([row2, row3]));
ok((await chargesFor(row2.row_id)).length === 1 && (await chargesFor(row3.row_id)).length === 1,
  'multiple receipt rows create one independently traceable company charge per row UUID');
ok((await officeBalanceCents(OFFICE_A.id)) === -21000 && (await officeBalanceCents(OFFICE_B.id)) === -5500,
  'same-company rows accumulate while different companies remain isolated');
ok((await vehicleBalanceCents(V1.id)) === 0 && (await vehicleBalanceCents(V2.id)) === 0,
  'multiple company charges never affect either vehicle balance');

console.log('\n— no company / unresolvable company safety —');
const noCompanyRow = mkRow({ kartano: 'NONE', office: null, net: 40, sarf: 4 });
await FinancialService.createReceipt(U, mkReceipt([noCompanyRow]));
ok((await chargesFor(noCompanyRow.row_id)).length === 0,
  'rows without a company create no company ledger entry');
const receiptsBeforeUnknown = (await DB.getAll('receipts', { username: U })).length;
let unknownError = '';
try {
  await FinancialService.createReceipt(U, mkReceipt([mkRow({ office: 'شركة غير مسجلة', net: 10, sarf: 1 })]));
} catch (error) { unknownError = error.message; }
ok(/unknown office/.test(unknownError) && (await DB.getAll('receipts', { username: U })).length === receiptsBeforeUnknown,
  'unresolvable company fails before the atomic receipt write and never fabricates an office');

console.log('\n— edit lifecycle —');
const lifecycleOld = mkRow({ kartano: 'EDIT-OLD', office: OFFICE_A.name, net: 30, sarf: 2 });
const lifecycleReceipt = await FinancialService.createReceipt(U, mkReceipt([lifecycleOld]));
const lifecycleId = lifecycleReceipt.receipt.id;
const oldCharge = (await chargesFor(lifecycleOld.row_id))[0];
const lifecycleNew = mkRow({ kartano: 'EDIT-NEW', office: OFFICE_B.name, net: 10, sarf: 3 });
await FinancialService.updateReceipt(U, lifecycleId, mkReceipt([lifecycleNew]));
const oldAudit = await chargesFor(lifecycleOld.row_id, false);
const newCharge = (await chargesFor(lifecycleNew.row_id))[0];
ok(oldAudit.length === 1 && oldAudit[0].is_reversed === true
  && newCharge && newCharge.amount === 1300 && newCharge.client_id === OFFICE_B.id,
  'receipt edit reverses the old row charge into audit and creates one updated charge for the fresh row UUID');
ok((await chargesFor(lifecycleNew.row_id)).length === 1,
  'receipt edit creates no duplicate active company charge for the new row');

console.log('\n— delete lifecycle and manual-office independence —');
const manual = await FinancialService.createManualOfficeBalanceEntry(U, {
  office_id: OFFICE_A.id,
  entry_type: 'deposit',
  amount: 20,
  date: '2026-08-10',
  note: 'حركة يدوية مستقلة',
});
const beforeDeleteManualBalance = await officeBalanceCents(OFFICE_A.id);
await FinancialService.deleteReceipt(U, lifecycleId);
ok((await chargesFor(lifecycleNew.row_id)).length === 0
  && (await chargesFor(lifecycleNew.row_id, false)).every(entry => entry.is_reversed === true),
  'receipt deletion reverses its active company charge while preserving audit history');
ok((await officeBalanceCents(OFFICE_A.id)) === beforeDeleteManualBalance,
  'deleting a receipt for another company leaves manual office balance independent');
const manualEntry = (await DB.getByIndex('vehicle_ledger', 'by_reference_id', manual.reference_id))[0];
ok(manualEntry.is_reversed === false && manualEntry.reference_type === 'manual_office_balance',
  'manual office movement remains active and independent from receipt-row company charges');

console.log('\n— namespace and Karta isolation —');
const activeKartaEntries = await DB.findByFields('vehicle_ledger', { reference_type: 'receipt_row', is_reversed: false });
ok(activeKartaEntries.length === 0,
  'receipt-row company charge creation does not create or modify Karta Settlement entries');
ok((await ReceiptRepository.getRowById(row1.row_id)).payment_status === 'unpaid',
  'receipt-row payment status remains independently controlled after charge lifecycle tests');

console.log(failures === 0
  ? '\n✅ ALL RECEIPT-ROW-COMPANY-CHARGE ASSERTIONS PASSED'
  : `\n❌ ${failures} RECEIPT-ROW-COMPANY-CHARGE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
