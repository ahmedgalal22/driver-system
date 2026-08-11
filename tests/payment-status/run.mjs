// run.mjs — Payment Status (الحالة) verification for receipt rows.
//
// Verifies, against the REAL production modules on the idb shim:
//   • persistence contract — payment_status is persisted per receipt row,
//     whitelist {'paid','unpaid'}, default 'unpaid', legacy rows read unpaid;
//   • the state machine — unpaid⇄paid transitions only; unchanged = no-op;
//     unpaid→paid posts EXACTLY TWO ledger legs (vehicle = الصافي,
//     company = الصافي + الصرف), paid→unpaid reverses exactly those legs;
//   • atomicity, idempotency, row-UUID traceability, edit/delete reconciliation;
//   • UI contract — الحالة column immediately after الصافي in All Receipts,
//     its dropdown markup, the page mapper clamp, print + Excel columns
//     (all via verbatim-extracted production source).

import { installIDB } from './idb-shim.mjs';
installIDB();
import { readFileSync } from 'node:fs';

const { Money } = await import('./money.js');
const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');
const { ReceiptRepository } = await import('./services/receiptRepository.js');
const { ReceiptReadRepository } = await import('./services/receiptReadRepository.js');

const U = 'payment-status-tester';
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; };
const J = (v) => JSON.stringify(v);
const uuid = () => crypto.randomUUID();

const FINANCIAL_SRC   = readFileSync('./financial.js', 'utf8');
const DATABASE_SRC    = readFileSync('./database.js', 'utf8');
const RECEIPTS_SRC    = readFileSync('./_src/receipts.js', 'utf8');
const ALLRECEIPTS_SRC = readFileSync('./_src/allReceipts.js', 'utf8');
const EXCEL_SRC       = readFileSync('./_src/excelService.js', 'utf8');

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
// Bracket-matching extraction starting from an exact marker (e.g. a const decl).
function extractAfter(src, marker, open) {
  const m = src.indexOf(marker);
  if (m < 0) throw new Error(`extractAfter: marker "${marker}" not found`);
  const pairs = { '[': ']', '{': '}' };
  const close = pairs[open];
  let depth = 0;
  for (let j = src.indexOf(open, m); j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close) { depth--; if (depth === 0) return src.slice(m, j + 1); }
  }
  throw new Error(`extractAfter: "${marker}" unbalanced`);
}
// Static fingerprint: exact production line must exist in the real source.
function fingerprint(src, snippet, label) {
  ok(src.includes(snippet), `source fingerprint — ${label}`);
}

await DB.init();

// ── Fixtures: offices master data (unique by_name) + number-keyed vehicles ──
const OWNER_ID   = uuid();
const OWNER_NAME = '123 أ ب';
const OFFICE_A = { id: uuid(), username: U, name: 'شركة أ', phone: null };
const OFFICE_B = { id: uuid(), username: U, name: 'شركة ب', phone: null };
await DB.add('offices', { ...OFFICE_A }, { username: U });
await DB.add('offices', { ...OFFICE_B }, { username: U });
const VID1 = uuid();
const VID2 = uuid();
const V1 = { id: VID1, username: U, plate: '123 أ ب', owner_id: OWNER_ID, owner_name: OWNER_NAME };
const V2 = { id: VID2, username: U, plate: '456 ت ج', owner_id: OWNER_ID, owner_name: OWNER_NAME };
await ClientRepository.saveVehicle({ ...V1 }, { username: U });
await ClientRepository.saveVehicle({ ...V2 }, { username: U });

// ── Read helpers (balances expressed in CENTS — persisted vocabulary) ──
const LEDGER = 'vehicle_ledger';
const NAMESPACE = { reference_type: 'receipt_row_payment', effect: 'receipt_row_payment' };
const payEntriesAll = async (rowId) =>
  (await DB.getByIndex(LEDGER, 'by_reference_id', String(rowId)))
    .filter(e => e.reference_type === NAMESPACE.reference_type && e.effect === NAMESPACE.effect);
const payEntriesActive = async (rowId) =>
  (await payEntriesAll(rowId)).filter(e => e.is_reversed === false && e.deleted_at === null);
// This suite counts only the receipt_row_payment namespace it owns; independent
// receipt-created company charges are covered by their dedicated suite.
const ledgerCount = async () => (await DB.getAll(LEDGER))
  .filter(e => e.reference_type === NAMESPACE.reference_type && e.effect === NAMESPACE.effect).length;
const vBalCents = async (vid) => Math.round((await FinancialService.rebuildVehicleBalance(vid)).balance * 100);
const coBalCents = async (officeId) => (await DB.findByFields(LEDGER, { client_id: String(officeId) }))
  .filter(e => e.reference_type === NAMESPACE.reference_type
    && e.effect === NAMESPACE.effect
    && e.is_reversed === false
    && e.deleted_at === null)
  .reduce((s, e) => s + (e.type === 'deposit' ? Number(e.amount) : -Number(e.amount)), 0);
const liveRows = async (rid) => ReceiptReadRepository.getReceiptRowsByReceipt(rid);
const sortedIds = (arr) => arr.map(e => e.id).sort().join(',');

// ── Receipt fixtures — exact production-collector row shape (decimals in) ──
// net 11 EGP (1100c) + sarf 75 EGP (7500c): الصرف is deliberately NON-ZERO so
// the company leg (الصافي + الصرف = 8600c) can never be confused with الصافي.
const mkRow = (over = {}) => ({
  _type: 'data', row_id: uuid(),
  owner_id: OWNER_ID, owner_name: OWNER_NAME,
  kartano: '55', date: '2026-08-10',
  data: null, driver_name: null, driver_id: null,
  car: V1.plate, vehicle_id: VID1, vehicle_plate: V1.plate,
  loading: 'طنطا', taktik: 'القاهرة', type: 'نشا', office: OFFICE_A.name,
  weight: 10, weight2: 5, deficit: 1, weightTotal: 14,
  noloon: 100, ohda: 50, officeAmount: 25, discount: 0, sarf: 75, add: 0, net: 11,
  ...over,
});
const mkReceipt = (rows, over = {}) => ({
  receipt_date: '2026-08-10',
  client_id: OWNER_ID, client_type: 'owner', client_name: OWNER_NAME,
  total: rows.reduce((s, r) => s + (Number(r.net) || 0), 0),
  rows,
  ...over,
});
const NET_CENTS = 1100, SARF_CENTS = 7500, BOTH_CENTS = NET_CENTS + SARF_CENTS; // 8600

// ══ GROUP 1 — persistence contract: new rows default to unpaid (T1/T2) ══
console.log('\n— GROUP 1: persistence contract — new row defaults to لم يتم صرفه, zero posting (T1/T2) —');
const fxRowA = mkRow();
const rA = await FinancialService.createReceipt(U, mkReceipt([fxRowA]));
const RA = rA.receipt.id;
const rowsA = await liveRows(RA);
const rowA = rowsA[0];
ok(rowsA.length === 1, 'receipt A persisted exactly one row');
ok(String(rowA.row_id) === String(fxRowA.row_id), 'persisted row keeps its row UUID (the stable reference identity)');
ok(rowA.payment_status === 'unpaid', `T1: newly created row persists payment_status='unpaid' (default لم يتم صرفه) — got ${J(rowA.payment_status)}`);
ok(rowA.net === NET_CENTS && rowA.sarf === SARF_CENTS, `fixture sanity: net/sarf persist as cents (${rowA.net}/${rowA.sarf})`);
ok((await ledgerCount()) === 0, 'T2: an unpaid row creates ZERO ledger postings on save');

// ══ GROUP 2 — the explicit state machine (T3/T4/T5/T6) ══
console.log('\n— GROUP 2: state machine — unpaid⇄paid transitions, exactly-once posting (T3/T4/T5/T6) —');
// T6: unpaid → unpaid is an explicit no-op
let res = await FinancialService.setReceiptRowPaymentStatus(U, rowA.row_id, 'unpaid');
ok(res.changed === false && res.payment_status === 'unpaid', 'T6: unpaid → unpaid is an explicit no-op (changed:false), never a fabricated operation');
ok((await ledgerCount()) === 0, 'T6: no-transition writes NOTHING to the ledger');
// Whitelist: free-form status strings must never exist — garbage clamps to unpaid
res = await FinancialService.setReceiptRowPaymentStatus(U, rowA.row_id, 'paid-ish garbage');
ok(res.changed === false, 'whitelist: an arbitrary status string clamps to unpaid (no free-form state ever accepted)');
ok((await liveRows(RA))[0].payment_status === 'unpaid', 'whitelist: persisted value stays exactly \'unpaid\' — nothing outside the {paid,unpaid} pair');

// T3: unpaid → paid — the only financially positive transition
res = await FinancialService.setReceiptRowPaymentStatus(U, rowA.row_id, 'paid');
ok(res.changed === true && res.payment_status === 'paid', 'T3: unpaid → paid is a real transition (changed:true)');
ok((await liveRows(RA))[0].payment_status === 'paid', 'T3: the row itself now persists \'paid\' (تم صرفه)');
let legs = await payEntriesActive(rowA.row_id);
ok(legs.length === 2, `T3: exactly TWO posting legs created, no more, no fewer (got ${legs.length})`);
let vLeg = legs.find(l => l.client_type === 'vehicle');
let cLeg = legs.find(l => l.client_type === 'office');
ok(!!vLeg && !!cLeg, 'T3: one vehicle leg + one company leg (client_type discriminates)');
ok(vLeg && vLeg.amount === NET_CENTS && vLeg.type === 'deposit', `T3: vehicle leg = الصافي exactly (1100c deposit, got ${vLeg && vLeg.amount})`);
ok(vLeg && String(vLeg.vehicle_id) === String(VID1), 'T3: vehicle leg carries vehicle_id (rebuildVehicleBalance must see it)');
ok(cLeg && cLeg.amount === BOTH_CENTS && cLeg.type === 'deposit', `T3: company leg = الصافي + الصرف exactly (1100+7500=8600c, got ${cLeg && cLeg.amount}) — NOT just الصافي`);
ok(cLeg && String(cLeg.client_id) === String(OFFICE_A.id), 'T3: company leg resolves the row\'s اسم الشركة snapshot to the offices master record');
ok(cLeg && cLeg.vehicle_id === null, 'T3: company leg has vehicle_id null (would otherwise double-count in the vehicle balance)');
ok(legs.every(l => String(l.reference_id) === String(rowA.row_id)), 'T3: both legs reference the receipt row UUID (reference_id = row_id)');
ok(legs.every(l => l.reference_type === NAMESPACE.reference_type && l.effect === NAMESPACE.effect),
  'T3: legs carry the dedicated payment namespace (not the karta-settlement one)');
ok((await vBalCents(VID1)) === NET_CENTS, 'T3: vehicle balance increased by الصافي exactly (11.00 EGP)');
ok((await coBalCents(OFFICE_A.id)) === BOTH_CENTS, 'T3: company balance increased by الصافي + الصرف exactly (86.00 EGP)');
const paidIdsA = sortedIds(legs);

// T4: paid → paid — idempotent, zero new entries
const countBeforeRePay = await ledgerCount();
res = await FinancialService.setReceiptRowPaymentStatus(U, rowA.row_id, 'paid');
ok(res.changed === false && res.payment_status === 'paid', 'T4: paid → paid is an explicit no-op (changed:false)');
ok((await ledgerCount()) === countBeforeRePay, 'T4: no duplicate posting — ledger record count unchanged');
ok(sortedIds(await payEntriesActive(rowA.row_id)) === paidIdsA
  && (await payEntriesAll(rowA.row_id)).length === 2, 'T4: the SAME two legs remain the only postings (no shadow entries)');
ok((await vBalCents(VID1)) === NET_CENTS && (await coBalCents(OFFICE_A.id)) === BOTH_CENTS,
  'T4: balances untouched by the repeated save');

// Corruption-immunity: a live posting set + an unpaid-marked row must NOT double-post.
// Simulate the inconsistent shape: mark the row unpaid while its legs are ACTIVE.
await DB.update('receipt_rows', rowA.row_id, { payment_status: 'unpaid' }, { username: U });
res = await FinancialService.setReceiptRowPaymentStatus(U, rowA.row_id, 'paid');
ok(res.changed === true, 'corruption-immunity: row marked unpaid with live postings still completes the transition');
ok((await payEntriesAll(rowA.row_id)).length === 2 && sortedIds(await payEntriesActive(rowA.row_id)) === paidIdsA,
  'idempotency: an existing ACTIVE posting set is NEVER duplicated (the guard refuses to post twice)');
ok((await vBalCents(VID1)) === NET_CENTS && (await coBalCents(OFFICE_A.id)) === BOTH_CENTS,
  'idempotency: balances still reflect exactly one posting set');

// T5: paid → unpaid — exact reversal of the previously created legs
res = await FinancialService.setReceiptRowPaymentStatus(U, rowA.row_id, 'unpaid');
ok(res.changed === true && res.payment_status === 'unpaid', 'T5: paid → unpaid is a real transition (changed:true)');
ok((await liveRows(RA))[0].payment_status === 'unpaid', 'T5: the row persists \'unpaid\' again (لم يتم صرفه)');
ok((await payEntriesActive(rowA.row_id)).length === 0, 'T5: zero ACTIVE postings remain for the row');
const reversedA = await payEntriesAll(rowA.row_id);
ok(reversedA.length === 2 && reversedA.every(e => e.is_reversed === true && e.reversed_at && e.reversed_by === U),
  'T5: reversal = is_reversed:true audit (reversed_at/reversed_by stamped) — never a hard delete');
ok(sortedIds(reversedA) === paidIdsA, 'T5: exactly the SAME two previously created records were reversed (exact, traceable)');
ok((await vBalCents(VID1)) === 0 && (await coBalCents(OFFICE_A.id)) === 0,
  'T5: vehicle AND company balances return to zero (exact reversal, no residue)');

// Second cycle — pay/unpay again: each cycle posts/reverses exactly once
await FinancialService.setReceiptRowPaymentStatus(U, rowA.row_id, 'paid');
const legs2 = await payEntriesActive(rowA.row_id);
ok(legs2.length === 2 && sortedIds(legs2) !== paidIdsA, 'second cycle creates a FRESH pair (new ledger ids, audit trail grows)');
await FinancialService.setReceiptRowPaymentStatus(U, rowA.row_id, 'unpaid');
ok((await payEntriesAll(rowA.row_id)).length === 4
  && (await payEntriesAll(rowA.row_id)).every(e => e.is_reversed === true)
  && (await vBalCents(VID1)) === 0 && (await coBalCents(OFFICE_A.id)) === 0,
  'two full cycles leave 4 reversed audit records and BOTH balances at exactly zero');

// ══ GROUP 3 — independent rows: same receipt, separate states & postings (T7/T8/T17) ══
console.log('\n— GROUP 3: per-row independence + accumulation (T7/T8/T17) —');
const fxB1 = mkRow();
const fxB2 = mkRow(); // deliberately IDENTICAL values — only the row UUID differs
const rB = await FinancialService.createReceipt(U, mkReceipt([fxB1, fxB2]));
const RB = rB.receipt.id;
const rowsB = await liveRows(RB);
const byIdB = Object.fromEntries(rowsB.map(r => [String(r.row_id), r]));
ok(rowsB.length === 2 && byIdB[fxB1.row_id].payment_status === 'unpaid' && byIdB[fxB2.row_id].payment_status === 'unpaid',
  'both rows of receipt B persist unpaid by default');
ok((await vBalCents(VID1)) === 0, 'no posting for either row before any transition');
await FinancialService.setReceiptRowPaymentStatus(U, fxB1.row_id, 'paid');
ok((await vBalCents(VID1)) === NET_CENTS && (await coBalCents(OFFICE_A.id)) === BOTH_CENTS,
  'T7: paying one row posts for that row only (vehicle 1100c / company 8600c)');
ok(byIdB[fxB2.row_id].payment_status === 'unpaid'
  && (await liveRows(RB)).find(r => String(r.row_id) === String(fxB2.row_id)).payment_status === 'unpaid'
  && (await payEntriesAll(fxB2.row_id)).length === 0,
  'T7: the sibling row in the SAME receipt stays unpaid with zero postings (status belongs to the ROW)');
await FinancialService.setReceiptRowPaymentStatus(U, fxB2.row_id, 'paid');
ok((await vBalCents(VID1)) === 2 * NET_CENTS && (await coBalCents(OFFICE_A.id)) === 2 * BOTH_CENTS,
  'T17: a second paid row accumulates — vehicle 2200c / company 17200c');
const legsB1 = await payEntriesActive(fxB1.row_id), legsB2 = await payEntriesActive(fxB2.row_id);
ok(legsB1.length === 2 && legsB2.length === 2
  && legsB1.every(l => String(l.reference_id) === String(fxB1.row_id))
  && legsB2.every(l => String(l.reference_id) === String(fxB2.row_id))
  && sortedIds(legsB1) !== sortedIds(legsB2),
  'T8: identical rows post INDEPENDENTLY — each pair is traceable to its own row UUID, sets are disjoint');
await FinancialService.setReceiptRowPaymentStatus(U, fxB1.row_id, 'unpaid');
ok((await payEntriesActive(fxB1.row_id)).length === 0 && (await payEntriesActive(fxB2.row_id)).length === 2,
  'T8: unpaying one row reverses ITS pair only — the sibling\'s ACTIVE postings are untouched');
ok((await vBalCents(VID1)) === NET_CENTS && (await coBalCents(OFFICE_A.id)) === BOTH_CENTS,
  'T8: balances now reflect the still-paid sibling only (1100c / 8600c)');
// restore zero baseline for later groups (extra reversal proof)
await FinancialService.setReceiptRowPaymentStatus(U, fxB2.row_id, 'unpaid');
ok((await vBalCents(VID1)) === 0 && (await coBalCents(OFFICE_A.id)) === 0, 'reversing the last paid row restores both balances to zero');

// ══ GROUP 4 — edit / re-save reconciliation (T9/T10/T11/T15) ══
console.log('\n— GROUP 4: receipt edit & re-save — no loss, no duplication, safe adjust (T9/T10/T11/T15) —');
const fxCU = mkRow({ kartano: '60' });
const fxCP = mkRow({ kartano: '70' });
const rC = await FinancialService.createReceipt(U, mkReceipt([fxCU, fxCP]));
const RC = rC.receipt.id;

// T9: edit while unpaid — a real change, ZERO financial effects
const countBeforeEdit1 = await ledgerCount();
await FinancialService.updateReceipt(U, RC, mkReceipt([
  mkRow({ ...fxCU, row_id: uuid(), kartano: '60x' }), // changed non-financial field
  mkRow({ ...fxCP, row_id: uuid() }),                 // same values as collected
]));
ok((await ledgerCount()) === countBeforeEdit1, 'T9: re-saving an UNPAID receipt writes ZERO ledger records');
let rowsC = await liveRows(RC);
ok(rowsC.length === 2 && rowsC.every(r => r.payment_status === 'unpaid'), 'T9: unpaid rows stay unpaid through edit (status preserved)');
ok(!rowsC.some(r => String(r.row_id) === String(fxCU.row_id) || String(r.row_id) === String(fxCP.row_id)),
  'T9: edit replaced row entities with FRESH row UUIDs (store replacement semantics)');

// T10: pay one row, then re-save unchanged — reverse+repost net-zero, never duplicated
let curCP = rowsC.find(r => r.kartano === '70');
await FinancialService.setReceiptRowPaymentStatus(U, curCP.row_id, 'paid');
const preEdit2Active = sortedIds(await payEntriesActive(curCP.row_id));
ok((await vBalCents(VID1)) === NET_CENTS && (await coBalCents(OFFICE_A.id)) === BOTH_CENTS, 'baseline: paid row posted (1100c / 8600c)');
const countBeforeEdit2 = await ledgerCount();
await FinancialService.updateReceipt(U, RC, mkReceipt([
  mkRow({ ...fxCU, row_id: uuid(), kartano: '60x' }),                    // unchanged unpaid row
  mkRow({ ...fxCP, row_id: uuid(), kartano: '70', payment_status: 'paid' }), // collector-carried unchanged paid row
]));
rowsC = await liveRows(RC);
const newCP = rowsC.find(r => r.kartano === '70');
ok(newCP && newCP.payment_status === 'paid' && String(newCP.row_id) !== String(curCP.row_id),
  'T10: the paid row stays paid after re-save (status survives the edit), under its fresh row UUID');
const postEdit2Active = await payEntriesActive(newCP.row_id);
ok(postEdit2Active.length === 2 && sortedIds(postEdit2Active) !== preEdit2Active,
  'T10: a FRESH posting pair was created for the new row UUID (old pair belongs to the replaced row)');
const allCPostings = [...(await payEntriesAll(curCP.row_id)), ...(await payEntriesAll(newCP.row_id))];
ok(allCPostings.filter(e => e.is_reversed === true).length === 2
  && allCPostings.filter(e => e.is_reversed === false).length === 2,
  'T10: the replaced row\'s pair was reversed exactly; exactly one ACTIVE pair remains system-wide for this receipt row lineage — NO DUPLICATE');
ok((await vBalCents(VID1)) === NET_CENTS && (await coBalCents(OFFICE_A.id)) === BOTH_CENTS,
  'T10: re-saving an unchanged paid row leaves BOTH balances EXACTLY as before (reverse+repost is net-zero)');
ok((await ledgerCount()) === countBeforeEdit2 + 2, 'T10: ledger grew by exactly the fresh pair (old pair remains as reversed audit)');

// T11: re-save the paid row with CHANGED vehicle/company/الصافي/الصرف — safe adjustment
const beforeT11 = { v1: await vBalCents(VID1), v2: await vBalCents(VID2), a: await coBalCents(OFFICE_A.id), b: await coBalCents(OFFICE_B.id) };
await FinancialService.updateReceipt(U, RC, mkReceipt([
  mkRow({ ...fxCU, row_id: uuid(), kartano: '60x' }),
  mkRow({ ...fxCP, row_id: uuid(), kartano: '70', payment_status: 'paid',
    vehicle_id: VID2, vehicle_plate: V2.plate, car: V2.plate,
    office: OFFICE_B.name, net: 20, sarf: 5 }),
]));
rowsC = await liveRows(RC);
const adjCP = rowsC.find(r => r.kartano === '70');
ok(adjCP && adjCP.payment_status === 'paid' && String(adjCP.vehicle_id) === String(VID2) && adjCP.office === OFFICE_B.name
  && adjCP.net === 2000 && adjCP.sarf === 500, 'T11: the edit itself persists (new vehicle/company/الصافي/الصرف, row stays paid)');
const adjLegs = await payEntriesActive(adjCP.row_id);
ok(adjLegs.length === 2
  && adjLegs.find(l => l.client_type === 'vehicle').amount === 2000
  && String(adjLegs.find(l => l.client_type === 'vehicle').vehicle_id) === String(VID2)
  && adjLegs.find(l => l.client_type === 'office').amount === 2500
  && String(adjLegs.find(l => l.client_type === 'office').client_id) === String(OFFICE_B.id),
  'T11: the NEW posting pair reflects the EDITED financial identity (vehicle2 2000c / company2 2500c=net20+sarf5)');
ok((await payEntriesActive(newCP.row_id)).length === 0 && (await payEntriesAll(newCP.row_id)).every(e => e.is_reversed === true),
  'T11: the PREVIOUS posting pair was reversed in the same operation (old effect cannot survive)');
ok((await vBalCents(VID1)) === beforeT11.v1 - NET_CENTS && (await coBalCents(OFFICE_A.id)) === beforeT11.a - BOTH_CENTS,
  'T11: old vehicle/company effects withdrawn exactly (vehicle1 −1100c, company1 −8600c)');
ok((await vBalCents(VID2)) === beforeT11.v2 + 2000 && (await coBalCents(OFFICE_B.id)) === beforeT11.b + 2500,
  'T11: new vehicle/company effects applied exactly (vehicle2 +2000c, company2 +2500c) — one atomic adjustment');

// T15: full chain create → persist → read → page-shape → edit → re-save preserves state
const chainRead = await liveRows(RC);
ok(chainRead.length === 2 && chainRead.find(r => r.kartano === '70').payment_status === 'paid'
  && chainRead.find(r => r.kartano === '60x').payment_status === 'unpaid',
  'T15: create→persist→read returns both rows with their independent statuses intact');
await FinancialService.updateReceipt(U, RC, mkReceipt([
  mkRow({ ...fxCU, row_id: uuid(), kartano: '60x' }),
  mkRow({ ...fxCP, row_id: uuid(), kartano: '70', payment_status: 'paid',
    vehicle_id: VID2, vehicle_plate: V2.plate, car: V2.plate, office: OFFICE_B.name, net: 20, sarf: 5 }),
]));
const reSaved = await liveRows(RC);
const reSavedPaid = reSaved.find(r => r.kartano === '70');
ok(reSavedPaid.payment_status === 'paid'
  && (await payEntriesActive(reSavedPaid.row_id)).length === 2
  && (await payEntriesActive(adjCP.row_id)).length === 0
  && (await vBalCents(VID2)) === beforeT11.v2 + 2000 && (await coBalCents(OFFICE_B.id)) === beforeT11.b + 2500,
  'T15: edit→re-save preserves the paid state and its EXACT posting (again net-zero, balances unchanged)');

// ══ GROUP 5 — deletion reverses paid effects (T12) ══
console.log('\n— GROUP 5: receipt deletion reverses its row effects (T12) —');
const fxD1 = mkRow({ kartano: '80' });
const rD = await FinancialService.createReceipt(U, mkReceipt([fxD1]));
const RD = rD.receipt.id;
await FinancialService.setReceiptRowPaymentStatus(U, fxD1.row_id, 'paid');
const delLegIds = sortedIds(await payEntriesActive(fxD1.row_id));
ok((await vBalCents(VID1)) === NET_CENTS && (await coBalCents(OFFICE_A.id)) === BOTH_CENTS, 'baseline: receipt D paid (1100c / 8600c)');
const delRes = await FinancialService.deleteReceipt(U, RD);
ok(delRes && delRes.deleted === true, 'deleteReceipt returns its kept contract shape { id, deleted:true }');
const delLegs = await payEntriesAll(fxD1.row_id);
ok((await payEntriesActive(fxD1.row_id)).length === 0
  && delLegs.length === 2 && sortedIds(delLegs) === delLegIds
  && delLegs.every(e => e.is_reversed === true && e.reversed_by === U && e.deleted_at === null),
  'T12: deleting the receipt reversed EXACTLY its paid row\'s pair (same two records → is_reversed, audit preserved)');
ok((await vBalCents(VID1)) === 0 && (await coBalCents(OFFICE_A.id)) === 0,
  'T12: vehicle/company balances lose the deleted receipt\'s effect entirely');
ok((await vBalCents(VID2)) === 2000 && (await coBalCents(OFFICE_B.id)) === 2500,
  'T12: OTHER receipts\' live postings are untouched by the deletion (reversal is scoped to the deleted rows)');
ok((await DB.findByFields('receipts', { id: RD })).length === 0
  && (await DB.findByFields('receipt_rows', { receipt_id: RD })).length === 0,
  'T12: receipt + rows moved to soft-deleted audit (default read views exclude them)');
ok((await liveRows(RD)).length === 0, 'T12: read path no longer surfaces the deleted receipt\'s rows');

// ══ GROUP 6 — atomic failure + legacy rows (T13/T14) ══
console.log('\n— GROUP 6: atomic failure rolls everything back; legacy rows read unpaid (T13/T14) —');
// Receipt creation now rejects an unresolvable company before it can create an
// independent receipt-row company charge. Insert one legacy-shaped unknown row
// directly to retain the payment-transition failure test without bypassing that
// new receipt-creation safety rule.
const rE = await FinancialService.createReceipt(U, mkReceipt([mkRow({ kartano: '90', office: OFFICE_A.name })]));
const RE = rE.receipt.id;
const fxBad = {
  row_id: uuid(), receipt_id: RE, username: U,
  driver_id: null, vehicle_id: VID1, vehicle_plate: V1.plate,
  driver_price: 10000, loading: '', destination: '', office: 'شركة غير معروفة',
  advance: 0, net: NET_CENTS, sarf: SARF_CENTS,
  kartano: '90-unknown', date: '2026-08-10', driver_name: null, type: 'نشا',
  weight: null, weight2: null, deficit: null, weightTotal: null,
  officeAmount: 0, discount: 0, add: 0, row_order: null,
  payment_status: 'unpaid',
};
await DB.add('receipt_rows', fxBad, { username: U });
const countBeforeFail = await ledgerCount();
const v1BeforeFail = await vBalCents(VID1);
let failErr = '';
try { await FinancialService.setReceiptRowPaymentStatus(U, fxBad.row_id, 'paid'); } catch (e) { failErr = e.message; }
ok(/unknown office|لا يمكن ترحيل|شركة/.test(failErr || ''), `T13: toggle to paid with an unregistered company fails LOUDLY ("${String(failErr).slice(0, 60)}…")`);
ok((await liveRows(RE)).find(r => String(r.row_id) === String(fxBad.row_id)).payment_status === 'unpaid', 'T13: the failed transition did NOT mark the row paid');
ok((await ledgerCount()) === countBeforeFail && (await payEntriesAll(fxBad.row_id)).length === 0,
  'T13: the failed transition committed NOTHING (no partial postings) — one atomic unit');
ok((await vBalCents(VID1)) === v1BeforeFail, 'T13: vehicle balance completely unchanged by the failure');
// A nonexistent row_id is likewise rejected loudly, before any write
let vehErr = '';
try { await FinancialService.setReceiptRowPaymentStatus(U, 'row-that-does-not-exist', 'paid'); } catch (e) { vehErr = e.message; }
ok(/receipt row not found/.test(vehErr || ''), `T13: a nonexistent row_id is rejected before any write ("${String(vehErr).slice(0, 60)}…")`);
ok((await ledgerCount()) === countBeforeFail, 'T13: the nonexistent-row attempt also wrote NOTHING');

// T14: legacy persisted row WITHOUT the field (no backfill, no migration)
const legacyRow = {
  row_id: uuid(), receipt_id: RE, username: U,
  driver_id: null, vehicle_id: VID1, vehicle_plate: V1.plate,
  driver_price: 10000, loading: '', destination: '', office: OFFICE_A.name,
  advance: 0, net: NET_CENTS, sarf: SARF_CENTS,
  kartano: '95', date: '2026-08-10', driver_name: null, type: 'نشا',
  weight: null, weight2: null, deficit: null, weightTotal: null,
  officeAmount: 0, discount: 0, add: 0, row_order: null,
  // deliberately NO payment_status key — pre-feature legacy shape
};
await DB.add('receipt_rows', legacyRow, { username: U });
const gotLegacy = await ReceiptRepository.getRowById(legacyRow.row_id);
ok(gotLegacy && !('payment_status' in gotLegacy), 'legacy fixture sanity: the stored record genuinely has NO payment_status field');
res = await FinancialService.setReceiptRowPaymentStatus(U, legacyRow.row_id, 'unpaid');
ok(res.changed === false && res.payment_status === 'unpaid', 'T14: a legacy row without the field IS unpaid (unpaid target is a no-op)');
ok((await payEntriesAll(legacyRow.row_id)).length === 0, 'T14: legacy rows carry no hidden postings');
res = await FinancialService.setReceiptRowPaymentStatus(U, legacyRow.row_id, 'paid');
ok(res.changed === true && (await payEntriesActive(legacyRow.row_id)).length === 2
  && (await vBalCents(VID1)) === v1BeforeFail + NET_CENTS,
  'T14: legacy rows enter the full state machine on first touch (pay posts normally)');
ok((await ReceiptRepository.getRowById(legacyRow.row_id)).payment_status === 'paid',
  'T14: the field materializes on the row record after the first transition (no migration script needed)');
await FinancialService.setReceiptRowPaymentStatus(U, legacyRow.row_id, 'unpaid'); // restore zero baseline
ok((await vBalCents(VID1)) === v1BeforeFail, 'legacy reversal restores the baseline');

await FinancialService.deleteReceipt(U, RE); // cleanup (contains fxBad unpaid + legacy unpaid)
ok((await vBalCents(VID1)) === 0 && (await coBalCents(OFFICE_A.id)) === 0
  && (await vBalCents(VID2)) === 2000 && (await coBalCents(OFFICE_B.id)) === 2500,
  'end-state: only receipt C\'s paid lineage remains live (vehicle2 2000c / company2 2500c), everything else exactly zero');
const finalActive = (await DB.getAll(LEDGER))
  .filter(e => e.reference_type === NAMESPACE.reference_type && e.effect === NAMESPACE.effect
    && e.is_reversed === false && e.deleted_at === null);
const finalRowC = (await liveRows(RC)).find(r => r.kartano === '70');
ok(finalActive.length === 2 && finalActive.every(e => String(e.reference_id) === String(finalRowC.row_id)),
  'global invariant: exactly ONE ACTIVE posting pair exists system-wide, referencing receipt C\'s live paid row UUID — no orphans, no duplicates');

// ══ GROUP 7 — UI contract via verbatim-extracted production source ══
console.log('\n— GROUP 7: UI contract — الحالة column, dropdown, mapper, print, Excel (extracted real source) —');
// COL_DEFS order: الحالة immediately after الصافي
const colDefs = new Function(
  `${extractAfter(RECEIPTS_SRC, 'const COL_DEFS = [', '[')}; return COL_DEFS;`
)();
const colKeys = colDefs.map(c => c.key);
const idxNet = colKeys.indexOf('net'), idxPay = colKeys.indexOf('payment_status'), idxAct = colKeys.indexOf('_actions');
ok(idxNet > -1 && idxPay === idxNet + 1, 'COL_DEFS: الحالة column sits IMMEDIATELY after الصافي (net) — required placement');
ok(idxAct === idxPay + 1, 'COL_DEFS: …and immediately before إجراءات (no other column inserted)');
const payColDef = colDefs.find(c => c.key === 'payment_status');
ok(payColDef.label === 'الحالة' && payColDef.noForm === true,
  'COL_DEFS: الحالة column is labeled الحالة and carries noForm (the receipt FORM grid stays unchanged)');
ok(colDefs.filter(c => c.key !== '_actions').length === 20, 'COL_DEFS: all-receipts data column count = 20 (الحالة included as data column #20)');

// Snapshot rendering — real payment-status dropdown generation from the real row shape
const snapshot = new Function('COL_DEFS', `
  const _snapshotEsc = (v) => String(v ?? '');
  const formatSnapshotNumber = (v) => String(v ?? '');
  ${extractFn(RECEIPTS_SRC, 'getSnapshotCellRawValue')}
  ${extractFn(RECEIPTS_SRC, 'formatSnapshotCellValue')}
  ${extractFn(RECEIPTS_SRC, 'renderReceiptSnapshotDataRow')}
  return { getSnapshotCellRawValue, formatSnapshotCellValue, renderReceiptSnapshotDataRow };
`)(colDefs);
ok(snapshot.getSnapshotCellRawValue({ payment_status: 'paid' }, payColDef) === 'paid'
  && snapshot.getSnapshotCellRawValue({ payment_status: 'unpaid' }, payColDef) === 'unpaid'
  && snapshot.getSnapshotCellRawValue({}, payColDef) === 'unpaid'
  && snapshot.getSnapshotCellRawValue({ payment_status: 'garbage' }, payColDef) === 'unpaid',
  'snapshot raw value: whitelist clamp at render (missing/garbage → unpaid)');
ok(snapshot.formatSnapshotCellValue({ payment_status: 'paid' }, payColDef) === 'تم صرفه'
  && snapshot.formatSnapshotCellValue({ payment_status: 'unpaid' }, payColDef) === 'لم يتم صرفه',
  'snapshot formats the ONLY two display labels: تم صرفه / لم يتم صرفه');
const selectUnpaid = snapshot.renderReceiptSnapshotDataRow({ row_id: 'RID-1', payment_status: 'unpaid' });
ok(selectUnpaid.includes('<select') && selectUnpaid.includes('data-action="set-row-payment-status"')
  && selectUnpaid.includes('data-row-id="RID-1"') && !selectUnpaid.includes('<button'),
  'dropdown (unpaid row): status renders as an explicit select, never a clickable toggle chip');
ok((selectUnpaid.match(/<option /g) || []).length === 2
  && selectUnpaid.includes('<option value="unpaid" selected>لم يتم صرفه</option>')
  && selectUnpaid.includes('<option value="paid">تم صرفه</option>'),
  'dropdown (unpaid row): contains exactly the two required options with unpaid selected');
const selectPaid = snapshot.renderReceiptSnapshotDataRow({ row_id: 'RID-2', payment_status: 'paid' });
ok((selectPaid.match(/<option /g) || []).length === 2
  && selectPaid.includes('<option value="unpaid">لم يتم صرفه</option>')
  && selectPaid.includes('<option value="paid" selected>تم صرفه</option>')
  && selectPaid.includes('background:#dcfce7'),
  'dropdown (paid row): contains exactly the required options, selects paid, and keeps green paid styling');
const selectLegacy = snapshot.renderReceiptSnapshotDataRow({ row_id: 'RID-3' });
ok(selectLegacy.includes('<option value="unpaid" selected>لم يتم صرفه</option>')
  && selectLegacy.includes('<option value="paid">تم صرفه</option>'),
  'dropdown (legacy row without the field): defaults to unpaid in the same two-option select');
const selectNoId = snapshot.renderReceiptSnapshotDataRow({ payment_status: 'paid' });
ok(selectNoId.includes('تم صرفه') && !selectNoId.includes('<select') && !selectNoId.includes('data-action'),
  'dropdown (row without row_id): renders a plain label, never an editable control without a row UUID');

// Page mapper — the All Receipts page row shape (verified through the real function)
const pageMapper = new Function('Money', `
  ${extractFn(ALLRECEIPTS_SRC, '_persistedRowToPageRow')}
  return { _persistedRowToPageRow };
`)(Money);
ok(pageMapper._persistedRowToPageRow({ row_id: 'x', payment_status: 'paid' }).payment_status === 'paid'
  && Money.toDecimal && pageMapper._persistedRowToPageRow({ row_id: 'x', payment_status: 'unpaid' }).payment_status === 'unpaid'
  && pageMapper._persistedRowToPageRow({ row_id: 'x' }).payment_status === 'unpaid',
  'page mapper: paid passes through, unpaid passes through, legacy (no field) clamps to unpaid');

// Execute the production dropdown handler verbatim with a select-shaped event
// target. The test verifies UI delegation only; the financial state-machine
// behavior itself is exercised against the real FinancialService in Groups 1–6.
const dropdownCalls = [];
let dropdownRefreshes = 0;
const dropdownHandler = new Function('getSessionUsername', 'FinancialService', 'refreshAllReceiptsPage', 'alert', `
  ${extractFn(ALLRECEIPTS_SRC, '_handleRowPaymentStatusChange')}
  return _handleRowPaymentStatusChange;
`)(
  () => U,
  { setReceiptRowPaymentStatus: async (...args) => { dropdownCalls.push(args); } },
  async () => { dropdownRefreshes++; },
  () => {}
);
const dropdownControl = { dataset: { rowId: 'RID-UI' }, value: 'paid', disabled: false };
await dropdownHandler(dropdownControl);
ok(dropdownControl.disabled === true
  && J(dropdownCalls) === J([[U, 'RID-UI', 'paid']])
  && dropdownRefreshes === 1,
  'dropdown change calls the existing setReceiptRowPaymentStatus entry point once with the selected paid value, then refreshes');

// All-Receipts print columns — الحالة immediately after الصافي
const printCols = new Function(
  `${extractAfter(ALLRECEIPTS_SRC, 'const _RECEIPT_PRINT_COLS = Object.freeze([', '[')}); return _RECEIPT_PRINT_COLS;`
)();
const printKeys = printCols.map(c => c.key);
ok(printKeys.indexOf('payment_status') === printKeys.indexOf('net') + 1
  && printCols.find(c => c.key === 'payment_status').label === 'الحالة',
  'all-receipts print: الحالة column sits immediately after الصافي');
const printCell = new Function(
  `${extractFn(ALLRECEIPTS_SRC, '_receiptPrintGetCellValue')}
   return { _receiptPrintGetCellValue };`
)();
ok(printCell._receiptPrintGetCellValue({ payment_status: 'paid' }, 'payment_status') === 'تم صرفه'
  && printCell._receiptPrintGetCellValue({}, 'payment_status') === 'لم يتم صرفه',
  'all-receipts print cells render تم صرفه / لم يتم صرفه');

// Excel export — الحالة immediately after الصافي with the same Arabic labels
const excelCols = new Function('_str', '_allReceiptsNum',
  `${extractAfter(EXCEL_SRC, 'const _ALL_RECEIPTS_COLS = Object.freeze([', '[')}); return _ALL_RECEIPTS_COLS;`
)((v) => v, (v) => v);
const excelHeaders = excelCols.map(c => c.header);
ok(excelHeaders.indexOf('الحالة') === excelHeaders.indexOf('الصافي') + 1,
  'excel export: الحالة column sits immediately after الصافي');
const excelPayCol = excelCols.find(c => c.header === 'الحالة');
ok(excelPayCol && excelPayCol.getValue({ payment_status: 'paid' }, {}) === 'تم صرفه'
  && excelPayCol.getValue({}, {}) === 'لم يتم صرفه',
  'excel export renders تم صرفه / لم يتم صرفه for the row');

// ══ GROUP 8 — fingerprints, census, KEEP/REMOVED contracts ══
console.log('\n— GROUP 8: fingerprints + census + KEEP/REMOVED contracts —');
fingerprint(RECEIPTS_SRC, "{ key: 'payment_status', label: 'الحالة'", 'الحالة column defined in the shared COL_DEFS contract');
fingerprint(RECEIPTS_SRC, "payment_status: row.dataset.paymentStatus === 'paid' ? 'paid' : 'unpaid',",
  'receipt FORM collector carries the row status (unpaid default) on save');
fingerprint(RECEIPTS_SRC, "tr.dataset.paymentStatus = rowData.payment_status === 'paid' ? 'paid' : 'unpaid';",
  'edit-load round-trips the persisted status into the form row (invisible carry)');
fingerprint(RECEIPTS_SRC, 'COL_DEFS.filter(col => !col.noForm).map(col => {',
  'receipt FORM grid excludes noForm columns (form layout unchanged)');
fingerprint(RECEIPTS_SRC, 'if (c.noForm) return false;',
  'receipt FORM print excludes the status column (form print layout unchanged)');
fingerprint(ALLRECEIPTS_SRC, "payment_status: row.payment_status === 'paid' ? 'paid' : 'unpaid',",
  'page mapper persists the whitelist only');
fingerprint(ALLRECEIPTS_SRC, 'select[data-action="set-row-payment-status"]',
  'page listens for payment-status select changes, not a click-to-toggle chip');
fingerprint(ALLRECEIPTS_SRC, 'await _handleRowPaymentStatusChange(statusSelect);',
  'page change delegate routes the dropdown selection to the existing status handler');
fingerprint(ALLRECEIPTS_SRC, 'await FinancialService.setReceiptRowPaymentStatus(username, rowId, target);',
  'the dropdown handler delegates the transition to FinancialService — NO direct balance mutation in the UI');
fingerprint(FINANCIAL_SRC, "const PAYMENT_STATUS = Object.freeze({ UNPAID: 'unpaid', PAID: 'paid' });",
  'domain-level status whitelist constant');
fingerprint(FINANCIAL_SRC, "const PAYMENT_REF_TYPE = 'receipt_row_payment';", 'dedicated posting reference namespace');
fingerprint(FINANCIAL_SRC, 'amount: netCents + sarfCents,', 'company leg posts الصافي + الصرف (never just الصافي)');
fingerprint(FINANCIAL_SRC, 'vehicle_id: null, // by_vehicle sums must never see the company leg',
  'company leg excluded from vehicle-balance sums (no double-count)');
fingerprint(FINANCIAL_SRC, 'reference_id: String(row.row_id),', 'every posting traceable to the receipt row UUID');

// Census: exactly ONE posting builder, exactly TWO aggregate entry points + the explicit toggle
const addCallSites = (FINANCIAL_SRC.match(/await _paymentAddCommands\(/g) || []).length;
ok(addCallSites === 2, `census: _paymentAddCommands has exactly TWO call sites (create + edit reconciliation) — got ${addCallSites}`);
const legSites = (FINANCIAL_SRC.match(/_paymentLegPayloads\(/g) || []).length;
ok(legSites === 3, `census: _paymentLegPayloads has ONE definition + TWO call sites (aggregate flow + explicit toggle) — got ${legSites}, no parallel posting builders`);
const toggleSites = (FINANCIAL_SRC.match(/async function setReceiptRowPaymentStatus/g) || []).length;
ok(toggleSites === 1, 'census: exactly ONE public state-transition entry point exists');
const uiPostSites = (ALLRECEIPTS_SRC.match(/setReceiptRowPaymentStatus\(/g) || []).length;
ok(uiPostSites === 1, 'census: the UI calls the state machine in exactly ONE place (no financial logic in the page)');
ok(!/rebuildVehicleBalance\(|vehicle_ledger/.test(RECEIPTS_SRC) && !/rebuildVehicleBalance\(/.test(ALLRECEIPTS_SRC),
  'census: UI modules NEVER touch balances directly (no posting math outside financial.js)');

// KEEP / REMOVED contracts
ok(DATABASE_SRC.includes('const DB_VERSION = 14;'), 'KEEP: DB schema version stays 14 (payment_status is additive row data — no schema churn)');
// database.js documents the removals in its version-history comments — the census
// for it must run on CODE ONLY (comments stripped), a structural not textual check.
const databaseCodeOnly = DATABASE_SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
for (const [label, src] of [
  ['financial.js', FINANCIAL_SRC], ['receipts.js', RECEIPTS_SRC],
  ['allReceipts.js', ALLRECEIPTS_SRC], ['excelService.js', EXCEL_SRC], ['database.js(code)', databaseCodeOnly],
]) {
  ok(!/treasury|خزنة|mainCapital/i.test(src), `REMOVED-CONTRACT: ${label} carries ZERO treasury references (subsystem stays permanently removed)`);
  ok(!/receipt_number|receiptNumber/.test(src), `REMOVED-CONTRACT: ${label} carries ZERO receipt-numbering references (stays permanently removed)`);
}
const badStatusLiterals = [FINANCIAL_SRC, RECEIPTS_SRC, ALLRECEIPTS_SRC, EXCEL_SRC]
  .some(src => /payment_status\s*===\s*'(?!paid'|unpaid')/.test(src)
    || /payment_status\s*:\s*'(?!paid'|unpaid')/.test(src));
ok(!badStatusLiterals,
  'census: payment_status is only ever compared/assigned against the {paid, unpaid} whitelist literals — no invented states');

console.log(failures === 0 ? '\n✅ ALL PAYMENT-STATUS ASSERTIONS PASSED' : `\n❌ ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
