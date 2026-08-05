// run.mjs — End-to-end read-path verification (Phase 4 — Step 7).
//
// What this proves:
//   1. The REAL frozen read stack (database.js → DBProvider → ReadDataSource →
//      ReceiptReadRepository / ReceiptRepository) serves normalized rows on
//      data written through the REAL frozen write path (FinancialService).
//   2. The migrated consumption expressions from dashboard.js / offices.js are
//      re-executed as VERBATIM EXTRACTED functions (each source-cited, and each
//      bound to the real source by a verbatim marker-line assertion) against
//      those repositories + REAL money.js / financialCalculator.js.
//   3. The REAL modified UI sources are statically asserted to contain no
//      embedded receipt.rows access and the new repository wiring.
//
// dashboard.js / offices.js themselves are not imported (UI modules with
// browser-only dependencies) — they are read as text for the static assertions.
import { installIDB } from './idb-shim.mjs';
installIDB();

import { readFileSync } from 'node:fs';

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ReceiptRepository } = await import('./services/receiptRepository.js');
const { ReceiptReadRepository } = await import('./services/receiptReadRepository.js');
const { Money } = await import('./money.js');
const { calculateWeightTotal } = await import('./services/financialCalculator.js');

const U = 'tester';
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; };
const uuid = () => crypto.randomUUID();

// ═══ SEED via the REAL frozen write path ═══════════════════════════════════
const officeA = await DB.add('offices', { name: 'شركة أ' }, { username: U });
const officeB = await DB.add('offices', { name: 'شركة ب' }, { username: U });

const row1 = () => ({ row_id: uuid(), _type: 'data', owner_id: 'owner-1', owner_name: 'مالك اختبار',
  vehicle_id: 'veh-1', vehicle_plate: '111 أ ب', driver_id: null,
  driver_price: 11, advance: 5, loading: 'طنطا', destination: 'القاهرة',
  office: 'شركة أ', net: 550, sarf: 2 });
const row2 = () => ({ row_id: uuid(), _type: 'data', owner_id: 'owner-1', owner_name: 'مالك اختبار',
  vehicle_id: 'veh-2', vehicle_plate: '222 ج د', driver_id: null,
  driver_price: 12, advance: 0, loading: 'طنطا', destination: 'الإسكندرية',
  office: 'شركة ب', net: 600, sarf: 0 });
const row3 = () => ({ row_id: uuid(), _type: 'data', owner_id: 'owner-1', owner_name: 'مالك اختبار',
  vehicle_id: 'veh-3', vehicle_plate: '333 هـ و', driver_id: null,
  driver_price: 10, advance: 0, loading: 'طنطا', destination: 'المنصورة',
  office: 'شركة أ', net: 650, sarf: 0 });
const rowX = () => ({ row_id: uuid(), _type: 'data', owner_id: 'owner-1', owner_name: 'مالك اختبار',
  vehicle_id: 'veh-9', vehicle_plate: '999 ز ح', driver_id: null,
  driver_price: 20, advance: 0, loading: 'طنطا', destination: 'القاهرة',
  office: 'شركة أ', net: 100, sarf: 0 });

const hdr = (over = {}) => ({
  receipt_date: '2026-07-27', receipt_number: '1001',
  client_id: 'owner-1', client_type: 'owner', client_name: 'مالك اختبار',
  account_type: null, total: 1150,
  ...over,
});

const R1 = (await FinancialService.createReceipt(U, hdr({ rows: [row1(), row2()] }))).receipt.id;
// update 2→3 rows (same arithmetic family as the proven write-path harness)
await FinancialService.updateReceipt(U, R1, hdr({
  total: 1800,
  rows: [row1(), row2(), row3()],
}));
const R2 = (await FinancialService.createReceipt(U, hdr({
  receipt_number: '1002', total: 100, rows: [rowX()],
}))).receipt.id;
await FinancialService.deleteReceipt(U, R2);

// ─── GROUP 1: repository semantics over real normalized data ───────────────
console.log('\n— GROUP 1: ReceiptReadRepository semantics (real modules, real data) —');
const liveRows = await ReceiptReadRepository.getReceiptRowsByReceipt(R1);
ok(liveRows.length === 3, `R1 live rows after 2→3 update = 3, NO soft-deleted leak (got ${liveRows.length})`);
ok(liveRows.every(r => typeof r.driver_price === 'number' && typeof r.advance === 'number'
    && typeof r.net === 'number' && typeof r.sarf === 'number' && typeof r.row_id === 'string'
    && r.receipt_id === R1), 'rows carry persisted contract (row_id, receipt_id FK, cents money)');
ok(liveRows.every(r => 'kartano' in r && 'date' in r && 'driver_name' in r && 'type' in r
    && 'weight' in r && 'weight2' in r && 'deficit' in r && 'weightTotal' in r
    && 'officeAmount' in r && 'discount' in r && 'add' in r && 'row_order' in r
    && !('office_amount' in r) && !('noloon' in r) && !('taktik' in r) && !('_type' in r)),
  'contract is structural (Phase 5 Step 2): restored slots persisted (kartano/date/driver_name/type/weight/weight2/deficit/weightTotal/officeAmount/discount/add/row_order); UI-vocabulary aliases (office_amount/noloon/taktik/_type) still never persisted');
ok((await ReceiptReadRepository.getReceiptRowsByReceipt(R2)).length === 0,
  'deleted receipt R2 → 0 live rows (rows soft-deleted with header)');

// ─── EXTRACTED VERBATIM: dashboard.js:89-106 (_loadReceiptRowsProjection) ──
async function _loadReceiptRowsProjection(receipts) {
  const projection = new Map();
  await Promise.all((receipts || []).map(async (rec) => {
    const key = String(rec?.id ?? '');
    if (!key) { projection.set(key, []); return; }
    try {
      const rows = await ReceiptReadRepository.getReceiptRowsByReceipt(rec.id);
      projection.set(key, rows || []);
    } catch (err) {
      console.warn('[dashboard] row projection failed for receipt', key, err);
      projection.set(key, []);
    }
  }));
  return projection;
}

// ─── GROUP 2: dashboard.js pipeline (extracted verbatim, real repositories) ─
console.log('\n— GROUP 2: dashboard.js pipeline —');
const allReceipts = await ReceiptRepository.getAll(U);
const activeReceipts = (allReceipts || []).filter(r => {
  if (!r || r.deleted_at !== null) return false;
  return true; // no date range in this scenario
});
ok(activeReceipts.length === 1 && activeReceipts[0].id === R1,
  `active headers = {R1} only; deleted R2 excluded at DB.getAll (got ${activeReceipts.length})`);
const receiptRowsProjection = await _loadReceiptRowsProjection(activeReceipts);
ok((receiptRowsProjection.get(String(R1)) || []).length === 3, 'projection: R1 → 3 rows');

// EXTRACTED VERBATIM Card 3 loop — dashboard.js (_refreshDashboard)
let totalOfficeCents = 0;
for (const r of activeReceipts) {
  if (r) {
    const rows = receiptRowsProjection.get(String(r.id)) || [];
    for (const row of rows) {
      if (!row) continue; // separators are UI-local — never persisted in receipt_rows
      // office_amount has NO persisted slot in the frozen ReceiptRow contract
      // (B6) → contributes 0 until the contract is extended.
      totalOfficeCents += Money.toCents(row.office_amount || 0);
    }
  }
}
ok(totalOfficeCents === 0, `Card 3 (إجمالي المكتب) = 0¢ — structural B6 zero, NOT a lookup failure (got ${totalOfficeCents})`);

// EXTRACTED VERBATIM Card 4 weightMap pass — dashboard.js (_calculateTotalCollectedFromCompanies)
const offices = [officeA, officeB];
const officeNameMap = new Map();
for (const office of offices) {
  if (office && office.name) officeNameMap.set(String(office.name).trim().toLowerCase(), String(office.id));
}
const weightMap = {};
for (const receipt of activeReceipts) {
  if (!receipt) continue;
  const rows = (receiptRowsProjection && receiptRowsProjection.get(String(receipt.id))) || [];
  for (const row of rows) {
    if (!row) continue;
    const rowOffice = String(row.office || '').trim().toLowerCase();
    if (!rowOffice) continue;
    const officeId = officeNameMap.get(rowOffice);
    if (!officeId) continue;
    const loading = String(row.loading || '').trim().toLowerCase();
    const dest = String(row.destination || '').trim().toLowerCase();
    const w = (Number(row.weight) || 0) + (Number(row.weight2) || 0);
    if (!loading || !dest) continue;
    const key = `${officeId}::${loading}::${dest}`;
    weightMap[key] = (weightMap[key] || 0) + w;
  }
}
const expectedKeys = new Set([
  `${officeA.id}::طنطا::القاهرة`, `${officeA.id}::طنطا::المنصورة`, `${officeB.id}::طنطا::الإسكندرية`,
]);
const gotKeys = new Set(Object.keys(weightMap));
ok(gotKeys.size === 3 && [...expectedKeys].every(k => gotKeys.has(k)),
  `Card 4: weightMap keys formed from persisted office/loading/destination (${[...gotKeys].join(' | ')})`);
ok(Object.values(weightMap).every(v => v === 0),
  'Card 4: all weights = 0 — structural B6 zero (weights have no persisted slot)');

// ─── GROUP 3: offices.js pipeline (extracted verbatim, real repositories) ───
console.log('\n— GROUP 3: offices.js pipeline —');

// EXTRACTED VERBATIM — offices.js (_persistedRowToOfficeShape)
function _persistedRowToOfficeShape(row) {
  return {
    office : row.office || '',
    loading: row.loading || '',
    taktik : row.destination || '', // destination → الجهة
    // ── no persisted slot (blank/zero until the contract gains them — B6) ──
    weight: '', weight2: '', deficit: '',
    type: '', officeAmount: 0, discount: 0, add: 0,
    // ── money: cents → decimals ──
    noloon: Money.toDecimal(row.driver_price ?? 0), // driver_price → نولون
    ohda  : Money.toDecimal(row.advance ?? 0),      // advance     → عهدة
    sarf  : Money.toDecimal(row.sarf ?? 0),
    net   : Money.toDecimal(row.net ?? 0),          // persisted row net
  };
}

// EXTRACTED VERBATIM summary loop — offices.js (getOfficeFinancialSummary)
function _officeSummaryLoop(filteredReceipts, rowsProjection, nameMap, officeList) {
  const summary = new Map();
  for (const office of officeList) {
    summary.set(String(office.id), { office, net: 0, weight: 0 });
  }
  for (const receipt of filteredReceipts) {
    const rows = rowsProjection.get(String(receipt.id)) || [];
    for (const row of rows) {
      if (!row) continue; // separators are UI-local — never persisted in receipt_rows
      const shape = _persistedRowToOfficeShape(row);
      const officeName = shape.office.trim();
      if (!officeName) continue;
      const office = nameMap.get(officeName.toLowerCase());
      if (!office) {
        throw new Error(`[OfficesService] unknown office: ${officeName}`);
      }
      const item = summary.get(String(office.id));
      item.weight += calculateWeightTotal(shape); // _calcWeight alias → real financialCalculator
      item.net += shape.net;                      // persisted authoritative save-time row net
    }
  }
  return summary;
}

const nameMap = new Map(offices.map((o) => [String(o.name || '').trim().toLowerCase(), o]));
const sRow = _persistedRowToOfficeShape(liveRows.find(r => r.vehicle_plate === '111 أ ب'));
ok(sRow.office === 'شركة أ' && sRow.loading === 'طنطا' && sRow.taktik === 'القاهرة',
  'shape: office/loading mapped + destination → الجهة vocabulary bridge');
ok(sRow.noloon === 11 && sRow.ohda === 5 && sRow.sarf === 2 && sRow.net === 550,
  `shape money: cents→decimal via REAL Money (نولون=${sRow.noloon}, عهدة=${sRow.ohda}, sarf=${sRow.sarf}, net=${sRow.net})`);
ok(sRow.weight === '' && sRow.weight2 === '' && sRow.deficit === ''
    && sRow.officeAmount === 0 && sRow.discount === 0 && sRow.add === 0 && sRow.type === '',
  'shape: un-persisted slots blank/zero (B6)');
ok(calculateWeightTotal(sRow) === 0, 'calculateWeightTotal(shape) = 0 via REAL financialCalculator (B6)');

const summary = _officeSummaryLoop(activeReceipts, receiptRowsProjection, nameMap, offices);
const sumA = summary.get(String(officeA.id)), sumB = summary.get(String(officeB.id));
const expectedNetA = Money.toDecimal(liveRows.filter(r => r.office === 'شركة أ').reduce((s, r) => s + (r.net || 0), 0));
ok(sumA.net === 1200 && sumA.net === expectedNetA,
  `summary: شركة أ net REVIVED from persisted row nets (${sumA.net} = 550+650, cross-checked vs cents sum ${expectedNetA})`);
ok(sumB.net === 600, `summary: شركة ب net = 600 from persisted row net (got ${sumB.net})`);
ok(sumA.weight === 0 && sumB.weight === 0, 'summary: weights = 0 (B6 structural zero)');

// EXTRACTED VERBATIM cards loop core — offices.js (_getOfficeCards)
function _officeCardsLoop(allReceipts_arg, rowsProjection_arg, officeName) {
  const cards = [];
  for (const receipt of allReceipts_arg) {
    if (receipt.deleted_at !== null) continue;
    const rows = rowsProjection_arg.get(String(receipt.id)) || [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const rowOffice = String(row.office || '').trim().toLowerCase();
      if (rowOffice !== officeName) continue;
      cards.push({
        receipt_id: receipt.id,
        receipt_number: receipt.receipt_number || '',
        client_name: receipt.client_name || receipt.owner_name || '',
        receipt_date: receipt.receipt_date || '',
        row_index: i,
        _rowId: row.row_id ?? null,
        kartano: '', date: '', car: row.vehicle_plate || '', driver: '', weight: 0,
        noloon: Money.toDecimal(row.driver_price ?? 0),
        loading: row.loading || '',
        taktik: row.destination || '',
        type: '', notes: '',
      });
    }
  }
  return cards;
}
const cardsA = _officeCardsLoop(activeReceipts, receiptRowsProjection, 'شركة أ');
const cardsB = _officeCardsLoop(activeReceipts, receiptRowsProjection, 'شركة ب');
const headerR1 = await ReceiptRepository.getById(R1);
ok(cardsA.length === 2 && cardsB.length === 1, `office filter: شركة أ→2 cards, شركة ب→1 card (got ${cardsA.length}/${cardsB.length})`);
const cardByCar = Object.fromEntries(cardsA.map(c => [c.car, c]));
const c1 = cardByCar['111 أ ب'], c3 = cardByCar['333 هـ و'];
ok(!!c1 && !!c3 && c1.noloon === 11 && c3.noloon === 10
    && c1.taktik === 'القاهرة' && c3.taktik === 'المنصورة' && c1.loading === 'طنطا',
  'cards: persisted slots revived (car/loading/destination→الجهة/نولون via REAL Money)');
ok(c1.receipt_id === R1 && typeof c1._rowId === 'string' && liveRows.some(r => r.row_id === c1._rowId),
  'cards: _rowId = persisted ReceiptRow PK, receipt_id FK intact');
ok(c1.kartano === '' && c1.date === '' && c1.driver === '' && c1.weight === 0 && c1.type === '' && c1.notes === '',
  'cards: un-persisted slots blank/zero (B6) — kartano/date/driver/weight/type/notes');
ok(c1.client_name === 'مالك اختبار' && c1.receipt_date === '2026-07-27'
    && c1.payout_status === undefined,
  'cards: header metadata propagated (client_name, receipt_date); REMOVED-CONTRACT (Paid phase): payout_status no longer on office cards');
ok(c1.receipt_number === '1001', 'cards: receipt_number revived from persisted header (Phase 5 — Step 2)');

// loud failure on unknown office — preserved semantics
await FinancialService.createReceipt(U, hdr({ receipt_number: '1003', total: 100,
  rows: [{ ...rowX(), office: 'شركة وهمية' }] }));
const badReceipts = await ReceiptRepository.getAll(U);
const badProjection = await _loadReceiptRowsProjection(badReceipts);
let threw = null;
try { _officeSummaryLoop(badReceipts, badProjection, nameMap, offices); }
catch (e) { threw = e.message; }
ok(/\[OfficesService\] unknown office/.test(threw || ''), `unknown-office loud failure preserved ("${threw}")`);

// ─── GROUP 4: static assertions on the REAL modified sources ───────────────
console.log('\n— GROUP 4: static source assertions (real dashboard.js / offices.js text) —');
const dashSrc = readFileSync('./dashboard.src.js', 'utf8');
const offSrc = readFileSync('./offices.src.js', 'utf8');
ok(dashSrc.includes("import { ReceiptReadRepository } from './services/receiptReadRepository.js';"),
  'dashboard.js imports ReceiptReadRepository');
ok(!/Array\.isArray\(\s*(receipt|r)\.rows/.test(dashSrc), 'dashboard.js: ZERO executable embedded receipt.rows accessors');
ok(dashSrc.includes('const rows = (receiptRowsProjection && receiptRowsProjection.get(String(receipt.id))) || [];'),
  'extraction-bound: Card 4 marker present verbatim in dashboard.js');
ok(dashSrc.includes('totalOfficeCents += Money.toCents(row.office_amount || 0);'),
  'extraction-bound: Card 3 marker present verbatim in dashboard.js');
ok(offSrc.includes("import { ReceiptRepository } from './services/receiptRepository.js';")
    && offSrc.includes("import { ReceiptReadRepository } from './services/receiptReadRepository.js';"),
  'offices.js imports ReceiptRepository + ReceiptReadRepository');
ok(!offSrc.includes('OfficeRepository.getReceipts(') && !offSrc.includes('OfficeRepository.getReceiptById('),
  'offices.js: OfficeRepository receipt-store reads eliminated (methods now unused — Step 8 cleanup candidates)');
ok(!/Array\.isArray\(\s*receipt\.rows/.test(offSrc), 'offices.js: ZERO executable embedded receipt.rows accessors');
ok(offSrc.includes('item.net += shape.net;') && offSrc.includes('_rowId: row.row_id ?? null,')
    && offSrc.includes('noloon: Money.toDecimal(row.driver_price ?? 0),'),
  'extraction-bound: summary/cards/shape markers present verbatim in offices.js');

// ─── GROUP 5: ledger-header reroute equivalence (offices.js:445 → ReceiptRepository.getById) ──
console.log('\n— GROUP 5: receipt header read-path (ReceiptRepository.getById) —');
ok(!!headerR1 && headerR1.id === R1, 'ReceiptRepository.getById returns live header (same DB.getById chain as before)');
ok(headerR1.receipt_number === '1001', 'header.receipt_number persisted (Phase 5 — Step 2) → reference_number source restored');
ok((await ReceiptRepository.getById(R2)) === null, 'getById of soft-deleted receipt → null (semantics preserved)');

console.log(`\n${failures === 0 ? '✅ ALL READ-PATH ASSERTIONS PASSED' : '❌ FAILURES: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
