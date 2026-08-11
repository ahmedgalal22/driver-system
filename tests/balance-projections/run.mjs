// run.mjs — Existing receipt-row-payment balance projection verification.
//
// This suite never writes ledger rows directly. It transitions receipt rows
// only through FinancialService.setReceiptRowPaymentStatus(), then reads the
// resulting existing vehicle_ledger effects through:
//   • FinancialService.rebuildVehicleBalance(vehicleId), and
//   • FinancialService.getOfficeBalance(officeId).

import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');

const U = 'balance-projection-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();

const FINANCIAL_SRC = readFileSync('./financial.js', 'utf8');
const ENTITIES_SRC = readFileSync('./_src/entities.js', 'utf8');
const OFFICES_SRC = readFileSync('./_src/offices.js', 'utf8');

await DB.init();

const OWNER_ID = uuid();
const OFFICE_A = { id: uuid(), username: U, name: 'شركة أ', phone: null };
const OFFICE_B = { id: uuid(), username: U, name: 'شركة ب', phone: null };
const V1 = { id: uuid(), username: U, plate: '123 أ ب', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
const V2 = { id: uuid(), username: U, plate: '456 ت ج', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };

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
  net: 11,
  sarf: 7,
  ...over,
});

const r1 = mkRow({ kartano: 'A-1' });
const r2 = mkRow({ kartano: 'A-2' }); // same financial identity, distinct UUID
const r3 = mkRow({
  kartano: 'B-1',
  vehicle_id: V2.id,
  vehicle_plate: V2.plate,
  office: OFFICE_B.name,
  net: 20,
  sarf: 5,
});

const receipt = await FinancialService.createReceipt(U, {
  receipt_date: '2026-08-10',
  client_id: OWNER_ID,
  client_type: 'owner',
  client_name: 'مالك اختبار',
  total: 42,
  rows: [r1, r2, r3],
});
ok(!!receipt.receipt?.id, 'fixture receipt persists through the real receipt write path');

const vehicleBalanceCents = async (vehicleId) =>
  Math.round((await FinancialService.rebuildVehicleBalance(vehicleId)).balance * 100);
const officeBalanceCents = async (officeId) =>
  Math.round((await FinancialService.getOfficeBalance(officeId)).balance * 100);

console.log('\n— unpaid baseline —');
ok((await vehicleBalanceCents(V1.id)) === 0 && (await vehicleBalanceCents(V2.id)) === 0,
  'unpaid rows leave both authoritative vehicle balances unchanged');
ok((await officeBalanceCents(OFFICE_A.id)) === -3600 && (await officeBalanceCents(OFFICE_B.id)) === -2500,
  'unpaid rows create independent company charge withdrawals while vehicle balances remain unchanged');
ok((await FinancialService.getVehicleLedger(V1.id)).length === 0
  && (await FinancialService.getOfficeBalance(OFFICE_A.id)).entries.length === 2,
  'unpaid rows produce company-only charge movements but no vehicle movements');

console.log('\n— first paid row —');
await FinancialService.setReceiptRowPaymentStatus(U, r1.row_id, 'paid');
ok((await vehicleBalanceCents(V1.id)) === 1100 && (await vehicleBalanceCents(V2.id)) === 0,
  'unpaid → paid adds row.net to its vehicle only (11.00 to V1; V2 unchanged)');
ok((await officeBalanceCents(OFFICE_A.id)) === -1800 && (await officeBalanceCents(OFFICE_B.id)) === -2500,
  'unpaid → paid adds the existing payment deposit without removing independent company charges');
const firstVehicleEntries = await FinancialService.getVehicleLedger(V1.id);
const firstOffice = await FinancialService.getOfficeBalance(OFFICE_A.id);
ok(firstVehicleEntries.length === 1 && firstVehicleEntries[0].amount === 11
  && firstVehicleEntries[0].reference_id === r1.row_id,
  'vehicle movement projection exposes the existing net deposit under row UUID r1');
ok(firstOffice.entries.length === 3
  && firstOffice.entries.filter(entry => entry.reference_type === 'receipt_row_company_charge').length === 2
  && firstOffice.entries.some(entry => entry.reference_type === 'receipt_row_payment'
    && entry.amount === 18 && entry.reference_id === r1.row_id && entry.vehicle_id === null),
  'company projection exposes both receipt-created charges and the independent paid-row net+sarf leg');

console.log('\n— multiple independent paid rows —');
await FinancialService.setReceiptRowPaymentStatus(U, r2.row_id, 'paid');
ok((await vehicleBalanceCents(V1.id)) === 2200 && (await officeBalanceCents(OFFICE_A.id)) === 0,
  'multiple paid rows on the same vehicle/company offset their independent creation charges');
const officeAAfterTwo = await FinancialService.getOfficeBalance(OFFICE_A.id);
const chargeRefsA = officeAAfterTwo.entries
  .filter(entry => entry.reference_type === 'receipt_row_company_charge')
  .map(entry => entry.reference_id).sort();
ok(officeAAfterTwo.entries.length === 4
  && chargeRefsA.join(',') === [r1.row_id, r2.row_id].sort().join(','),
  'identical receipt rows retain independent company-charge UUID traceability');

await FinancialService.setReceiptRowPaymentStatus(U, r3.row_id, 'paid');
ok((await vehicleBalanceCents(V1.id)) === 2200 && (await vehicleBalanceCents(V2.id)) === 2000,
  'different vehicles remain isolated (V1=22.00; V2=20.00)');
ok((await officeBalanceCents(OFFICE_A.id)) === 0 && (await officeBalanceCents(OFFICE_B.id)) === 0,
  'different companies remain isolated while each paid-row deposit offsets only its own charge');

console.log('\n— reversals —');
await FinancialService.setReceiptRowPaymentStatus(U, r2.row_id, 'unpaid');
ok((await vehicleBalanceCents(V1.id)) === 1100 && (await officeBalanceCents(OFFICE_A.id)) === -1800,
  'paid → unpaid removes only that row payment effect while both receipt-created charges remain active');
ok((await FinancialService.getOfficeBalance(OFFICE_A.id)).entries.length === 3
  && (await FinancialService.getOfficeBalance(OFFICE_A.id)).entries.filter(entry => entry.reference_type === 'receipt_row_company_charge').length === 2,
  'reversed payment entry no longer contributes while independent company charges remain in the projection');

await FinancialService.setReceiptRowPaymentStatus(U, r1.row_id, 'unpaid');
await FinancialService.setReceiptRowPaymentStatus(U, r3.row_id, 'unpaid');
ok((await vehicleBalanceCents(V1.id)) === 0 && (await vehicleBalanceCents(V2.id)) === 0,
  'reversing all paid rows removes all vehicle effects through existing is_reversed entries');
ok((await officeBalanceCents(OFFICE_A.id)) === -3600 && (await officeBalanceCents(OFFICE_B.id)) === -2500,
  'reversing all paid rows leaves the independent receipt-created company charges active');

console.log('\n— UI binding fingerprints —');
ok(FINANCIAL_SRC.includes('async function getVehicleLedger(vehicle_id)')
  && FINANCIAL_SRC.includes('async function getOfficeBalance(office_id)'),
  'FinancialService exposes read-only vehicle and office balance projections');
ok(ENTITIES_SRC.includes('FinancialService.rebuildVehicleBalance(vehicle.id)')
  && ENTITIES_SRC.includes('FinancialService.getVehicleLedger(vehicle.id)')
  && ENTITIES_SRC.includes('const ledgerHtml = _renderLedger(client, financials.ledger);'),
  'Vehicle/Owner Details binds its balance and movement UI to the existing vehicle ledger projections');
ok(OFFICES_SRC.includes('const balanceData = await FinancialService.getOfficeBalance(office.id);')
  && OFFICES_SRC.includes('content.innerHTML = _renderOfficeBalance(balanceData.entries);'),
  'Office Details binds the existing Company Balance layout to the office ledger projection');
ok(!FINANCIAL_SRC.includes("STORE.LEDGER, 'read_only_company_ledger'")
  && !FINANCIAL_SRC.includes('company_ledger'),
  'no second company ledger/store or duplicate posting mechanism was introduced');

console.log(failures === 0
  ? '\n✅ ALL BALANCE-PROJECTION ASSERTIONS PASSED'
  : `\n❌ ${failures} BALANCE-PROJECTION FAILURES`);
process.exit(failures === 0 ? 0 : 1);
