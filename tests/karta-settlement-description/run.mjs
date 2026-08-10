// run.mjs — Karta Settlement vehicle description regression.
// Verifies only the vehicle movement label changes. Ledger shape, amounts,
// reference namespace, balance effect, and reversal behavior stay unchanged.

import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');

const U = 'karta-description-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();

const FINANCIAL_SRC = readFileSync('./financial.js', 'utf8');
await DB.init();

const OWNER_ID = uuid();
const DRIVER = { id: uuid(), username: U, name: 'أحمد محمد', phone: null };
const VEHICLE = { id: uuid(), username: U, plate: '123 أ ب', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
await ClientRepository.saveDriver(DRIVER, { username: U });
await ClientRepository.saveVehicle(VEHICLE, { username: U });

const kartaRow = {
  _type: 'data',
  row_id: uuid(),
  owner_id: OWNER_ID,
  owner_name: 'مالك اختبار',
  driver_id: DRIVER.id,
  driver_name: DRIVER.name,
  vehicle_id: VEHICLE.id,
  vehicle_plate: VEHICLE.plate,
  driver_price: 0,
  loading: 'طنطا',
  destination: 'القاهرة',
  office: null,
  advance: 0,
  net: 10,
  sarf: 0,
};
await FinancialService.createReceipt(U, {
  receipt_date: '2026-08-10',
  client_id: OWNER_ID,
  client_type: 'owner',
  client_name: 'مالك اختبار',
  total: 10,
  rows: [kartaRow],
});

const before = await FinancialService.rebuildVehicleBalance(VEHICLE.id);
ok(before.balance === 0, 'vehicle balance starts at zero before Karta Settlement');

await FinancialService.createKartaSettlement(U, {
  row_id: kartaRow.row_id,
  vehicle_id: VEHICLE.id,
  amount: 50,
  date: '2026-08-10',
  note: 'ملاحظة تسوية السائق',
});

const entries = await DB.getByIndex('vehicle_ledger', 'by_reference_id', kartaRow.row_id);
const active = entries.filter(entry => entry.is_reversed === false);
const paymentLeg = active.find(entry => entry.type === 'driver_karta_payment');
const vehicleLeg = active.find(entry => entry.effect === 'karta_settlement_charge');
ok(active.length === 2 && paymentLeg && vehicleLeg,
  'Karta Settlement still creates the exact two active ledger legs');
ok(paymentLeg.amount === -5000 && paymentLeg.price === 5000 && paymentLeg.note === 'ملاحظة تسوية السائق',
  'driver settlement ledger amount, price, and driver-leg note are unchanged');
ok(vehicleLeg.amount === 5000
  && vehicleLeg.type === 'withdraw'
  && vehicleLeg.reference_type === 'receipt_row'
  && vehicleLeg.reference_id === kartaRow.row_id
  && vehicleLeg.effect === 'karta_settlement_charge'
  && vehicleLeg.vehicle_id === VEHICLE.id,
  'vehicle settlement ledger amount, type, reference, effect, and vehicle link remain unchanged');
ok(vehicleLeg.note === 'تسوية كارتة (أحمد محمد)',
  'vehicle movement description is exactly تسوية كارتة (اسم السائق)');

const vehicleLedger = await FinancialService.getVehicleLedger(VEHICLE.id);
ok(vehicleLedger.length === 1 && vehicleLedger[0].note === 'تسوية كارتة (أحمد محمد)',
  'Vehicle Details movement projection exposes the updated Karta description');
const afterCreate = await FinancialService.rebuildVehicleBalance(VEHICLE.id);
ok(afterCreate.balance === -50 && afterCreate.withdraw_total === 50,
  'vehicle balance behavior remains unchanged: Karta Settlement charges 50.00 as a withdrawal');

await FinancialService.reverseKartaSettlement(U, kartaRow.row_id);
const reversed = await DB.getByIndex('vehicle_ledger', 'by_reference_id', kartaRow.row_id);
ok(reversed.length === 2 && reversed.every(entry => entry.is_reversed === true
  && entry.reversed_at && entry.reversed_by === U),
  'Karta Settlement reversal still flags both original entries as reversed');
const afterReverse = await FinancialService.rebuildVehicleBalance(VEHICLE.id);
ok(afterReverse.balance === 0 && afterReverse.entry_count === 0,
  'vehicle balance returns to zero after the unchanged reversal flow');

ok(FINANCIAL_SRC.includes('return driverName ? `تسوية كارتة (${driverName})` : \'تسوية كارتة\';'),
  'description uses the existing receipt-row driver_name snapshot without a new persisted field');
ok(!FINANCIAL_SRC.includes('تحميل تسوية كارتة على المركبة'),
  'obsolete generic vehicle movement description is removed');

console.log(failures === 0
  ? '\n✅ ALL KARTA-SETTLEMENT-DESCRIPTION ASSERTIONS PASSED'
  : `\n❌ ${failures} KARTA-SETTLEMENT-DESCRIPTION FAILURES`);
process.exit(failures === 0 ? 0 : 1);
