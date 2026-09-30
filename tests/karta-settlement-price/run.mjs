// run.mjs — Persistent Driver Details Karta settlement-price verification.
// Exercises the production FinancialService, receipt_rows store, and existing
// Karta Settlement ledger contract against the IndexedDB shim.

import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');

const U = 'karta-settlement-price-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();
const rejects = async (fn) => {
  try {
    await fn();
    return false;
  } catch (_) {
    return true;
  }
};

const FINANCIAL_SRC = readFileSync('./financial.js', 'utf8');
const ENTITIES_SRC = readFileSync('./_src/entities.js', 'utf8');
const INDEX_SRC = readFileSync('./_src/index.html', 'utf8');
const DATABASE_SRC = readFileSync('./database.js', 'utf8');

await DB.init();

const OWNER_ID = uuid();
const DRIVER_A = { id: uuid(), username: U, name: 'السائق أ', phone: null };
const DRIVER_B = { id: uuid(), username: U, name: 'السائق ب', phone: null };
const V1 = { id: uuid(), username: U, plate: '111 أ ب', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
const V2 = { id: uuid(), username: U, plate: '222 ج د', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
await ClientRepository.saveDriver(DRIVER_A, { username: U });
await ClientRepository.saveDriver(DRIVER_B, { username: U });
await ClientRepository.saveVehicle(V1, { username: U });
await ClientRepository.saveVehicle(V2, { username: U });

const mkRow = ({ row_id = uuid(), driver, vehicle, settlementPrice = undefined, kartano }) => ({
  _type: 'data',
  row_id,
  owner_id: OWNER_ID,
  owner_name: 'مالك اختبار',
  driver_id: driver.id,
  driver_name: driver.name,
  vehicle_id: vehicle.id,
  vehicle_plate: vehicle.plate,
  driver_price: 77.77,
  driver_settlement_price: settlementPrice,
  loading: 'طنطا',
  destination: 'القاهرة',
  office: null,
  advance: 5,
  net: 10,
  sarf: 0,
  kartano,
});

const ROW_A_SETTLED = mkRow({
  driver: DRIVER_A, vehicle: V1, settlementPrice: 12.34, kartano: 'A-SETTLED',
});
const ROW_A_UNSETTLED = mkRow({
  driver: DRIVER_A, vehicle: V2, settlementPrice: undefined, kartano: 'A-UNSETTLED',
});
const ROW_B = mkRow({
  driver: DRIVER_B, vehicle: V2, settlementPrice: 45.67, kartano: 'B-ONLY',
});

await FinancialService.createReceipt(U, {
  receipt_date: '2026-09-30',
  client_id: OWNER_ID,
  client_type: 'owner',
  client_name: 'مالك اختبار',
  total: 30,
  rows: [ROW_A_SETTLED, ROW_A_UNSETTLED, ROW_B],
});

console.log('\n— receipt-row persistence and read projection —');
const rawInitialA = await DB.getById('receipt_rows', ROW_A_SETTLED.row_id);
const rawInitialUnsettled = await DB.getById('receipt_rows', ROW_A_UNSETTLED.row_id);
const rawInitialB = await DB.getById('receipt_rows', ROW_B.row_id);
const initialAProjection = await FinancialService.getDriverKartas(DRIVER_A.id);
ok(rawInitialA.driver_settlement_price === 1234
  && rawInitialUnsettled.driver_settlement_price === null
  && rawInitialB.driver_settlement_price === 4567,
  'receipt rows persist a dedicated cents price while blank/unset remains null');
ok(rawInitialA.driver_price === 7777
  && rawInitialA.driver_settlement_price !== rawInitialA.driver_price,
  'driver_settlement_price remains independent from receipt_rows.driver_price (نولون)');
ok(initialAProjection.length === 2
  && initialAProjection.every(row => row.status === 'unsettled')
  && initialAProjection.find(row => row.row_id === ROW_A_SETTLED.row_id)?.driver_settlement_price === 12.34
  && initialAProjection.find(row => row.row_id === ROW_A_UNSETTLED.row_id)?.driver_settlement_price === null,
  'Driver A reads only its Karta rows with decimalized persistent prices and unsettled status');

console.log('\n— blank, zero, decimal, and isolated patch validation —');
const untouchedFields = {
  row_id: rawInitialUnsettled.row_id,
  receipt_id: rawInitialUnsettled.receipt_id,
  driver_id: rawInitialUnsettled.driver_id,
  vehicle_id: rawInitialUnsettled.vehicle_id,
  vehicle_plate: rawInitialUnsettled.vehicle_plate,
  driver_price: rawInitialUnsettled.driver_price,
  loading: rawInitialUnsettled.loading,
  destination: rawInitialUnsettled.destination,
  advance: rawInitialUnsettled.advance,
  net: rawInitialUnsettled.net,
  sarf: rawInitialUnsettled.sarf,
  kartano: rawInitialUnsettled.kartano,
};
const blankResult = await FinancialService.updateDriverKartaSettlementPrice(U, ROW_A_UNSETTLED.row_id, '');
ok(blankResult.driver_settlement_price === null
  && (await DB.getById('receipt_rows', ROW_A_UNSETTLED.row_id)).driver_settlement_price === null,
  'blank settlement price is allowed and persists as unset while the row is unsettled');
const zeroResult = await FinancialService.updateDriverKartaSettlementPrice(U, ROW_A_UNSETTLED.row_id, 0);
ok(zeroResult.driver_settlement_price === 0
  && (await DB.getById('receipt_rows', ROW_A_UNSETTLED.row_id)).driver_settlement_price === 0,
  'zero settlement price is allowed and stored as zero cents while the row is unsettled');
const decimalResult = await FinancialService.updateDriverKartaSettlementPrice(U, ROW_A_UNSETTLED.row_id, '200.25');
const rawDecimal = await DB.getById('receipt_rows', ROW_A_UNSETTLED.row_id);
ok(decimalResult.driver_settlement_price === 200.25 && rawDecimal.driver_settlement_price === 20025,
  'positive decimal settlement price is normalized through the existing cents convention');
ok(Object.entries(untouchedFields).every(([key, value]) => rawDecimal[key] === value),
  'price update patches only driver_settlement_price and preserves all other receipt-row fields');

const rowBeforeInvalid = await DB.getById('receipt_rows', ROW_A_UNSETTLED.row_id);
ok(await rejects(() => FinancialService.updateDriverKartaSettlementPrice(U, ROW_A_UNSETTLED.row_id, -1)),
  'negative settlement price is rejected');
ok(await rejects(() => FinancialService.updateDriverKartaSettlementPrice(U, ROW_A_UNSETTLED.row_id, 'not-a-number')),
  'non-numeric settlement price is rejected');
ok((await DB.getById('receipt_rows', ROW_A_UNSETTLED.row_id)).driver_settlement_price === rowBeforeInvalid.driver_settlement_price,
  'rejected values leave the persisted settlement price unchanged');

console.log('\n— reload, driver isolation, and vehicle isolation —');
const { FinancialService: ReloadedFinancialService } = await import('./financial.js?settlement-price-reload');
const reloadedA = await ReloadedFinancialService.getDriverKartas(DRIVER_A.id);
const reloadedB = await ReloadedFinancialService.getDriverKartas(DRIVER_B.id);
ok(reloadedA.find(row => row.row_id === ROW_A_UNSETTLED.row_id)?.driver_settlement_price === 200.25,
  'settlement price survives a fresh FinancialService module reload');
ok(reloadedB.length === 1
  && reloadedB[0].row_id === ROW_B.row_id
  && reloadedB[0].driver_settlement_price === 45.67
  && !reloadedB.some(row => row.row_id === ROW_A_UNSETTLED.row_id),
  'Driver A price never appears in Driver B Karta projection');
ok((await DB.getById('receipt_rows', ROW_B.row_id)).driver_settlement_price === 4567,
  'updating Driver A row does not alter Driver B row');
ok(rawDecimal.vehicle_id === V2.id && rawDecimal.vehicle_plate === V2.plate,
  'settlement-price patch preserves vehicle_id and vehicle_plate exactly');
const ledgerBeforeSettlement = await DB.getAll('vehicle_ledger', {}, { includeDeleted: true });
await FinancialService.updateDriverKartaSettlementPrice(U, ROW_A_UNSETTLED.row_id, 201);
const ledgerAfterPriceOnly = await DB.getAll('vehicle_ledger', {}, { includeDeleted: true });
ok(JSON.stringify(ledgerAfterPriceOnly) === JSON.stringify(ledgerBeforeSettlement),
  'price-only update creates and changes no vehicle_ledger movement');
ok((await FinancialService.rebuildVehicleBalance(V1.id)).balance === 0
  && (await FinancialService.rebuildVehicleBalance(V2.id)).balance === 0,
  'price-only update does not change either Vehicle Balance');

console.log('\n— settlement status derives from existing active ledger effects —');
await FinancialService.createKartaSettlement(U, {
  row_id: ROW_A_SETTLED.row_id,
  vehicle_id: V1.id,
  amount: 50,
  date: '2026-09-30',
  note: 'تسوية موجودة',
});
const afterSettlementA = await FinancialService.getDriverKartas(DRIVER_A.id);
const settledProjection = afterSettlementA.find(row => row.row_id === ROW_A_SETTLED.row_id);
const unsettledProjection = afterSettlementA.find(row => row.row_id === ROW_A_UNSETTLED.row_id);
const activeSettlementLegs = (await DB.getByIndex('vehicle_ledger', 'by_reference_id', ROW_A_SETTLED.row_id))
  .filter(entry => entry.is_reversed === false);
ok(settledProjection.status === 'settled'
  && unsettledProjection.status === 'unsettled'
  && afterSettlementA.length === 2,
  'active driver_karta_payment marks exactly its row settled while the Driver All dataset includes both rows');
ok(activeSettlementLegs.length === 2
  && activeSettlementLegs.some(entry => entry.type === 'driver_karta_payment' && entry.amount === -5000)
  && activeSettlementLegs.some(entry => entry.effect === 'karta_settlement_charge' && entry.amount === 5000),
  'existing Karta Settlement still creates its unchanged two financial ledger legs');
ok((await FinancialService.rebuildVehicleBalance(V1.id)).balance === -50,
  'existing Karta Settlement keeps its unchanged Vehicle Balance withdrawal behavior');

const ledgerBeforeSettledPriceEdit = await DB.getByIndex('vehicle_ledger', 'by_reference_id', ROW_A_SETTLED.row_id);
await FinancialService.updateDriverKartaSettlementPrice(U, ROW_A_SETTLED.row_id, 333.33);
const ledgerAfterSettledPriceEdit = await DB.getByIndex('vehicle_ledger', 'by_reference_id', ROW_A_SETTLED.row_id);
ok((await FinancialService.getDriverKartas(DRIVER_A.id)).find(row => row.row_id === ROW_A_SETTLED.row_id)?.driver_settlement_price === 333.33
  && JSON.stringify(ledgerAfterSettledPriceEdit) === JSON.stringify(ledgerBeforeSettledPriceEdit),
  'settled-row price editing persists the dedicated field without redesigning settlement ledger effects');

console.log('\n— UI and schema scope fingerprints —');
ok(ENTITIES_SRC.includes('save-inline-karta-settlement-price')
  && ENTITIES_SRC.includes('edit-karta-settlement-price')
  && ENTITIES_SRC.includes('FinancialService.updateDriverKartaSettlementPrice'),
  'Driver Details uses direct unsettled input saves and settled-row price edit actions through FinancialService');
ok(INDEX_SRC.includes('data-filter="unsettled"')
  && INDEX_SRC.includes('data-filter="settled"')
  && INDEX_SRC.includes('data-filter="all"')
  && INDEX_SRC.includes('id="kartaSettlementPriceModal"')
  && INDEX_SRC.includes('data-action="settle-unsettled-kartas"'),
  'Karta UI retains the required three tabs and the price editor alongside the later unsettled batch action');
ok(!ENTITIES_SRC.includes('data-action="open-karta-settlement"')
  && !ENTITIES_SRC.includes('data-action="save-karta-settlement"'),
  'Driver Details retains no legacy per-row settlement creation control');
ok(FINANCIAL_SRC.includes('updateDriverKartaSettlementPrice')
  && !FINANCIAL_SRC.includes('is_settled'),
  'price persistence remains a receipt-row patch with settlement status derived from active ledger records');
ok(DATABASE_SRC.includes('const DB_VERSION = 16;')
  && !DATABASE_SRC.includes('driver_settlement_price'),
  'no IndexedDB version, store, index, or schema definition change was required');

console.log(failures === 0
  ? '\n✅ ALL KARTA-SETTLEMENT-PRICE ASSERTIONS PASSED'
  : `\n❌ ${failures} KARTA-SETTLEMENT-PRICE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
