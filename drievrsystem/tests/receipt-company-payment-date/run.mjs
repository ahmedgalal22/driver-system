import assert from 'node:assert/strict';
import { installIDB } from './idb-shim.mjs';
// Freeze the clock while retaining real Cairo date conversion.
const RealDate = globalThis.Date;
let now = '2025-08-21T12:00:00Z';
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return new RealDate(now).getTime(); }
};
installIDB();
const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');
const U = 'receipt-company-payment-date';
const owner = crypto.randomUUID();
const vehicle = { id: crypto.randomUUID(), username: U, plate: 'D-1', owner_id: owner, owner_name: 'Owner' };
const office = { id: crypto.randomUUID(), username: U, name: 'Office' };
const office2 = { id: crypto.randomUUID(), username: U, name: 'Second Office' };
await DB.init();
await ClientRepository.saveVehicle(vehicle);
await DB.add('offices', office);
await DB.add('offices', office2);
const row = { row_id: crypto.randomUUID(), owner_id: owner, vehicle_id: vehicle.id, vehicle_plate: vehicle.plate,
  office: office.name, date: '2024-02-15', driver_price: 1, advance: 0,
  weight: 115, deficit: 0, officeAmount: 0, discount: 0, add: 0, net: 100, sarf: 15 };
const payload = (receiptDate, rows) => ({ receipt_date: receiptDate, client_id: owner, client_type: 'owner', client_name: 'Owner', rows });
const entries = id => DB.findByFields('vehicle_ledger', { reference_id: id }, { includeDeleted: true });
const live = (list, ref) => list.filter(x => x.reference_type === ref && x.is_reversed === false && x.deleted_at === null);
const vehicleRef = 'receipt_row_vehicle_balance', chargeRef = 'receipt_row_company_charge', paymentRef = 'receipt_row_payment_company';
const { receipt } = await FinancialService.createReceipt( payload('2024-01-10', [row]));
let records = await entries(row.row_id);
assert.equal(live(records, vehicleRef)[0].date, '2024-01-10');
assert.equal(live(records, chargeRef)[0].date, '2024-01-10');
assert.equal((await DB.getById('receipt_rows', row.row_id)).date, '2024-02-15');
const initial = JSON.stringify(records);
let edited = { ...row, date: '2024-03-16', payment_status: 'unpaid' };
await FinancialService.updateReceipt( receipt.id, payload('2024-01-10', [edited]));
assert.equal(JSON.stringify(await entries(row.row_id)), initial);
assert.equal((await DB.getById('receipt_rows', row.row_id)).date, '2024-03-16');
console.log('PASS creation uses receipt date and unpaid row-date edit changes no ledger entry');

await FinancialService.setReceiptRowPaymentStatus( row.row_id, 'paid');
records = await entries(row.row_id);
let payment = live(records, paymentRef)[0];
assert.equal(payment.date, '2025-08-21');
assert.equal((await DB.getById('vehicle_ledger', payment.id)).date, '2025-08-21');
const id = payment.id;
const afterPaid = JSON.stringify(records);
now = '2025-08-25T12:00:00Z';
assert.equal((await FinancialService.setReceiptRowPaymentStatus( row.row_id, 'paid')).changed, false);
edited = { ...edited, date: '2024-04-17', payment_status: 'paid' };
await FinancialService.updateReceipt( receipt.id, payload('2024-01-10', [edited]));
assert.equal(JSON.stringify(await entries(row.row_id)), afterPaid);
assert.equal((await DB.getById('receipt_rows', row.row_id)).date, '2024-04-17');
console.log('PASS paid transition uses actual day; repeated paid and table-date-only edit do not alter any ledger entry');

await FinancialService.updateReceipt( receipt.id, payload('2024-05-12', [edited]));
records = await entries(row.row_id);
assert.equal(live(records, paymentRef)[0].id, id);
assert.equal(live(records, paymentRef)[0].date, '2025-08-21');
assert.equal(live(records, chargeRef)[0].date, '2024-05-12');
assert.equal(live(records, vehicleRef)[0].date, '2024-05-12');
console.log('PASS main-date edit updates creation entries but leaves company payment untouched');

// A real financial edit requires reversing/replacing the paid leg, not re-dating it.
const beforeReplacement = live(records, paymentRef)[0];
edited = { ...edited, office: office2.name, weight: 125, net: 110 };
await FinancialService.updateReceipt( receipt.id, payload('2024-05-12', [edited]));
records = await entries(row.row_id);
payment = live(records, paymentRef)[0];
assert.notEqual(payment.id, beforeReplacement.id);
assert.equal(records.find(e => e.id === beforeReplacement.id).is_reversed, true);
assert.equal(payment.date, '2025-08-21');
assert.equal(payment.client_id, office2.id);
assert.equal(payment.amount, 12500);
console.log('PASS paid amount/office edit replaces payment while preserving original persisted date');

// Reversal followed by a new transition is a new payment, so it gets a new date.
await FinancialService.setReceiptRowPaymentStatus( row.row_id, 'unpaid');
assert.equal((await DB.getById('vehicle_ledger', payment.id)).is_reversed, true);
now = '2025-09-04T12:00:00Z';
await FinancialService.setReceiptRowPaymentStatus( row.row_id, 'paid');
records = await entries(row.row_id);
assert.equal(live(records, paymentRef).length, 1);
assert.equal(live(records, paymentRef)[0].date, '2025-09-04');
console.log('PASS reversal and subsequent paid transition use new transition date');

// Receipt edits can also transition an existing row to paid via the service.
const another = { ...row, row_id: crypto.randomUUID(), date: '', payment_status: 'unpaid' };
await FinancialService.updateReceipt( receipt.id, payload('2024-05-12', [edited, another]));
now = '2025-09-06T12:00:00Z';
await FinancialService.updateReceipt( receipt.id, payload('2024-05-12', [edited, { ...another, payment_status: 'paid' }]));
assert.equal(live(await entries(another.row_id), paymentRef)[0].date, '2025-09-06');
console.log('PASS paid transition through receipt update captures transition date');

// Legacy paid entries: keep the persisted date rather than inventing a transition date.
const legacyPaid = live(await entries(another.row_id), paymentRef)[0];
await DB.update('vehicle_ledger', legacyPaid.id, { date: '2021-01-05' });
now = '2025-10-01T12:00:00Z';
const anotherPaidChanged = { ...another, payment_status: 'paid', weight: 125, net: 110 };
await FinancialService.updateReceipt( receipt.id, payload('2024-05-12', [edited, anotherPaidChanged]));
const legacyReplacement = live(await entries(another.row_id), paymentRef)[0];
assert.equal(legacyReplacement.date, '2021-01-05');
assert.equal((await DB.getById('vehicle_ledger', legacyPaid.id)).is_reversed, true);
console.log('PASS existing paid entry replacement preserves its recorded legacy date');

// A missing historical date cannot safely be reconstructed from either receipt date.
await DB.update('vehicle_ledger', legacyReplacement.id, { date: null });
const beforeMissing = JSON.stringify(await entries(another.row_id));
await assert.rejects(() => FinancialService.updateReceipt( receipt.id, payload('2024-05-12', [edited, { ...anotherPaidChanged, weight: 135, net: 120 }])), /no posting date/);
assert.equal(JSON.stringify(await entries(another.row_id)), beforeMissing);
assert.equal((await DB.getById('receipt_rows', another.row_id)).net, 11000);
console.log('PASS missing legacy payment date fails safely without a ledger or row mutation');

// Exercise real transition persistence across Cairo midnight with different device zones.
const originalTZ = process.env.TZ;
async function createUnpaid() {
  const testRow = { ...row, row_id: crypto.randomUUID(), payment_status: 'unpaid' };
  const created = await FinancialService.createReceipt( payload('2024-01-10', [testRow]));
  return { testRow, receiptId: created.receipt.id };
}
process.env.TZ = 'UTC';
const midnight = await createUnpaid();
now = '2025-01-01T21:59:59Z'; // Cairo 23:59:59, UTC 21:59:59
await FinancialService.setReceiptRowPaymentStatus( midnight.testRow.row_id, 'paid');
assert.equal(live(await entries(midnight.testRow.row_id), paymentRef)[0].date, '2025-01-01');
await FinancialService.setReceiptRowPaymentStatus( midnight.testRow.row_id, 'unpaid');
now = '2025-01-01T22:00:00Z'; // Cairo 00:00:00 on Jan 2, UTC still Jan 1
assert.equal(new Date().getDate(), 1);
await FinancialService.setReceiptRowPaymentStatus( midnight.testRow.row_id, 'paid');
assert.equal(live(await entries(midnight.testRow.row_id), paymentRef)[0].date, '2025-01-02');
console.log('PASS UTC device before and at Cairo midnight stores the Cairo calendar date');

process.env.TZ = 'America/Los_Angeles';
const otherZone = await createUnpaid();
now = '2025-01-01T22:00:00Z';
assert.equal(new Date().getDate(), 1);
await FinancialService.setReceiptRowPaymentStatus( otherZone.testRow.row_id, 'paid');
assert.equal(live(await entries(otherZone.testRow.row_id), paymentRef)[0].date, '2025-01-02');
console.log('PASS Los Angeles device stores Cairo date rather than device-local date');

// Fail closed even when the environment would otherwise fall back to device time.
const unsupported = await createUnpaid();
const unsupportedBefore = JSON.stringify(await entries(unsupported.testRow.row_id));
const originalFormatter = Intl.DateTimeFormat;
Intl.DateTimeFormat = function(locale, options) {
  if (options?.timeZone === 'Africa/Cairo' && locale === 'en-US-u-ca-gregory-nu-latn') throw new RangeError('Cairo unavailable');
  return new originalFormatter(locale, options);
};
try {
  await assert.rejects(() => FinancialService.setReceiptRowPaymentStatus( unsupported.testRow.row_id, 'paid'), /تعذر تحديد تاريخ القاهرة/);
  assert.equal(JSON.stringify(await entries(unsupported.testRow.row_id)), unsupportedBefore);
  assert.equal((await DB.getById('receipt_rows', unsupported.testRow.row_id)).payment_status, 'unpaid');
  await assert.rejects(() => FinancialService.updateReceipt( unsupported.receiptId,
    payload('2024-01-10', [{ ...unsupported.testRow, payment_status: 'paid' }])), /تعذر تحديد تاريخ القاهرة/);
  assert.equal(JSON.stringify(await entries(unsupported.testRow.row_id)), unsupportedBefore);
  assert.equal((await DB.getById('receipt_rows', unsupported.testRow.row_id)).payment_status, 'unpaid');
} finally {
  Intl.DateTimeFormat = originalFormatter;
  if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
}
console.log('PASS unsupported Cairo timezone aborts both payment transition paths without writes');

// Move the clock while real asynchronous IndexedDB-shim reads are in flight.
// The first path must capture only after the office lookup completes.
const officesStore = DB._db.stores.get('offices');
const originalOfficeGetAll = officesStore.getAll;
const crossingStatus = await createUnpaid();
now = '2025-01-01T21:59:59Z';
let officeCrossed = false;
officesStore.getAll = function(...args) {
  const request = originalOfficeGetAll.apply(this, args);
  queueMicrotask(() => { now = '2025-01-01T22:00:00Z'; officeCrossed = true; });
  return request;
};
try {
  await FinancialService.setReceiptRowPaymentStatus( crossingStatus.testRow.row_id, 'paid');
} finally { officesStore.getAll = originalOfficeGetAll; }
assert.equal(officeCrossed, true);
assert.equal(live(await entries(crossingStatus.testRow.row_id), paymentRef)[0].date, '2025-01-02');
assert.equal((await DB.getById('receipt_rows', crossingStatus.testRow.row_id)).payment_status, 'paid');
console.log('PASS status transition crosses Cairo midnight during asynchronous office resolution');

// In updateReceipt, cross midnight on a vehicle read *after* payment office
// resolution, proving the capture is later than all remaining async preparation.
const crossingEdit = await createUnpaid();
const vehicleStore = DB._db.stores.get('vehicles');
const originalVehicleGet = vehicleStore.get;
let officeReads = 0, paymentOfficeResolved = false, editCrossed = false;
now = '2025-01-01T21:59:59Z';
officesStore.getAll = function(...args) {
  const request = originalOfficeGetAll.apply(this, args);
  queueMicrotask(() => { officeReads++; if (officeReads >= 2) paymentOfficeResolved = true; });
  return request;
};
vehicleStore.get = function(...args) {
  const request = originalVehicleGet.apply(this, args);
  if (paymentOfficeResolved) queueMicrotask(() => { now = '2025-01-01T22:00:00Z'; editCrossed = true; });
  return request;
};
try {
  await FinancialService.updateReceipt( crossingEdit.receiptId, payload('2024-01-10', [
    { ...crossingEdit.testRow, payment_status: 'paid', weight: 125, net: 110 },
  ]));
} finally {
  officesStore.getAll = originalOfficeGetAll;
  vehicleStore.get = originalVehicleGet;
}
assert.equal(paymentOfficeResolved, true);
assert.equal(editCrossed, true);
assert.equal(live(await entries(crossingEdit.testRow.row_id), paymentRef)[0].date, '2025-01-02');
assert.equal((await DB.getById('receipt_rows', crossingEdit.testRow.row_id)).payment_status, 'paid');
console.log('PASS receipt edit crosses Cairo midnight after payment office lookup and before final write');
