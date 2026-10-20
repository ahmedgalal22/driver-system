// run.mjs — Vehicle Identity (رقم المركبة) verification.
// The Vehicle Name (اسم المركبة) field is permanently removed from Vehicle
// Management; vehicles are identified by رقم المركبة only, and the receipt
// relationship is رقم المركبة → vehicle → owner/client.
import { installIDB } from './idb-shim.mjs';
installIDB();
import { readFileSync } from 'node:fs';

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');

const U = 'vehicle-identity-tester';
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; };
const J = (v) => JSON.stringify(v);
const uuid = () => crypto.randomUUID();

// window/CustomEvent stubs for the verbatim-extracted browser-coupled fns
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } };
}
if (typeof globalThis.window.dispatchEvent !== 'function') globalThis.window.dispatchEvent = () => true;

const ENTITIES_SRC = readFileSync('./_src/entities.js', 'utf8');
const RECEIPTS_SRC = readFileSync('./_src/receipts.js', 'utf8');
const EXCEL_SRC    = readFileSync('./_src/excelService.js', 'utf8');
const INDEX_SRC    = readFileSync('./_src/index.html', 'utf8');
const CLIENT_REPO_SRC = readFileSync('./services/clientRepository.js', 'utf8');

// Verbatim extraction (async-aware: back up 6 chars to keep the `async ` prefix).
function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`extractFn: ${name} not found`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`extractFn: ${name} unbalanced`);
}

// Scope-injected verbatim copy of the real entities.js owner-registry code.
const entitiesScope = new Function(
  'ClientRepository',
  `const _toText = (value) => (value === undefined || value === null) ? '' : String(value);
   const _uuid = () => crypto.randomUUID();
   const _emitOwnersChanged = () => window.dispatchEvent(new CustomEvent('owners:changed'));
   ${extractFn(ENTITIES_SRC, 'createOwner')}
   ${extractFn(ENTITIES_SRC, 'updateOwner')}
   ${extractFn(ENTITIES_SRC, 'addAccount')}
   ${extractFn(ENTITIES_SRC, '_normalizePlate')}
   ${extractFn(ENTITIES_SRC, 'resolveVehicle')}
   return { createOwner, updateOwner, addAccount, resolveVehicle };`
)(ClientRepository);

const { createOwner, updateOwner, addAccount, resolveVehicle } = entitiesScope;

await DB.init();
await DB.add('offices', { id: uuid(), username: U, name: 'شركة أ', phone: null }, { username: U });

// ══ GROUP 1 — owner registry is number-keyed (real createOwner/updateOwner) ══
console.log('\n— GROUP 1: owner registry (number-keyed identity) —');
const rec = await createOwner(U, { vehicle_number: '123 أ ب', notes: null });
ok(rec.vehicle_number === '123 أ ب', `created owner persists vehicle_number verbatim (got ${J(rec.vehicle_number)})`);
ok(rec.name === '123 أ ب', 'owner display slot (name) mirrors the vehicle number');
ok(!('vehicle_name' in rec), 'REMOVED-CONTRACT: no vehicle_name slot is persisted on owner records');
ok(typeof rec.id === 'string' && rec.id.length > 0, 'internal owner UUID generated and preserved');

let dupErr = '';
try { await createOwner(U, { vehicle_number: '123 أ ب  ' }); } catch (e) { dupErr = e.message; }
ok(dupErr.includes('رقم المركبة مستخدم بالفعل'), `duplicate vehicle number rejected at create ("${dupErr}")`);
let wsErr = '';
try { await createOwner(U, { vehicle_number: '123  أ   ب' }); } catch (e) { wsErr = e.message; }
ok(wsErr.includes('رقم المركبة مستخدم بالفعل'), 'whitespace-normalized duplicate number also rejected');
let reqErr = '';
try { await createOwner(U, { vehicle_number: '   ' }); } catch (e) { reqErr = e.message; }
ok(reqErr.includes('رقم المركبة مطلوب'), `vehicle number is required ("${reqErr}")`);

const rec2 = await createOwner(U, { vehicle_number: '999 ج د' });
let updDupErr = '';
try { await updateOwner(U, rec2.id, { vehicle_number: '123 أ ب' }); } catch (e) { updDupErr = e.message; }
ok(updDupErr.includes('رقم المركبة مستخدم بالفعل'), `duplicate vehicle number rejected at update ("${updDupErr}")`);
const upd = await updateOwner(U, rec2.id, { vehicle_number: '777 هـ و' });
ok(upd.vehicle_number === '777 هـ و' && upd.name === '777 هـ و', 'update rewrites number + mirrored name');
ok((await ClientRepository.findOwnersByNumber('999 ج د')).length === 0, 'old number no longer resolves after update');
const same = await updateOwner(U, rec.id, { vehicle_number: '123 أ ب' });
ok(same.id === rec.id, 'update keeping the same number passes (self not treated as duplicate)');

// ══ GROUP 2 — رقم المركبة → vehicle → owner resolution (verbatim resolveVehicle) ══
console.log('\n— GROUP 2: plate → vehicle → owner resolution —');
ok((await DB.getAll('vehicles')).length === 0, 'vehicles store empty before receipt-driven resolution');
const v1 = await resolveVehicle(U, '123 أ ب', { id: rec.id, name: rec.name });
ok(typeof v1.id === 'string' && v1.plate === '123 أ ب', `vehicle created by number with internal UUID (plate=${J(v1.plate)})`);
ok(String(v1.owner_id) === String(rec.id), `vehicle bound to the number's owner (owner_id=${v1.owner_id})`);
// same number, whitespace variant, DIFFERENT owner argument → same vehicle, owner untouched
const v1b = await resolveVehicle(U, '123  أ   ب', { id: rec2.id, name: rec2.vehicle_number });
ok(String(v1b.id) === String(v1.id), 'same vehicle number always resolves to the SAME vehicle (no duplicate created)');
ok(String(v1b.owner_id) === String(rec.id), 'existing vehicle keeps its owner — no silent re-association to a different owner');
ok((await DB.getAll('vehicles')).length === 1, 'vehicles store holds exactly one record for the repeated number');
// unknown number + no owner context → loud refusal, never an invented owner
let unkErr = '';
try { await resolveVehicle(U, '555 مجهولة', null); } catch (e) { unkErr = e.message; }
ok(unkErr.includes('يجب تحديد مالك المركبة قبل تسجيل المركبة'), `unknown number does not invent an owner ("${unkErr}")`);
ok((await DB.getAll('vehicles')).length === 1, 'unknown number wrote nothing to the vehicles store');

// ══ GROUP 3 — receipt create/edit persistence: vehicle/owner relationship ══
console.log('\n— GROUP 3: receipt persistence + edit preservation —');
// Exact production-collector row shape (receipts.js collectReceiptRows output).
// Production issues a FRESH row_id on every save (row_id is the store key;
// old rows stay as soft-deleted audit records under their original ids).
const rowPayload = () => ({
  _type: 'data', row_id: uuid(),
  owner_id: String(rec.id), owner_name: rec.name,
  kartano: '55', date: '2026-08-10',
  data: null, driver_name: null, driver_id: null,
  car: v1.plate, vehicle_id: v1.id, vehicle_plate: v1.plate,
  loading: 'طنطا', taktik: 'القاهرة', type: 'نشا', office: 'شركة أ',
  weight: 10, weight2: 5, deficit: 1, weightTotal: 14,
  noloon: 100, ohda: 50, officeAmount: 25, discount: 0, sarf: 0, add: 0, net: 500,
});
const created = await FinancialService.createReceipt(U, {
  receipt_date: '2026-08-10',
  client_id: rec.id, client_type: 'owner', client_name: rec.name,
  total: 500,
  rows: [rowPayload()],
});
const liveRows = async (rid) => (await import('./services/receiptReadRepository.js'))
  .ReceiptReadRepository.getReceiptRowsByReceipt(rid);
const RID = created.receipt.id;
const rRows = await liveRows(RID);
ok(rRows.length === 1, 'receipt persisted exactly one data row');
ok(String(rRows[0].vehicle_id) === String(v1.id), `persisted row carries the vehicle UUID link (vehicle_id=${rRows[0].vehicle_id})`);
ok(rRows[0].vehicle_plate === '123 أ ب', 'persisted row carries the رقم المركبة snapshot');
ok(created.receipt.client_name === '123 أ ب', 'receipt header client/owner snapshot = vehicle number (صاحب المركبة resolved by number)');
ok((await DB.getAll('vehicles')).length === 1, 'receipt save created no extra vehicle');

// Edit/re-save the same receipt — vehicle/owner relationship must be preserved
const edited = await FinancialService.updateReceipt(U, RID, {
  receipt_date: '2026-08-10',
  client_id: rec.id, client_type: 'owner', client_name: rec.name,
  total: 500,
  rows: [rowPayload()],
});
const eRows = await liveRows(RID);
ok(eRows.length === 1 && String(eRows[0].vehicle_id) === String(v1.id) && eRows[0].vehicle_plate === '123 أ ب',
  'editing the receipt preserves the same vehicle/owner relationship (vehicle_id + plate unchanged)');
ok((await DB.getAll('vehicles')).length === 1, 'edit did not delete/recreate the vehicle (UUID stable)');

// Persistence-layer guard: a data row with no resolved owner is rejected outright
let noOwnerErr = '';
try {
  await FinancialService.createReceipt(U, {
    receipt_date: '2026-08-10',
    client_id: rec.id, client_type: 'owner', client_name: rec.name,
    rows: [{ ...rowPayload(), row_id: uuid(), owner_id: '', vehicle_id: String(v1.id) }],
  });
} catch (e) { noOwnerErr = e.message; }
ok(/owner_id must be a non-empty/.test(noOwnerErr || ''), `receipt with no resolved owner is rejected ("${noOwnerErr.slice(0, 70)}…")`);
let noVehErr = '';
try {
  await FinancialService.createReceipt(U, {
    receipt_date: '2026-08-10',
    client_id: rec.id, client_type: 'owner', client_name: rec.name,
    rows: [{ ...rowPayload(), row_id: uuid(), owner_id: String(rec.id), vehicle_id: '' }],
  });
} catch (e) { noVehErr = e.message; }
ok(/vehicle_id must be a non-empty/.test(noVehErr || ''), `receipt with no resolved vehicle is rejected ("${noVehErr.slice(0, 70)}…")`);

// ══ GROUP 4 — UI census + KEEP pins ══
console.log('\n— GROUP 4: vehicle-name census + number-contract KEEP pins —');
for (const [label, src] of [
  ['entities.js', ENTITIES_SRC], ['index.html', INDEX_SRC],
  ['excelService.js', EXCEL_SRC], ['clientRepository.js', CLIENT_REPO_SRC],
]) {
  ok(!/اسم المركبة|vehicle_name|add-m-name|findOwnersByName|ownerNameInput/.test(src),
    `census: ${label} carries ZERO vehicle-name references (field/input/lookup all removed)`);
}
ok(ENTITIES_SRC.includes('<th style="color:#fff;">رقم المركبة</th>') && ENTITIES_SRC.includes('add-m-vehicle-number'),
  'KEEP: Vehicle Management list + add/edit modal expose رقم المركبة only');
ok(INDEX_SRC.includes('<th>رقم المركبة</th>') && !INDEX_SRC.includes('<th>اسم المركبة</th>'),
  'Vehicle Management static shell: رقم المركبة column only — اسم المركبة column absent');
ok(EXCEL_SRC.includes("'رقم المركبة',") && !EXCEL_SRC.includes("'اسم المركبة',"),
  'KEEP: Excel entities export/import keyed on the رقم المركبة column');
ok(RECEIPTS_SRC.includes('const plates = vehicles.map(v => v.plate).filter(Boolean);'),
  'KEEP: Receipt Form vehicle selector suggests vehicle plates only');
ok(RECEIPTS_SRC.includes('await VehiclesModule.resolveVehicle(_currentUsername(), plate, clientOwner);'),
  'KEEP: receipt row pipeline resolves رقم المركبة → vehicle (verbatim production line)');
ok(RECEIPTS_SRC.includes("owner_id     : String(finalOwner.id),") && RECEIPTS_SRC.includes('vehicle.plate'),
  'KEEP: receipt row owner/client comes from the resolved vehicle record (صاحب المركبة)');
ok(!/receipt-car[^]*list="vehicleNameList"/.test(RECEIPTS_SRC), 'no vehicle-name datalist exists in the Receipt Form');

console.log(failures === 0 ? '\n✅ ALL VEHICLE-IDENTITY ASSERTIONS PASSED' : `\n❌ ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
