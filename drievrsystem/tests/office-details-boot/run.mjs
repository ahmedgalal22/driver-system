// run.mjs — Office Details boot-state regression.
//
// Executes the REAL production app.js boot flow. The real offices.js resolver
// and real database.js run on the shared IndexedDB shim; unrelated page modules
// are inert stubs created by setup.sh. Each case runs in a fresh Node process so
// app.js performs a new boot from isolated session/storage/database state.

import { spawnSync } from 'node:child_process';

const scenario = process.argv[2] || '';

if (!scenario) {
  const scenarios = ['no-context', 'valid', 'invalid', 'deleted'];
  let failed = false;

  for (const name of scenarios) {
    console.log(`\n— ${name} —`);
    const result = spawnSync(process.execPath, [new URL(import.meta.url).pathname, name], {
      encoding: 'utf8',
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.status !== 0) failed = true;
  }

  if (failed) {
    console.error('\n❌ OFFICE-DETAILS-BOOT REGRESSION FAILED');
    process.exit(1);
  }
  console.log('\n✅ ALL OFFICE-DETAILS-BOOT ASSERTIONS PASSED');
  process.exit(0);
}

const { installIDB } = await import('./idb-shim.mjs');
installIDB();

const USERNAME = 'office-boot-tester';
let failures = 0;
function ok(condition, label) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
}

function createStorage() {
  const entries = new Map();
  return {
    getItem(key) { return entries.has(key) ? entries.get(key) : null; },
    setItem(key, value) { entries.set(key, String(value)); },
    removeItem(key) { entries.delete(key); },
    clear() { entries.clear(); },
  };
}

function createClassList() {
  const values = new Set();
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : !!force;
      if (enabled) values.add(name); else values.delete(name);
      return enabled;
    },
    contains(name) { return values.has(name); },
  };
}

function createElement(id = '') {
  return {
    id,
    dataset: {},
    style: {},
    classList: createClassList(),
    innerHTML: '',
    firstElementChild: null,
    addEventListener() {},
    remove() {},
  };
}

function installDom() {
  const byId = new Map();
  const pageIds = [
    'homePage', 'dashboardPage', 'receiptPage', 'allReceiptsPage',
    'ownersPage', 'ownerDetailsPage', 'driverDetailsPage',
    'officesPage', 'officeDetailsPage',
  ];
  for (const id of pageIds) {
    const page = createElement(id);
    page.classList.add('page', 'hidden');
    byId.set(id, page);
  }
  byId.set('app', createElement('app'));
  byId.set('sidebar', createElement('sidebar'));
  byId.set('logoutBtn', createElement('logoutBtn'));

  const body = createElement('body');
  body.appendChild = () => {};

  globalThis.document = {
    readyState: 'loading',
    body,
    getElementById(id) { return byId.get(id) || null; },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '.page') return pageIds.map((id) => byId.get(id));
      return [];
    },
    createElement() { return createElement(); },
    addEventListener() {},
  };

  return { byId };
}

const { byId } = installDom();
globalThis.sessionStorage = createStorage();
globalThis.localStorage = createStorage();
globalThis.__OFFICE_BOOT_SESSION__ = { username: USERNAME, role: 'admin' };
globalThis.window = globalThis;
globalThis.window.addEventListener = () => {};
globalThis.window.removeEventListener = () => {};
globalThis.window.dispatchEvent = () => true;
globalThis.window.location = { href: '' };

const { DB } = await import('./database.js');
const { OfficesModule } = await import('./offices.js');
await DB.init();

async function activeOfficeCount() {
  return (await DB.getAll('offices')).length;
}

async function allOfficeCount() {
  return (await DB.findByFields('offices', {}, { includeDeleted: true })).length;
}

async function seedOffice(name) {
  const id = crypto.randomUUID();
  return DB.add('offices', { id, username: USERNAME, name, phone: null }, { username: USERNAME });
}

let showOfficeDetailsCalls = [];
const strictShowOfficeDetails = globalThis.window.showOfficeDetails;
globalThis.window.showOfficeDetails = async (id) => {
  showOfficeDetailsCalls.push(String(id));
  return strictShowOfficeDetails(id);
};

let seeded = null;
if (scenario === 'valid') {
  seeded = await seedOffice('شركة اختبار صالحة');
  sessionStorage.setItem('financial_last_page', 'officeDetailsPage');
  sessionStorage.setItem('financial_last_page_ctx', JSON.stringify({
    page: 'officeDetailsPage',
    officeId: seeded.id,
  }));
}
if (scenario === 'invalid') {
  sessionStorage.setItem('financial_last_page', 'officeDetailsPage');
  sessionStorage.setItem('financial_last_page_ctx', JSON.stringify({
    page: 'officeDetailsPage',
    officeId: 'missing-office-id',
  }));
}
if (scenario === 'deleted') {
  seeded = await seedOffice('شركة اختبار محذوفة');
  await DB.delete('offices', seeded.id, { username: USERNAME });
  sessionStorage.setItem('financial_last_page', 'officeDetailsPage');
  sessionStorage.setItem('financial_last_page_ctx', JSON.stringify({
    page: 'officeDetailsPage',
    officeId: seeded.id,
  }));
}

const beforeActive = await activeOfficeCount();
const beforeAll = await allOfficeCount();

// Imports the unmodified production app.js. It invokes boot() immediately.
await import(`./app.js?office-boot-scenario=${scenario}`);
await new Promise((resolve) => setTimeout(resolve, 30));

const appHtml = byId.get('app').innerHTML;
const fatalBoot = appHtml.includes('فشل تحميل التطبيق');
const currentPage = sessionStorage.getItem('financial_last_page');
const storedContext = sessionStorage.getItem('financial_last_page_ctx');
const afterActive = await activeOfficeCount();
const afterAll = await allOfficeCount();

if (scenario === 'no-context') {
  ok(!fatalBoot, 'no Office Details context: boot does not enter the fatal catch');
  ok(showOfficeDetailsCalls.length === 0, 'no Office Details context: boot does not call showOfficeDetails');
  ok(currentPage === 'homePage', 'no Office Details context: normal boot falls back to homePage');
  ok(afterActive === 0 && afterAll === 0, 'no Office Details context: boot creates no office');
}

if (scenario === 'valid') {
  ok(!fatalBoot, 'valid office ID: boot does not enter the fatal catch');
  ok(showOfficeDetailsCalls.length === 1 && showOfficeDetailsCalls[0] === String(seeded.id),
    'valid office ID: boot restores the exact persisted office ID');
  ok(currentPage === 'officeDetailsPage', 'valid office ID: Office Details remains the active last page');
  ok(storedContext && JSON.parse(storedContext).officeId === String(seeded.id),
    'valid office ID: valid Office Details context is retained');
  ok(afterActive === beforeActive && afterAll === beforeAll && afterActive === 1,
    'valid office ID: opening details creates no additional office');
}

if (scenario === 'invalid') {
  ok(!fatalBoot, 'invalid office ID: boot does not enter the fatal catch');
  ok(showOfficeDetailsCalls.length === 0, 'invalid office ID: boot never calls strict showOfficeDetails');
  ok(storedContext === null, 'invalid office ID: stale Office Details context is removed');
  ok(currentPage === 'officesPage', 'invalid office ID: existing fallback routes safely to officesPage');
  ok(afterActive === beforeActive && afterAll === beforeAll && afterAll === 0,
    'invalid office ID: boot creates no office as a side effect');

  let directError = null;
  try { await strictShowOfficeDetails('missing-office-id'); } catch (error) { directError = error; }
  ok(directError?.message === 'Office not found',
    'invalid office ID: direct showOfficeDetails remains strict and throws Office not found');
}

if (scenario === 'deleted') {
  ok(!fatalBoot, 'deleted office ID: boot does not enter the fatal catch');
  ok(showOfficeDetailsCalls.length === 0, 'deleted office ID: boot never calls strict showOfficeDetails');
  ok(storedContext === null, 'deleted office ID: stale Office Details context is removed');
  ok(currentPage === 'officesPage', 'deleted office ID: existing fallback routes safely to officesPage');
  ok(afterActive === 0 && afterAll === beforeAll && afterAll === 1,
    'deleted office ID: boot does not recreate the soft-deleted office');
}

if (failures > 0) {
  console.error(`❌ ${failures} ${scenario} assertion(s) failed`);
  process.exit(1);
}
