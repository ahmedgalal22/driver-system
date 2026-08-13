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
  office_id: OFFICE.id, entry_type: 'deposit', amount: 50, date: '2026-08-10', note: 'حركة يدوية',
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

const paymentEntry = displayEntries.find(entry => entry.reference_type === 'receipt_row_payment');
const manualEntry = displayEntries.find(entry => entry.reference_id === manual.reference_id);
ok(!paymentEntry.reference_display && !manualEntry.reference_display,
  'payment-status and manual company movements retain existing fallback reference behavior');

const displayRenderer = new Function('_text', '_fmt', '_balanceClass', `
  ${extractFn(SRC, '_renderOfficeBalance')}
  return _renderOfficeBalance;
`)((value) => value == null ? '' : String(value), (value) => Number(value || 0).toFixed(2), () => '');
const html = displayRenderer(displayEntries);
ok(html.includes('إضافة كارتة: 1258') && html.includes('إضافة كارتة: 1260'),
  'Company Balance table renderer consumes the resolved display reference');

const balanceAfterDisplayResolution = await FinancialService.getOfficeBalance(OFFICE.id);
ok(balanceAfterDisplayResolution.balance === balanceData.balance
  && balanceAfterDisplayResolution.deposit_total === balanceData.deposit_total
  && balanceAfterDisplayResolution.withdraw_total === balanceData.withdraw_total,
  'reference display enrichment does not change Company Balance amounts or calculations');

console.log('\n— source scope —');
ok(SRC.includes("entry.reference_type === 'receipt_row_company_charge'")
  && SRC.includes('entry.reference_display || entry.reference_number || entry.reference_id ||'),
  'reference formatting is scoped only to receipt-created company charges with existing fallback behavior');

console.log(failures === 0
  ? '\n✅ ALL COMPANY-CHARGE-REFERENCE ASSERTIONS PASSED'
  : `\n❌ ${failures} COMPANY-CHARGE-REFERENCE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
