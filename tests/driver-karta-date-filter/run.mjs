import { readFileSync } from 'node:fs';

const SRC = readFileSync('./entities.js', 'utf8');
const FINANCIAL = readFileSync('./financial.js', 'utf8');
const INDEX = readFileSync('./index.html', 'utf8');
const CSS = readFileSync('./styles.css', 'utf8');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
function extractFn(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
}

const fromEl = { value: '', dataset: {}, addEventListener() {} };
const toEl = { value: '', dataset: {}, addEventListener() {} };
const searchEl = { value: '', dataset: {}, addEventListener() {} };
const messageEl = {
  textContent: '',
  classList: { toggle(_name, hidden) { messageEl.hidden = hidden; } },
  hidden: true,
};
let rendered = [];
let filteredTotal = [];
const api = new Function('document', '_renderKartaTable', '_renderFilteredKartaPriceTotal', `
  let _currentKartas = [
    { row_id: 'before', status: 'unsettled', date: '2026-01-09', settlement_date: '2026-02-01', driver_settlement_price: 10, company: 'A' },
    { row_id: 'start', status: 'unsettled', date: '2026-01-10', settlement_date: '2026-02-01', driver_settlement_price: 20, company: 'B' },
    { row_id: 'middle', status: 'settled', date: '2026-01-15', settlement_date: '2025-12-01', driver_settlement_price: 30, company: 'C' },
    { row_id: 'end', status: 'unsettled', date: '2026-01-20', settlement_date: '2026-02-01', driver_settlement_price: 40, company: 'D' },
    { row_id: 'after', status: 'unsettled', date: '2026-01-21', settlement_date: '2026-02-01', driver_settlement_price: 50, company: 'E' },
    { row_id: 'missing', status: 'unsettled', date: null, settlement_date: '2026-01-15', driver_settlement_price: 60, company: 'F' },
  ];
  let _kartaStatusFilter = 'all';
  let batchDateFilterState = null;
  function _syncKartaFilterButtons() {}
  function _syncKartaTableColumns() {}
  function _syncKartaBatchSettlementButton(dateFilterActive) { batchDateFilterState = dateFilterActive; }
  ${extractFn(SRC, '_readKartaDateFilter')}
  ${extractFn(SRC, '_setKartaDateFilterMessage')}
  ${extractFn(SRC, '_applyKartaFilters')}
  return {
    apply: _applyKartaFilters,
    setStatus: value => { _kartaStatusFilter = value; },
    source: () => _currentKartas,
    batchDateFilterActive: () => batchDateFilterState,
  };
`)(
  {
    getElementById(id) {
      return {
        kartaFromDate: fromEl,
        kartaToDate: toEl,
        kartaSearchInput: searchEl,
        kartaDateFilterMessage: messageEl,
      }[id] || null;
    },
  },
  rows => { rendered = rows; },
  rows => { filteredTotal = rows; },
);

const tbody = {};
const ids = () => rendered.map(row => row.row_id).join(',');
console.log('\n— date range behavior —');
api.apply(tbody, 'driver-a');
ok(ids() === 'before,start,middle,end,after,missing', 'no date filter preserves existing all-status Cards result');
ok(api.batchDateFilterActive() === false, 'batch action remains eligible without date filter');

fromEl.value = '2026-01-10';
api.apply(tbody, 'driver-a');
ok(ids() === 'start,middle,end,after', 'start date is inclusive and excludes missing dates only when active');
ok(api.batchDateFilterActive() === true, 'batch action is suppressed while date filtering is active');

after: {
  fromEl.value = '';
  toEl.value = '2026-01-20';
  api.apply(tbody, 'driver-a');
  ok(ids() === 'before,start,middle,end', 'end date is inclusive');
}

fromEl.value = '2026-01-10';
toEl.value = '2026-01-20';
api.apply(tbody, 'driver-a');
ok(ids() === 'start,middle,end', 'both dates produce an inclusive receipt-date range');
ok(filteredTotal.length === 3, 'filtered totals receive exactly visible Cards');

fromEl.value = '2026-01-21';
toEl.value = '2026-01-10';
api.apply(tbody, 'driver-a');
ok(rendered.length === 0 && !messageEl.hidden && /تاريخ البداية/.test(messageEl.textContent), 'invalid range renders no Cards and exposes a validation message');

fromEl.value = '';
toEl.value = '';
searchEl.value = 'office test';
api.setStatus('unsettled');
api.apply(tbody, 'driver-a');
ok(rendered.length === 0, 'existing search and status filters remain active when date range is cleared');
searchEl.value = '';
api.apply(tbody, 'driver-a');
ok(ids() === 'before,start,end,after,missing', 'clearing date values preserves status filter while restoring matching Cards');
ok(JSON.stringify(api.source().map(k => k.row_id)) === JSON.stringify(['before', 'start', 'middle', 'end', 'after', 'missing']), 'filtering does not mutate stored Cards data');

console.log('\n— displayed date and scoped UI contract —');
ok(FINANCIAL.includes("date: receipt?.receipt_date || null") && SRC.includes('_dateLabel(karta.date)'), 'filter uses the same receipt date rendered in the Cards table');
ok(!/new Date\(karta\.date/.test(extractFn(SRC, '_applyKartaFilters')) && /kartaDate < from/.test(extractFn(SRC, '_applyKartaFilters')), 'date filtering uses lexical YYYY-MM-DD comparisons without timezone conversion');
ok(SRC.includes('_kartaDateFilter.driverId !== key') && SRC.includes("_kartaDateFilter = { driverId: key, from: '', to: '' }"), 'switching drivers resets Cards date-range state');
ok(SRC.includes('if (_hasActiveKartaDateFilter())') && SRC.includes('!dateFilterActive && _kartaStatusFilter'), 'batch settlement cannot act while date filtering is active');
ok(INDEX.includes('id="kartaFromDate"') && INDEX.includes('id="kartaToDate"') && INDEX.includes('id="kartaResetDateFilter"'), 'Cards tab contains dedicated start/end/reset controls');
ok(!INDEX.includes('id="driverFromDate"') || INDEX.includes('id="driverToDate"'), 'existing Driver Ledger date controls remain present independently');
ok(/\.driver-details-karta-date-filters/.test(CSS), 'Cards date controls use scoped Driver Details styles');

console.log(`\n${failures === 0 ? '✅ ALL DRIVER-KARTA-DATE-FILTER ASSERTIONS PASSED' : `❌ FAILURES: ${failures}`}`);
process.exitCode = failures ? 1 : 0;
