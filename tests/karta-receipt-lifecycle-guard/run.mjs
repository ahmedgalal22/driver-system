// run.mjs — Phase 6B receipt lifecycle must block active Karta settlements.
import { installIDB } from './idb-shim.mjs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');

const U = 'karta-receipt-lifecycle-guard-tester';
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
const DRIVER = { id: uuid(), username: U, name: 'سائق اختبار', phone: null };
const VEHICLE = { id: uuid(), username: U, plate: '111 أ ب', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
await ClientRepository.saveDriver(DRIVER, { username: U });
await ClientRepository.saveVehicle(VEHICLE, { username: U });

const mkRow = ({ row_id = uuid(), price = 50, kartano = row_id }) => ({
  _type: 'data', row_id,
  owner_id: OWNER_ID, owner_name: 'مالك اختبار',
  driver_id: DRIVER.id, driver_name: DRIVER.name,
  vehicle_id: VEHICLE.id, vehicle_plate: VEHICLE.plate,
  driver_price: 10, driver_settlement_price: price,
  loading: 'طنطا', destination: 'القاهرة', office: null,
  advance: 0, net: 10, sarf: 0, kartano,
});

function payload(rows) {
  return {
    receipt_date: '2026-10-05',
    client_id: OWNER_ID,
    client_type: 'owner',
    client_name: 'مالك اختبار',
    total: rows.length * 10,
    rows,
  };
}

async function createReceipt(rows) {
  return FinancialService.createReceipt(U, payload(rows));
}

const all = async (store, filters = {}) => DB.findByFields(store, filters, { includeDeleted: true });
async function snapshot(receiptId) {
  return JSON.stringify({
    receipts: await all('receipts', { id: receiptId }),
    rows: await all('receipt_rows', { receipt_id: receiptId }),
    ledger: await all('vehicle_ledger'),
  });
}
const activeKarta = async (rowId) => (await DB.getByIndex('vehicle_ledger', 'by_reference_id', rowId))
  .filter(entry => entry.is_reversed === false
    && entry.deleted_at === null
    && entry.reference_type === 'receipt_row'
    && (entry.type === 'driver_karta_payment' || entry.effect === 'karta_settlement_charge'));

async function settleSingle(row) {
  return FinancialService.createKartaSettlement(U, {
    row_id: row.row_id,
    driver_id: DRIVER.id,
    amount: 50,
    date: '2026-10-05',
    note: 'تسوية اختبار',
  });
}

console.log('\n— ordinary receipt lifecycle remains unchanged without Karta settlement —');
const NO_SETTLE_UPDATE = mkRow({ kartano: 'NO-SETTLE-UPDATE' });
const noSettleUpdateReceipt = await createReceipt([NO_SETTLE_UPDATE]);
const replacement = mkRow({ kartano: 'NO-SETTLE-UPDATE-NEW' });
await FinancialService.updateReceipt(U, noSettleUpdateReceipt.receipt.id, payload([replacement]));
ok((await DB.getById('receipt_rows', replacement.row_id))?.kartano === 'NO-SETTLE-UPDATE-NEW'
  && (await DB.getById('receipt_rows', NO_SETTLE_UPDATE.row_id)) === null,
  'receipt update with no active Karta settlement succeeds normally');

const NO_SETTLE_DELETE = mkRow({ kartano: 'NO-SETTLE-DELETE' });
const noSettleDeleteReceipt = await createReceipt([NO_SETTLE_DELETE]);
await FinancialService.deleteReceipt(U, noSettleDeleteReceipt.receipt.id);
ok((await DB.getById('receipts', noSettleDeleteReceipt.receipt.id)) === null
  && (await DB.getById('receipt_rows', NO_SETTLE_DELETE.row_id)) === null,
  'receipt delete with no active Karta settlement succeeds normally');

console.log('\n— active single-row settlement blocks update and delete without mutation —');
const SINGLE_UPDATE = mkRow({ kartano: 'SINGLE-UPDATE' });
const singleUpdateReceipt = await createReceipt([SINGLE_UPDATE]);
await settleSingle(SINGLE_UPDATE);
const singleUpdateBefore = await snapshot(singleUpdateReceipt.receipt.id);
ok(await rejects(() => FinancialService.updateReceipt(U, singleUpdateReceipt.receipt.id, payload([mkRow({ kartano: 'SHOULD-NOT-EXIST' })]))),
  'receipt update with active single Karta settlement is rejected');
ok((await snapshot(singleUpdateReceipt.receipt.id)) === singleUpdateBefore
  && (await activeKarta(SINGLE_UPDATE.row_id)).length === 2,
  'single-settlement update rejection changes neither receipt rows nor ledger legs');

const SINGLE_DELETE = mkRow({ kartano: 'SINGLE-DELETE' });
const singleDeleteReceipt = await createReceipt([SINGLE_DELETE]);
await settleSingle(SINGLE_DELETE);
const singleDeleteBefore = await snapshot(singleDeleteReceipt.receipt.id);
ok(await rejects(() => FinancialService.deleteReceipt(U, singleDeleteReceipt.receipt.id)),
  'receipt delete with active single Karta settlement is rejected');
ok((await snapshot(singleDeleteReceipt.receipt.id)) === singleDeleteBefore
  && (await DB.getById('receipt_rows', SINGLE_DELETE.row_id))
  && (await activeKarta(SINGLE_DELETE.row_id)).length === 2,
  'single-settlement delete rejection soft-deletes nothing and preserves ledger evidence');

console.log('\n— active batch settlement blocks update and delete exactly the same way —');
const BATCH_UPDATE = mkRow({ price: 100, kartano: 'BATCH-UPDATE' });
const batchUpdateReceipt = await createReceipt([BATCH_UPDATE]);
await FinancialService.createKartaSettlementBatch(U, DRIVER.id, [BATCH_UPDATE.row_id]);
const batchUpdateBefore = await snapshot(batchUpdateReceipt.receipt.id);
ok(await rejects(() => FinancialService.updateReceipt(U, batchUpdateReceipt.receipt.id, payload([mkRow({ kartano: 'BATCH-UPDATE-NEW' })]))),
  'receipt update with active batch Karta settlement is rejected');
ok((await snapshot(batchUpdateReceipt.receipt.id)) === batchUpdateBefore
  && (await activeKarta(BATCH_UPDATE.row_id)).length === 2,
  'batch-settlement update rejection creates no replacement row or ledger mutation');

const BATCH_DELETE = mkRow({ price: 100, kartano: 'BATCH-DELETE' });
const batchDeleteReceipt = await createReceipt([BATCH_DELETE]);
await FinancialService.createKartaSettlementBatch(U, DRIVER.id, [BATCH_DELETE.row_id]);
const batchDeleteBefore = await snapshot(batchDeleteReceipt.receipt.id);
ok(await rejects(() => FinancialService.deleteReceipt(U, batchDeleteReceipt.receipt.id)),
  'receipt delete with active batch Karta settlement is rejected');
ok((await snapshot(batchDeleteReceipt.receipt.id)) === batchDeleteBefore
  && (await DB.getById('receipt_rows', BATCH_DELETE.row_id))
  && (await activeKarta(BATCH_DELETE.row_id)).length === 2,
  'batch-settlement delete rejection preserves active pair and receipt rows');

console.log('\n— one settled row blocks the entire multi-row receipt mutation —');
const MULTI_UNSETTLED = mkRow({ kartano: 'MULTI-UNSETTLED' });
const MULTI_SETTLED = mkRow({ kartano: 'MULTI-SETTLED' });
const multiReceipt = await createReceipt([MULTI_UNSETTLED, MULTI_SETTLED]);
await settleSingle(MULTI_SETTLED);
const multiBefore = await snapshot(multiReceipt.receipt.id);
ok(await rejects(() => FinancialService.updateReceipt(U, multiReceipt.receipt.id, payload([
  mkRow({ kartano: 'MULTI-REPLACEMENT-A' }),
  mkRow({ kartano: 'MULTI-REPLACEMENT-B' }),
]))), 'one active settled row blocks replacement of the entire receipt atomically');
ok((await snapshot(multiReceipt.receipt.id)) === multiBefore
  && (await DB.getById('receipt_rows', MULTI_UNSETTLED.row_id))
  && (await DB.getById('receipt_rows', MULTI_SETTLED.row_id)),
  'multi-row guard leaves every original row and ledger record unchanged');

console.log('\n— explicit reversal restores ordinary receipt update/delete workflow —');
const REVERSE_UPDATE = mkRow({ kartano: 'REVERSE-UPDATE' });
const reverseUpdateReceipt = await createReceipt([REVERSE_UPDATE]);
await settleSingle(REVERSE_UPDATE);
await FinancialService.reverseKartaSettlement(U, REVERSE_UPDATE.row_id);
const REVERSE_UPDATE_NEW = mkRow({ kartano: 'REVERSE-UPDATE-NEW' });
await FinancialService.updateReceipt(U, reverseUpdateReceipt.receipt.id, payload([REVERSE_UPDATE_NEW]));
const reversedUpdateHistory = await DB.getByIndex('vehicle_ledger', 'by_reference_id', REVERSE_UPDATE.row_id);
ok(reversedUpdateHistory.length === 2 && reversedUpdateHistory.every(entry => entry.is_reversed === true)
  && (await DB.getById('receipt_rows', REVERSE_UPDATE_NEW.row_id))
  && (await activeKarta(REVERSE_UPDATE.row_id)).length === 0,
  'explicit Karta reversal permits receipt update with no stale active pair');

const REVERSE_DELETE = mkRow({ kartano: 'REVERSE-DELETE' });
const reverseDeleteReceipt = await createReceipt([REVERSE_DELETE]);
await settleSingle(REVERSE_DELETE);
await FinancialService.reverseKartaSettlement(U, REVERSE_DELETE.row_id);
await FinancialService.deleteReceipt(U, reverseDeleteReceipt.receipt.id);
const reversedDeleteHistory = await DB.getByIndex('vehicle_ledger', 'by_reference_id', REVERSE_DELETE.row_id);
ok(reversedDeleteHistory.length === 2 && reversedDeleteHistory.every(entry => entry.is_reversed === true)
  && (await DB.getById('receipts', reverseDeleteReceipt.receipt.id)) === null,
  'explicit Karta reversal permits receipt delete while audit settlement legs remain reversed');

console.log('\n— partial/corrupt Karta evidence blocks both lifecycle operations —');
const PARTIAL_UPDATE = mkRow({ kartano: 'PARTIAL-UPDATE' });
const partialUpdateReceipt = await createReceipt([PARTIAL_UPDATE]);
await DB.add('vehicle_ledger', {
  username: U, owner_id: DRIVER.id, owner_name: null, client_id: null, client_type: 'driver',
  type: 'driver_karta_payment', amount: -5000, price: 5000, vehicle_id: VEHICLE.id,
  reference_type: 'receipt_row', reference_id: PARTIAL_UPDATE.row_id,
  date: '2026-10-05', applied_at: '2026-10-05T10:00:00', is_reversed: false, note: 'حالة جزئية',
}, { username: U });
const partialUpdateBefore = await snapshot(partialUpdateReceipt.receipt.id);
ok(await rejects(() => FinancialService.updateReceipt(U, partialUpdateReceipt.receipt.id, payload([mkRow({ kartano: 'PARTIAL-NEW' })]))),
  'partial active Karta state blocks receipt update');
ok((await snapshot(partialUpdateReceipt.receipt.id)) === partialUpdateBefore,
  'partial-state update rejection changes no receipt or ledger record');

const PARTIAL_DELETE = mkRow({ kartano: 'PARTIAL-DELETE' });
const partialDeleteReceipt = await createReceipt([PARTIAL_DELETE]);
await DB.add('vehicle_ledger', {
  username: U, owner_id: OWNER_ID, owner_name: 'مالك اختبار', client_id: OWNER_ID, client_type: 'owner',
  vehicle_id: VEHICLE.id, vehicle_plate: VEHICLE.plate, type: 'withdraw', effect: 'karta_settlement_charge', amount: 5000,
  reference_type: 'receipt_row', reference_id: PARTIAL_DELETE.row_id,
  date: '2026-10-05', applied_at: '2026-10-05T10:00:00', is_reversed: false, note: 'حالة جزئية',
}, { username: U });
const partialDeleteBefore = await snapshot(partialDeleteReceipt.receipt.id);
ok(await rejects(() => FinancialService.deleteReceipt(U, partialDeleteReceipt.receipt.id)),
  'partial active Karta state blocks receipt delete');
ok((await snapshot(partialDeleteReceipt.receipt.id)) === partialDeleteBefore
  && (await DB.getById('receipt_rows', PARTIAL_DELETE.row_id)),
  'partial-state delete rejection preserves source row and audit evidence');

console.log(failures === 0
  ? '\n✅ ALL KARTA-RECEIPT-LIFECYCLE-GUARD ASSERTIONS PASSED'
  : `\n❌ ${failures} KARTA-RECEIPT-LIFECYCLE-GUARD FAILURES`);
process.exit(failures === 0 ? 0 : 1);
