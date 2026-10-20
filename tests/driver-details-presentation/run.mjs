// Driver Details presentation regression: validates the five-column ledger
// layout and identity renderer without importing browser-coupled production UI.
import { readFileSync } from 'node:fs';

const ENTITIES = readFileSync('./_src/entities.js', 'utf8');
const INDEX = readFileSync('./_src/index.html', 'utf8');
const STYLES = readFileSync('./_src/styles.css', 'utf8');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};

function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`extractFn: ${name} not found`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let parenDepth = 0;
  let bodyStart = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')') parenDepth--;
    else if (src[i] === '{' && parenDepth === 0) { bodyStart = i; break; }
  }
  if (bodyStart < 0) throw new Error(`extractFn: ${name} body not found`);
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

const pageStart = INDEX.indexOf('<section id="driverDetailsPage"');
const pageEnd = INDEX.indexOf('<!-- Settled Karta Price Modal', pageStart);
const DRIVER_PAGE = INDEX.slice(pageStart, pageEnd);

console.log('\n— table layout contract —');
ok(!DRIVER_PAGE.includes('<th>النوع</th>') && !DRIVER_PAGE.includes('المركبة / المرجع'),
  'Driver Details ledger has no Type or Reference header');
const ledgerHeader = DRIVER_PAGE.match(/<section id="driverTabLedger"[\s\S]*?<thead>[\s\S]*?<tr>([\s\S]*?)<\/tr>/)?.[1] || '';
ok((ledgerHeader.match(/<th>/g) || []).length === 5,
  'Driver Details ledger header has exactly five aligned columns');
ok(['التاريخ', 'المبلغ', 'الرصيد بعد الحركة', 'الوصف', 'الإجراءات'].every(label => ledgerHeader.includes(`<th>${label}</th>`)),
  'Driver Details ledger retains date, amount, running balance, description, and actions');
ok(DRIVER_PAGE.includes('colspan="5"') && ENTITIES.includes('colspan="5" class="driver-details-empty-state"'),
  'empty states match the five-column ledger layout');
ok(!ENTITIES.includes('const typeStr =') && !ENTITIES.includes('const refStr ='),
  'Driver renderer removes Type/Reference-only display variables');

const tbody = { innerHTML: '' };
const document = { getElementById: (id) => id === 'driverTransactionsBody' ? tbody : null };
const renderLedger = new Function('document', '_dateLabel', '_fmt', '_ledgerNote', `
  ${extractFn(ENTITIES, '_renderDriverLedgerTable')}
  return _renderDriverLedgerTable;
`)(document, value => String(value || '').split('T')[0] || '—', value => Number(value || 0).toFixed(2), entry => entry.note || 'حركة مالية');
renderLedger([{
  date: '2026-10-10', amount: 125.5, running_balance: 300.75,
  note: 'إيداع تشغيل', reference_id: 'internal-reference-id',
  reference_type: 'manual_driver_balance', effect: 'manual_driver_balance', type: 'deposit',
}]);
const renderedRow = tbody.innerHTML;
ok((renderedRow.match(/<td\b/g) || []).length === 5,
  'each rendered Driver Details ledger row has exactly five cells');
ok(renderedRow.includes('2026-10-10') && renderedRow.includes('125.50')
  && renderedRow.includes('300.75') && renderedRow.includes('إيداع تشغيل'),
  'date, amount, running balance, and description remain rendered');
ok(renderedRow.includes('data-action="edit-driver-tx"') && renderedRow.includes('data-action="delete-driver-tx"'),
  'existing manual movement actions remain available');

console.log('\n— centered header balance contract —');
const heroMarkup = DRIVER_PAGE.match(/<header class="driver-details-hero">([\s\S]*?)<\/header>/)?.[1] || '';
const balanceOccurrences = (DRIVER_PAGE.match(/id="driverDetailsBalance"/g) || []).length;
const identityIndex = heroMarkup.indexOf('<div class="driver-details-identity">');
const balanceIndex = heroMarkup.indexOf('<section class="driver-details-summary driver-details-summary--hero"');
const actionsIndex = heroMarkup.indexOf('<div class="driver-details-actions"');
const heroEndIndex = DRIVER_PAGE.indexOf('</header>');
const tabsStartIndex = DRIVER_PAGE.indexOf('<!-- Driver details tabs', heroEndIndex);
const afterHeroBeforeTabs = DRIVER_PAGE.slice(heroEndIndex + '</header>'.length, tabsStartIndex);
ok(balanceOccurrences === 1,
  'Driver Details page contains exactly one existing Driver Balance element');
ok(identityIndex >= 0 && balanceIndex > identityIndex && actionsIndex > balanceIndex,
  'hero content orders identity, the existing balance card, then actions');
ok(!/class="driver-details-summary(?:\s|")/.test(afterHeroBeforeTabs),
  'no obsolete standalone Driver Details summary remains below the hero');
ok(STYLES.includes('grid-template-columns: minmax(0, 1fr) minmax(250px, max-content) minmax(0, 1fr);')
  && STYLES.includes('grid-template-areas: "actions balance identity";')
  && STYLES.includes('grid-area: identity;\n  justify-self: end;')
  && STYLES.includes('grid-area: balance;')
  && STYLES.includes('grid-area: actions;\n  gap: 0.55rem;\n  justify-self: start;')
  && STYLES.includes('justify-self: center;'),
  'desktop hero places actions left, the balance center, and identity right');
ok(STYLES.includes('@media (max-width: 760px)')
  && STYLES.includes('grid-template-areas: "identity" "balance" "actions";')
  && STYLES.includes('.driver-details-summary--hero { width: 100%; justify-self: stretch; }'),
  'narrow and tablet widths stack the hero before the 250px center track can compress side content');
ok(STYLES.includes('width: 100%;')
  && STYLES.includes('max-width: none;')
  && STYLES.includes('margin: 0;'),
  'the Driver Details full-width layout remains unchanged');

console.log('\n— identity presentation contract —');
const classList = {
  positive: false,
  negative: false,
  toggle(name, enabled) {
    if (name === 'driver-details-balance-value--positive') this.positive = !!enabled;
    if (name === 'driver-details-balance-value--negative') this.negative = !!enabled;
  },
};
const identityElements = new Map([
  ['driverDetailsName', { textContent: '' }],
  ['driverDetailsPhone', { textContent: '' }],
  ['driverDetailsBalance', { textContent: '', classList }],
]);
const identityDocument = { getElementById: (id) => identityElements.get(id) || null };
const populateIdentity = new Function('document', '_fmt', `
  ${extractFn(ENTITIES, '_populateDriverDetailsIdentity')}
  return _populateDriverDetailsIdentity;
`)(identityDocument, value => Number(value || 0).toFixed(2));
populateIdentity({ name: 'أحمد محمد', phone: '01000000000' }, { balance: -25.5 });
ok(identityElements.get('driverDetailsName').textContent === 'أحمد محمد'
  && identityElements.get('driverDetailsPhone').textContent === '01000000000'
  && identityElements.get('driverDetailsBalance').textContent === '-25.50',
  'showDriverDetails presentation helper fills existing name, phone, and balance placeholders');
ok(classList.negative && !classList.positive,
  'negative Driver Balance receives the dedicated negative visual state');

console.log('\n— scoped redesign and existing controls —');
ok(STYLES.includes('.driver-details-page')
  && STYLES.includes('.driver-details-table--ledger')
  && STYLES.includes('.driver-details-karta-summary')
  && STYLES.includes('@media (max-width: 620px)'),
  'Driver Details has dedicated scoped desktop and responsive styling');
ok(DRIVER_PAGE.includes('data-action="open-driver-balance-entry"')
  && DRIVER_PAGE.includes('data-action="karta-status-filter"')
  && DRIVER_PAGE.includes('data-action="settle-unsettled-kartas"'),
  'manual balance actions and Karta filtering/settlement hooks remain intact');
ok(ENTITIES.includes('FinancialService.createManualDriverBalanceEntry(username, data)')
  && ENTITIES.includes('FinancialService.createKartaSettlementBatch('),
  'existing Driver Details financial action paths remain connected without new accounting logic');

if (failures) {
  console.error(`\n❌ ${failures} DRIVER DETAILS PRESENTATION ASSERTION(S) FAILED`);
  process.exit(1);
}
console.log('\n✅ ALL DRIVER DETAILS PRESENTATION ASSERTIONS PASSED');
