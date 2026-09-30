// run.mjs — atomic multi-vehicle Driver Karta batch settlement verification.
import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');

const U = 'karta-batch-settlement-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();
const rejects = async (fn) => {
  try { await fn(); return false; } catch (_) { return true; }
};
const money = (amount) => Math.round(amount * 100);

const FINANCIAL_SRC = readFileSync('./financial.js', 'utf8');
const ENTITIES_SRC = readFileSync('./_src/entities.js', 'utf8');
const INDEX_SRC = readFileSync('./_src/index.html', 'utf8');
const DATABASE_SRC = readFileSync('./database.js', 'utf8');

await DB.init();

const OWNER_ID = uuid();
const DRIVER_A = { id: uuid(), username: U, name: 'السائق أ', phone: null };
const DRIVER_B = { id: uuid(), username: U, name: 'السائق ب', phone: null };
const VA = { id: uuid(), username: U, plate: '111 أ ب', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
const VB = { id: uuid(), username: U, plate: '333 ج د', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
const VC = { id: uuid(), username: U, plate: '777 هـ و', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
await ClientRepository.saveDriver(DRIVER_A, { username: U });
await ClientRepository.saveDriver(DRIVER_B, { username: U });
await ClientRepository.saveVehicle(VA, { username: U });
await ClientRepository.saveVehicle(VB, { username: U });
await ClientRepository.saveVehicle(VC, { username: U });

const mkRow = ({ row_id = uuid(), driver = DRIVER_A, vehicle = VA, price = null, kartano = row_id }) => ({
  _type: 'data', row_id,
  owner_id: OWNER_ID, owner_name: 'مالك اختبار',
  driver_id: driver.id, driver_name: driver.name,
  vehicle_id: vehicle?.id ?? null,
  vehicle_plate: vehicle?.plate ?? null,
  driver_price: 44,
  driver_settlement_price: price,
  loading: 'طنطا', destination: 'القاهرة', office: null,
  advance: 0, net: 10, sarf: 0, kartano,
});

async function createRows(rows) {
  const receiptId = uuid();
  await FinancialService.createReceipt(U, {
    id: receiptId,
    receipt_date: '2026-09-30',
    client_id: OWNER_ID,
    client_type: 'owner',
    client_name: 'مالك اختبار',
    total: rows.length * 10,
    rows,
  });
  return rows;
}

const activeByRow = async (rowId) => (await DB.getByIndex('vehicle_ledger', 'by_reference_id', rowId))
  .filter(entry => entry.is_reversed === false && entry.deleted_at === null);
const batchChargeEntries = async (vehicleId, refs) => (await DB.getByIndex('vehicle_ledger', 'by_vehicle', vehicleId))
  .filter(entry => entry.is_reversed === false
    && entry.effect === 'karta_settlement_charge'
    && refs.includes(entry.reference_id));
const vehicleCents = async (vehicleId) => money((await FinancialService.rebuildVehicleBalance(vehicleId)).balance);

console.log('\n— basic multi-vehicle batch: 500 / 0 / blank / 300 —');
const A = mkRow({ vehicle: VA, price: 500, kartano: 'A-500' });
const B = mkRow({ vehicle: VB, price: 0, kartano: 'B-0' });
const BLANK = mkRow({ vehicle: VB, price: null, kartano: 'B-BLANK' });
const C = mkRow({ vehicle: VC, price: 300, kartano: 'C-300' });
await createRows([A, B, BLANK, C]);
const driverBefore = await FinancialService.getDriverBalance(DRIVER_A.id);
const basic = await FinancialService.createKartaSettlementBatch(U, DRIVER_A.id, [A.row_id, B.row_id, BLANK.row_id, C.row_id]);
ok(basic.success === true && basic.settled_count === 2 && basic.total === 800
  && basic.affected_vehicle_count === 2 && basic.batch_id,
  'batch settles exactly the positive-price rows with total 800 across two vehicles');
ok(new Set([...await activeByRow(A.row_id), ...await activeByRow(C.row_id)].map(entry => entry.batch_id)).size === 1
  && (await activeByRow(A.row_id)).every(entry => entry.batch_id === basic.batch_id)
  && (await activeByRow(C.row_id)).every(entry => entry.batch_id === basic.batch_id),
  'every created batch ledger entry shares one batch_id');
ok((await activeByRow(A.row_id)).length === 2 && (await activeByRow(C.row_id)).length === 2
  && (await activeByRow(B.row_id)).length === 0 && (await activeByRow(BLANK.row_id)).length === 0,
  'positive rows receive two legs each while zero and blank rows receive no movement');
ok((await activeByRow(A.row_id)).every(entry => entry.reference_id === A.row_id)
  && (await activeByRow(C.row_id)).every(entry => entry.reference_id === C.row_id),
  'each Karta leg keeps reference_id equal to its own row_id');
ok((await vehicleCents(VA.id)) === -50000
  && (await vehicleCents(VB.id)) === 0
  && (await vehicleCents(VC.id)) === -30000,
  'vehicle A withdraws 500, vehicle B remains unchanged, and vehicle C withdraws 300');
ok((await FinancialService.getDriverBalance(DRIVER_A.id)).balance === driverBefore.balance,
  'batch driver_karta_payment legs do not alter the Driver Balance projection');
const afterBasicProjection = await FinancialService.getDriverKartas(DRIVER_A.id);
ok(afterBasicProjection.find(row => row.row_id === A.row_id).status === 'settled'
  && afterBasicProjection.find(row => row.row_id === C.row_id).status === 'settled'
  && afterBasicProjection.find(row => row.row_id === B.row_id).status === 'unsettled'
  && afterBasicProjection.find(row => row.row_id === BLANK.row_id).status === 'unsettled',
  'only positive-price rows move from unsettled to settled');

console.log('\n— same vehicle rows remain separately auditable —');
const SAME_A = mkRow({ vehicle: VA, price: 500, kartano: 'VA-500' });
const SAME_B = mkRow({ vehicle: VA, price: 300, kartano: 'VA-300' });
const SAME_C = mkRow({ vehicle: VB, price: 200, kartano: 'VB-200' });
await createRows([SAME_A, SAME_B, SAME_C]);
const beforeSameA = await vehicleCents(VA.id);
const beforeSameB = await vehicleCents(VB.id);
const sameVehicleBatch = await FinancialService.createKartaSettlementBatch(U, DRIVER_A.id, [SAME_A.row_id, SAME_B.row_id, SAME_C.row_id]);
const sameVehicleCharges = await batchChargeEntries(VA.id, [SAME_A.row_id, SAME_B.row_id]);
ok(sameVehicleBatch.settled_count === 3
  && sameVehicleCharges.length === 2
  && sameVehicleCharges.map(entry => entry.amount).sort((a, b) => a - b).join(',') === '30000,50000',
  'same-vehicle Kartas create two separate vehicle withdrawals, never one aggregate charge');
ok((await vehicleCents(VA.id)) === beforeSameA - 80000
  && (await vehicleCents(VB.id)) === beforeSameB - 20000,
  'same-vehicle and other-vehicle balances change exactly once per Karta');

console.log('\n— already-settled rows are skipped, never duplicated —');
const ALREADY = mkRow({ vehicle: VC, price: 50, kartano: 'ALREADY' });
const FRESH = mkRow({ vehicle: VC, price: 500, kartano: 'FRESH' });
await createRows([ALREADY, FRESH]);
await FinancialService.createKartaSettlement(U, {
  row_id: ALREADY.row_id, vehicle_id: VC.id, amount: 50, date: '2026-09-30', note: 'تسوية فردية قائمة',
});
const alreadyLegsBefore = await activeByRow(ALREADY.row_id);
const mixed = await FinancialService.createKartaSettlementBatch(U, DRIVER_A.id, [ALREADY.row_id, FRESH.row_id]);
ok(mixed.settled_count === 1 && mixed.skipped_row_ids.includes(ALREADY.row_id)
  && (await activeByRow(ALREADY.row_id)).length === alreadyLegsBefore.length
  && (await activeByRow(FRESH.row_id)).length === 2,
  'already-settled Karta is skipped and only the fresh Karta is settled');

console.log('\n— atomic validation guards —');
const VALID = mkRow({ vehicle: VA, price: 500, kartano: 'VALID-WITH-BAD' });
await createRows([VALID]);
const MISSING_VEHICLE = mkRow({ vehicle: null, price: 300, kartano: 'MISSING-VEHICLE' });
await DB.add('receipt_rows', {
  ...MISSING_VEHICLE,
  receipt_id: uuid(),
  driver_settlement_price: 30000,
  driver_price: 4400,
  advance: 0,
  net: 1000,
  sarf: 0,
  payment_status: 'unpaid',
}, { username: U });
const beforeMissingFailure = await DB.getAll('vehicle_ledger', {}, { includeDeleted: true });
ok(await rejects(() => FinancialService.createKartaSettlementBatch(U, DRIVER_A.id, [VALID.row_id, MISSING_VEHICLE.row_id])),
  'positive-price row without vehicle rejects the entire batch');
ok(JSON.stringify(await DB.getAll('vehicle_ledger', {}, { includeDeleted: true })) === JSON.stringify(beforeMissingFailure)
  && (await activeByRow(VALID.row_id)).length === 0,
  'missing-vehicle validation leaves no partial settlement for the valid row');

const NEGATIVE = mkRow({ vehicle: VB, price: 10, kartano: 'NEGATIVE' });
await createRows([NEGATIVE]);
await DB.update('receipt_rows', NEGATIVE.row_id, { driver_settlement_price: -100 }, { username: U });
const beforeNegativeFailure = await DB.getAll('vehicle_ledger', {}, { includeDeleted: true });
ok(await rejects(() => FinancialService.createKartaSettlementBatch(U, DRIVER_A.id, [NEGATIVE.row_id])),
  'corrupt negative persisted price rejects the batch');
ok(JSON.stringify(await DB.getAll('vehicle_ledger', {}, { includeDeleted: true })) === JSON.stringify(beforeNegativeFailure),
  'negative-price rejection creates no driver or vehicle settlement leg');

const DUPLICATE = mkRow({ vehicle: VB, price: 100, kartano: 'DUPLICATE' });
await createRows([DUPLICATE]);
ok(await rejects(() => FinancialService.createKartaSettlementBatch(U, DRIVER_A.id, [DUPLICATE.row_id, DUPLICATE.row_id])),
  'duplicate row_id input is rejected before batch writes');
ok((await activeByRow(DUPLICATE.row_id)).length === 0,
  'duplicate input rejection leaves the Karta unsettled');

const OTHER_DRIVER = mkRow({ driver: DRIVER_B, vehicle: VB, price: 150, kartano: 'OTHER-DRIVER' });
await createRows([OTHER_DRIVER]);
ok(await rejects(() => FinancialService.createKartaSettlementBatch(U, DRIVER_A.id, [OTHER_DRIVER.row_id])),
  'selected driver cannot settle another driver’s Karta');
ok((await activeByRow(OTHER_DRIVER.row_id)).length === 0,
  'driver-isolation rejection creates no movement for the other driver');

console.log('\n— simulated ledger write failure rolls back the entire batch —');
const FAIL_A = mkRow({ vehicle: VA, price: 100, kartano: 'FAIL-A' });
const FAIL_B = mkRow({ vehicle: VC, price: 200, kartano: 'FAIL-B' });
await createRows([FAIL_A, FAIL_B]);
const allLedgerBeforeWriteFailure = await DB.getAll('vehicle_ledger', {}, { includeDeleted: true });
const ledgerStore = DB._db.stores.get('vehicle_ledger');
const originalAdd = ledgerStore.add;
let attemptedAdds = 0;
ledgerStore.add = function failingSecondLedgerAdd(record) {
  attemptedAdds++;
  if (attemptedAdds === 2) throw new Error('simulated ledger write failure');
  return originalAdd.call(this, record);
};
const writeFailed = await rejects(() => FinancialService.createKartaSettlementBatch(U, DRIVER_A.id, [FAIL_A.row_id, FAIL_B.row_id]));
ledgerStore.add = originalAdd;
ok(writeFailed && attemptedAdds >= 2,
  'simulated failure occurs after the first batch ledger write is attempted');
ok(JSON.stringify(await DB.getAll('vehicle_ledger', {}, { includeDeleted: true })) === JSON.stringify(allLedgerBeforeWriteFailure)
  && (await activeByRow(FAIL_A.row_id)).length === 0
  && (await activeByRow(FAIL_B.row_id)).length === 0,
  'transaction rollback leaves no partial batch settlement after a write failure');

console.log('\n— UI, single-row, and schema regression contracts —');
ok(ENTITIES_SRC.includes('FinancialService.createKartaSettlementBatch(')
  && ENTITIES_SRC.includes('settle-unsettled-kartas')
  && INDEX_SRC.includes('id="settleUnsettledKartasBtn"')
  && INDEX_SRC.includes('>تسوية عام</button>'),
  'تسوية عام is wired only through the Driver Details unsettled Karta workflow');
ok(ENTITIES_SRC.includes('عدد الكارتات: ${eligible.length}')
  && ENTITIES_SRC.includes('إجمالي التسوية: ${_fmt(Money.toDecimal(totalCents))}')
  && ENTITIES_SRC.includes('السيارات المتأثرة: ${affectedVehicles}'),
  'confirmation is computed from eligible rows with count, amount total, and vehicle count');
ok(FINANCIAL_SRC.includes('async function createKartaSettlement(username, data)')
  && FINANCIAL_SRC.includes('async function updateKartaSettlement(username, data)')
  && FINANCIAL_SRC.includes('async function createKartaSettlementBatch(username, driverId, rowIds)'),
  'existing single-row Karta settlement APIs remain alongside the batch API');
ok(DATABASE_SRC.includes('const DB_VERSION = 16;')
  && !DATABASE_SRC.includes('batch_id')
  && !DATABASE_SRC.includes('batches'),
  'batch_id is ledger metadata only; no DB version, store, or index was added');

console.log(failures === 0
  ? '\n✅ ALL KARTA-BATCH-SETTLEMENT ASSERTIONS PASSED'
  : `\n❌ ${failures} KARTA-BATCH-SETTLEMENT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
