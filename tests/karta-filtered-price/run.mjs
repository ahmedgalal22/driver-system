// run.mjs — Driver Karta filtered price summary regression.
import { readFileSync } from 'node:fs';

const SRC = readFileSync('./entities.src.js', 'utf8');
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
    { row_id: 'a', status: 'paid', price: 100 },
    { row_id: 'b', status: 'partial', price: 50 },
    { row_id: 'c', status: 'unpaid', price: 25 },
    { row_id: 'd', status: 'unpaid', price: null },
  ];
  let _kartaStatusFilter = 'all';
  function _syncKartaFilterButtons() {}
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
console.log('\n— filtered Karta price summary —');
api.apply(tbody, 'driver-1');
ok(totalEl.textContent === '175.00' && rendered.length === 4,
  'all filter total equals the prices of all displayed Karta rows');
api.setFilter('settled');
api.apply(tbody, 'driver-1');
ok(totalEl.textContent === '150.00' && rendered.length === 2,
  'settled filter total equals only settled/partial displayed Karta rows');
api.setFilter('unsettled');
api.apply(tbody, 'driver-1');
ok(totalEl.textContent === '25.00' && rendered.length === 2,
  'unsettled filter total equals only unsettled displayed Karta rows');

ok(SRC.includes('id="kartaFilteredTotalPrice"')
  && SRC.includes('_renderFilteredKartaPriceTotal(filtered);'),
  'summary card is updated from the exact in-memory filtered collection rendered in the Karta table');
ok(SRC.includes('FinancialService.getDriverKartasSummary(driverId)'),
  'existing settlement data source remains unchanged');

console.log(failures === 0
  ? '\n✅ ALL KARTA-FILTERED-PRICE ASSERTIONS PASSED'
  : `\n❌ ${failures} KARTA-FILTERED-PRICE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
