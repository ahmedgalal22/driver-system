// run.mjs — Manual Vehicle Balance verification.
// Uses real production FinancialService and vehicle_ledger records. Manual
// movements are created/reversed exclusively through the new FinancialService
// entry points; receipt-row payments continue through their existing state
// machine unchanged.

import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');

const U = 'manual-vehicle-balance-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();

const FINANCIAL_SRC = readFileSync('./financial.js', 'utf8');
const ENTITIES_SRC = readFileSync('./_src/entities.js', 'utf8');

await DB.init();

const OWNER_ID = uuid();
const OFFICE = { id: uuid(), username: U, name: 'شركة الاختبار', phone: null };
const V1 = { id: uuid(), username: U, plate: '111 أ ب', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
const V2 = { id: uuid(), username: U, plate: '222 ج د', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
await DB.add('offices', OFFICE, { username: U });
await ClientRepository.saveVehicle(V1, { username: U });
await ClientRepository.saveVehicle(V2, { username: U });

const receiptRow = {
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
  office: OFFICE.name,
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

const vehicleBalanceCents = async (vehicleId, service = FinancialService) =>
  Math.round((await service.rebuildVehicleBalance(vehicleId)).balance * 100);
const companyBalanceCents = async () =>
  Math.round((await FinancialService.getOfficeBalance(OFFICE.id)).balance * 100);

console.log('\n— receipt-row baseline remains unchanged —');
ok((await vehicleBalanceCents(V1.id)) === 0 && (await companyBalanceCents()) === 0,
  'unpaid receipt row has no vehicle or company financial effect before manual operations');
await FinancialService.setReceiptRowPaymentStatus(U, receiptRow.row_id, 'paid');
ok((await vehicleBalanceCents(V1.id)) === 1100 && (await companyBalanceCents()) === 1800,
  'existing receipt-row payment still posts net to vehicle and net+sarf to company');

console.log('\n— manual deposit / withdrawal —');
const deposit = await FinancialService.createManualVehicleBalanceEntry(U, {
  vehicle_id: V1.id,
  entry_type: 'deposit',
  amount: 100,
  date: '2026-08-10',
  note: 'إيداع يدوي للاختبار',
});
ok(deposit.reference_type === 'manual_vehicle_balance'
  && deposit.effect === 'manual_vehicle_balance'
  && deposit.type === 'deposit'
  && deposit.amount === 100,
  'manual deposit uses the dedicated existing vehicle_ledger convention');
ok((await vehicleBalanceCents(V1.id)) === 11100 && (await vehicleBalanceCents(V2.id)) === 0,
  'manual deposit increases only its selected vehicle (receipt 11 + manual 100; V2 unchanged)');
ok((await companyBalanceCents()) === 1800,
  'manual vehicle deposit does not affect the existing company balance projection');

const withdrawal = await FinancialService.createManualVehicleBalanceEntry(U, {
  vehicle_id: V1.id,
  entry_type: 'withdraw',
  amount: 40,
  date: '2026-08-11',
  note: 'سحب يدوي للاختبار',
});
ok(withdrawal.type === 'withdraw' && withdrawal.amount === 40,
  'manual withdrawal persists as a vehicle withdrawal entry');
ok((await vehicleBalanceCents(V1.id)) === 7100 && (await vehicleBalanceCents(V2.id)) === 0,
  'manual withdrawal decreases only its selected vehicle (111 - 40 = 71; V2 unchanged)');

const movements = await FinancialService.getVehicleLedger(V1.id);
const manualRefs = movements
  .filter(entry => entry.reference_type === 'manual_vehicle_balance')
  .map(entry => entry.reference_id)
  .sort();
ok(manualRefs.join(',') === [deposit.reference_id, withdrawal.reference_id].sort().join(','),
  'both manual movements appear in the existing vehicle movement projection');
ok(movements.some(entry => entry.reference_id === receiptRow.row_id
  && entry.reference_type === 'receipt_row_payment'),
  'existing receipt-row payment movement remains visible alongside manual movements');

// A fresh FinancialService module instance reads the same persisted IndexedDB
// data, proving the manual transaction survives service/page reload.
const { FinancialService: ReloadedFinancialService } = await import('./financial.js?manual-vehicle-reload');
ok((await vehicleBalanceCents(V1.id, ReloadedFinancialService)) === 7100
  && (await ReloadedFinancialService.getVehicleLedger(V1.id)).length === movements.length,
  'manual movements persist and rebuild correctly after a fresh FinancialService reload');

console.log('\n— audit-preserving manual deletion/reversal —');
await FinancialService.deleteManualVehicleBalanceEntry(U, deposit.reference_id);
ok((await vehicleBalanceCents(V1.id)) === -2900,
  'reversing the manual deposit removes only that manual effect while receipt payment and manual withdrawal remain');
const depositAudit = (await DB.getByIndex('vehicle_ledger', 'by_reference_id', deposit.reference_id))[0];
ok(depositAudit.is_reversed === true && depositAudit.reversed_at && depositAudit.reversed_by === U,
  'manual deletion follows the existing audit-preserving is_reversed convention');
ok((await companyBalanceCents()) === 1800,
  'manual reversal does not affect the separate company receipt-row-payment effect');

await FinancialService.deleteManualVehicleBalanceEntry(U, withdrawal.reference_id);
ok((await vehicleBalanceCents(V1.id)) === 1100,
  'reversing the manual withdrawal restores the balance to the receipt-row-payment baseline');
await FinancialService.setReceiptRowPaymentStatus(U, receiptRow.row_id, 'unpaid');
ok((await vehicleBalanceCents(V1.id)) === 0 && (await companyBalanceCents()) === 0,
  'existing receipt-row reversal remains unchanged after manual vehicle activity');

console.log('\n— UI and domain isolation fingerprints —');
ok(ENTITIES_SRC.includes('data-action="open-balance-entry"')
  && ENTITIES_SRC.includes('await _openVehicleBalanceEntryModal(openVehicleBalanceEntry.dataset.entryType);')
  && ENTITIES_SRC.includes('FinancialService.createManualVehicleBalanceEntry(_currentUsername(), {'),
  'Vehicle Details manual buttons open the connected modal and save through FinancialService');
ok(FINANCIAL_SRC.includes("const MANUAL_VEHICLE_REF_TYPE = 'manual_vehicle_balance';")
  && FINANCIAL_SRC.includes("const MANUAL_VEHICLE_EFFECT = 'manual_vehicle_balance';"),
  'manual vehicle ledger namespace is explicit and distinct');
ok(!FINANCIAL_SRC.includes('KARTA_CHARGE_EFFECT, MANUAL_VEHICLE')
  && !FINANCIAL_SRC.includes('PAYMENT_REF_TYPE, MANUAL_VEHICLE'),
  'manual vehicle functions do not merge Karta Settlement or receipt-row-payment namespaces');
ok(!FINANCIAL_SRC.includes('company_ledger') && !FINANCIAL_SRC.includes('treasury'),
  'manual vehicle functionality adds no company ledger/store or Treasury dependency');

console.log(failures === 0
  ? '\n✅ ALL VEHICLE-MANUAL-BALANCE ASSERTIONS PASSED'
  : `\n❌ ${failures} VEHICLE-MANUAL-BALANCE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
