// Authentication integration with production modules and the IndexedDB shim.
// This does not claim native-browser persistence or navigation testing.
import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key), clear: () => values.clear() };
};
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
const { DB } = await import('./database.js');
const { AuthService } = await import('./auth.js');
const { AuthRepository } = await import('./services/authRepository.js');
const { DBProvider } = await import('./services/dbProvider.js');
let failures = 0;
function ok(value, label) { console.log(`${value ? 'PASS' : 'FAIL'}  ${label}`); if (!value) failures++; }
async function rejects(fn) { try { await fn(); return false; } catch { return true; } }
const users = () => DB.findByFields('users', {}, { includeDeleted: true });
await DB.init();

console.log('\n— first run and sessions —');
await AuthService.login('admin', 'admin123');
const firstUsers = await users();
ok(firstUsers.length === 1 && firstUsers[0].username === 'admin' && !('role' in firstUsers[0]),
  'first login creates only the default admin without role metadata');
ok(AuthService.getSession()?.username === 'admin' && !('role' in AuthService.getSession()),
  'admin session contains the username without an authorization role');
const reloadedAuth = await import('./auth.js?reload');
ok(reloadedAuth.AuthService.getSession()?.username === 'admin', 'admin session survives a fresh module load');
sessionStorage.setItem('financial_last_page', 'dashboardPage');
AuthService.logout();
ok(!localStorage.getItem('session') && !sessionStorage.getItem('financial_last_page') && !AuthService.getSession(),
  'logout clears the session and session storage');
ok(await rejects(() => AuthService.login('admin', 'wrong')), 'incorrect admin password is rejected');

console.log('\n— admin credentials and data preservation —');
const hash = await AuthService.hashPassword('custom-admin-password');
await DB.update('users', firstUsers[0].id, { password_hash: hash }, { username: 'admin' });
const adminBefore = await DB.getById('users', firstUsers[0].id);
await DB.add('drivers', { id: 'data-preservation', name: 'Fixture driver' }, { username: 'admin' });
const driverBefore = await DB.getById('drivers', 'data-preservation');
await AuthService.initialize();
ok(JSON.stringify(await DB.getById('users', firstUsers[0].id)) === JSON.stringify(adminBefore)
  && JSON.stringify(await DB.getById('drivers', 'data-preservation')) === JSON.stringify(driverBefore),
  'initialization does not modify admin credentials or business data');
ok(await rejects(() => AuthService.login('not-admin', 'custom-admin-password')),
  'login accepts only the admin username');
ok(await rejects(() => AuthService.login('admin', 'admin123')), 'custom password is not reset to the default');
await AuthService.login('admin', 'custom-admin-password');
ok(AuthService.getSession()?.username === 'admin'
  && JSON.stringify(await DB.getById('users', firstUsers[0].id)) === JSON.stringify(adminBefore),
  'custom password authenticates without modifying admin data');
localStorage.setItem('session', JSON.stringify({ username: 'not-admin' }));
ok(AuthService.getSession() === null, 'session accepts only the admin username');
console.log('\n— account storage guards —');
const invalid = { id: 'unsupported', username: 'not-admin', password_hash: 'fixture' };
const actor = { username: 'not-admin' };
ok(await rejects(() => AuthRepository.saveUser(invalid, actor)), 'repository rejects unsupported account');
ok(await rejects(() => DBProvider.save('users', invalid, actor))
  && await rejects(() => DB.add('users', invalid, actor)), 'provider and direct add reject unsupported account');
ok(await rejects(() => DB.transaction(tx => tx.add('users', invalid), { ...actor, stores: ['users'] }))
  && await rejects(() => DB.transaction([{ op: 'add', store: 'users', payload: invalid }], actor)),
  'callback and batch adds reject unsupported account');
const adminId = firstUsers[0].id;
const invalidPatch = { username: 'not-admin' };
ok(await rejects(() => DB.update('users', adminId, invalidPatch, { username: 'admin' }))
  && await rejects(() => DB.transaction(tx => tx.update('users', adminId, invalidPatch), { username: 'admin', stores: ['users'] }))
  && await rejects(() => DB.transaction([{ op: 'update', store: 'users', id: adminId, patch: invalidPatch }], { username: 'admin' })),
  'standalone, callback and batch updates reject unsupported username');
ok(await rejects(() => DB.transaction(tx => tx.delete('users', adminId, invalidPatch), { username: 'admin', stores: ['users'] }))
  && await rejects(() => DB.transaction([{ op: 'delete', store: 'users', id: adminId, patch: invalidPatch }], { username: 'admin' })),
  'callback and batch soft-delete patches cannot change account username');
ok(await rejects(() => DB.transaction(async tx => {
  await tx.add('drivers', { id: 'rollback-driver', name: 'rollback' });
  await tx.add('users', invalid);
}, { username: 'not-admin', stores: ['drivers', 'users'] }))
  && !(await DB.getById('drivers', 'rollback-driver')),
  'invalid callback account write rolls back prior business writes');
let rejectedInsideCallback = false;
ok(await rejects(() => DB.transaction(async tx => {
  await tx.add('drivers', { id: 'caught-rollback', name: 'rollback' });
  try { await tx.add('users', invalid); } catch { rejectedInsideCallback = true; }
}, { username: 'not-admin', stores: ['drivers', 'users'] }))
  && rejectedInsideCallback && !(await DB.getById('drivers', 'caught-rollback'))
  && !(await users()).some(user => user.id === invalid.id),
  'caught invalid account write aborts the entire callback transaction');
for (const operation of ['update', 'delete']) {
  const driverId = `caught-${operation}`;
  let caught = false;
  const failed = await rejects(() => DB.transaction(async tx => {
    await tx.add('drivers', { id: driverId, name: 'rollback' });
    try { await tx[operation]('users', adminId, invalidPatch); } catch { caught = true; }
  }, { username: 'admin', stores: ['drivers', 'users'] }));
  ok(failed && caught && !(await DB.getById('drivers', driverId)),
    `caught invalid account ${operation} aborts the entire transaction`);
}
ok(await rejects(() => DB.transaction([
  { op: 'add', store: 'drivers', payload: { id: 'rollback-batch', name: 'rollback' } },
  { op: 'add', store: 'users', payload: invalid },
], { username: 'not-admin' })) && !(await DB.getById('drivers', 'rollback-batch')),
  'invalid batch account write does not persist prior business writes');
ok((await users()).length === 1 && JSON.stringify(await DB.getById('users', adminId)) === JSON.stringify(adminBefore),
  'rejected account writes leave admin unchanged');
console.log('\n— changing getter bypass regression —');
function changingPayload(id, first = 'admin', second = 'intruder') {
  let reads = 0;
  return { id, password_hash: 'fixture', get username() { return ++reads === 1 ? first : second; } };
}
const getterCallback = changingPayload('getter-callback-intruder');
ok(await rejects(() => DB.transaction(tx => tx.add('users', getterCallback), { username: 'admin', stores: ['users'] }))
  && !(await users()).some(u => u.id === 'getter-callback-intruder'),
  'callback add with changing username getter does not create non-admin account');
const getterBatch = changingPayload('getter-batch-intruder');
ok(await rejects(() => DB.transaction([{ op: 'add', store: 'users', payload: getterBatch }], { username: 'admin' }))
  && !(await users()).some(u => u.id === 'getter-batch-intruder'),
  'batch add with changing username getter does not create non-admin account');
let caughtGetter = false;
ok(await rejects(() => DB.transaction(async tx => {
  await tx.add('drivers', { id: 'getter-rollback-driver', name: 'rollback' });
  try { await tx.add('users', changingPayload('getter-rollback-user')); } catch { caughtGetter = true; }
}, { username: 'admin', stores: ['drivers', 'users'] }))
  && caughtGetter && !(await DB.getById('drivers', 'getter-rollback-driver'))
  && !(await users()).some(u => u.id === 'getter-rollback-user'),
  'caught callback getter bypass aborts entire transaction and leaves no partial data');
ok(await rejects(() => DB.transaction([
  { op: 'add', store: 'drivers', payload: { id: 'getter-batch-driver', name: 'rollback' } },
  { op: 'add', store: 'users', payload: changingPayload('getter-batch-user-2') },
], { username: 'admin' }))
  && !(await DB.getById('drivers', 'getter-batch-driver'))
  && !(await users()).some(u => u.id === 'getter-batch-user-2'),
  'batch getter bypass does not leave partial transaction data behind');
await DB.delete('users', firstUsers[0].id, { username: 'admin' });
const deletedAdmin = (await users())[0];
await AuthService.initialize();
ok(await rejects(() => AuthService.login('admin', 'custom-admin-password'))
  && JSON.stringify((await users())[0]) === JSON.stringify(deletedAdmin),
  'soft-deleted admin is neither reactivated nor replaced');

console.log('\n— navigation and login contracts —');
const app = readFileSync('./_src/app.js', 'utf8');
const dashboard = readFileSync('./_src/dashboard.js', 'utf8');
const loginHtml = readFileSync('./_src/login.html', 'utf8');
ok(!/session\??\.role|\brole\s*[!=]==?\s*['"](?:admin|user)/.test(app + dashboard),
  'application navigation and dashboard contain no account-role checks');
ok(app.includes('await initDashboardPage();') && app.includes('await AuthModule.initialize();'),
  'application initializes authentication and allows dashboard navigation');
ok(loginHtml.includes('id="loginForm"') && loginHtml.includes('id="username"') && loginHtml.includes('id="password"'),
  'existing login screen retains its username and password form');
const pageNames = ['homePage', 'dashboardPage', 'receiptPage', 'allReceiptsPage', 'ownersPage',
  'ownerDetailsPage', 'driverDetailsPage', 'officesPage', 'officeDetailsPage', 'loadPricesPage'];
const pages = Object.fromEntries(pageNames.map(id => [id, {
  id, hidden: false,
  classList: { add() { pages[id].hidden = true; }, remove() { pages[id].hidden = false; } },
}]));
const dom = { getElementById: id => pages[id] || null,
  querySelectorAll: selector => selector === '.page' ? Object.values(pages) : [] };
const routing = app.slice(app.indexOf('const PAGE_MAP ='), app.indexOf('window.showPage = showPage;'));
let dashboardCalls = 0;
const showPage = new Function('document', 'sessionStorage', 'loadOwners', 'loadOffices', 'initAllReceiptsPage',
  'loadLoadPrices', 'initDashboardPage', 'initHomePage', `const LAST_PAGE_KEY = 'last';\n${routing}\nreturn showPage;`)(
  dom, sessionStorage, async () => {}, async () => {}, async () => {}, async () => {},
  async () => { dashboardCalls++; }, () => {});
let pagesAccessible = true;
for (const name of pageNames) {
  await showPage(name);
  if (pages[name].hidden) pagesAccessible = false;
}
ok(pagesAccessible && dashboardCalls === 1, 'all application pages, including dashboard, can be navigated without role checks');
console.log(failures ? `\n${failures} FAILURES` : '\nALL ADMIN-ONLY AUTH ASSERTIONS PASSED');
process.exit(failures ? 1 : 0);
