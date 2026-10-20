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
const entries = async rowId => DB.findByFields(
  'vehicle_ledger', { reference_id: rowId }, { includeDeleted: true }
);
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
const netEditReversed = state.all.find(entry => entry.id === initialVehicleId);
ok(netEditReversed?.is_reversed === true
  && !state.vehicle.some(entry => entry.id === initialVehicleId)
  && state.vehicle.length === 1 && state.vehicle[0].amount === 12000 && state.vehicle[0].id !== initialVehicleId,
'net edit retains the prior vehicle creation entry as reversed and creates exactly one active replacement');
ok((await vehicleBalance(V1.id)) === 12000 && (await officeBalance()) === -13500,
  'net edit updates both creation-side balances exactly once');
const netEditVehicleId = state.vehicle[0].id;

await FinancialService.updateReceipt(U, receiptId, payload([{ ...original, row_id: stored.row_id, net: 120, sarf: 15, vehicle_id: V2.id, vehicle_plate: V2.plate }]));
stored = (await DB.findByFields('receipt_rows', { receipt_id: receiptId }))[0];
state = await effects(stored.row_id);
const vehicleEditReversed = state.all.find(entry => entry.id === netEditVehicleId);
ok(vehicleEditReversed?.is_reversed === true
  && !state.vehicle.some(entry => entry.id === netEditVehicleId)
  && state.vehicle.length === 1 && state.vehicle[0].vehicle_id === V2.id && state.vehicle[0].id !== netEditVehicleId,
'vehicle edit retains the prior creation entry as reversed and creates exactly one active entry for the new vehicle');
ok((await vehicleBalance(V1.id)) === 0 && (await vehicleBalance(V2.id)) === 12000,
  'vehicle edit moves the creation balance exactly once');
const vehicleEditId = state.vehicle[0].id;

await FinancialService.updateReceipt(U, receiptId, payload([{ ...original, row_id: stored.row_id, net: 120, sarf: 15, vehicle_id: V2.id, vehicle_plate: V2.plate, date: '2026-03-11' }], { receipt_date: '2026-03-11' }));
stored = (await DB.findByFields('receipt_rows', { receipt_id: receiptId }))[0];
state = await effects(stored.row_id);
const dateEditReversed = state.all.find(entry => entry.id === vehicleEditId);
ok(dateEditReversed?.is_reversed === true
  && !state.vehicle.some(entry => entry.id === vehicleEditId)
  && state.vehicle.length === 1 && state.vehicle[0].date === '2026-03-11' && state.vehicle[0].id !== vehicleEditId,
'date edit retains the prior creation entry as reversed and creates exactly one active entry with the updated business date');
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
const deletionReversed = state.all.find(entry => entry.id === dateEditVehicleId);
ok(deletionReversed?.is_reversed === true
  && !state.vehicle.some(entry => entry.id === dateEditVehicleId)
  && state.vehicle.length === 0
  && deletedRow.deleted_at !== null,
'eligible unpaid deletion retains and reverses the final vehicle creation entry, leaves no active creation entry, and soft-deletes the row');
ok(state.company.length === 0 && (await vehicleBalance(V2.id)) === 0 && (await officeBalance()) === 0,
  'unpaid deletion reverses both creation-side balances exactly once');

const paidRow = row({ kartano: 'VC-2' });
const paidReceipt = await FinancialService.createReceipt(U, payload([paidRow]));
const paidStored = (await DB.findByFields('receipt_rows', { receipt_id: paidReceipt.receipt.id }))[0];
await FinancialService.setReceiptRowPaymentStatus(U, paidStored.row_id, 'paid');
const beforePaidDelete = await effects(paidStored.row_id);
ok(await rejects(() => FinancialService.deleteReceipt(U, paidReceipt.receipt.id)), 'paid receipt deletion remains blocked');
const afterPaidDelete = await effects(paidStored.row_id);
ok(JSON.stringify(beforePaidDelete) === JSON.stringify(afterPaidDelete), 'blocked paid deletion leaves financial effects unchanged');

const snapshotReceiptCreationStores = async () => ({
  receipts: await DB.getAll('receipts'),
  receiptRows: await DB.getAll('receipt_rows'),
  ledger: await DB.getAll('vehicle_ledger'),
  loadPrices: await DB.getAll('loadPrices'),
});
const lateFailureRows = [
  row({ kartano: 'VC-FAIL-1', loading: 'مسار فشل متأخر', destination: 'وجهة فشل متأخر' }),
  row({ kartano: 'VC-FAIL-2', loading: 'مسار فشل متأخر', destination: 'وجهة فشل متأخر' }),
];
const lateFailureReceiptId = uuid();
const beforeLateWriteFailure = await snapshotReceiptCreationStores();
const ledgerStore = DB._db.stores.get('vehicle_ledger');
const originalLedgerAdd = ledgerStore.add;
let attemptedLedgerAdds = 0;
ledgerStore.add = function failAfterCreationLegsBegin(record) {
  attemptedLedgerAdds++;
  // Receipt header, both rows, route discovery, two office charges, and the
  // first vehicle creation entry precede this fourth ledger add.
  if (attemptedLedgerAdds === 4) throw new Error('simulated late receipt creation ledger failure');
  return originalLedgerAdd.call(this, record);
};
let lateWriteRejected = false;
try {
  lateWriteRejected = await rejects(() => FinancialService.createReceipt(
    U, payload(lateFailureRows, { id: lateFailureReceiptId })
  ));
} finally {
  ledgerStore.add = originalLedgerAdd;
}
const afterLateWriteFailure = await snapshotReceiptCreationStores();
ok(lateWriteRejected && attemptedLedgerAdds === 4,
  'receipt creation fails only after office and vehicle creation ledger writes have begun');
ok(JSON.stringify(afterLateWriteFailure) === JSON.stringify(beforeLateWriteFailure)
  && !afterLateWriteFailure.receipts.some(receipt => receipt.id === lateFailureReceiptId)
  && lateFailureRows.every(failureRow => !afterLateWriteFailure.receiptRows.some(saved => saved.row_id === failureRow.row_id))
  && lateFailureRows.every(failureRow => !afterLateWriteFailure.ledger.some(entry => entry.reference_id === failureRow.row_id)),
'late receipt-creation failure rolls back receipt headers, rows, office charges, vehicle creation entries, and discovered load prices');

console.log('\n— legacy vehicle payment protection —');
const legacyRow = row({ kartano: 'VC-LEGACY' });
const legacyReceipt = await FinancialService.createReceipt(U, payload([legacyRow]));
const legacyStored = (await DB.findByFields('receipt_rows', { receipt_id: legacyReceipt.receipt.id }))[0];
await DB.add('vehicle_ledger', {
  username: U, owner_id: OWNER, client_id: legacyStored.vehicle_id, client_type: 'vehicle',
  vehicle_id: legacyStored.vehicle_id, type: 'deposit', amount: 10000,
  reference_type: 'receipt_row_payment_vehicle', effect: 'receipt_row_payment_vehicle',
  reference_id: legacyStored.row_id, date: legacyStored.date, applied_at: legacyStored.date,
  is_reversed: false,
}, { username: U });
const legacyBefore = await effects(legacyStored.row_id);
ok(await rejects(() => FinancialService.setReceiptRowPaymentStatus(U, legacyStored.row_id, 'paid')),
  'legacy vehicle payment entry blocks status transition without reinterpretation');
const legacyAfter = await effects(legacyStored.row_id);
ok(JSON.stringify(legacyBefore) === JSON.stringify(legacyAfter)
  && (await DB.getById('receipt_rows', legacyStored.row_id)).payment_status === 'unpaid',
  'legacy status block leaves ledger and receipt status unchanged');

console.log('\n— creation-effect invariant protection —');
const missingCreationRow = row({ kartano: 'VC-MISSING-CREATION' });
const missingCreationReceipt = await FinancialService.createReceipt(U, payload([missingCreationRow]));
const missingCreationStored = (await DB.findByFields('receipt_rows', { receipt_id: missingCreationReceipt.receipt.id }))[0];
const missingCreationState = await effects(missingCreationStored.row_id);
await DB.update('vehicle_ledger', missingCreationState.vehicle[0].id, { is_reversed: true }, { username: U });
const missingBeforeStatus = await effects(missingCreationStored.row_id);
ok(await rejects(() => FinancialService.setReceiptRowPaymentStatus(U, missingCreationStored.row_id, 'paid')),
  'missing vehicle creation effect rejects unpaid → paid');
const missingAfterStatus = await effects(missingCreationStored.row_id);
ok(JSON.stringify(missingAfterStatus) === JSON.stringify(missingBeforeStatus)
  && (await DB.getById('receipt_rows', missingCreationStored.row_id)).payment_status === 'unpaid',
'missing creation-effect rejection makes no office payment, vehicle mutation, or row-status change');

const duplicateCreationRow = row({ kartano: 'VC-DUPLICATE-CREATION' });
const duplicateCreationReceipt = await FinancialService.createReceipt(U, payload([duplicateCreationRow]));
const duplicateCreationStored = (await DB.findByFields('receipt_rows', { receipt_id: duplicateCreationReceipt.receipt.id }))[0];
await DB.add('vehicle_ledger', {
  username: U, owner_id: OWNER, owner_name: 'Owner C', client_id: duplicateCreationStored.vehicle_id,
  client_type: 'vehicle', client_name: V1.plate, vehicle_id: duplicateCreationStored.vehicle_id,
  vehicle_plate: V1.plate, type: 'deposit', effect: VEHICLE, amount: 10000,
  reference_type: VEHICLE, reference_id: duplicateCreationStored.row_id,
  date: duplicateCreationStored.date, applied_at: duplicateCreationStored.date, is_reversed: false,
  note: 'قيد اختبار مكرر',
}, { username: U });
const duplicateBeforeStatus = await effects(duplicateCreationStored.row_id);
ok(await rejects(() => FinancialService.setReceiptRowPaymentStatus(U, duplicateCreationStored.row_id, 'unpaid')),
  'duplicate vehicle creation effects reject an unpaid → unpaid no-op');
const duplicateAfterStatus = await effects(duplicateCreationStored.row_id);
ok(JSON.stringify(duplicateAfterStatus) === JSON.stringify(duplicateBeforeStatus)
  && (await DB.getById('receipt_rows', duplicateCreationStored.row_id)).payment_status === 'unpaid',
'duplicate creation-effect rejection makes no ledger mutation or row-status change');

console.log(`\n${failures === 0 ? '✅ ALL RECEIPT-ROW-VEHICLE-CREATION ASSERTIONS PASSED' : `❌ FAILURES: ${failures}`}`);
process.exitCode = failures ? 1 : 0;
