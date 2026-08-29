// Dashboard Capital Treasury focused regression suite.
import { installIDB } from './idb-shim.mjs';
import { existsSync, readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { Money } = await import('./money.js');
const { DashboardRepository } = await import('./services/dashboardRepository.js');

const U = 'capital-owner';
const OTHER = 'other-owner';
const CAPITAL_ENTRY_TYPE = Object.freeze({ DEPOSIT: 'deposit', WITHDRAW: 'withdraw' });
const DOMAIN_EVENT = Object.freeze({ CAPITAL_CHANGED: 'capital:changed' });
const DASHBOARD_SRC = readFileSync('./dashboard.js', 'utf8');
const DB_SRC = readFileSync('./database.js', 'utf8');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};

function extractFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`) >= 0
    ? source.indexOf(`async function ${name}(`)
    : source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

function materialize(source, name, bindings) {
  const keys = Object.keys(bindings);
  return new Function(...keys, `${source}\nreturn ${name};`)(...keys.map(key => bindings[key]));
}

await DB.init();

console.log('\n— schema and exclusion contract —');
ok(DB_SRC.includes('const DB_VERSION = 16;') && !!DB.STORES.mainCapitalTreasury,
  'v16 defines the Dashboard-only mainCapitalTreasury store');
ok(DB.STORES.mainCapitalTreasury.keyPath === 'id'
   && DB.STORES.mainCapitalTreasury.autoIncrement === false
   && DB.STORES.mainCapitalTreasury.indexes.some(i => i.name === 'by_username')
   && DB.STORES.mainCapitalTreasury.indexes.some(i => i.name === 'by_type')
   && DB.STORES.mainCapitalTreasury.indexes.some(i => i.name === 'by_deleted'),
  'mainCapitalTreasury keeps the historical UUID key and username/type/deleted indexes');
ok(!/name\s*:\s*'treasury'/.test(DB_SRC)
   && !existsSync('./treasury.js')
   && !existsSync('./services/treasuryRepository.js')
   && !DASHBOARD_SRC.includes('treasuryPage')
   && !DASHBOARD_SRC.includes('TreasuryRepository')
   && !DASHBOARD_SRC.includes('treasury:changed'),
  'standalone Treasury page, store, repository, route, and event remain absent');
ok(DASHBOARD_SRC.includes('الخزنة الرئيسية (رأس المال الخاص)')
   && DASHBOARD_SRC.includes('DashboardRepository')
   && DASHBOARD_SRC.includes("capital:changed"),
  'Dashboard source contains only the approved embedded Capital Treasury surface');

console.log('\n— real repository persistence / username scoping —');
const emitted = [];
globalThis.CustomEvent = class CustomEvent {
  constructor(type) { this.type = type; }
};
const sourceAddCapital = extractFunction(DASHBOARD_SRC, '_addCapitalTransaction');
const addCapital = materialize(sourceAddCapital, '_addCapitalTransaction', {
  Money,
  DashboardRepository,
  CAPITAL_ENTRY_TYPE,
  _uuid: () => crypto.randomUUID(),
  _todayISO: () => '2026-08-29',
  DOMAIN_EVENT,
  window: { dispatchEvent: event => emitted.push(event.type) },
});

await addCapital(U, CAPITAL_ENTRY_TYPE.DEPOSIT, 250.75, 'رأس مال افتتاحي', '2026-08-01');
await addCapital(U, CAPITAL_ENTRY_TYPE.WITHDRAW, 50.25, 'سحب تشغيلي', '2026-08-02');
await addCapital(OTHER, CAPITAL_ENTRY_TYPE.DEPOSIT, 999, 'لا يظهر للمالك الأول', '2026-08-03');

const ownLive = await DashboardRepository.getCapitalTransactions(U);
const deposit = ownLive.find(entry => entry.note === 'رأس مال افتتاحي');
const withdrawal = ownLive.find(entry => entry.note === 'سحب تشغيلي');
ok(ownLive.length === 2 && ownLive.every(entry => entry.username === U),
  'getCapitalTransactions is scoped to the requested username');
ok(deposit?.type === 'deposit' && deposit.amount === 25075
   && withdrawal?.type === 'withdraw' && withdrawal.amount === 5025,
  'Capital deposit and withdrawal use the real dashboard source function and persist cent amounts');
ok(emitted.length === 3 && emitted.every(type => type === DOMAIN_EVENT.CAPITAL_CHANGED),
  'every Capital create dispatches capital:changed');

console.log('\n— balance and search rendering —');
const tableBody = { innerHTML: '' };
const balanceEl = { textContent: '' };
const renderDocument = {
  getElementById(id) {
    if (id === 'capitalTableBody') return tableBody;
    if (id === 'capitalBalanceVal') return balanceEl;
    return null;
  },
};
const STATE = { capitalSearchQuery: 'سحب' };
const sourceRenderCapital = extractFunction(DASHBOARD_SRC, '_renderCapitalTreasury');
const renderCapital = materialize(sourceRenderCapital, '_renderCapitalTreasury', {
  document: renderDocument,
  Money,
  STATE,
  CAPITAL_ENTRY_TYPE,
  _getCapitalTransactions: username => DashboardRepository.getCapitalTransactions(username),
  _esc: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
});
await renderCapital(U);
ok(balanceEl.textContent.includes('200.50'),
  'Capital balance is all active deposits minus all active withdrawals');
ok(tableBody.innerHTML.includes('سحب تشغيلي') && !tableBody.innerHTML.includes('رأس مال افتتاحي'),
  'Capital search filters transaction history without changing total balance');
ok(DASHBOARD_SRC.includes("filtered.sort((a, b) => {") && DASHBOARD_SRC.includes('return timeB - timeA;'),
  'Capital transaction history remains newest-first by created_at');

console.log('\n— soft deletion —');
await DashboardRepository.deleteTransaction(deposit.id, { username: U });
const liveAfterDelete = await DashboardRepository.getCapitalTransactions(U);
const includingDeleted = await DB.findByFields('mainCapitalTreasury', { id: deposit.id }, { includeDeleted: true });
ok(liveAfterDelete.length === 1 && liveAfterDelete[0].id === withdrawal.id,
  'deleted Capital transaction is excluded from live history');
ok(includingDeleted.length === 1 && includingDeleted[0].deleted_at !== null,
  'Capital delete uses the existing soft-delete behavior');
STATE.capitalSearchQuery = '';
await renderCapital(U);
ok(balanceEl.textContent.includes('-50.25') && tableBody.innerHTML.includes('سحب تشغيلي'),
  'soft-deleted deposit no longer contributes to Capital balance or table');

console.log('\n— print data —');
const printableRows = [{
  textContent: '2026-08-01 إيداع +250.75 رأس مال افتتاحي',
  querySelectorAll() {
    return [
      { textContent: '2026-08-01' },
      { textContent: 'إيداع' },
      { textContent: '+250.75' },
      { textContent: 'رأس مال افتتاحي' },
      { textContent: U },
    ];
  },
}, {
  textContent: '2026-08-02 سحب -50.25 سحب تشغيلي',
  querySelectorAll() {
    return [
      { textContent: '2026-08-02' },
      { textContent: 'سحب' },
      { textContent: '-50.25' },
      { textContent: 'سحب تشغيلي' },
      { textContent: U },
    ];
  },
}];
let printed = null;
const sourcePrintCapital = extractFunction(DASHBOARD_SRC, '_printCapitalTreasury');
const printCapital = materialize(sourcePrintCapital, '_printCapitalTreasury', {
  document: { getElementById: id => id === 'capitalTableBody' ? { querySelectorAll: () => printableRows } : null },
  alert: () => { throw new Error('print should have rows'); },
  printHTML: (doc, options) => { printed = { doc, options }; },
  buildPrintDocument: config => config,
  Money,
});
printCapital();
ok(printed?.doc?.title === 'طباعة كشف الخزنة الرئيسية'
   && printed.doc.body.includes('إجمالي الإيداعات')
   && printed.doc.body.includes('+250.75')
   && printed.doc.body.includes('-50.25')
   && printed.doc.body.includes('200.50')
   && printed.options?.id === 'capital-print-iframe',
  'Capital print uses the visible history and includes deposit, withdrawal, and net totals');

console.log('\n— capital:changed Dashboard refresh listener —');
const windowListeners = new Map();
let refreshCalls = 0;
const attachSource = extractFunction(DASHBOARD_SRC, '_attachListeners');
const attachBindings = {
  document: {
    addEventListener: () => {},
    getElementById: id => id === 'dashboardPage' ? { classList: { contains: () => false } } : null,
  },
  window: { addEventListener: (type, listener) => windowListeners.set(type, listener) },
  DOMAIN_EVENT: {
    CAPITAL_CHANGED: 'capital:changed',
    RECEIPTS_CHANGED: 'receipts:changed',
    OFFICES_CHANGED: 'offices:changed',
  },
  _setQuickFilterRange: () => {},
  _syncQuickRangeButtons: () => {},
  _refreshDashboard: async () => { refreshCalls++; },
  _openCapitalModal: () => {},
  CAPITAL_ENTRY_TYPE,
  _closeCapitalModal: () => {},
  _saveCapitalTransactionFromModal: async () => {},
  confirm: () => false,
  _deleteCapitalTransaction: async () => {},
  _currentUsername: () => U,
  _printCapitalTreasury: () => {},
  _renderCapitalTreasury: async () => {},
};
const attachKeys = Object.keys(attachBindings);
const attachListeners = new Function(
  ...attachKeys,
  `let _bound = false; ${attachSource}\nreturn _attachListeners;`,
)(...attachKeys.map(key => attachBindings[key]));
attachListeners();
await windowListeners.get('capital:changed')();
ok(refreshCalls === 1,
  'capital:changed refreshes the Dashboard while it is visible');

console.log(`\n${failures === 0 ? '✅ ALL DASHBOARD CAPITAL TREASURY ASSERTIONS PASSED' : '❌ FAILURES: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
