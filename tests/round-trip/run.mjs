// run.mjs — ROUND-TRIP DIAGNOSTIC (read-only investigation; NO fix).
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
// hand-copied. Assertions describe the CURRENT (regressed) behavior; a PASS
// means the field-by-field analysis in the report reproduces exactly.
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
// Payload shape mirrors collectRawData() (receipts.js:2653) + collectReceiptRows()
// (receipts.js:2564). Fingerprint the collector mappings so this payload is
// provably faithful to production code.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ STAGE A — form payload (collector fingerprints) ══');
[
  ["kartano      : normalizeOptionalString(_field(row, 'receipt-kartano'))", 'collector maps kartano'],
  ["date         : normalizeOptionalString(_field(row, 'receipt-date'))", 'collector maps row date'],
  ["data         : normalizeOptionalString(_field(row, 'receipt-data'))", 'collector maps driver name (data)'],
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
  previous_balance: 500, general_discount: 0, general_add: 100,
  paid: 0, total: 0, net_due: 0, net_total: 0,
  rows: [
    { _type: 'data', owner_id: 'owner-1', owner_name: 'مالك الاختبار',
      kartano: 'K-100', date: '2026-07-29', data: 'السائق أحمد', driver_name: 'السائق أحمد',
      car: 'أ ب ج 1234', vehicle_id: 'veh-1', vehicle_plate: 'أ ب ج 1234',
      loading: 'طنطا', taktik: 'القاهرة', type: 'قمح', office: 'شركة الأمل',
      weight: 50, weight2: 10, deficit: 2, weightTotal: 58,
      noloon: 20, ohda: 150, officeAmount: 75, discount: 25, sarf: 30, add: 40,
      net: rowA_net },
    { _type: 'separator', vehicleName: 'أ ب ج 1234', subtotal: rowA_net, notes: 'ملاحظة الفاصل', isAuto: false },
    { _type: 'data', owner_id: 'owner-1', owner_name: 'مالك الاختبار',
      kartano: 'K-101', date: '2026-07-29', data: 'السائق أحمد', driver_name: 'السائق أحمد',
      car: 'أ ب ج 1234', vehicle_id: 'veh-1', vehicle_plate: 'أ ب ج 1234',
      loading: 'طنطا', taktik: 'الإسكندرية', type: 'ذرة', office: 'شركة الأمل',
      weight: 30, weight2: 0, deficit: 0, weightTotal: 30,
      noloon: 10, ohda: 50, officeAmount: 0, discount: 0, sarf: 0, add: 0,
      net: rowB_net },
  ],
};
console.log(`entered rows: data A net=${rowA_net}, separator, data B net=${rowB_net}; total=${rowA_net + rowB_net}, general_add=100, prev_balance=500`);

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
ok(servicePayload.rows[0].driver_id === null, `driver_id is null (form collects free-text name, never an id)`);
console.log(`B row0 net=${servicePayload.rows[0].net}, row2 net=${servicePayload.rows[2].net}, total=${servicePayload.total}, net_due=${servicePayload.net_due}, net_total=${servicePayload.net_total}`);

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

// Header losses
ok(persistedHeader.receipt_number === undefined, 'LOST: header.receipt_number NOT persisted (entered "42")');
ok(persistedHeader.owner_name === undefined, 'LOST: header.owner_name NOT persisted (display falls back to client_name)');
ok(persistedHeader.row_count === undefined, 'LOST: header.row_count NOT persisted (card falls back to counting rows)');
ok(persistedHeader.vehicle_id === undefined, 'LOST: header.vehicle_id NOT persisted');
// Header survivors
ok(persistedHeader.client_id === 'owner-1' && persistedHeader.client_name === 'مالك الاختبار'
   && persistedHeader.receipt_date === '2026-07-29', 'KEPT: client_id / client_name / receipt_date');
ok(persistedHeader.total === Money.toCents(1170) && persistedHeader.general_add === Money.toCents(100)
   && persistedHeader.net_due === Money.toCents(1270) && persistedHeader.net_total === Money.toCents(1770)
   && persistedHeader.previous_balance === Money.toCents(500) && persistedHeader.paid === 0,
   `KEPT: header money in cents (total=${persistedHeader.total}, net_due=${persistedHeader.net_due}, net_total=${persistedHeader.net_total})`);
ok(persistedHeader.payout_status === 'unpaid', 'KEPT: payout_status');

// Row losses / survivors
ok(persistedRows.length === 2, `LOST: separator row dropped — only 2 data rows persisted (3 pushed incl. separator)`);
const pA = persistedRows.find(r => r.driver_price === 2000) || persistedRows[0];
const lostRowFields = ['kartano', 'date', 'data', 'driver_name', 'weight', 'weight2', 'deficit', 'weightTotal', 'type', 'officeAmount', 'discount', 'add', 'row_order'];
ok(lostRowFields.every(f => pA[f] === undefined),
   `LOST from every row: ${lostRowFields.join(', ')} (all undefined in store)`);
ok(pA.driver_id === null, 'LOST: driver name — driver_id persisted as null, name never stored on the row');
ok(pA.vehicle_plate === 'أ ب ج 1234' && pA.office === 'شركة الأمل' && pA.loading === 'طنطا'
   && pA.destination === 'القاهرة', 'KEPT: vehicle_plate / office / loading / destination');
ok(pA.driver_price === 2000 && pA.advance === 15000 && pA.net === 92000 && pA.sarf === 3000,
   `KEPT: money in cents (driver_price=${pA.driver_price}, advance=${pA.advance}, net=${pA.net}, sarf=${pA.sarf})`);
const ledger = await DB.getByIndex('vehicle_ledger', 'by_reference_id', rid);
ok(ledger.length === 1 && ledger[0].amount === 127000 && ledger[0].type === 'receipt_due',
   `KEPT: ledger entry (amount=${ledger[0]?.amount}) — NOTE embeds UUID not number (receipt_number lost): ${J(ledger[0]?.note)}`);

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
// Blank despite being entered
ok(dmap.kartano === '' && dmap.date === '' && dmap.data === '' && dmap.type === '',
   'AllForms BLANK (never persisted): رقم الكارتة / التاريخ / اسم السائق / النوع');
ok(dmap.weight === '' && dmap.weight2 === '' && dmap.deficit === '' && dmap.weightTotal === '',
   'AllForms BLANK (never persisted): وزن وش / وزن م / عجز / الوزن');
ok(dmap.officeAmount === '0' && dmap.add === '' && dmap.discount === '',
   `AllForms: officeAmount renders "0", إضافة/خصم blank (never persisted)`);
// Card header
fingerprint(ALLRECEIPTS_SRC, "${esc(record.receipt_number || '—')}", 'card إذن الصرف reads record.receipt_number');
fingerprint(ALLRECEIPTS_SRC, "${esc(record.owner_name || record.client_name || '—')}", 'card owner falls back to client_name');
const cardIzn = read.receipt.receipt_number || '—';
const cardOwner = read.receipt.owner_name || read.receipt.client_name || '—';
ok(cardIzn === '—', `AllForms card: إذن الصرف shows ${J(cardIzn)} although "42" was entered (receipt_number not persisted)`);
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
  "setF('receipt-data',          ui.data);",
  "setF('receipt-car',           ui.car);",
  "setF('receipt-noloon',        ui.noloon ? Money.fmt(ui.noloon) : '');",
  "setF('receipt-net',           Money.fmt(ui.net || 0));",
].forEach((s) => fingerprint(RECEIPTS_SRC, s, 'loadReceiptForEdit mapping: ' + s.slice(0, 44)));
fingerprint(RECEIPTS_SRC, 'if (d) driverNames.set(did, d.name || \'\');', 'driver names resolve ONLY via driver_id');
fingerprint(RECEIPTS_SRC, '<input id="receiptNumber" type="text" readonly tabindex="-1"', 'receiptNumber input is readonly');

const uiA = _persistedRowToUiShape(read.rows.find(r => r.row_id === pA.row_id), /* driverName resolves via driver_id=null → */ '');
const editFields = {
  'receipt-kartano': uiA.kartano, 'receipt-date': uiA.date, 'receipt-data': uiA.data,
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
ok(editFields['receipt-kartano'] === '' && editFields['receipt-date'] === '' && editFields['receipt-data'] === ''
   && editFields['receipt-type'] === '' && editFields['receipt-weight'] === '' && editFields['receipt-office-amount'] === '',
   'Edit BLANK (never persisted): kartano / row date / driver name / type / weights / officeAmount (+discount, add)');
const editReceiptNumber = read.receipt.receipt_number || read.receipt.receiptNumber || '';
ok(editReceiptNumber === '', 'Edit header: receiptNumber input reconstructed as EMPTY (receipt_number not persisted)');

// ════════════════════════════════════════════════════════════════════════════
// STAGE G — Edit-save consequences (REAL validation gate + REAL calculator on
// reconstructed values)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ STAGE G — what happens if the user now presses حفظ التعديلات ══');
fingerprint(RECEIPTS_SRC, "    alert('رقم النموذج مطلوب');", 'validateBeforeSave receipt_number gate');
fingerprint(RECEIPTS_SRC, '  if (!rawData.receipt_number) {', 'gate condition: !rawData.receipt_number');
fingerprint(RECEIPTS_SRC, '  if (!el || ReceiptState.isEditing) return;', 'generateReceiptNumber refuses in edit mode');
const gateBlocks = !(editReceiptNumber); // validateBeforeSave: if (!rawData.receipt_number) → alert + return false
ok(gateBlocks === true,
   'EDIT SAVE HARD-BLOCKED: reconstructed receipt_number="" → validateBeforeSave alerts «رقم النموذج مطلوب» and aborts — for EVERY receipt saved through the current architecture');

// Even if the gate were bypassed: calculateTotals()/update would recompute row nets
// from the BLANK weight/officeAmount/discount/add inputs (REAL calculateRowNet).
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
ok(recomputedA === -(150 + 30) && recomputedA !== 920,
   `Edit re-save would CORRUPT row net 920 → ${recomputedA} (weights/officeAmount/add/discount blank at recompute)`);
const rebuiltTotals = calculateReceiptTotals(
  [
    { weight: 0, weight2: 0, deficit: 0, noloon: 20, ohda: 150, officeAmount: 0, discount: 0, add: 0, sarf: 30 },
    { weight: 0, weight2: 0, deficit: 0, noloon: 10, ohda: 50, officeAmount: 0, discount: 0, add: 0, sarf: 0 },
  ], 100, 500, 0);
console.log(`   totals frame after loadReceiptForEdit→calculateTotals(): total=${rebuiltTotals.total}, net_due=${rebuiltTotals.net_due}, net_total=${rebuiltTotals.net_total}`);
ok(rebuiltTotals.total === -230 && rebuiltTotals.total !== 1270,
   `Edit view totals frame is WRONG on load: total ${rebuiltTotals.total} instead of 1270 (negative)`);
fingerprint(FINANCIAL_SRC, "throw new Error('[FinancialService] total must be a non-negative number.');",
  'FinancialService would reject negative total on save (if the number gate were bypassed)');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ SUMMARY ══');
console.log('Round trip verified: Create→Persist→Read→AllForms→Edit→Reconstruct');
console.log('LOSS LAYER: persistence assembly in FinancialService (entity builders).');
console.log('Read repo / read bridges / snapshot readers / edit bridge = faithful to stored data.');
if (failures > 0) { console.error(`\n❌ ${failures} diagnostic assertion(s) FAILED`); process.exit(1); }
console.log('\n✅ DIAGNOSTIC COMPLETE — every reported symptom reproduced against real code');
