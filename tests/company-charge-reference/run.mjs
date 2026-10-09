// run.mjs — Company Balance receipt-row charge reference display regression.
import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ReceiptRepository } = await import('./services/receiptRepository.js');
const { ClientRepository } = await import('./services/clientRepository.js');

const U = 'company-charge-reference-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();
const SRC = readFileSync('./_src/offices.js', 'utf8');

function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`extractFn: ${name} not found`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`extractFn: ${name} unbalanced`);
}

await DB.init();
const OWNER_ID = uuid();
const OFFICE = { id: uuid(), username: U, name: 'شركة الاختبار', phone: null };
const VEHICLE = { id: uuid(), username: U, plate: '123 أ ب', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
await DB.add('offices', OFFICE, { username: U });
await ClientRepository.saveVehicle(VEHICLE, { username: U });

const mkRow = (kartano, net, sarf) => ({
  _type: 'data', row_id: uuid(), owner_id: OWNER_ID, owner_name: 'مالك اختبار',
  driver_id: null, vehicle_id: VEHICLE.id, vehicle_plate: VEHICLE.plate,
  driver_price: 0, loading: 'طنطا', destination: 'القاهرة', office: OFFICE.name,
  advance: 0, kartano, net, sarf,
});
const rowA = mkRow('1258', 100, 20);
const rowB = mkRow('1260', 80, 10);
await FinancialService.createReceipt(U, {
  receipt_date: '2026-08-10', client_id: OWNER_ID, client_type: 'owner', client_name: 'مالك اختبار',
  total: 180, rows: [rowA, rowB],
});
await FinancialService.setReceiptRowPaymentStatus(U, rowA.row_id, 'paid');
const manual = await FinancialService.createManualOfficeBalanceEntry(U, {
  office_id: OFFICE.id, entry_type: 'deposit', amount: 50, date: '2026-08-10', note: 'إيداع تشغيل',
});

const balanceData = await FinancialService.getOfficeBalance(OFFICE.id);
const resolveReferences = new Function('ReceiptRepository', `
  ${extractFn(SRC, '_resolveOfficeBalanceReferences')}
  return _resolveOfficeBalanceReferences;
`)(ReceiptRepository);
const displayEntries = await resolveReferences(balanceData.entries);

console.log('\n— company-charge reference display —');
const chargeA = displayEntries.find(entry => entry.reference_id === rowA.row_id && entry.reference_type === 'receipt_row_company_charge');
const chargeB = displayEntries.find(entry => entry.reference_id === rowB.row_id && entry.reference_type === 'receipt_row_company_charge');
ok(chargeA.reference_display === 'إضافة كارتة: 1258',
  'company charge for kartano 1258 displays إضافة كارتة: 1258');
ok(chargeB.reference_display === 'إضافة كارتة: 1260',
  'multiple company charges resolve their own individual persisted Karta numbers');
ok(!chargeA.reference_display.includes(rowA.row_id) && !chargeB.reference_display.includes(rowB.row_id),
  'company-charge display reference uses kartano rather than the receipt-row UUID');

const paymentEntry = displayEntries.find(entry => entry.reference_type === 'receipt_row_payment_company');
const manualEntry = displayEntries.find(entry => entry.reference_id === manual.reference_id);
ok(paymentEntry.reference_display === 'صرف كارتة: 1258',
  'receipt payment resolves the related card number instead of exposing the receipt-row UUID');
ok(manualEntry.reference_display === 'حركة يدوية: إيداع تشغيل',
  'manual company movement displays its Arabic note instead of the technical reference ID');

const unresolvedEntries = await resolveReferences([
  { reference_type: 'receipt_row_payment_company', reference_id: 'missing-receipt-row' },
  { reference_type: 'manual_office_balance', reference_id: 'manual-technical-id', note: '' },
  { reference_type: 'unknown_reference_type', reference_id: 'raw-technical-id' },
]);
ok(unresolvedEntries[0].reference_display === 'صرف كارتة'
  && unresolvedEntries[1].reference_display === 'حركة يدوية'
  && unresolvedEntries[2].reference_display === 'حركة مالية',
  'unresolvable receipt, manual, and unknown references use clear Arabic fallbacks');

const displayRenderer = new Function('_text', '_fmt', '_balanceClass', `
  ${extractFn(SRC, '_renderOfficeBalance')}
  return _renderOfficeBalance;
`)((value) => value == null ? '' : String(value), (value) => Number(value || 0).toFixed(2), () => '');
const html = displayRenderer(displayEntries);
ok(html.includes('إضافة كارتة: 1258')
  && html.includes('إضافة كارتة: 1260')
  && html.includes('صرف كارتة: 1258')
  && html.includes('حركة يدوية: إيداع تشغيل'),
  'Company Balance table renderer consumes the Arabic display reference for every supported movement type');
const fallbackHtml = displayRenderer(unresolvedEntries);
ok(fallbackHtml.includes('صرف كارتة')
  && fallbackHtml.includes('حركة يدوية')
  && fallbackHtml.includes('حركة مالية')
  && !fallbackHtml.includes('raw-technical-id')
  && !fallbackHtml.includes('manual-technical-id')
  && !fallbackHtml.includes('missing-receipt-row'),
  'renderer never falls back to a raw technical reference ID');

const persistedFields = (entries) => entries.map(entry => ({
  id: entry.id,
  amount: entry.amount,
  reference_type: entry.reference_type,
  reference_id: entry.reference_id,
  effect: entry.effect,
  note: entry.note,
}));
const balanceAfterDisplayResolution = await FinancialService.getOfficeBalance(OFFICE.id);
ok(balanceAfterDisplayResolution.balance === balanceData.balance
  && balanceAfterDisplayResolution.deposit_total === balanceData.deposit_total
  && balanceAfterDisplayResolution.withdraw_total === balanceData.withdraw_total,
  'reference display enrichment does not change Company Balance amounts or calculations');
ok(JSON.stringify(persistedFields(balanceAfterDisplayResolution.entries))
  === JSON.stringify(persistedFields(balanceData.entries)),
  'reference display enrichment does not change persisted ledger identifiers, effects, notes, or amounts');

console.log('\n— source scope —');
ok(SRC.includes("let _activeDetailsTab = 'balance';")
  && SRC.includes("_activeDetailsTab = 'balance';\n  _detailsOfficeId = String(id);"),
  'Company Details opens every office on the Company Balance tab');
ok(SRC.includes("referenceType === 'receipt_row_company_charge'")
  && SRC.includes("referenceType === 'receipt_row_payment_company'")
  && SRC.includes("referenceType === 'manual_office_balance'")
  && SRC.includes("reference_display: 'حركة مالية'")
  && SRC.includes("return _text(entry.reference_display || 'حركة مالية');"),
  'presentation maps every supported company movement type and hides unknown technical IDs');

console.log(failures === 0
  ? '\n✅ ALL COMPANY-CHARGE-REFERENCE ASSERTIONS PASSED'
  : `\n❌ ${failures} COMPANY-CHARGE-REFERENCE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
