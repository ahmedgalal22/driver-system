import { installIDB } from './idb-shim.mjs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');

const U = 'vehicle-creation-lifecycle';
const COMPANY = 'receipt_row_company_charge';
const VEHICLE = 'receipt_row_vehicle_balance';
const PAYMENT = 'receipt_row_payment_company';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const rejects = async fn => { try { await fn(); return false; } catch { return true; } };
const uuid = () => crypto.randomUUID();
const cents = value => Math.round(Number(value) * 100);

await DB.init();
const OWNER = uuid();
const OFFICE = { id: uuid(), username: U, name: 'Office C', phone: null };
const V1 = { id: uuid(), username: U, plate: 'C-1', owner_id: OWNER, owner_name: 'Owner C' };
const V2 = { id: uuid(), username: U, plate: 'C-2', owner_id: OWNER, owner_name: 'Owner C' };
await DB.add('offices', OFFICE, { username: U });
await ClientRepository.saveVehicle(V1, { username: U });
await ClientRepository.saveVehicle(V2, { username: U });

const row = (over = {}) => ({
  _type: 'data', row_id: uuid(), owner_id: OWNER, owner_name: 'Owner C', driver_id: null,
  vehicle_id: V1.id, vehicle_plate: V1.plate, driver_price: 0, driver_settlement_price: null,
  kartano: 'VC-1', date: '2026-03-10', loading: 'طنطا', destination: 'القاهرة',
  office: OFFICE.name, advance: 0, net: 100, sarf: 15, weight: 0, weight2: 0,
  deficit: 0, officeAmount: 0, discount: 0, add: 0, ...over,
});
const payload = (rows, over = {}) => ({
  receipt_date: over.receipt_date || '2026-03-10', client_id: OWNER, client_type: 'owner',
  client_name: 'Owner C', total: rows.reduce((sum, item) => sum + Number(item.net || 0), 0), rows, ...over,
});
const active = rows => rows.filter(entry => entry.is_reversed === false && entry.deleted_at === null);
const entries = async rowId => DB.getByIndex('vehicle_ledger', 'by_reference_id', rowId);
const effects = async rowId => {
  const all = await entries(rowId); const live = active(all);
  return {
    all,
    company: live.filter(entry => entry.reference_type === COMPANY && entry.effect === COMPANY),
    vehicle: live.filter(entry => entry.reference_type === VEHICLE && entry.effect === VEHICLE),
    payment: live.filter(entry => entry.reference_type === PAYMENT && entry.effect === PAYMENT),
    legacyVehicle: live.filter(entry => entry.reference_type === 'receipt_row_payment_vehicle'),
  };
};
const vehicleBalance = async id => cents((await FinancialService.rebuildVehicleBalance(id)).balance);
const officeBalance = async () => cents((await FinancialService.getOfficeBalance(OFFICE.id)).balance);

console.log('\n— creation, payment, and idempotency —');
const original = row();
const created = await FinancialService.createReceipt(U, payload([original]));
const receiptId = created.receipt.id;
let stored = (await DB.findByFields('receipt_rows', { receipt_id: receiptId }))[0];
let state = await effects(stored.row_id);
ok(stored.payment_status === 'unpaid' && state.company.length === 1 && state.vehicle.length === 1 && state.payment.length === 0 && state.legacyVehicle.length === 0,
  'creation writes exactly one company charge and one vehicle creation balance entry while unpaid');
ok(state.company[0].type === 'withdraw' && state.company[0].amount === 11500 && state.company[0].vehicle_id === null,
  'creation office charge is withdraw net+sarf');
ok(state.vehicle[0].type === 'deposit' && state.vehicle[0].amount === 10000 && state.vehicle[0].vehicle_id === V1.id,
  'creation vehicle entry is deposit net for the authoritative vehicle');
ok((await vehicleBalance(V1.id)) === 10000 && (await officeBalance()) === -11500,
  'creation changes vehicle +net and office -net-sarf');
const initialVehicleId = state.vehicle[0].id;

let result = await FinancialService.setReceiptRowPaymentStatus(U, stored.row_id, 'paid');
state = await effects(stored.row_id);
ok(result.changed && state.payment.length === 1 && state.vehicle.length === 1 && state.legacyVehicle.length === 0,
  'unpaid to paid creates company payment only and retains vehicle creation entry');
ok((await vehicleBalance(V1.id)) === 10000 && (await officeBalance()) === 0,
  'unpaid to paid changes office only and leaves vehicle balance unchanged');
const companyPaymentId = state.payment[0].id;
result = await FinancialService.setReceiptRowPaymentStatus(U, stored.row_id, 'paid');
state = await effects(stored.row_id);
ok(!result.changed && state.payment.length === 1 && state.payment[0].id === companyPaymentId,
  'repeated paid status creates no duplicate payment effect');

result = await FinancialService.setReceiptRowPaymentStatus(U, stored.row_id, 'unpaid');
state = await effects(stored.row_id);
ok(result.changed && state.payment.length === 0 && state.vehicle.length === 1 && state.vehicle[0].id === initialVehicleId,
  'paid to unpaid reverses company payment only and retains vehicle creation entry');
ok((await vehicleBalance(V1.id)) === 10000 && (await officeBalance()) === -11500,
  'paid to unpaid changes office only and leaves vehicle balance unchanged');
result = await FinancialService.setReceiptRowPaymentStatus(U, stored.row_id, 'unpaid');
ok(!result.changed && (await effects(stored.row_id)).vehicle.length === 1,
  'repeated unpaid status is idempotent');

console.log('\n— edit identities —');
await FinancialService.updateReceipt(U, receiptId, payload([{ ...original, row_id: stored.row_id, net: 120, sarf: 15 }]));
stored = (await DB.findByFields('receipt_rows', { receipt_id: receiptId }))[0];
state = await effects(stored.row_id);
ok(state.vehicle.length === 1 && state.vehicle[0].amount === 12000 && state.vehicle[0].id !== initialVehicleId,
  'net edit reverses old vehicle creation entry and creates exactly one replacement');
ok((await vehicleBalance(V1.id)) === 12000 && (await officeBalance()) === -13500,
  'net edit updates both creation-side balances exactly once');
const netEditVehicleId = state.vehicle[0].id;

await FinancialService.updateReceipt(U, receiptId, payload([{ ...original, row_id: stored.row_id, net: 120, sarf: 15, vehicle_id: V2.id, vehicle_plate: V2.plate }]));
stored = (await DB.findByFields('receipt_rows', { receipt_id: receiptId }))[0];
state = await effects(stored.row_id);
ok(state.vehicle.length === 1 && state.vehicle[0].vehicle_id === V2.id && state.vehicle[0].id !== netEditVehicleId,
  'vehicle edit reverses old creation effect and creates one effect for new vehicle');
ok((await vehicleBalance(V1.id)) === 0 && (await vehicleBalance(V2.id)) === 12000,
  'vehicle edit moves the creation balance exactly once');
const vehicleEditId = state.vehicle[0].id;

await FinancialService.updateReceipt(U, receiptId, payload([{ ...original, row_id: stored.row_id, net: 120, sarf: 15, vehicle_id: V2.id, vehicle_plate: V2.plate, date: '2026-03-11' }], { receipt_date: '2026-03-11' }));
stored = (await DB.findByFields('receipt_rows', { receipt_id: receiptId }))[0];
state = await effects(stored.row_id);
ok(state.vehicle.length === 1 && state.vehicle[0].date === '2026-03-11' && state.vehicle[0].id !== vehicleEditId,
  'date edit replaces vehicle creation entry with updated business date');
const dateEditVehicleId = state.vehicle[0].id;

await FinancialService.updateReceipt(U, receiptId, payload([{ ...original, row_id: stored.row_id, net: 120, sarf: 20, vehicle_id: V2.id, vehicle_plate: V2.plate, date: '2026-03-11' }], { receipt_date: '2026-03-11' }));
state = await effects(stored.row_id);
ok(state.vehicle.length === 1 && state.vehicle[0].id === dateEditVehicleId,
  'sarf-only edit leaves vehicle creation entry untouched');
ok((await vehicleBalance(V2.id)) === 12000 && (await officeBalance()) === -14000,
  'sarf-only edit changes office creation amount without changing vehicle balance');

console.log('\n— deletion and transaction rollback —');
await FinancialService.deleteReceipt(U, receiptId);
state = await effects(stored.row_id);
const deletedRow = (await DB.findByFields('receipt_rows', { row_id: stored.row_id }, { includeDeleted: true }))[0];
ok(state.company.length === 0 && state.vehicle.length === 0 && deletedRow.deleted_at !== null,
  'eligible unpaid deletion reverses both creation effects and preserves soft delete');
ok((await vehicleBalance(V2.id)) === 0 && (await officeBalance()) === 0,
  'unpaid deletion restores both projected balances');

const paidRow = row({ kartano: 'VC-2' });
const paidReceipt = await FinancialService.createReceipt(U, payload([paidRow]));
const paidStored = (await DB.findByFields('receipt_rows', { receipt_id: paidReceipt.receipt.id }))[0];
await FinancialService.setReceiptRowPaymentStatus(U, paidStored.row_id, 'paid');
const beforePaidDelete = await effects(paidStored.row_id);
ok(await rejects(() => FinancialService.deleteReceipt(U, paidReceipt.receipt.id)), 'paid receipt deletion remains blocked');
const afterPaidDelete = await effects(paidStored.row_id);
ok(JSON.stringify(beforePaidDelete) === JSON.stringify(afterPaidDelete), 'blocked paid deletion leaves financial effects unchanged');

const failureRow = row({ kartano: 'VC-3' });
const beforeFailureCount = (await DB.getAll('receipt_rows')).length;
ok(await rejects(() => FinancialService.createReceipt(U, payload([failureRow], { id: paidReceipt.receipt.id }))),
  'receipt creation write failure is rejected');
ok((await DB.getAll('receipt_rows')).length === beforeFailureCount,
  'failed receipt creation does not leave a partial receipt row or creation postings');

console.log(`\n${failures === 0 ? '✅ ALL RECEIPT-ROW-VEHICLE-CREATION ASSERTIONS PASSED' : `❌ FAILURES: ${failures}`}`);
process.exitCode = failures ? 1 : 0;
