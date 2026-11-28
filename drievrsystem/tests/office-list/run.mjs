import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
installIDB();
const listeners = {};
const page = { innerHTML: '' }, tbody = { innerHTML: '' }, search = { value: '' }, msg = { textContent: '', classList: { add() {} } };
globalThis.document = {
  body: { dataset: {} },
  getElementById: id => ({ officesPage: page, officesTableBody: tbody, officeSearch: search, officesInlineMsg: msg, officeModal: {} })[id] || null,
  addEventListener: (type, cb) => { listeners[type] = cb; },
};
globalThis.window = globalThis;
window.addEventListener = () => {};
const events = [];
window.dispatchEvent = event => { events.push(event); return true; };
globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } };
const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');
const { OfficeRepository } = await import('./services/officeRepository.js');
const { loadOffices, attachOfficesPageListeners, OfficesService } = await import('./offices.js');
await DB.init();
const U = 'office-list-user';
const specialName = `New "office" & <partners> 'Ltd'`;
const office = { id: crypto.randomUUID(), username: U, name: 'Original', phone: ' 123 ', hamolaRows: [{ id: 'h', loading_place: 'Tanta' }], custom: { a: [1, 2] } };
const other = { id: crypto.randomUUID(), username: U, name: 'Other', phone: null };
await DB.add('offices', office, { username: U });
await DB.add('offices', other, { username: U });
await FinancialService.createManualOfficeBalanceEntry(U, { office_id: office.id, entry_type: 'deposit', amount: 25.5, date: '2026-01-01', note: 'test' });
await FinancialService.createManualOfficeBalanceEntry(U, { office_id: other.id, entry_type: 'withdraw', amount: 4, date: '2026-01-01', note: 'test' });
let ledgerReads = 0;
const nativeTransaction = DB._db.transaction.bind(DB._db);
DB._db.transaction = (stores, mode) => {
  if ((Array.isArray(stores) ? stores : [stores]).includes('vehicle_ledger') && mode === 'readonly') ledgerReads++;
  return nativeTransaction(stores, mode);
};
const balances = await FinancialService.getOfficeBalances([office.id, other.id]);
assert.equal(ledgerReads, 1);
DB._db.transaction = nativeTransaction;
assert.deepEqual(balances.get(office.id), await FinancialService.getOfficeBalance(office.id));
assert.deepEqual(balances.get(other.id), await FinancialService.getOfficeBalance(other.id));
await loadOffices();
assert.match(page.innerHTML, /الرصيد/); assert.doesNotMatch(page.innerHTML, /إجمالي الوزن/);
assert.match(tbody.innerHTML, /25\.50/); assert.match(tbody.innerHTML, /-4\.00/);
assert.match(tbody.innerHTML, /data-action="office-edit"/);
console.log('PASS list uses existing projection for positive and negative balances');

const owner = crypto.randomUUID();
const vehicle = { id: crypto.randomUUID(), username: U, plate: 'T-1', owner_id: owner, owner_name: 'Owner' };
await ClientRepository.saveVehicle(vehicle, { username: U });
const row = { row_id: crypto.randomUUID(), owner_id: owner, vehicle_id: vehicle.id, vehicle_plate: vehicle.plate,
  office: office.name, driver_price: 1, advance: 0, weight: 115, deficit: 0, officeAmount: 0, discount: 0, add: 0, net: 100, sarf: 15 };
const row2 = { ...row, row_id: crypto.randomUUID() };
const payload = rows => ({ receipt_date: '2026-01-01', client_id: owner, client_type: 'owner', client_name: 'Owner', rows });
const rec1 = (await FinancialService.createReceipt(U, payload([row]))).receipt;
const rec2 = (await FinancialService.createReceipt(U, payload([row2]))).receipt;
await FinancialService.setReceiptRowPaymentStatus(U, row.row_id, 'paid');
// Summary and rename deliberately use case-insensitive, trimmed matching.
await DB.update('receipt_rows', row2.row_id, { office: '  oRiGiNaL  ' }, { username: U });
const deletedRow = { row_id: crypto.randomUUID(), receipt_id: rec1.id, office: 'Original' };
await DB.add('receipt_rows', deletedRow, { username: U });
await DB.delete('receipt_rows', deletedRow.row_id, { username: U });
const unrelated = { row_id: crypto.randomUUID(), receipt_id: rec2.id, office: 'Other' };
await DB.add('receipt_rows', unrelated, { username: U });
const deletedReceipt = await DB.add('receipts', { id: crypto.randomUUID(), username: U }, { username: U });
const rowOfDeletedReceipt = { row_id: crypto.randomUUID(), receipt_id: deletedReceipt.id, office: 'Original' };
await DB.add('receipt_rows', rowOfDeletedReceipt, { username: U });
await DB.delete('receipts', deletedReceipt.id, { username: U });
const foreign = { row_id: crypto.randomUUID(), receipt_id: crypto.randomUUID(), office: 'Original' };
await DB.add('receipt_rows', foreign, { username: 'audit-origin' });
const foreignReceipt = await DB.add('receipts', { id: crypto.randomUUID(), username: 'audit-origin' }, { username: 'audit-origin' });
const foreignLinkedRow = { row_id: crypto.randomUUID(), receipt_id: foreignReceipt.id, username: 'audit-origin', office: 'Original' };
await DB.add('receipt_rows', foreignLinkedRow, { username: 'audit-origin' });
const beforeOffice = await DB.getById('offices', office.id);
const beforeRows = await Promise.all([row.row_id, row2.row_id].map(id => DB.getById('receipt_rows', id)));
const beforeBalance = (await FinancialService.getOfficeBalance(office.id)).balance;

// Fault injection wraps the real transaction context, after a real row write.
const originalTransaction = OfficeRepository.transaction;
for (const failAt of ['after-first-row', 'office-write']) {
  let writes = 0;
  OfficeRepository.transaction = (callback, meta) => originalTransaction(async tx => callback({
    ...tx, async update(store, id, patch) {
      if (store === 'offices' && failAt === 'office-write') throw new Error('injected final office failure');
      const result = await tx.update(store, id, patch);
      if (store === 'receipt_rows' && ++writes === 1 && failAt === 'after-first-row') throw new Error('injected after row write');
      return result;
    },
  }), meta);
  try { await assert.rejects(OfficesService.updateOffice(U, office.id, { name: specialName }), /injected/); }
  finally { OfficeRepository.transaction = originalTransaction; }
  assert.ok(writes >= 1);
  assert.deepEqual(await DB.getById('offices', office.id), beforeOffice);
  assert.deepEqual(await Promise.all([row.row_id, row2.row_id].map(id => DB.getById('receipt_rows', id))), beforeRows);
}
// Inject a real unique-index collision at the final put after linked row writes.
await DB.add('offices', { id: crypto.randomUUID(), username: 'audit-origin', name: 'Global collision' }, { username: 'audit-origin' });
OfficeRepository.transaction = (callback, meta) => originalTransaction(async tx => callback({
  ...tx, async update(store, id, patch) {
    return tx.update(store, id, store === 'offices' ? { ...patch, name: 'Global collision' } : patch);
  },
}), meta);
try { await assert.rejects(OfficesService.updateOffice(U, office.id, { name: specialName })); }
finally { OfficeRepository.transaction = originalTransaction; }
assert.deepEqual(await DB.getById('offices', office.id), beforeOffice);
assert.deepEqual(await Promise.all([row.row_id, row2.row_id].map(id => DB.getById('receipt_rows', id))), beforeRows);
console.log('PASS rollback after a row update and at the final office write, including a real index constraint error');

attachOfficesPageListeners();
const action = (name, id, tr) => ({ closest(selector) {
  if (selector === `[data-action="${name}"]`) return this;
  if (selector === '[data-id]') return { dataset: { id } };
  if (selector === 'tr') return tr;
  return null;
} });
await listeners.click({ target: action('office-edit', office.id) });
assert.match(tbody.innerHTML, /office-edit-name/); assert.doesNotMatch(tbody.innerHTML, /office-edit-phone/);
await listeners.click({ target: action('office-cancel', office.id) });
await listeners.click({ target: action('office-edit', office.id) });
const tr = { dataset: { id: office.id }, querySelector: selector => selector === '.office-edit-name' ? { value: specialName } : null };
await listeners.click({ target: action('office-save', office.id, tr) });
const updatedOffice = await DB.getById('offices', office.id);
// Transaction audit timestamp/user are expected to change; every business field is untouched.
const { name: _oldName, updated_at: _oldAt, updated_by: _oldBy, ...oldFields } = beforeOffice;
const { name: _newName, updated_at: _newAt, updated_by: _newBy, ...newFields } = updatedOffice;
assert.deepEqual(newFields, oldFields);
assert.equal(updatedOffice.name, specialName);
for (const id of [row.row_id, row2.row_id]) assert.equal((await DB.getById('receipt_rows', id)).office, specialName);
assert.equal((await DB.getById('receipt_rows', unrelated.row_id)).office, 'Other');
assert.equal((await DB.getById('receipt_rows', foreign.row_id)).office, 'Original');
const renamedForeign = await DB.getById('receipt_rows', foreignLinkedRow.row_id);
assert.equal(renamedForeign.office, specialName);
assert.equal(renamedForeign.username, 'audit-origin');
assert.equal(renamedForeign.updated_by, U);
assert.equal((await DB.getById('receipt_rows', rowOfDeletedReceipt.row_id)).office, 'Original');
assert.equal((await DB.findByFields('receipt_rows', { row_id: deletedRow.row_id }, { includeDeleted: true }))[0].office, 'Original');
assert.equal((await FinancialService.getOfficeBalance(office.id)).balance, beforeBalance);
assert.deepEqual((await FinancialService.getOfficeBalances([office.id])).get(office.id), await FinancialService.getOfficeBalance(office.id));
// Remove the artificial non-financial unrelated row before asking for a summary.
await DB.delete('receipt_rows', unrelated.row_id, { username: U });
const summary = await OfficesService.getOfficeFinancialSummary(U);
assert.equal(summary.rows.find(item => item.office.id === office.id).net, 200);
assert.ok(events.some(event => event.type === 'offices:changed' && event.detail?.officeName === specialName));
await listeners.click({ target: action('office-edit', office.id) });
assert.ok(tbody.innerHTML.includes('value="New &quot;office&quot; &amp; &lt;partners&gt; &#39;Ltd&#39;"'));
assert.ok(!tbody.innerHTML.includes(`value="${specialName}"`));
await listeners.click({ target: action('office-cancel', office.id) });
console.log('PASS multiple rows renamed, other business fields preserved, summary and escaped input correct');

const activePayment = async () => (await DB.findByFields('vehicle_ledger', { reference_id: row.row_id, reference_type: 'receipt_row_payment_company', is_reversed: false }))[0];
const paymentBefore = await activePayment();
await FinancialService.updateReceipt(U, rec1.id, payload([{ ...row, office: specialName, net: 110, weight: 125, payment_status: 'paid' }]));
const paymentAfter = await activePayment();
assert.equal(paymentAfter.client_id, office.id);
assert.equal(paymentAfter.date, paymentBefore.date);
assert.notEqual(paymentAfter.id, paymentBefore.id);
await FinancialService.setReceiptRowPaymentStatus(U, row.row_id, 'unpaid');
assert.equal(await activePayment(), undefined);
await FinancialService.deleteReceipt(U, rec1.id);
assert.equal(await DB.getById('receipt_rows', row.row_id), null);
await FinancialService.setReceiptRowPaymentStatus(U, row2.row_id, 'paid');
assert.equal((await FinancialService.getOfficeBalance(office.id)).balance, 25.5);
console.log('PASS paid receipt edit preserves payment date and office; reversal, deletion and later payment succeed');
await assert.rejects(OfficesService.updateOffice(U, office.id, { name: '  oThEr  ' }), /duplicate/);
await assert.rejects(OfficesService.updateOffice(U, office.id, { name: 'Global collision' }), /duplicate/);
const auditEdit = await OfficesService.updateOffice('audit-origin', office.id, { phone: '456' });
assert.equal(auditEdit.username, U);
assert.equal(auditEdit.updated_by, 'audit-origin');
assert.equal((await OfficesService.getOfficeById(office.id, 'audit-origin')).phone, '456');
assert.equal((await DB.getById('offices', office.id)).name, specialName);
console.log('PASS duplicate names rejected and edits preserve the original audit username');

// Exercise the actual receipt-form helper without reconstructing the user's draft.
const src = readFileSync('./receipts.src.js', 'utf8');
const start = src.indexOf('function _escapeOfficeOption(');
const end = src.indexOf('// ─── RECEIPT: PER-ROW DRIVER', start);
const draftRows = [{ office: { value: '  ORIGINAL  ' }, loading: 'unsaved load', net: '42', note: 'keep me' }, { office: { value: 'Other' }, loading: 'another unsaved value' }, { office: { value: 'Original extra' } }];
const draft = draftRows.map(row => row.office);
let optionsHtml = '';
const draftDocument = { querySelectorAll: selector => { assert.equal(selector, '#receiptTableBody .receipt-office'); return draft; }, getElementById: () => ({ set innerHTML(value) { optionsHtml = value; } }) };
const scope = new Function('document', 'offices', `
  const _currentUsername = () => '${U}';
  const ReceiptsModule = { getOffices: async () => offices };
  ${src.slice(start, end)}
  return { refresh: _refreshRenamedOfficeInDraft, load: loadOfficesForReceipt, escape: _escapeOfficeOption };
`)(draftDocument, [updatedOffice]);
scope.refresh({ username: U, previousName: 'Original', officeName: specialName });
assert.deepEqual(draft.map(input => input.value), [specialName, 'Other', 'Original extra']);
assert.deepEqual({ loading: draftRows[0].loading, net: draftRows[0].net, note: draftRows[0].note }, { loading: 'unsaved load', net: '42', note: 'keep me' });
assert.equal(draftRows[1].loading, 'another unsaved value');
scope.refresh({ username: 'audit-origin', previousName: specialName, officeName: 'Shared name' });
assert.equal(draft[0].value, 'Shared name');
assert.equal(scope.escape(specialName), 'New &quot;office&quot; &amp; &lt;partners&gt; &#39;Ltd&#39;');
await scope.load();
assert.equal(optionsHtml, '<option value="New &quot;office&quot; &amp; &lt;partners&gt; &#39;Ltd&#39;">');
assert.match(src, /_refreshRenamedOfficeInDraft\(event\.detail\)/);
console.log('PASS open draft updates only matching office inputs; other draft values remain untouched');
