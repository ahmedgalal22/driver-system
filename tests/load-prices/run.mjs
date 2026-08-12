// run.mjs — Load Prices discovery and master-data regression.
import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { LoadPriceRepository } = await import('./services/loadPriceRepository.js');
const { canonicalRouteKey } = await import('./services/routeNameNorm.js');

const U = 'load-prices-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();

const DB_SRC = readFileSync('./database.js', 'utf8');
const PAGE_SRC = readFileSync('./_src/loadPrices.js', 'utf8');
const INDEX_SRC = readFileSync('./_src/index.html', 'utf8');
const APP_SRC = readFileSync('./_src/app.js', 'utf8');

await DB.init();

const mkRow = (over = {}) => ({
  _type: 'data',
  row_id: uuid(),
  owner_id: 'owner-1',
  owner_name: 'مالك اختبار',
  driver_id: null,
  vehicle_id: 'vehicle-1',
  vehicle_plate: '111 أ ب',
  driver_price: 0,
  loading: 'الإسكندرية',
  destination: 'دمنهور',
  office: null,
  advance: 0,
  net: 10,
  sarf: 0,
  ...over,
});
const mkReceipt = (rows) => ({
  receipt_date: '2026-08-10',
  client_id: 'owner-1',
  client_type: 'owner',
  client_name: 'مالك اختبار',
  total: rows.reduce((sum, row) => sum + (Number(row.net) || 0), 0),
  rows,
});
const routes = async () => DB.getAll('loadPrices');
const ledgerCount = async () => (await DB.getAll('vehicle_ledger')).length;

console.log('\n— page and schema contract —');
ok(DB_SRC.includes('const DB_VERSION = 15;') && DB.STORES.loadPrices,
  'database version 15 defines the Load Prices store');
ok(INDEX_SRC.includes('data-page="loadPrices"') && INDEX_SRC.includes('أسعار الحمولة')
  && INDEX_SRC.includes('id="loadPricesPage"') && APP_SRC.includes("loadPrices: 'loadPricesPage'"),
  'sidebar and page routing include أسعار الحمولة');
ok(PAGE_SRC.includes('التحميل') && PAGE_SRC.includes('الجهة')
  && PAGE_SRC.includes('السعر') && PAGE_SRC.includes('الإجراءات'),
  'Load Prices page table renders the required four Arabic columns');

console.log('\n— canonical normalization —');
ok(canonicalRouteKey('الإسكندرية', 'دمنهور') === canonicalRouteKey('اسكندريه', '  دمنهور  '),
  'Arabic place variants and whitespace resolve to one deterministic canonical route key');

console.log('\n— automatic discovery —');
const r1 = mkRow();
await FinancialService.createReceipt(U, mkReceipt([r1]));
let all = await routes();
ok(all.length === 1 && all[0].loading === 'الإسكندرية' && all[0].destination === 'دمنهور' && all[0].price === 0,
  'new receipt route creates exactly one readable Load Price record at price zero');
ok((await ledgerCount()) === 0,
  'route discovery is master-data only and creates no financial ledger movement');

const duplicate = mkRow({ loading: 'اسكندريه', destination: ' دمنهور ' });
await FinancialService.createReceipt(U, mkReceipt([duplicate]));
ok((await routes()).length === 1,
  'saving a canonical duplicate route creates no duplicate record');

const dupInReceiptA = mkRow({ loading: 'الإسكندرية', destination: 'دمنهور' });
const dupInReceiptB = mkRow({ loading: 'اسكندرية', destination: 'دمنهور' });
const different = mkRow({ loading: 'الإسكندرية', destination: 'السويس' });
await FinancialService.createReceipt(U, mkReceipt([dupInReceiptA, dupInReceiptB, different]));
all = await routes();
ok(all.length === 2,
  'multiple receipt rows create one active route per unique canonical route key');
ok(all.some(route => route.destination === 'السويس'),
  'different destination creates an independent route record');

console.log('\n— price preservation and update discovery —');
const damanhurRoute = all.find(route => canonicalRouteKey(route.loading, route.destination) === canonicalRouteKey('الإسكندرية', 'دمنهور'));
await LoadPriceRepository.updatePrice(damanhurRoute.id, 50000, { username: U });
await FinancialService.createReceipt(U, mkReceipt([mkRow({ loading: 'إسكندرية', destination: 'دمنهور' })]));
const priced = await LoadPriceRepository.getById(damanhurRoute.id);
ok(priced.price === 50000 && (await routes()).length === 2,
  'future receipt discovery preserves the user-managed price without duplication');

const updateSource = await FinancialService.createReceipt(U, mkReceipt([mkRow({ loading: 'طنطا', destination: 'القاهرة' })]));
const updateRow = mkRow({ loading: 'طنطا', destination: 'المنصورة' });
await FinancialService.updateReceipt(U, updateSource.receipt.id, mkReceipt([updateRow]));
ok((await routes()).some(route => canonicalRouteKey(route.loading, route.destination) === canonicalRouteKey('طنطا', 'المنصورة')),
  'receipt update discovers routes from replacement rows without altering prior prices');

console.log('\n— delete and recreate —');
await LoadPriceRepository.delete(damanhurRoute.id, { username: U });
ok((await routes()).every(route => route.id !== damanhurRoute.id),
  'deleted route is removed from active route reads through soft deletion');
await FinancialService.createReceipt(U, mkReceipt([mkRow({ loading: 'الإسكندرية', destination: 'دمنهور' })]));
all = await routes();
const recreated = all.find(route => canonicalRouteKey(route.loading, route.destination) === canonicalRouteKey('الإسكندرية', 'دمنهور'));
const auditOld = (await DB.findByFields('loadPrices', { id: damanhurRoute.id }, { includeDeleted: true }))[0];
ok(recreated && recreated.id !== damanhurRoute.id && recreated.price === 0 && auditOld.deleted_at !== null,
  'deleted route is automatically recreated at price zero while the older record remains audited');

console.log('\n— route/financial isolation —');
ok((await ledgerCount()) === 0,
  'route records do not affect vehicle, company, driver, payment-status, or Karta ledgers');

console.log(failures === 0
  ? '\n✅ ALL LOAD-PRICES ASSERTIONS PASSED'
  : `\n❌ ${failures} LOAD-PRICES FAILURES`);
process.exit(failures === 0 ? 0 : 1);
