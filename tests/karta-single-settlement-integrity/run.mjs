// run.mjs — Phase 6A single Karta settlement integrity verification.
import { installIDB } from './idb-shim.mjs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');

const U = 'single-karta-integrity-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const rejects = async (fn) => {
  try { await fn(); return false; } catch (_) { return true; }
};
const uuid = () => crypto.randomUUID();

await DB.init();

const OWNER_ID = uuid();
const DRIVER_A = { id: uuid(), username: U, name: 'السائق أ', phone: null };
const DRIVER_B = { id: uuid(), username: U, name: 'السائق ب', phone: null };
const V1 = { id: uuid(), username: U, plate: '111 أ ب', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
const V2 = { id: uuid(), username: U, plate: '222 ج د', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
await ClientRepository.saveDriver(DRIVER_A, { username: U });
await ClientRepository.saveDriver(DRIVER_B, { username: U });
await ClientRepository.saveVehicle(V1, { username: U });
await ClientRepository.saveVehicle(V2, { username: U });

const mkRow = ({ row_id = uuid(), driver = DRIVER_A, vehicle = V1, kartano = row_id }) => ({
  _type: 'data', row_id,
  owner_id: OWNER_ID, owner_name: 'مالك اختبار',
  driver_id: driver.id, driver_name: driver.name,
  vehicle_id: vehicle?.id ?? null, vehicle_plate: vehicle?.plate ?? null,
  driver_price: 0, driver_settlement_price: 50,
  loading: 'طنطا', destination: 'القاهرة', office: null,
  advance: 0, net: 10, sarf: 0, kartano,
});

async function createRow(row) {
  await FinancialService.createReceipt(U, {
    receipt_date: '2026-10-01', client_id: OWNER_ID, client_type: 'owner', client_name: 'مالك اختبار',
    total: 10, rows: [row],
  });
  return row;
}

const activeLegs = async (rowId) => (await DB.getByIndex('vehicle_ledger', 'by_reference_id', rowId))
  .filter(entry => entry.is_reversed === false && entry.deleted_at === null
    && entry.reference_type === 'receipt_row');
const ledgerSnapshot = async () => JSON.stringify(await DB.getAll('vehicle_ledger', {}, { includeDeleted: true }));
const vehicleCents = async (vehicleId) => Math.round((await FinancialService.rebuildVehicleBalance(vehicleId)).balance * 100);

function driverLeg(row, amount = 5000, vehicle = V1) {
  return {
    username: U, owner_id: DRIVER_A.id, owner_name: null, client_id: null, client_type: 'driver',
    type: 'driver_karta_payment', amount: -amount, price: amount,
    vehicle_id: vehicle.id, reference_type: 'receipt_row', reference_id: row.row_id,
    date: '2026-10-01', applied_at: '2026-10-01T10:00:00', is_reversed: false, note: 'اختبار',
  };
}
function vehicleLeg(row, amount = 5000, vehicle = V1) {
  return {
    username: U, owner_id: OWNER_ID, owner_name: 'مالك اختبار', client_id: OWNER_ID, client_type: 'owner',
    vehicle_id: vehicle.id, vehicle_plate: vehicle.plate, type: 'withdraw', effect: 'karta_settlement_charge', amount,
    reference_type: 'receipt_row', reference_id: row.row_id,
    date: '2026-10-01', applied_at: '2026-10-01T10:00:00', is_reversed: false, note: 'اختبار',
  };
}

console.log('\n— source, driver, and vehicle validation —');
let before = await ledgerSnapshot();
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: 'missing-row', driver_id: DRIVER_A.id, amount: 50, date: '2026-10-01',
})), 'missing receipt row is rejected');
ok((await ledgerSnapshot()) === before, 'missing receipt row writes no ledger entries');

const DELETED_ROW = await createRow(mkRow({ kartano: 'DELETED' }));
await DB.delete('receipt_rows', DELETED_ROW.row_id, { username: U });
before = await ledgerSnapshot();
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: DELETED_ROW.row_id, driver_id: DRIVER_A.id, amount: 50, date: '2026-10-01',
})), 'deleted receipt row is rejected');
ok((await ledgerSnapshot()) === before, 'deleted receipt row writes no ledger entries');

const NO_DRIVER = await createRow(mkRow({ kartano: 'NO-DRIVER' }));
await DB.update('receipt_rows', NO_DRIVER.row_id, { driver_id: null }, { username: U });
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: NO_DRIVER.row_id, driver_id: DRIVER_A.id, amount: 50, date: '2026-10-01',
})), 'row without a driver is rejected');

const WRONG_DRIVER = await createRow(mkRow({ kartano: 'WRONG-DRIVER' }));
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: WRONG_DRIVER.row_id, driver_id: DRIVER_B.id, amount: 50, date: '2026-10-01',
})), 'selected driver must match receipt-row driver');
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: WRONG_DRIVER.row_id, amount: 50, date: '2026-10-01',
})), 'missing selected driver is rejected');
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: WRONG_DRIVER.row_id, driver_id: DRIVER_A.id, amount: Infinity, date: '2026-10-01',
})), 'non-finite settlement amount is rejected');

const INACTIVE_DRIVER = { id: uuid(), username: U, name: 'سائق محذوف', phone: null };
await ClientRepository.saveDriver(INACTIVE_DRIVER, { username: U });
const INACTIVE_DRIVER_ROW = await createRow(mkRow({ driver: INACTIVE_DRIVER, kartano: 'INACTIVE-DRIVER' }));
await ClientRepository.deleteDriver(INACTIVE_DRIVER.id, { username: U });
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: INACTIVE_DRIVER_ROW.row_id, driver_id: INACTIVE_DRIVER.id, amount: 50, date: '2026-10-01',
})), 'inactive receipt-row driver is rejected');

const NO_VEHICLE = await createRow(mkRow({ kartano: 'NO-VEHICLE' }));
await DB.update('receipt_rows', NO_VEHICLE.row_id, { vehicle_id: null, vehicle_plate: null }, { username: U });
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: NO_VEHICLE.row_id, driver_id: DRIVER_A.id, amount: 50, date: '2026-10-01',
})), 'row without vehicle_id is rejected');

const INACTIVE_VEHICLE = { id: uuid(), username: U, plate: '999 ز ح', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
await ClientRepository.saveVehicle(INACTIVE_VEHICLE, { username: U });
const INACTIVE_VEHICLE_ROW = await createRow(mkRow({ vehicle: INACTIVE_VEHICLE, kartano: 'INACTIVE-VEHICLE' }));
await ClientRepository.deleteVehicle(INACTIVE_VEHICLE.id, { username: U });
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: INACTIVE_VEHICLE_ROW.row_id, driver_id: DRIVER_A.id, amount: 50, date: '2026-10-01',
})), 'inactive receipt-row vehicle is rejected');

console.log('\n— authoritative successful settlement and return identity —');
const VALID = await createRow(mkRow({ vehicle: V1, kartano: 'VALID' }));
const driverBalanceBefore = await FinancialService.getDriverBalance(DRIVER_A.id);
const created = await FinancialService.createKartaSettlement(U, {
  row_id: VALID.row_id, driver_id: DRIVER_A.id, vehicle_id: V1.id, amount: 50,
  date: '2026-10-01', note: 'تسوية صحيحة',
});
const validLegs = await activeLegs(VALID.row_id);
const validDriverLeg = validLegs.find(entry => entry.type === 'driver_karta_payment');
const validVehicleLeg = validLegs.find(entry => entry.effect === 'karta_settlement_charge');
ok(created.settlement_reference_id === VALID.row_id && created.row_id === VALID.row_id,
  'returned settlement identity equals the persisted receipt row ID');
ok(validLegs.length === 2 && validDriverLeg && validVehicleLeg
  && validDriverLeg.reference_type === 'receipt_row' && validVehicleLeg.reference_type === 'receipt_row'
  && validDriverLeg.reference_id === VALID.row_id && validVehicleLeg.reference_id === VALID.row_id
  && validDriverLeg.vehicle_id === V1.id && validVehicleLeg.vehicle_id === V1.id
  && validDriverLeg.amount === -5000 && validDriverLeg.price === 5000
  && validVehicleLeg.amount === 5000 && validVehicleLeg.type === 'withdraw',
  'successful settlement writes exactly one authoritative driver/vehicle pair');
ok((await vehicleCents(V1.id)) === -5000
  && (await FinancialService.getDriverBalance(DRIVER_A.id)).balance === driverBalanceBefore.balance,
  'vehicle decreases once while the existing Driver Balance projection remains unchanged');

before = await ledgerSnapshot();
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: VALID.row_id, driver_id: DRIVER_A.id, amount: 50, date: '2026-10-01',
})), 'complete active settlement rejects duplicate creation');
ok((await ledgerSnapshot()) === before, 'duplicate settlement rejection writes nothing');
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: VALID.row_id, driver_id: DRIVER_A.id, vehicle_id: V2.id, amount: 50, date: '2026-10-01',
})), 'caller supplied wrong vehicle ID is rejected');

console.log('\n— partial and duplicate active pair detection —');
const DRIVER_ONLY = await createRow(mkRow({ kartano: 'DRIVER-ONLY' }));
await DB.add('vehicle_ledger', driverLeg(DRIVER_ONLY), { username: U });
before = await ledgerSnapshot();
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: DRIVER_ONLY.row_id, driver_id: DRIVER_A.id, amount: 50, date: '2026-10-01',
})), 'active driver leg without vehicle charge is rejected as partial state');
ok((await ledgerSnapshot()) === before, 'partial driver-leg rejection writes nothing');

const VEHICLE_ONLY = await createRow(mkRow({ kartano: 'VEHICLE-ONLY' }));
await DB.add('vehicle_ledger', vehicleLeg(VEHICLE_ONLY), { username: U });
before = await ledgerSnapshot();
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: VEHICLE_ONLY.row_id, driver_id: DRIVER_A.id, amount: 50, date: '2026-10-01',
})), 'active vehicle charge without driver leg is rejected as partial state');
ok((await ledgerSnapshot()) === before, 'partial vehicle-leg rejection writes nothing');

const MULTIPLE = await createRow(mkRow({ kartano: 'MULTIPLE' }));
await DB.add('vehicle_ledger', driverLeg(MULTIPLE), { username: U });
await DB.add('vehicle_ledger', driverLeg(MULTIPLE), { username: U });
before = await ledgerSnapshot();
ok(await rejects(() => FinancialService.createKartaSettlement(U, {
  row_id: MULTIPLE.row_id, driver_id: DRIVER_A.id, amount: 50, date: '2026-10-01',
})), 'multiple active settlement legs are rejected as duplicate state');
ok((await ledgerSnapshot()) === before, 'duplicate-state rejection writes nothing');

console.log('\n— atomic update and reversal —');
const balanceBeforeUpdate = await vehicleCents(V1.id);
const UPDATE_ROW = await createRow(mkRow({ vehicle: V1, kartano: 'UPDATE' }));
await FinancialService.createKartaSettlement(U, {
  row_id: UPDATE_ROW.row_id, driver_id: DRIVER_A.id, amount: 50, date: '2026-10-01',
});
const oldUpdateLegs = await activeLegs(UPDATE_ROW.row_id);
const updated = await FinancialService.updateKartaSettlement(U, {
  row_id: UPDATE_ROW.row_id, driver_id: DRIVER_A.id, vehicle_id: V1.id,
  amount: 80, date: '2026-10-02', note: 'تعديل صحيح',
});
const allUpdateLegs = await DB.getByIndex('vehicle_ledger', 'by_reference_id', UPDATE_ROW.row_id);
const newUpdateLegs = allUpdateLegs.filter(entry => entry.is_reversed === false);
ok(updated.settlement_reference_id === UPDATE_ROW.row_id
  && oldUpdateLegs.every(entry => allUpdateLegs.find(saved => saved.id === entry.id)?.is_reversed === true)
  && newUpdateLegs.length === 2
  && newUpdateLegs.every(entry => entry.vehicle_id === V1.id)
  && newUpdateLegs.find(entry => entry.effect === 'karta_settlement_charge')?.amount === 8000,
  'update reverses old pair and writes a corrected pair using the row vehicle');
ok(await rejects(() => FinancialService.updateKartaSettlement(U, {
  row_id: UPDATE_ROW.row_id, driver_id: DRIVER_A.id, vehicle_id: V2.id,
  amount: 90, date: '2026-10-02',
})), 'update rejects caller attempt to move charge to another vehicle');
await FinancialService.reverseKartaSettlement(U, UPDATE_ROW.row_id);
const reversedUpdateLegs = await DB.getByIndex('vehicle_ledger', 'by_reference_id', UPDATE_ROW.row_id);
ok(reversedUpdateLegs.every(entry => entry.is_reversed === true && entry.deleted_at === null)
  && (await vehicleCents(V1.id)) === balanceBeforeUpdate,
  'reversal marks both active corrected legs reversed, retains history, and restores that settlement balance');

console.log('\n— partial reversal is surfaced, not silently hidden —');
const PARTIAL_REVERSE = await createRow(mkRow({ kartano: 'PARTIAL-REVERSE' }));
await DB.add('vehicle_ledger', driverLeg(PARTIAL_REVERSE), { username: U });
before = await ledgerSnapshot();
ok(await rejects(() => FinancialService.reverseKartaSettlement(U, PARTIAL_REVERSE.row_id)),
  'reversal rejects an inconsistent partial settlement pair');
ok((await ledgerSnapshot()) === before, 'partial reversal rejection preserves evidence for a future repair workflow');

console.log(failures === 0
  ? '\n✅ ALL SINGLE-KARTA-SETTLEMENT-INTEGRITY ASSERTIONS PASSED'
  : `\n❌ ${failures} SINGLE-KARTA-SETTLEMENT-INTEGRITY FAILURES`);
process.exit(failures === 0 ? 0 : 1);
