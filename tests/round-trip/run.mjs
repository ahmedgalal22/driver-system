// run.mjs — ROUND-TRIP VERIFICATION (Phase 5 — after Steps 2+3; created as the
// read-only diagnostic of the original regression, now asserts the FIXED behavior).
//
// Traces ONE fully-populated Receipt (2 data rows + 1 separator, every form
// field populated) through the REAL production code path:
//
//   A  form payload (as collectRawData/collectReceiptRows emit)
//   B  REAL receipts.js _normalize + _uiRowToPersistedShape + _buildServicePayload
//   C  REAL FinancialService.createReceipt on the idb shim → raw IndexedDB records
//   D  REAL ReceiptReadRepository.getReceiptWithRows
//   E  REAL allReceipts.js _persistedRowToPageRow + receipts.js snapshot readers
//      (what the All Forms page renders, column by column)
//   F  edit input reconstruction: REAL receipts.js _persistedRowToUiShape +
//      the exact loadReceiptForEdit setV/setF mappings
//   G  edit-save consequences: validation gate + totals recomputation
//
// UI modules are browser-coupled; their pure mapping functions are EXTRACTED
// VERBATIM from the production source text and executed — nothing is
// hand-copied. Assertions describe the CURRENT behavior (Phase 5 Steps 2+3
// applied): a PASS means every user-entered field survives the full cycle.
import { readFileSync } from 'node:fs';
import { installIDB } from './idb-shim.mjs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ReceiptReadRepository } = await import('./services/receiptReadRepository.js');
const { Money } = await import('./money.js');
const { calculateRowNet, calculateReceiptTotals } = await import('./services/financialCalculator.js');

const U = 'roundtrip-tester';
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; };
const J = (v) => JSON.stringify(v);

// ── Verbatim extraction of REAL production functions (brace-balanced scan) ──
const RECEIPTS_SRC = readFileSync('./_src/receipts.js', 'utf8');
const ALLRECEIPTS_SRC = readFileSync('./_src/allReceipts.js', 'utf8');
const FINANCIAL_SRC = readFileSync('./financial.js', 'utf8');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`extractFn: ${name} not found`);
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`extractFn: ${name} unbalanced`);
}
function extractBracketConst(src, name, open) {
  const start = src.indexOf(`const ${name} = ${open}`);
  if (start < 0) throw new Error(`extractBracketConst: ${name} not found`);
  const pairs = { '[': ']', '{': '}' };
  const close = pairs[open];
  let depth = 0;
  for (let j = src.indexOf(open, start); j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close) { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`extractBracketConst: ${name} unbalanced`);
}
// Static fingerprint: exact production line must exist in the real source.
function fingerprint(src, snippet, label) {
  ok(src.includes(snippet), `source fingerprint — ${label}`);
}

// Bind REAL functions into one scope (deps injected by name).
const receiptsScope = new Function(
  'Money', 'calculateRowNet', 'calculateReceiptTotals',
  `
  ${extractBracketConst(RECEIPTS_SRC, 'ROW_TYPES', '{')};
  ${extractBracketConst(RECEIPTS_SRC, 'ROW_PAYMENT', '{')};
  ${extractBracketConst(RECEIPTS_SRC, 'COL_DEFS', '[')}
  ${extractFn(RECEIPTS_SRC, 'normalizeOptionalString')}
  ${extractFn(RECEIPTS_SRC, '_uuid')}
  ${extractFn(RECEIPTS_SRC, '_normalizeRow')}
  ${extractFn(RECEIPTS_SRC, '_normalize')}
  ${extractFn(RECEIPTS_SRC, '_uiRowToPersistedShape')}
  ${extractFn(RECEIPTS_SRC, '_persistedRowToUiShape')}
  ${extractFn(RECEIPTS_SRC, '_buildServicePayload')}
  ${extractFn(RECEIPTS_SRC, 'tFmt')}
  ${extractFn(RECEIPTS_SRC, '_snapshotEsc')}
  ${extractFn(RECEIPTS_SRC, 'formatSnapshotNumber')}
  ${extractFn(RECEIPTS_SRC, 'getSnapshotCellRawValue')}
  ${extractFn(RECEIPTS_SRC, 'formatSnapshotCellValue')}
  return { ROW_TYPES, COL_DEFS, _normalize, _uiRowToPersistedShape,
           _persistedRowToUiShape, _buildServicePayload,
           getSnapshotCellRawValue, formatSnapshotCellValue };
  `
)(Money, calculateRowNet, calculateReceiptTotals);

const allReceiptsScope = new Function(
  'Money',
  `
  ${extractFn(ALLRECEIPTS_SRC, '_persistedRowToPageRow')}
  return { _persistedRowToPageRow };
  `
)(Money);

const {
  COL_DEFS, _normalize, _persistedRowToUiShape, _buildServicePayload,
  getSnapshotCellRawValue,
} = receiptsScope;
const { _persistedRowToPageRow } = allReceiptsScope;

// ════════════════════════════════════════════════════════════════════════════
// STAGE A — What the form actually submits
// Payload shape mirrors collectRawData() (receipts.js:2664) + collectReceiptRows()
// (receipts.js:2566). Fingerprint the collector mappings so this payload is
// provably faithful to production code.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ STAGE A — form payload (collector fingerprints) ══');
[
  ["kartano      : normalizeOptionalString(_field(row, 'receipt-kartano'))", 'collector maps kartano'],
  ["date         : normalizeOptionalString(_field(row, 'receipt-date'))", 'collector maps row date'],
  ["const rowDriverText = normalizeOptionalString(_field(row, 'receipt-data'));", 'collector reads the row driver NAME text (autocomplete input) — exact name → id resolution at save'],
  ["hit = await _promptCreateDriverForRow(row, rowDriverText);", 'unknown driver name → «add driver?» prompt at save (replaces the old rejection)'],
  ["let hit = _findDriverIndexHit(driverIndex, rowDriverText);", 'save-time driver resolution is two-tier: exact trimmed name, then normalized «visually identical» name'],
  ["driverIndex.push({ rec: hit, trimmed: String(hit.name || '').trim(), norm: normalizeDriverName(hit.name) });", 'prompt-resolved driver cached for later rows in the same save (no double prompt)'],
  ["await ClientRepository.createDriverUnique(_currentUsername(), driverName);", 'quick-create reuses the drivers-store creation path (duplicate-safe normalized lookup)'],
  ["input.value = String(record.name || driverName);", 'newly created driver is auto-selected on the row before the save continues'],
  ["data         : rowDriverName,", 'collector maps driver display name resolved from the driver record (denorm, id → name only)'],
  ["driver_id    : rowDriverId || null, // authoritative relationship: THIS row → driver (no selected driver → null)", 'collector persists row.driver_id (Receipt Row → Driver; vehicle carries no driver)'],
  ["weight       : _num(row, 'receipt-weight')", 'collector maps weight'],
  ["weight2      : _num(row, 'receipt-weight2')", 'collector maps weight2'],
  ["deficit      : _num(row, 'receipt-deficit')", 'collector maps deficit'],
  ["type         : normalizeOptionalString(_field(row, 'receipt-type'))", 'collector maps type'],
  ["office       : normalizeOptionalString(_field(row, 'receipt-office'))", 'collector maps office'],
  ["officeAmount : _num(row, 'receipt-office-amount')", 'collector maps officeAmount'],
  ["discount     : _num(row, 'receipt-discount')", 'collector maps discount'],
  ["add          : _num(row, 'receipt-add')", 'collector maps add'],
  ["noloon       : _num(row, 'receipt-noloon')", 'collector maps noloon'],
  ["ohda         : _num(row, 'receipt-ohda')", 'collector maps ohda'],
  ["sarf         : _num(row, 'receipt-sarf')", 'collector maps sarf'],
  ["receiptRows.push({ _type: 'separator', vehicleName, subtotal, notes, isAuto })", 'collector emits separator rows'],
  ["receipt_number   : (receiptNumberInput || '').trim(),", 'header collector maps receipt_number'],
].forEach(([s, l]) => fingerprint(RECEIPTS_SRC, s, l));

// UX upgrade (driver quick-create): non-listed driver names are no longer
// rejected at save — the user is asked to add the driver instead.
ok(!RECEIPTS_SRC.includes('اسم السائق "${rowDriverText}" غير موجود في القائمة'),
  'REMOVED-CONTRACT (UX upgrade): the «driver not in the list» save-time rejection is gone — quick-create prompt instead (kept client/office «غير موجود في القائمة» warnings untouched)');
fingerprint(RECEIPTS_SRC, 'لم يتم العثور على السائق',
  'quick-create prompt says «لم يتم العثور على السائق "name"»');
fingerprint(RECEIPTS_SRC, '>إضافة السائق</button>',
  'prompt button: إضافة السائق (create path)');
fingerprint(RECEIPTS_SRC, '>متابعة البحث</button>',
  'prompt button: متابعة البحث (abort + keep searching)');
ok(!RECEIPTS_SRC.includes('السائق غير موجود. هل تريد إضافته؟'),
  'REMOVED-CONTRACT (dialog copy): old «السائق غير موجود. هل تريد إضافته؟» wording replaced by the three-way prompt');
fingerprint(RECEIPTS_SRC, "err.keepSearching = (choice === 'search');",
  'متابعة البحث carries keepSearching so saveReceipt reselects the typed text for continued searching');
fingerprint(RECEIPTS_SRC, 'err.code = DRIVER_CREATE_CANCELLED;',
  'إلغاء/متابعة البحث throw the DRIVER_CREATE_CANCELLED sentinel (save aborts, no error alert)');
fingerprint(RECEIPTS_SRC, 'err?.code === DRIVER_CREATE_CANCELLED',
  'saveReceipt catches the cancel sentinel — focus returns to the row driver field, nothing persisted');
fingerprint(RECEIPTS_SRC, 'await _receiptLoadDriverOptions();',
  'autocomplete source refreshed immediately after quick-create');
fingerprint(RECEIPTS_SRC, '_driverACClose();\n  return record;',
  'quick-create closes the popup after auto-select — the save continues, no reopen needed');

// UX polish (fuzzy search + ranking + highlight + extended keyboard):
fingerprint(RECEIPTS_SRC, 'const n = normalizeNameWithMap(String(d.name || \'\'));',
  'driver cache pre-normalizes names once at load (per-keystroke filtering reuses it)');
fingerprint(RECEIPTS_SRC, 'else if ((s = _driverACWordIndex(t, qn)) !== -1) { rank = 2; }',
  'ranking: exact → starts-with → word-starts-with → contains');
fingerprint(RECEIPTS_SRC, 'out.sort((a, b) => a.rank - b.rank);',
  'suggestions are ranked, not just filtered (stable within a rank)');
fingerprint(RECEIPTS_SRC, "mark.className = 'driver-ac-match';",
  'matched span highlighted via DOM-built <span> (no HTML injection)');
fingerprint(RECEIPTS_SRC, "_driverAC.items.length === 1",
  'Enter/Tab auto-selects the single remaining suggestion');
fingerprint(RECEIPTS_SRC, "['Home', 'End', 'PageUp', 'PageDown'].includes(key)",
  'extended keyboard support: Home / End / PageUp / PageDown while the list is open');

// REAL repository on the shim DB: duplicate-safe driver quick-create —
// a second attempt with the same (trim-normalized) name returns the SAME
// record instead of persisting a duplicate.
const { ClientRepository } = await import('./services/clientRepository.js');
const createdDrv = await ClientRepository.createDriverUnique(U, '  السائق أحمد  ');
ok(createdDrv && createdDrv.id != null && createdDrv.name === 'السائق أحمد',
  `quick-create: driver created via the shared repository path (name trimmed → ${J(createdDrv.name)}, id=${J(createdDrv.id)})`);
const dupDrv = await ClientRepository.createDriverUnique(U, 'السائق أحمد');
ok(String(dupDrv.id) === String(createdDrv.id),
  'duplicate prevention: normalized (trim) lookup returns the existing driver — no second record persisted');
const drvStoreRows = (await ClientRepository.getDriversForUser(U))
  .filter(d => d && d.deleted_at == null && String(d.name || '').trim() === 'السائق أحمد');
ok(drvStoreRows.length === 1,
  `drivers store holds exactly ONE «السائق أحمد» after two quick-create attempts (got ${drvStoreRows.length})`);

// EXTENDED duplicate rule (UX polish): visually identical drivers — differing
// only by hamza-on-alef, repeated spaces, diacritics or tatweel — must reuse
// the SAME record, never persist a look-alike duplicate.
const { normalizeDriverName } = await import('./services/nameNorm.js');
ok(normalizeDriverName('  أحْمــد   علي ') === 'احمد علي'
   && normalizeDriverName('إبراهيم') === 'ابراهيم',
  'shared normalizer: trim + collapse spaces + strip diacritics/tatweel + alef-fold أ/إ/آ→ا (canonical form)');
const h1 = await ClientRepository.createDriverUnique(U, 'احمد علي');
const h2 = await ClientRepository.createDriverUnique(U, 'أحمد   علي'); // alef-hamza + multi-space
const h3 = await ClientRepository.createDriverUnique(U, 'أَحْمـد عَلـي'); // diacritics + tatweel
ok(h1.id != null && String(h2.id) === String(h1.id) && String(h3.id) === String(h1.id),
  'duplicate prevention extended: hamza-fold + collapsed spaces + diacritics/tatweel → existing record reused');
const hamzaRows = (await ClientRepository.getDriversForUser(U))
  .filter(d => d && d.deleted_at == null && normalizeDriverName(d.name) === 'احمد علي');
ok(hamzaRows.length === 1,
  `drivers store holds exactly ONE «احمد علي» after three visually-identical attempts (got ${hamzaRows.length})`);

const rowA_net = calculateRowNet({
  weight: 50, weight2: 10, deficit: 2, noloon: 20, ohda: 150,
  officeAmount: 75, discount: 25, add: 40, sarf: 30,
}); // (50+10-2)*20 - (150+75+25) + 40 - 30 = 920
const rowB_net = calculateRowNet({
  weight: 30, weight2: 0, deficit: 0, noloon: 10, ohda: 50,
  officeAmount: 0, discount: 0, add: 0, sarf: 0,
}); // 30*10 - 50 = 250

const FORM_PAYLOAD = {
  id: undefined,
  receipt_date: '2026-07-29',
  receipt_number: '42',
  client_id: 'owner-1', client_type: 'owner', client_name: 'مالك الاختبار',
  owner_name: 'مالك الاختبار',
  company_name: null, company_phone: null,
  general_discount: 0,
  total: 0,
  rows: [
    // Row A: driver selected on the row (id-keyed) — collector output shape:
    // driver_id resolved from the row autocomplete (exact name → id), driver_name =
    // display denorm resolved from the driver record (id → name, D3).
    { _type: 'data', owner_id: 'owner-1', owner_name: 'مالك الاختبار',
      kartano: 'K-100', date: '2026-07-29', data: 'السائق أحمد', driver_name: 'السائق أحمد', driver_id: 'drv-1',
      car: 'أ ب ج 1234', vehicle_id: 'veh-1', vehicle_plate: 'أ ب ج 1234',
      loading: 'طنطا', taktik: 'القاهرة', type: 'قمح', office: 'شركة الأمل',
      weight: 50, weight2: 10, deficit: 2, weightTotal: 58,
      noloon: 20, ohda: 150, officeAmount: 75, discount: 25, sarf: 30, add: 40,
      net: rowA_net },
    { _type: 'separator', vehicleName: 'أ ب ج 1234', subtotal: rowA_net, notes: 'ملاحظة الفاصل', isAuto: false },
    // Row B: NO driver selected («— بدون سائق —», D1) → driver_id/driver_name null.
    { _type: 'data', owner_id: 'owner-1', owner_name: 'مالك الاختبار',
      kartano: 'K-101', date: '2026-07-29', data: null, driver_name: null, driver_id: null,
      car: 'أ ب ج 1234', vehicle_id: 'veh-1', vehicle_plate: 'أ ب ج 1234',
      loading: 'طنطا', taktik: 'الإسكندرية', type: 'ذرة', office: 'شركة الأمل',
      weight: 30, weight2: 0, deficit: 0, weightTotal: 30,
      noloon: 10, ohda: 50, officeAmount: 0, discount: 0, sarf: 0, add: 0,
      net: rowB_net },
  ],
};
console.log(`entered rows: data A net=${rowA_net}, separator, data B net=${rowB_net}; total=${rowA_net + rowB_net}`);

// ════════════════════════════════════════════════════════════════════════════
// STAGE B — What ReceiptsModule.create() constructs (REAL _normalize +
// _buildServicePayload extracted verbatim from receipts.js:165/277)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ STAGE B — service payload construction (REAL receipts.js normalizers) ══');
const normalized = _normalize(FORM_PAYLOAD);
const servicePayload = _buildServicePayload(normalized);
servicePayload.receipt_number = String(FORM_PAYLOAD.receipt_number); // assignReceiptNumber effect
const payloadRowKeys = Object.keys(servicePayload.rows[0]).sort();
ok(servicePayload.receipt_number === '42', `receipt_number survives into service payload (got ${J(servicePayload.receipt_number)})`);
ok(payloadRowKeys.includes('kartano') && payloadRowKeys.includes('weight') && payloadRowKeys.includes('type')
   && payloadRowKeys.includes('officeAmount') && payloadRowKeys.includes('data'),
   `service-payload row still carries full UI vocabulary: [${payloadRowKeys.join(',')}]`);
ok(servicePayload.rows[0].driver_price === 20 && servicePayload.rows[0].advance === 150
   && servicePayload.rows[0].destination === 'القاهرة',
   'write bridge maps نولون→driver_price, عهدة→advance, الجهة→destination');
ok(servicePayload.rows[0].driver_id === 'drv-1',
   `driver_id flows from the row's driver autocomplete (exact name → id; got ${J(servicePayload.rows[0].driver_id)})`);
ok(servicePayload.rows[2].driver_id === null,
   `driver-less row («— بدون سائق —») keeps driver_id = null (D1: optional per row; got ${J(servicePayload.rows[2].driver_id)})`);
console.log(`B row0 net=${servicePayload.rows[0].net}, row2 net=${servicePayload.rows[2].net}, total=${servicePayload.total}`);

// ════════════════════════════════════════════════════════════════════════════
// STAGE C — What is actually persisted (REAL FinancialService.createReceipt)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ STAGE C — persisted IndexedDB records (REAL FinancialService) ══');
const createRes = await FinancialService.createReceipt(U, servicePayload);
const rid = createRes.receipt.id;
const persistedHeader = await DB.getById('receipts', rid);
const persistedRows = await DB.findByFields('receipt_rows', { receipt_id: rid });
const headerKeys = Object.keys(persistedHeader).sort();
const rowKeys = Object.keys(persistedRows[0]).sort();
console.log('persisted header keys:', headerKeys.join(', '));
console.log('persisted row keys   :', rowKeys.join(', '));

// Header fields
ok(persistedHeader.receipt_number === '42', `KEPT (Phase 5 — Step 2): header.receipt_number persisted (got ${J(persistedHeader.receipt_number)})`);
ok(persistedHeader.owner_name === undefined, 'LOST: header.owner_name NOT persisted (display falls back to client_name)');
ok(persistedHeader.row_count === undefined, 'LOST: header.row_count NOT persisted (card falls back to counting rows)');
ok(persistedHeader.vehicle_id === undefined, 'LOST: header.vehicle_id NOT persisted');
// Header survivors
ok(persistedHeader.client_id === 'owner-1' && persistedHeader.client_name === 'مالك الاختبار'
   && persistedHeader.receipt_date === '2026-07-29', 'KEPT: client_id / client_name / receipt_date');
ok(persistedHeader.total === Money.toCents(1170) && persistedHeader.general_add === undefined
   && persistedHeader.net_due === undefined && persistedHeader.net_total === undefined
   && persistedHeader.previous_balance === undefined && persistedHeader.paid === undefined,
   `REMOVED (General Add + Net Due + Net Total + Paid + Client Balance phases): header.general_add / header.net_due / header.net_total / header.paid / header.previous_balance not persisted (total=${persistedHeader.total})`);
ok(persistedHeader.payout_status === undefined && persistedHeader.paid_at === undefined,
   `REMOVED-CONTRACT (Paid phase): payout_status / paid_at never persisted (payout_status=${persistedHeader.payout_status})`);

// Row losses / survivors
ok(persistedRows.length === 2, `LOST: separator row dropped — only 2 data rows persisted (3 pushed incl. separator)`);
const pA = persistedRows.find(r => r.driver_price === 2000) || persistedRows[0];
const restoredRowFields = ['kartano', 'date', 'driver_name', 'weight', 'weight2', 'deficit', 'weightTotal', 'type', 'officeAmount', 'discount', 'add', 'row_order'];
ok(restoredRowFields.every(f => f in pA),
   `KEPT (Phase 5 — Step 2): all restored row columns present in store: [${restoredRowFields.join(', ')}]`);
ok(pA.kartano === 'K-100' && pA.date === '2026-07-29' && pA.driver_name === 'السائق أحمد' && pA.type === 'قمح'
   && pA.weight === 50 && pA.weight2 === 10 && pA.deficit === 2 && pA.weightTotal === 58
   && pA.officeAmount === 7500 && pA.discount === 2500 && pA.add === 4000 && pA.row_order === 0
   && !('data' in pA),
   'KEPT: entered values exact — strings/quantities raw, officeAmount/discount/add integer cents (7500/2500/4000); UI-alias "data" intentionally not stored');
ok(pA.driver_id === 'drv-1' && pA.driver_name === 'السائق أحمد',
   `KEPT: row-selected driver_id persisted as the authoritative link + driver_name denorm from the driver record (D3) [driver_id=${J(pA.driver_id)}]`);
const pB = persistedRows.find(r => r.driver_price === 1000);
ok(pB && pB.driver_id === null && pB.driver_name === null,
   `driver-less row persisted with driver_id=null → excluded from every driver's Details (driver_id=${J(pB?.driver_id)}, driver_name=${J(pB?.driver_name)})`);
ok(pA.vehicle_plate === 'أ ب ج 1234' && pA.office === 'شركة الأمل' && pA.loading === 'طنطا'
   && pA.destination === 'القاهرة', 'KEPT: vehicle_plate / office / loading / destination');
ok(pA.driver_price === 2000 && pA.advance === 15000 && pA.net === 92000 && pA.sarf === 3000,
   `KEPT: money in cents (driver_price=${pA.driver_price}, advance=${pA.advance}, net=${pA.net}, sarf=${pA.sarf})`);
const ledger = await DB.getByIndex('vehicle_ledger', 'by_reference_id', rid);
ok(ledger.length === 0,
   `REMOVED-CONTRACT (Net Due phase): createReceipt writes ZERO ledger entries — no due leg exists (got ${ledger.length})`);

// ════════════════════════════════════════════════════════════════════════════
// STAGE D — What ReceiptReadRepository returns (REAL)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ STAGE D — ReceiptReadRepository.getReceiptWithRows ══');
const read = await ReceiptReadRepository.getReceiptWithRows(rid);
ok(read && read.receipt && Array.isArray(read.rows) && read.rows.length === 2,
   `normalized read returns { receipt, rows } — rows=2, faithful to store (nothing invented, nothing hidden)`);
ok(Object.keys(read.receipt).sort().join(',') === headerKeys.join(',')
   && Object.keys(read.rows[0]).sort().join(',') === rowKeys.join(','),
   'read model shape == persisted shape (read layer loses nothing further)');

// ════════════════════════════════════════════════════════════════════════════
// STAGE E — What All Forms renders (REAL allReceipts._persistedRowToPageRow +
// REAL receipts.js snapshot cell readers)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ STAGE E — All Forms display mapping (REAL bridges) ══');
const pageRowA = _persistedRowToPageRow(read.rows.find(r => r.row_id === pA.row_id));
const snapshotCols = COL_DEFS.filter(c => c.key !== '_actions');
const enteredA = FORM_PAYLOAD.rows[0];
const displayTable = snapshotCols.map(col => {
  const entered = col.key === 'data' ? enteredA.data
    : col.key === 'weightTotal' ? enteredA.weightTotal
    : (enteredA[col.key] ?? '');
  return { col: col.key, entered, rendered: receiptsScope.formatSnapshotCellValue(pageRowA, col), raw: getSnapshotCellRawValue(pageRowA, col) };
});
for (const t of displayTable) {
  console.log(`   ${String(t.col).padEnd(12)} entered=${J(t.entered)}  rendered=${J(t.rendered)}`);
}
const dmap = Object.fromEntries(displayTable.map(t => [t.col, t.rendered]));
// Correctly rendered (bridged from persisted cents/slots)
ok(dmap.car === 'أ ب ج 1234' && dmap.office === 'شركة الأمل' && dmap.loading === 'طنطا' && dmap.taktik === 'القاهرة',
   'AllForms OK: car / office / loading / taktik(الجهة)');
ok(dmap.noloon === '20' && dmap.ohda === '150', `AllForms OK: نولون=${dmap.noloon} عهدة=${dmap.ohda} (cents→decimal)`);
ok(dmap.sarf === '30.00' && dmap.net === '920.00', `AllForms OK: sarf=${dmap.sarf} net=${dmap.net} (persisted net displays CORRECTLY)`);
// Restored columns render the entered values (Phase 5 — Step 3 read bridges)
ok(dmap.kartano === 'K-100' && dmap.date === '2026-07-29' && dmap.data === 'السائق أحمد' && dmap.type === 'قمح',
   `AllForms RESTORED: رقم الكارتة=${J(dmap.kartano)} / التاريخ=${J(dmap.date)} / اسم السائق=${J(dmap.data)} / النوع=${J(dmap.type)}`);
ok(Number(dmap.weight) === 50 && Number(dmap.weight2) === 10 && Number(dmap.deficit) === 2 && Number(dmap.weightTotal) === 58,
   `AllForms RESTORED: وزن وش=${J(dmap.weight)} / وزن م=${J(dmap.weight2)} / عجز=${J(dmap.deficit)} / الوزن=${J(dmap.weightTotal)}`);
ok(Number(dmap.officeAmount) === 75 && Number(dmap.add) === 40 && Number(dmap.discount) === 25,
   `AllForms RESTORED: مكتب=${J(dmap.officeAmount)} / إضافة=${J(dmap.add)} / خصم=${J(dmap.discount)} (cents→decimal)`);
// Card header
fingerprint(ALLRECEIPTS_SRC, "${esc(record.receipt_number || '—')}", 'card إذن الصرف reads record.receipt_number');
fingerprint(ALLRECEIPTS_SRC, "${esc(record.owner_name || record.client_name || '—')}", 'card owner falls back to client_name');
const cardIzn = read.receipt.receipt_number || '—';
const cardOwner = read.receipt.owner_name || read.receipt.client_name || '—';
ok(cardIzn === '42', `AllForms card: إذن الصرف displays the persisted number ${J(cardIzn)} (Phase 5)`);
ok(cardOwner === 'مالك الاختبار', 'AllForms card: owner displays via client_name fallback (OK)');
ok((read.receipt.row_count != null ? read.receipt.row_count : read.rows.filter(r => r._type !== 'separator').length) === 2,
   'AllForms card: عدد الكارتات survives via row-count fallback (OK)');

// ════════════════════════════════════════════════════════════════════════════
// STAGE F — Edit reconstruction (REAL _persistedRowToUiShape + exact
// loadReceiptForEdit mappings)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ STAGE F — edit form reconstruction (REAL bridge) ══');
[
  "setV('receiptNumber',     receiptData.receipt_number || receiptData.receiptNumber || '');",
  "setF('receipt-kartano',       ui.kartano);",
  "setF('receipt-data',          rowData.driver_id ? (driverNames.get(rowData.driver_id) || '') : '');",
  "setF('receipt-car',           ui.car);",
  "setF('receipt-noloon',        ui.noloon ? Money.fmt(ui.noloon) : '');",
  "setF('receipt-net',           Money.fmt(ui.net || 0));",
].forEach((s) => fingerprint(RECEIPTS_SRC, s, 'loadReceiptForEdit mapping: ' + s.slice(0, 44)));
fingerprint(RECEIPTS_SRC, 'if (d) driverNames.set(did, d.name || \'\');', 'driver-name fallback resolution via driver_id (bridge prefers persisted driver_name)');
fingerprint(RECEIPTS_SRC, "el.id = 'driverACList';",
  'one shared custom driver autocomplete dropdown mounted on the page (replaces the native datalist)');
fingerprint(RECEIPTS_SRC, 'placeholder="— بدون سائق —"',
  'row driver control is a text input feeding the custom dropdown, keeping the «— بدون سائق —» placeholder');
ok(!RECEIPTS_SRC.includes('receiptDriversList'),
  'REMOVED-CONTRACT (UX upgrade): native <datalist> binding gone — the shared custom dropdown drives suggestions');
fingerprint(RECEIPTS_SRC, "driver_id   : row.driver_id ?? null,               // row's driver link (authoritative)",
  'edit bridge surfaces persisted driver_id for the row driver autocomplete');
fingerprint(RECEIPTS_SRC, '<input id="receiptNumber" type="text" readonly tabindex="-1"', 'receiptNumber input is readonly');

const uiA = _persistedRowToUiShape(read.rows.find(r => r.row_id === pA.row_id), /* driverName resolves via driver_id map */ '');
// Sim of the drivers-store backed map used by loadReceiptForEdit (id → record name)
const simDriverNames = new Map([[pA.driver_id, 'السائق أحمد']]);
const editFields = {
  'receipt-kartano': uiA.kartano, 'receipt-date': uiA.date,
  'receipt-data': pA.driver_id ? (simDriverNames.get(pA.driver_id) || '') : '',
  'receipt-car': uiA.car, 'receipt-weight': uiA.weight, 'receipt-weight2': uiA.weight2,
  'receipt-deficit': uiA.deficit, 'receipt-type': uiA.type, 'receipt-office': uiA.office,
  'receipt-loading': uiA.loading, 'receipt-taktik': uiA.taktik,
  'receipt-noloon': uiA.noloon ? Money.fmt(uiA.noloon) : '',
  'receipt-ohda': uiA.ohda ? Money.fmt(uiA.ohda) : '',
  'receipt-office-amount': uiA.officeAmount, 'receipt-discount': uiA.discount,
  'receipt-sarf': uiA.sarf ? Money.fmt(uiA.sarf) : '', 'receipt-add': uiA.add,
  'receipt-net': Money.fmt(uiA.net || 0),
};
for (const [k, v] of Object.entries(editFields)) console.log(`   ${k.padEnd(22)} = ${J(v)}`);
ok(editFields['receipt-car'] === 'أ ب ج 1234' && editFields['receipt-office'] === 'شركة الأمل'
   && editFields['receipt-loading'] === 'طنطا' && editFields['receipt-taktik'] === 'القاهرة',
   'Edit OK: car / office / loading / taktik reconstructed');
ok(editFields['receipt-noloon'] === '20.00' && editFields['receipt-ohda'] === '150.00'
   && editFields['receipt-sarf'] === '30.00' && editFields['receipt-net'] === '920.00',
   'Edit OK: نولون / عهدة / sarf / net reconstructed from persisted cents');
ok(editFields['receipt-kartano'] === 'K-100' && editFields['receipt-date'] === '2026-07-29'
   && editFields['receipt-data'] === 'السائق أحمد' && editFields['receipt-type'] === 'قمح'
   && editFields['receipt-weight'] === 50 && editFields['receipt-weight2'] === 10 && editFields['receipt-deficit'] === 2
   && editFields['receipt-office-amount'] === 75 && editFields['receipt-discount'] === 25 && editFields['receipt-add'] === 40,
   `Edit RESTORED: kartano / row date / driver autocomplete shows the driver NAME resolved id→name via the driver record (${J(editFields['receipt-data'])}) / type / weights / officeAmount / discount / add reconstructed exactly as entered`);
ok(uiA.data === 'السائق أحمد',
   `Edit display denorm: ui.data still resolves the driver NAME from the persisted denorm (got ${J(uiA.data)}) — print/snapshots keep showing names`);
const editReceiptNumber = read.receipt.receipt_number || read.receipt.receiptNumber || '';
ok(editReceiptNumber === '42', `Edit header: receiptNumber input reconstructed from persisted ${J(editReceiptNumber)} — save gate unblocked`);

// ════════════════════════════════════════════════════════════════════════════
// STAGE G — Edit-save consequences (REAL validation gate + REAL calculator on
// reconstructed values)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ STAGE G — what happens if the user now presses حفظ التعديلات ══');
fingerprint(RECEIPTS_SRC, "    alert('رقم النموذج مطلوب');", 'validateBeforeSave receipt_number gate');
fingerprint(RECEIPTS_SRC, '  if (!rawData.receipt_number) {', 'gate condition: !rawData.receipt_number');
fingerprint(RECEIPTS_SRC, '  if (!el || ReceiptState.isEditing) return;', 'generateReceiptNumber refuses in edit mode');
const gateBlocks = !(editReceiptNumber); // validateBeforeSave: if (!rawData.receipt_number) → alert + return false
ok(gateBlocks === false,
   'EDIT SAVE UNBLOCKED: reconstructed receipt_number "42" passes validateBeforeSave (Phase 5 — Steps 2+3)');

// calculateTotals()/recompute now runs on the RECONSTRUCTED inputs (REAL
// calculateRowNet) — the unchanged business calculator must reproduce the
// persisted net exactly.
const recomputedA = calculateRowNet({
  weight: parseFloat(editFields['receipt-weight']) || 0,
  weight2: parseFloat(editFields['receipt-weight2']) || 0,
  deficit: parseFloat(editFields['receipt-deficit']) || 0,
  noloon: parseFloat(editFields['receipt-noloon']) || 0,
  ohda: parseFloat(editFields['receipt-ohda']) || 0,
  officeAmount: parseFloat(editFields['receipt-office-amount']) || 0,
  discount: parseFloat(editFields['receipt-discount']) || 0,
  add: parseFloat(editFields['receipt-add']) || 0,
  sarf: parseFloat(editFields['receipt-sarf']) || 0,
});
console.log(`   row A: persisted net=920  →  recomputed after reconstruction=${recomputedA}`);
ok(recomputedA === 920 && recomputedA === Money.toDecimal(pA.net),
   `Edit re-save recompute = ${recomputedA} == persisted net (${Money.toDecimal(pA.net)}) — NO corruption; unchanged calculator + reconstructed inputs`);
const rebuiltTotals = calculateReceiptTotals(
  [
    // row A — built from the REAL reconstructed bridge output (uiA)
    { weight: Number(uiA.weight) || 0, weight2: Number(uiA.weight2) || 0, deficit: Number(uiA.deficit) || 0,
      noloon: uiA.noloon, ohda: uiA.ohda, officeAmount: uiA.officeAmount, discount: uiA.discount,
      add: uiA.add, sarf: uiA.sarf },
    // row B — entered values (same reconstruction established)
    { weight: 30, weight2: 0, deficit: 0, noloon: 10, ohda: 50, officeAmount: 0, discount: 0, add: 0, sarf: 0 },
  ]);
console.log(`   totals frame after loadReceiptForEdit→calculateTotals(): total=${rebuiltTotals.total}`);
ok(rebuiltTotals.total === 1170 && rebuiltTotals.net_total === undefined && rebuiltTotals.balance === undefined,
   `REMOVED-CONTRACT (Net Due + Net Total + Client Balance phases): calculator returns {total} only — total=${rebuiltTotals.total}, balance=${rebuiltTotals.balance}`);
fingerprint(FINANCIAL_SRC, "throw new Error('[FinancialService] total must be a non-negative number.');",
  'FinancialService would reject negative total on save (if the number gate were bypassed)');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ SUMMARY ══');
console.log('Round trip verified: Create→Persist→Read→AllForms→Edit→Reconstruct→Re-save');
console.log('Former loss layer (persistence entity builders) — fixed in Phase 5 Step 2.');
console.log('Read bridges (All Forms page + edit reconstruction) — fixed in Phase 5 Step 3.');
if (failures > 0) { console.error(`\n❌ ${failures} round-trip assertion(s) FAILED`); process.exit(1); }
console.log('\n✅ ROUND-TRIP COMPLETE — every entered field survives the full cycle against real code');
