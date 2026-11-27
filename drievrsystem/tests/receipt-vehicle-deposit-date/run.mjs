import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installIDB } from './idb-shim.mjs';
installIDB();
const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { DateUtils } = await import('./dateUtils.js');
const { ClientRepository } = await import('./services/clientRepository.js');
const U = 'receipt-vehicle-deposit-date';
const uuid = () => crypto.randomUUID();
await DB.init();
const owner = uuid();
const vehicle = { id: uuid(), username: U, plate: 'DATE-1', owner_id: owner, owner_name: 'Owner' };
const office = { id: uuid(), username: U, name: 'Date Office' };
await ClientRepository.saveVehicle(vehicle, { username: U });
await DB.add('offices', office, { username: U });
const makeRow = (date) => ({
  _type: 'data', row_id: uuid(), owner_id: owner, vehicle_id: vehicle.id,
  vehicle_plate: vehicle.plate, office: office.name, date, driver_price: 1,
  advance: 0, weight: 115, deficit: 0, officeAmount: 0, discount: 0, add: 0,
  net: 100, sarf: 15,
});
const payload = (date, rows) => ({ receipt_date: date, client_id: owner, client_type: 'owner', client_name: 'Owner', rows });
const entries = rowId => DB.findByFields('vehicle_ledger', { reference_id: rowId }, { includeDeleted: true });
const vehicles = async rowId => (await entries(rowId)).filter(e => e.reference_type === 'receipt_row_vehicle_balance' && e.is_reversed === false && e.deleted_at === null);

const different = makeRow('2025-04-24');
const empty = makeRow('');
const { receipt } = await FinancialService.createReceipt(U, payload('2025-03-10', [different, empty]));
let first = (await vehicles(different.row_id))[0];
assert.equal(first.date, '2025-03-10');
assert.equal((await vehicles(empty.row_id))[0].date, '2025-03-10');
assert.equal((await DB.getById('receipt_rows', different.row_id)).date, '2025-04-24');
assert.equal((await DB.getById('receipt_rows', empty.row_id)).date, null);
assert.equal((await DB.getById('vehicle_ledger', first.id)).date, '2025-03-10');
console.log('PASS creation with different and empty table dates; stored ledger and row dates');

// An informational date edit must not reverse or replace the vehicle movement.
const changedRow = { ...different, date: '2025-05-25' };
await FinancialService.updateReceipt(U, receipt.id, payload('2025-03-10', [changedRow, empty]));
assert.equal((await DB.getById('receipt_rows', different.row_id)).date, '2025-05-25');
assert.equal((await vehicles(different.row_id)).length, 1);
assert.equal((await vehicles(different.row_id))[0].id, first.id);
assert.equal((await vehicles(different.row_id))[0].date, '2025-03-10');
assert.equal((await entries(different.row_id)).filter(e => e.reference_type === 'receipt_row_vehicle_balance').length, 1);
console.log('PASS table-date-only edit preserves vehicle identity and stores informational date');

// Main-date-only change must replace both old rows, despite the nonempty table date.
const initialEmpty = (await vehicles(empty.row_id))[0];
await FinancialService.updateReceipt(U, receipt.id, payload('2025-06-12', [changedRow, empty]));
let replacement = (await vehicles(different.row_id))[0];
assert.notEqual(replacement.id, first.id);
assert.equal(replacement.date, '2025-06-12');
assert.equal((await DB.getById('vehicle_ledger', first.id)).is_reversed, true);
assert.equal((await DB.getById('vehicle_ledger', initialEmpty.id)).is_reversed, true);
assert.equal((await vehicles(empty.row_id))[0].date, '2025-06-12');
assert.equal((await DB.getById('receipt_rows', different.row_id)).date, '2025-05-25');
console.log('PASS main-date-only edit reverses and replaces vehicle entries');

const added = makeRow('2025-07-28');
await FinancialService.updateReceipt(U, receipt.id, payload('2025-06-12', [changedRow, empty, added]));
assert.equal((await vehicles(different.row_id))[0].id, replacement.id);
assert.equal((await vehicles(added.row_id))[0].date, '2025-06-12');
assert.equal((await DB.getById('receipt_rows', added.row_id)).date, '2025-07-28');
console.log('PASS row added during edit uses main date and retains its table date');

// Real read projection and actual vehicle-detail row renderer (with lightweight dependencies).
const projected = (await FinancialService.getVehicleLedger(vehicle.id)).find(e => e.id === replacement.id);
assert.equal(projected.date, '2025-06-12');
const entities = readFileSync('./entities.js', 'utf8');
const renderSource = entities.slice(entities.indexOf('function _renderVehicleFinancialRows('), entities.indexOf('\nfunction _refreshVehicleFinancialTable', entities.indexOf('function _renderVehicleFinancialRows(')));
assert(renderSource.startsWith('function _renderVehicleFinancialRows('));
const render = new Function('_vehicleFinancialSearchQuery', '_dateLabel', '_fmt', '_escapeMaintenanceText', '_vehicleLedgerDescription', `${renderSource}; return _renderVehicleFinancialRows;`)('', value => String(value).split('T')[0], String, String, () => 'receipt');
assert.match(render([projected]), /2025-06-12/);
assert.doesNotMatch(render([projected]), /2025-05-25/);
const june = await FinancialService.getVehicleMonthlyReport(vehicle.id, '2025-06');
assert.equal(june.movements.find(e => e.id === replacement.id).date, '2025-06-12');
assert.equal(june.movements.find(e => e.referenceId === added.row_id).date, '2025-06-12');
assert.equal((await FinancialService.getVehicleMonthlyReport(vehicle.id, '2025-05')).movements.some(e => e.id === replacement.id), false);
assert.match(entities, /_escapeMaintenanceText\(movement\.date \|\| '—'\)/);
console.log('PASS ledger display renderer and monthly report use persisted main date');

// The company payment uses the transition date, and does not alter vehicle deposit.
await FinancialService.setReceiptRowPaymentStatus(U, different.row_id, 'paid');
const company = (await entries(different.row_id)).find(e => e.reference_type === 'receipt_row_payment_company' && !e.is_reversed);
assert.equal(company.date, DateUtils.todayLocal());
assert.equal((await vehicles(different.row_id))[0].id, replacement.id);
console.log('PASS company payment uses the transition date');

const manual = await FinancialService.createManualVehicleBalanceEntry(U, {
  vehicle_id: vehicle.id, entry_type: 'deposit', amount: 17, date: '2025-08-19', note: 'Manual',
});
assert.equal(manual.date, '2025-08-19');
assert.equal((await DB.getById('vehicle_ledger', manual.id)).date, '2025-08-19');
console.log('PASS manual deposit retains its own date');
