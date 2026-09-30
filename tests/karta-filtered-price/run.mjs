// run.mjs — Driver Karta persistent settlement-price tab/filter regression.
import { readFileSync } from 'node:fs';

const SRC = readFileSync('./entities.js', 'utf8');
const INDEX_SRC = readFileSync('./index.html', 'utf8');
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

const totalEl = { textContent: '' };
const searchEl = { value: '' };
let rendered = [];
const api = new Function('Money', 'document', '_fmt', '_renderKartaTable', `
  let _currentKartas = [
    { row_id: 'a', status: 'settled', driver_settlement_price: 100 },
    { row_id: 'b', status: 'settled', driver_settlement_price: 50 },
    { row_id: 'c', status: 'unsettled', driver_settlement_price: 25 },
    { row_id: 'd', status: 'unsettled', driver_settlement_price: null },
  ];
  let _kartaStatusFilter = 'unsettled';
  function _syncKartaFilterButtons() {}
  function _syncKartaTableColumns() {}
  function _syncKartaBatchSettlementButton() {}
  ${extractFn(SRC, '_sumKartaPrices')}
  ${extractFn(SRC, '_renderFilteredKartaPriceTotal')}
  ${extractFn(SRC, '_applyKartaFilters')}
  return {
    apply: _applyKartaFilters,
    setFilter: (value) => { _kartaStatusFilter = value; },
    sum: _sumKartaPrices,
  };
`)(
  { toCents: (value) => Math.round((Number(value) || 0) * 100), toDecimal: (value) => Math.round(Number(value) || 0) / 100 },
  { getElementById: (id) => id === 'kartaFilteredTotalPrice' ? totalEl : id === 'kartaSearchInput' ? searchEl : null },
  (value) => Number(value || 0).toFixed(2),
  (rows) => { rendered = rows; }
);

const tbody = {};
console.log('\n— persistent Karta settlement-price filters —');
api.apply(tbody, 'driver-1');
ok(totalEl.textContent === '25.00' && rendered.length === 2,
  'default unsettled tab includes only unsettled rows and their persisted price total');
api.setFilter('settled');
api.apply(tbody, 'driver-1');
ok(totalEl.textContent === '150.00' && rendered.length === 2,
  'settled tab includes only rows with active settlement status');
api.setFilter('all');
api.apply(tbody, 'driver-1');
ok(totalEl.textContent === '175.00' && rendered.length === 4,
  'all tab includes both unsettled and settled rows while unset prices add zero');

console.log('\n— tab and edit-mode contract —');
const unsettledAt = INDEX_SRC.indexOf('data-filter="unsettled"');
const settledAt = INDEX_SRC.indexOf('data-filter="settled"');
const allAt = INDEX_SRC.indexOf('data-filter="all"');
ok(unsettledAt >= 0 && settledAt > unsettledAt && allAt > settledAt
  && INDEX_SRC.includes('>لم يتم تسويته</button>')
  && INDEX_SRC.includes('>تمت تسويته</button>')
  && INDEX_SRC.includes('>الكل</button>'),
  'Driver Details Karta tabs are exactly unsettled → settled → all');
ok(SRC.includes("let _kartaStatusFilter = 'unsettled';")
  && SRC.includes("_kartaStatusFilter === 'unsettled'")
  && SRC.includes('save-inline-karta-settlement-price'),
  'unsettled is the default and its price cell is directly editable');
ok(SRC.includes("_kartaStatusFilter === 'settled'")
  && SRC.includes('edit-karta-settlement-price')
  && INDEX_SRC.includes('id="kartaActionsHeader"'),
  'settled rows use the dedicated Actions-column price editor');
ok(SRC.includes("_kartaStatusFilter === 'unsettled'")
  && SRC.includes("_kartaStatusFilter === 'settled'")
  && !SRC.includes('data-action=\"open-karta-settlement\"')
  && !SRC.includes('data-action=\"save-karta-settlement\"'),
  'all rows are display-only and the Driver Details Karta UI has no per-row settlement creation control');
ok(SRC.includes("let _kartaStatusFilter = 'unsettled';")
  && SRC.includes('save-inline-karta-settlement-price')
  && SRC.includes('edit-karta-settlement-price'),
  'Phase 3 persistent-price tab semantics remain intact alongside later settlement workflows');

console.log(failures === 0
  ? '\n✅ ALL KARTA-PERSISTENT-PRICE ASSERTIONS PASSED'
  : `\n❌ ${failures} KARTA-PERSISTENT-PRICE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
