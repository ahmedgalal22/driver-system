// run.mjs — All Receipts summary totals regression.
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

const summaryApi = new Function(`
  const STATE = { filters: { receipts: { global: '', owner: '', company: '', vehicle: '', karta: '', type: '' } } };
  const toNumber = (value) => Number(value) || 0;
  const hasActiveRowFilters = (filters) => !!(
    String(filters.global || '').trim() || String(filters.owner || '').trim() ||
    String(filters.company || '').trim() || String(filters.vehicle || '').trim() ||
    String(filters.karta || '').trim() || String(filters.type || '').trim()
  );
  const getReceiptRows = (record) => record.rows || [];
  const getDisplayRowsForReceipt = (record) => record.visibleRows || record.rows || [];
  ${extractFn(SRC, 'sumVisibleRowWeight')}
  ${extractFn(SRC, 'sumVisibleRowField')}
  ${extractFn(SRC, 'summarizeReceipts')}
  return { STATE, summarizeReceipts };
`)();

const records = [
  {
    rows: [
      { _type: 'data', weightTotal: 10, noloon: 5, ohda: 1, net: 100, sarf: 7 },
      { _type: 'separator', net: 999, sarf: 999 },
      { _type: 'data', weight: 4, weight2: 2, deficit: 1, noloon: 0, ohda: '', net: 0, sarf: '' },
    ],
  },
  {
    rows: [
      { _type: 'data', weightTotal: 8, noloon: 9, ohda: 3, net: 250.5, sarf: 12.25 },
      { _type: 'data', weightTotal: '', weight: 0, weight2: 0, deficit: 0, noloon: null, ohda: null, net: null, sarf: null },
    ],
  },
];

console.log('\n— all loaded receipt rows —');
let sums = summaryApi.summarizeReceipts(records);
ok(sums.count === 4 && sums.weight === 23 && sums.noloon === 14 && sums.ohda === 4,
  'existing count, weight, noloon, and ohda summary conventions remain unchanged');
ok(sums.net === 350.5,
  'إجمالي الصافي equals the sum of data-row net values across multiple receipts');
ok(sums.sarf === 19.25,
  'إجمالي الصرف equals the sum of data-row sarf values across multiple receipts');
ok(Number.isFinite(sums.net) && Number.isFinite(sums.sarf),
  'zero, empty, null, and separator values do not break the new totals');

console.log('\n— visible row filters —');
summaryApi.STATE.filters.receipts.global = 'active-filter';
records[0].visibleRows = [records[0].rows[0]];
records[1].visibleRows = [records[1].rows[0]];
sums = summaryApi.summarizeReceipts(records);
ok(sums.count === 2 && sums.weight === 18 && sums.noloon === 14 && sums.ohda === 4,
  'existing cards continue to respect the currently visible filtered rows');
ok(sums.net === 350.5 && sums.sarf === 19.25,
  'new net and sarf totals use the same visible-row filter behavior as existing cards');

console.log('\n— summary card rendering contract —');
ok(SRC.includes("summaryCard('🗂️ عدد الكارتات', String(sums.count), 'summary-card--blue')")
  && SRC.includes("summaryCard('⚖️ إجمالي الوزن', fmtMoney(sums.weight), 'summary-card--green')"),
  'existing count and weight summary cards remain intact');
ok(SRC.includes("summaryCard('💜 إجمالي الصافي', fmtMoney(sums.net), 'summary-card--violet')")
  && SRC.includes("summaryCard('🟠 إجمالي الصرف', fmtMoney(sums.sarf), 'summary-card--orange')"),
  'new net and sarf summary cards render with existing professional card styles');

console.log(failures === 0
  ? '\n✅ ALL ALL-RECEIPTS-SUMMARY ASSERTIONS PASSED'
  : `\n❌ ${failures} ALL-RECEIPTS-SUMMARY FAILURES`);
process.exit(failures === 0 ? 0 : 1);
