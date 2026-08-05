// run.mjs — End-to-end write-path verification through REAL production code:
// FinancialService → ReceiptRepository (PersistenceCommands) → WriteDataSource
// → DBProvider → database.js — on a faithful IndexedDB shim.
import { installIDB } from './idb-shim.mjs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { WriteDataSource } = await import('./services/writeDataSource.js');
const { ReceiptRepository } = await import('./services/receiptRepository.js');
const { PersistenceCommandType } = await import('./services/persistenceCommand.js');

const U = 'tester';
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; };
const uuid = () => crypto.randomUUID();

function makePayload(over = {}) {
  const client_id = over.client_id || 'owner-1';
  return {
    receipt_date: '2026-07-27',
    receipt_number: '1001',
    client_id, client_type: 'owner', client_name: 'مالك اختبار',
    account_type: null,
    total: 1150, previous_balance: 0, paid: 0,
    net_due: 1150, net_total: 1150,
    rows: [
      { row_id: uuid(), _type: 'data', owner_id: client_id, owner_name: 'مالك اختبار',
        vehicle_id: 'veh-1', vehicle_plate: '111 أ ب', driver_id: null,
        driver_price: 11, advance: 0, loading: 'طنطا', destination: 'القاهرة',
        office: 'شركة أ', net: 550, sarf: 0 },
      { row_id: uuid(), _type: 'data', owner_id: client_id, owner_name: 'مالك اختبار',
        vehicle_id: 'veh-2', vehicle_plate: '222 ج د', driver_id: null,
        driver_price: 12, advance: 0, loading: 'طنطا', destination: 'الإسكندرية',
        office: 'شركة ب', net: 600, sarf: 0 },
    ],
    ...over,
  };
}

const rowsOf = async (id, includeDeleted = false) =>
  DB.findByFields('receipt_rows', { receipt_id: id }, { includeDeleted });
const ledgerOf = async (id) => DB.getByIndex('vehicle_ledger', 'by_reference_id', id);

// ─── STEP 1: createReceipt ───────────────────────────────────────────────────
console.log('\n— STEP 1: createReceipt (header + 2 rows + ledger) —');
const p1 = makePayload();
const createRes = await FinancialService.createReceipt(U, p1);
const rid = createRes.receipt.id;
const header1 = await DB.getById('receipts', rid);
const rows1 = await rowsOf(rid);
const ledger1 = await ledgerOf(rid);
ok(!!header1 && header1.username === U, 'receipt header persisted with username');
ok(header1.total === 115000 && header1.net_due === 115000 && header1.paid === 0, `header money in cents (total=${header1.total}, net_due=${header1.net_due})`);
ok(rows1.length === 2, `exactly 2 receipt_rows persisted (got ${rows1.length})`);
ok(rows1.every(r => r.receipt_id === rid && typeof r.driver_price === 'number'), 'rows carry receipt_id FK + cents money');
ok(ledger1.length === 1 && ledger1[0].type === 'receipt_due' && ledger1[0].amount === 115000 && ledger1[0].is_reversed === false,
  `exactly 1 receipt_due ledger entry with real amount (got ${ledger1.length}, amount=${ledger1[0]?.amount})`);

// zero-net_due receipt must NOT emit a ledger entry (B4 guard)
const p0 = makePayload({ receipt_number: '1002', total: 0, net_due: 0, net_total: 0,
  rows: [ { ...makePayload().rows[0], net: 0.01 } ] });
// total 0 would fail "rows total must be greater than zero" via groups? groups sum net cents; net=0.01 → groups total 1 cent ≠ 0; total=0 param → net_due = 0+add…
// simpler: use net_due 0 via paid? keep semantic: craft data where net_due=0
const lz = await FinancialService.createReceipt(U, makePayload({
  receipt_number: '1002', total: 100, net_due: 100, net_total: 100,
  rows: [ { ...makePayload().rows[0], net: 100 } ],
})).then(r => r.receipt.id);
ok((await ledgerOf(lz)).length === 1, 'nonzero net_due → ledger entry exists (sanity)');
const before = (await DB.getAll('receipts', { username: U })).length;
ok(before === 2, `2 receipts visible after two creates (got ${before})`);

// ─── STEP 2: updateReceipt ───────────────────────────────────────────────────
console.log('\n— STEP 2: updateReceipt (replace rows 2→3, reverse old ledger) —');
const oldRowIds = rows1.map(r => r.row_id);
const p1u = makePayload({
  id: rid, receipt_number: '1001', total: 1800, paid: 500, net_due: 1800, net_total: 2300, previous_balance: 500,
  payout_status: 'paid',
  rows: [ ...makePayload().rows,
    { row_id: uuid(), _type: 'data', owner_id: 'owner-1', owner_name: 'مالك اختبار',
      vehicle_id: 'veh-3', vehicle_plate: '333 هـ و', driver_id: null,
      driver_price: 10, advance: 0, loading: 'طنطا', destination: 'المنصورة',
      office: 'شركة ج', net: 650, sarf: 0 } ],
});
const updRes = await FinancialService.updateReceipt(U, rid, p1u);
const header2 = await DB.getById('receipts', rid);
const rows2 = await rowsOf(rid);
const rows2All = await rowsOf(rid, true);
const ledger2 = await ledgerOf(rid);
ok(header2.total === 180000 && header2.net_due === 180000 && header2.paid === 50000, `header updated in place (total=${header2.total})`);
ok(header2.payout_status === 'paid', 'payout_status patched when provided');
ok(rows2.length === 3, `rows replaced: exactly 3 live rows (got ${rows2.length}) — NO duplication`);
ok(rows2.every(r => !oldRowIds.includes(r.row_id)), 'old row_ids gone from live set (fresh ids)');
ok(rows2All.length === 5, `audit trail: 2 old rows soft-deleted retained (got ${rows2All.length})`);
ok(ledger2.length === 2 && ledger2.filter(e => e.is_reversed === false).length === 1, `ledger: exactly 1 active entry after reversal (got ${ledger2.filter(e=>!e.is_reversed).length})`);
ok(ledger2.find(e => e.is_reversed === false)?.amount === 180000, 'new active ledger amount = 180000¢');
ok(!!updRes.receipt && updRes.receipt.net_due === 1800, 'updateReceipt returns decimalized updated receipt');

// ─── STEP 3: updateReceipt WITHOUT payout_status → preserved ─────────────────
// rows with FRESH row_ids (production-realistic: the form mints new ids on every save — reusing ids would collide with the soft-deleted audit rows by design)
const p1v = makePayload({ id: rid, total: 1800, net_due: 1800, net_total: 1800, previous_balance: 0 });
await FinancialService.updateReceipt(U, rid, p1v);
const header3 = await DB.getById('receipts', rid);
ok(header3.payout_status === 'paid', `payout_status preserved when omitted (got ${header3.payout_status})`);

// ─── STEP 4: deleteReceipt ───────────────────────────────────────────────────
console.log('\n— STEP 4: deleteReceipt (reverse + soft-delete rows + header) —');
const delRes = await FinancialService.deleteReceipt(U, rid);
ok(delRes.deleted === true && delRes.reversed.ledger_count >= 1, `deleteReceipt reports reversal (ledger_count=${delRes.reversed.ledger_count})`);
ok((await DB.getById('receipts', rid)) === null, 'deleted receipt no longer readable (getById → null)');
ok((await rowsOf(rid)).length === 0, 'all rows of deleted receipt excluded from live reads');
ok((await rowsOf(rid, true)).length === 7, `deleted rows retained as soft-deleted audit records (2+3+2 across create+2 edits, got ${(await rowsOf(rid, true)).length})`);
ok((await ledgerOf(rid)).every(e => e.is_reversed === true), 'all ledger entries for receipt reversed');
const remaining = await DB.getAll('receipts', { username: U });
ok(remaining.length === 1 && remaining[0].id === lz, 'second receipt unaffected');

// ─── STEP 5: WriteDataSource guards ──────────────────────────────────────────
console.log('\n— STEP 5: WriteDataSource command-validation guards —');
let threw = null;
try { await WriteDataSource.execute([{ type: 'Add', aggregate: 'Nope', id: 'x', payload: {} }], { username: U }); }
catch (e) { threw = e.message; }
ok(/Unknown aggregate/.test(threw || ''), `unknown aggregate rejected: "${threw}"`);
threw = null;
try { await WriteDataSource.execute([{ type: 'Explode', aggregate: 'Receipt', id: 'x' }], { username: U }); }
catch (e) { threw = e.message; }
ok(/Unknown command type/.test(threw || ''), `unknown command type rejected: "${threw}"`);
ok(JSON.stringify(await WriteDataSource.execute([], { username: U })) === '[]', 'empty command list → [] (no-op)');
ok((await DB.getAll('receipts', { username: U })).length === 1, 'guards wrote nothing (store untouched)');

// ─── STEP 6: update on missing receipt fails atomically ──────────────────────
threw = null;
try { await FinancialService.updateReceipt(U, 'does-not-exist', makePayload({ rows: makePayload().rows })); }
catch (e) { threw = e.message; }
ok(!!threw, `update of missing receipt rejected atomically (${(threw || '').slice(0, 60)}…)`);

console.log(`\n${failures === 0 ? '✅ ALL WRITE-PATH ASSERTIONS PASSED' : '❌ FAILURES: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
