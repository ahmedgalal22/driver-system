// run.mjs — All Receipts driver-name filter regression.
import { readFileSync } from 'node:fs';

const SRC = readFileSync('./allReceipts.src.js', 'utf8');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`extractFn: ${name} not found`);
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

const api = new Function(`
  const STATE = { filters: { receipts: { global: '', owner: '', company: '', driver: '', vehicle: '', karta: '', type: '' } } };
  const toNumber = (value) => Number(value) || 0;
  const rowContains = (value, query) => !query || String(value ?? '').toLowerCase().includes(query);
  const getReceiptRows = (record) => record.rows || [];
  const inRange = () => true;
  const normalizeDate = (value) => String(value || '');
  ${extractFn(SRC, 'hasActiveRowFilters')}
  ${extractFn(SRC, 'rowMatchesReceiptFilters')}
  ${extractFn(SRC, 'getDisplayRowsForReceipt')}
  ${extractFn(SRC, 'sumVisibleRowWeight')}
  ${extractFn(SRC, 'sumVisibleRowField')}
  ${extractFn(SRC, 'summarizeReceipts')}
  ${extractFn(SRC, 'getReceiptCardsFiltered')}
  return { STATE, getDisplayRowsForReceipt, summarizeReceipts, getReceiptCardsFiltered, rowMatchesReceiptFilters };
`)();

const records = [
  { owner_name: 'مالك أ', company_name: 'شركة أ', rows: [
    { _type: 'data', data: 'أحمد محمد', driver: 'أحمد محمد', office: 'شركة أ', net: 100, sarf: 10, noloon: 20, ohda: 5, weightTotal: 8 },
  ] },
  { owner_name: 'مالك ب', company_name: 'شركة ب', rows: [
    { _type: 'data', data: 'محمد علي', driver: 'محمد علي', office: 'شركة ب', net: 50, sarf: 2, noloon: 10, ohda: 1, weightTotal: 4 },
  ] },
];

api.STATE.receipts = records;

console.log('\n— full and partial driver searches —');
api.STATE.filters.receipts.driver = 'أحمد محمد';
let visible = records.map(record => api.getDisplayRowsForReceipt(record));
let sums = api.summarizeReceipts(records);
ok(visible[0].length === 1 && visible[1].length === 0 && sums.count === 1 && sums.net === 100 && sums.sarf === 10,
  'full driver-name search returns only the matching receipt row and matching summary totals');

api.STATE.filters.receipts.driver = 'أحم';
visible = records.map(record => api.getDisplayRowsForReceipt(record));
sums = api.summarizeReceipts(records);
ok(visible[0].length === 1 && visible[1].length === 0 && sums.net === 100,
  'partial Arabic driver-name search matches the same row');

console.log('\n— no match, clear, and combined filters —');
api.STATE.filters.receipts.driver = 'سائق غير موجود';
visible = records.map(record => api.getDisplayRowsForReceipt(record));
sums = api.summarizeReceipts(records);
ok(visible.every(rows => rows.length === 0) && api.getReceiptCardsFiltered().length === 0
  && sums.count === 0 && sums.net === 0 && sums.sarf === 0,
  'driver search with no matches leaves no visible rows/cards and zero filtered summaries');

api.STATE.filters.receipts.driver = '';
visible = records.map(record => api.getDisplayRowsForReceipt(record));
sums = api.summarizeReceipts(records);
ok(visible[0].length === 1 && visible[1].length === 1 && api.getReceiptCardsFiltered().length === 2
  && sums.count === 2 && sums.net === 150 && sums.sarf === 12,
  'clearing driver search immediately restores all applicable rows/cards and totals');

api.STATE.filters.receipts.driver = 'أحمد';
api.STATE.filters.receipts.company = 'شركة ب';
visible = records.map(record => api.getDisplayRowsForReceipt(record));
ok(visible.every(rows => rows.length === 0),
  'driver search combines with existing company filter using all active conditions');
api.STATE.filters.receipts.company = 'شركة أ';
visible = records.map(record => api.getDisplayRowsForReceipt(record));
ok(visible[0].length === 1 && visible[1].length === 0,
  'driver and company filters retain the row only when both conditions match');

console.log('\n— source integration contract —');
ok(SRC.includes("driver: '',")
  && SRC.includes('data-filter-key="driver"')
  && SRC.includes('placeholder="اسم السائق"')
  && SRC.includes("if (driver && !rowContains(row.data || row.driver, driver)) return false;"),
  'All Receipts page defines and applies the dedicated persisted/displayed driver-name filter');
ok(SRC.includes('acc.net += toNumber(row.net);') && SRC.includes('acc.sarf += toNumber(row.sarf);'),
  'existing summaries continue to use visible filtered rows for net and sarf totals');

console.log(failures === 0
  ? '\n✅ ALL ALL-RECEIPTS-DRIVER-FILTER ASSERTIONS PASSED'
  : `\n❌ ${failures} ALL-RECEIPTS-DRIVER-FILTER FAILURES`);
process.exit(failures === 0 ? 0 : 1);
