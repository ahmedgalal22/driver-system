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

// Namespace filters mirror financial.js: Karta legs are
// reference_type 'receipt_row' + driver_karta_payment / karta_settlement_charge
// (_activeKartaSettlementLegs); the receipt-creation deposit is the separate
// receipt_row_vehicle_balance namespace sharing the same reference_id.
const VEHICLE_CREATION = 'receipt_row_vehicle_balance';
const isKartaLeg = (entry) => entry.reference_type === 'receipt_row'
  && (entry.type === 'driver_karta_payment' || entry.effect === 'karta_settlement_charge');
const isVehicleCreation = (entry) => entry.reference_type === VEHICLE_CREATION
  && entry.effect === VEHICLE_CREATION;
const activeOf = (entries) => entries.filter((entry) => entry.is_reversed === false && entry.deleted_at === null);

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
const creationBeforeSettle = activeOf(await DB.getByIndex('vehicle_ledger', 'by_reference_id', kartaRow.row_id))
  .filter(isVehicleCreation);
ok(creationBeforeSettle.length === 1 && creationBeforeSettle[0].type === 'deposit'
  && creationBeforeSettle[0].amount === 1000 && creationBeforeSettle[0].vehicle_id === VEHICLE.id,
  'receipt creation contributes exactly one active vehicle deposit equal to net (10.00) before any settlement');
ok(before.balance === 10 && before.deposit_total === 10 && before.withdraw_total === 0,
  'vehicle balance before Karta Settlement is exactly the receipt-creation net deposit (+10.00)');

const createdSettlement = await FinancialService.createKartaSettlement(U, {
  row_id: kartaRow.row_id,
  driver_id: DRIVER.id,
  vehicle_id: VEHICLE.id,
  amount: 50,
  date: '2026-08-10',
  note: 'ملاحظة تسوية السائق',
});

ok(createdSettlement.settlement_reference_id === kartaRow.row_id && createdSettlement.row_id === kartaRow.row_id,
  'single settlement returns the persisted receipt-row settlement identity');

const entries = await DB.getByIndex('vehicle_ledger', 'by_reference_id', kartaRow.row_id);
const active = activeOf(entries);
const activeKarta = active.filter(isKartaLeg);
const activeCreation = active.filter(isVehicleCreation);
const paymentLeg = activeKarta.find(entry => entry.type === 'driver_karta_payment');
const vehicleLeg = activeKarta.find(entry => entry.effect === 'karta_settlement_charge');
ok(activeKarta.length === 2 && paymentLeg && vehicleLeg
  && activeCreation.length === 1 && active.length === 3,
  'Karta Settlement still creates the exact two active Karta legs, distinct from the one receipt-creation deposit');
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
ok(vehicleLedger.length === 2
  && vehicleLedger.some(entry => entry.effect === 'karta_settlement_charge' && entry.note === 'تسوية كارتة (أحمد محمد)')
  && vehicleLedger.some(entry => entry.effect === VEHICLE_CREATION && entry.type === 'deposit'),
  'Vehicle Details movement projection exposes the updated Karta description alongside the separate creation deposit');
const afterCreate = await FinancialService.rebuildVehicleBalance(VEHICLE.id);
ok(afterCreate.balance === before.balance - 50
  && afterCreate.withdraw_total === before.withdraw_total + 50
  && afterCreate.deposit_total === before.deposit_total,
  'vehicle balance behavior remains unchanged: Karta Settlement charges exactly 50.00 as a withdrawal (delta from the creation baseline)');

await FinancialService.reverseKartaSettlement(U, kartaRow.row_id);
const reversed = await DB.getByIndex('vehicle_ledger', 'by_reference_id', kartaRow.row_id);
const reversedKarta = reversed.filter(isKartaLeg);
const creationAfterReverse = reversed.filter(isVehicleCreation);
ok(reversedKarta.length === 2 && reversedKarta.every(entry => entry.is_reversed === true
  && entry.reversed_at && entry.reversed_by === U),
  'Karta Settlement reversal still flags both original Karta entries as reversed exactly once');
ok(creationAfterReverse.length === 1 && creationAfterReverse[0].is_reversed === false
  && reversed.length === 3,
  'Karta reversal leaves the receipt-creation deposit active while the receipt row remains live (full history retained)');
const afterReverse = await FinancialService.rebuildVehicleBalance(VEHICLE.id);
ok(afterReverse.balance === before.balance && afterReverse.entry_count === 1,
  'vehicle balance returns to the pre-settlement creation baseline after the unchanged reversal flow');

ok(FINANCIAL_SRC.includes('return driverName ? `تسوية كارتة (${driverName})` : \'تسوية كارتة\';'),
  'description uses the existing receipt-row driver_name snapshot without a new persisted field');
ok(!FINANCIAL_SRC.includes('تحميل تسوية كارتة على المركبة'),
  'obsolete generic vehicle movement description is removed');

console.log(failures === 0
  ? '\n✅ ALL KARTA-SETTLEMENT-DESCRIPTION ASSERTIONS PASSED'
  : `\n❌ ${failures} KARTA-SETTLEMENT-DESCRIPTION FAILURES`);
process.exit(failures === 0 ? 0 : 1);
