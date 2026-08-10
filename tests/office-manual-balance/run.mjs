// run.mjs — Manual Office Balance verification.
// Exercises real production FinancialService on the IndexedDB shim. Manual
// company movements are created/reversed only through their dedicated service
// methods; receipt-row payments remain on their existing state machine.

import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');

const U = 'manual-office-balance-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();

const FINANCIAL_SRC = readFileSync('./financial.js', 'utf8');
const OFFICES_SRC = readFileSync('./_src/offices.js', 'utf8');

await DB.init();

const OWNER_ID = uuid();
const OFFICE_A = { id: uuid(), username: U, name: 'شركة أ', phone: null };
const OFFICE_B = { id: uuid(), username: U, name: 'شركة ب', phone: null };
const VEHICLE = { id: uuid(), username: U, plate: '123 أ ب', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
await DB.add('offices', OFFICE_A, { username: U });
await DB.add('offices', OFFICE_B, { username: U });
await ClientRepository.saveVehicle(VEHICLE, { username: U });

const receiptRow = {
  _type: 'data',
  row_id: uuid(),
  owner_id: OWNER_ID,
  owner_name: 'مالك اختبار',
  driver_id: null,
  vehicle_id: VEHICLE.id,
  vehicle_plate: VEHICLE.plate,
  driver_price: 0,
  loading: 'طنطا',
  destination: 'القاهرة',
  office: OFFICE_A.name,
  advance: 0,
  net: 11,
  sarf: 7,
};
await FinancialService.createReceipt(U, {
  receipt_date: '2026-08-10',
  client_id: OWNER_ID,
  client_type: 'owner',
  client_name: 'مالك اختبار',
  total: 11,
  rows: [receiptRow],
});

const officeBalanceCents = async (officeId, service = FinancialService) =>
  Math.round((await service.getOfficeBalance(officeId)).balance * 100);
const vehicleBalanceCents = async () =>
  Math.round((await FinancialService.rebuildVehicleBalance(VEHICLE.id)).balance * 100);

console.log('\n— receipt-row-payment baseline —');
ok((await officeBalanceCents(OFFICE_A.id)) === 0 && (await officeBalanceCents(OFFICE_B.id)) === 0,
  'unpaid receipt row leaves both companies unchanged');
await FinancialService.setReceiptRowPaymentStatus(U, receiptRow.row_id, 'paid');
ok((await officeBalanceCents(OFFICE_A.id)) === 1800,
  'existing receipt-row company posting remains net+sarf (11 + 7 = 18)');
ok((await vehicleBalanceCents()) === 1100,
  'existing receipt-row vehicle posting remains net only (11)');

console.log('\n— manual company deposit / withdrawal —');
const depositA = await FinancialService.createManualOfficeBalanceEntry(U, {
  office_id: OFFICE_A.id,
  entry_type: 'deposit',
  amount: 100,
  date: '2026-08-10',
  note: 'إيداع يدوي للشركة أ',
});
ok(depositA.reference_type === 'manual_office_balance'
  && depositA.effect === 'manual_office_balance'
  && depositA.client_type === 'office'
  && depositA.client_id === OFFICE_A.id
  && depositA.owner_id === OFFICE_A.id
  && depositA.vehicle_id === null
  && depositA.type === 'deposit'
  && depositA.amount === 100,
  'manual deposit uses the dedicated company-only vehicle_ledger convention');
ok((await officeBalanceCents(OFFICE_A.id)) === 11800 && (await officeBalanceCents(OFFICE_B.id)) === 0,
  'manual deposit increases only the selected company (receipt 18 + manual 100)');
ok((await vehicleBalanceCents()) === 1100,
  'manual company deposit does not affect vehicle balance');

const withdrawalA = await FinancialService.createManualOfficeBalanceEntry(U, {
  office_id: OFFICE_A.id,
  entry_type: 'withdraw',
  amount: 40,
  date: '2026-08-11',
  note: 'سحب يدوي من الشركة أ',
});
ok(withdrawalA.type === 'withdraw' && withdrawalA.amount === 40,
  'manual company withdrawal persists as a withdrawal movement');
ok((await officeBalanceCents(OFFICE_A.id)) === 7800 && (await officeBalanceCents(OFFICE_B.id)) === 0,
  'manual withdrawal decreases only the selected company (118 - 40 = 78)');
ok((await vehicleBalanceCents()) === 1100,
  'manual company withdrawal does not affect vehicle balance');

const movementsA = await FinancialService.getOfficeBalance(OFFICE_A.id);
const manualRefsA = movementsA.entries
  .filter(entry => entry.reference_type === 'manual_office_balance')
  .map(entry => entry.reference_id)
  .sort();
ok(manualRefsA.join(',') === [depositA.reference_id, withdrawalA.reference_id].sort().join(','),
  'manual company deposit and withdrawal appear in the existing company movement projection');
ok(movementsA.entries.some(entry => entry.reference_type === 'receipt_row_payment'
  && entry.reference_id === receiptRow.row_id && entry.amount === 18),
  'existing receipt-row company movement remains visible alongside manual company movements');

const depositB = await FinancialService.createManualOfficeBalanceEntry(U, {
  office_id: OFFICE_B.id,
  entry_type: 'deposit',
  amount: 30,
  date: '2026-08-12',
  note: 'إيداع يدوي للشركة ب',
});
ok((await officeBalanceCents(OFFICE_A.id)) === 7800 && (await officeBalanceCents(OFFICE_B.id)) === 3000,
  'different companies remain isolated (A=78; B=30)');

const { FinancialService: ReloadedFinancialService } = await import('./financial.js?manual-office-reload');
ok((await officeBalanceCents(OFFICE_A.id, ReloadedFinancialService)) === 7800
  && (await officeBalanceCents(OFFICE_B.id, ReloadedFinancialService)) === 3000,
  'manual company movements persist after a fresh FinancialService reload');

console.log('\n— audit-preserving reversal —');
await FinancialService.deleteManualOfficeBalanceEntry(U, depositA.reference_id);
ok((await officeBalanceCents(OFFICE_A.id)) === -2200,
  'reversing the manual deposit removes only that manual effect while receipt and withdrawal remain');
const depositAudit = (await DB.getByIndex('vehicle_ledger', 'by_reference_id', depositA.reference_id))[0];
ok(depositAudit.is_reversed === true && depositAudit.reversed_at && depositAudit.reversed_by === U,
  'manual company deletion follows the existing is_reversed audit convention without hard deletion');
await FinancialService.deleteManualOfficeBalanceEntry(U, withdrawalA.reference_id);
ok((await officeBalanceCents(OFFICE_A.id)) === 1800,
  'reversing both manual A movements restores the automatic receipt-row-payment balance only');
await FinancialService.setReceiptRowPaymentStatus(U, receiptRow.row_id, 'unpaid');
ok((await officeBalanceCents(OFFICE_A.id)) === 0 && (await officeBalanceCents(OFFICE_B.id)) === 3000,
  'receipt-row payment reversal and manual company movement remain independent');
await FinancialService.deleteManualOfficeBalanceEntry(U, depositB.reference_id);
ok((await officeBalanceCents(OFFICE_B.id)) === 0,
  'reversing B manual movement removes its company effect without affecting A');

console.log('\n— UI and domain isolation fingerprints —');
ok(OFFICES_SRC.includes('data-action="open-office-balance-entry"')
  && OFFICES_SRC.includes('await FinancialService.createManualOfficeBalanceEntry(_moduleSessionUsername(), {')
  && OFFICES_SRC.includes('await showOfficeDetails(_detailsOfficeId);'),
  'Office Details balance buttons open the connected modal and refresh the selected office after save');
ok(FINANCIAL_SRC.includes("const MANUAL_OFFICE_REF_TYPE = 'manual_office_balance';")
  && FINANCIAL_SRC.includes("const MANUAL_OFFICE_EFFECT = 'manual_office_balance';"),
  'manual office namespace is explicit and distinct from receipt-row payment');
ok(!FINANCIAL_SRC.includes('MANUAL_OFFICE_REF_TYPE = PAYMENT_REF_TYPE')
  && !FINANCIAL_SRC.includes('MANUAL_OFFICE_EFFECT = PAYMENT_EFFECT'),
  'manual office entries do not reuse or modify the automatic receipt-row-payment namespace');
ok(!FINANCIAL_SRC.includes('treasury') && !FINANCIAL_SRC.includes('company_ledger'),
  'manual office functionality adds no Treasury or separate company ledger/store');

console.log(failures === 0
  ? '\n✅ ALL OFFICE-MANUAL-BALANCE ASSERTIONS PASSED'
  : `\n❌ ${failures} OFFICE-MANUAL-BALANCE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
