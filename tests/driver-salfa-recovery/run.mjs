// run.mjs — Driver Salfa Recovery verification.
// Uses real production FinancialService on the IndexedDB shim. It proves a
// recovery is a separate driver deposit ledger event, never a rewrite of the
// original salfa and never a vehicle/company/receipt/Karta side effect.

import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');
const { ReceiptRepository } = await import('./services/receiptRepository.js');

const U = 'driver-salfa-recovery-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();

const FINANCIAL_SRC = readFileSync('./financial.js', 'utf8');
const ENTITIES_SRC = readFileSync('./_src/entities.js', 'utf8');
const INDEX_SRC = readFileSync('./index.html', 'utf8');

await DB.init();

const OWNER_ID = uuid();
const DRIVER_A = { id: uuid(), username: U, name: 'أحمد محمد', phone: null };
const DRIVER_B = { id: uuid(), username: U, name: 'محمود علي', phone: null };
const OFFICE = { id: uuid(), username: U, name: 'شركة الاختبار', phone: null };
const VEHICLE = { id: uuid(), username: U, plate: '123 أ ب', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
await ClientRepository.saveDriver(DRIVER_A, { username: U });
await ClientRepository.saveDriver(DRIVER_B, { username: U });
await DB.add('offices', OFFICE, { username: U });
await ClientRepository.saveVehicle(VEHICLE, { username: U });

const receiptRow = {
  _type: 'data',
  row_id: uuid(),
  owner_id: OWNER_ID,
  owner_name: 'مالك اختبار',
  driver_id: null,
  vehicle_id: VEHICLE.id,
  vehicle_plate: VEHICLE.plate,
  driver_price: 0,
  loading: 'طنطا',
  destination: 'القاهرة',
  office: OFFICE.name,
  advance: 0,
  net: 11,
  sarf: 7,
};
const createdReceipt = await FinancialService.createReceipt(U, {
  receipt_date: '2026-08-10',
  client_id: OWNER_ID,
  client_type: 'owner',
  client_name: 'مالك اختبار',
  total: 11,
  rows: [receiptRow],
});
await FinancialService.setReceiptRowPaymentStatus(U, receiptRow.row_id, 'paid');

const driverBalanceCents = async (driverId) =>
  Math.round((await FinancialService.getDriverBalance(driverId)).balance * 100);
const vehicleBalanceCents = async () =>
  Math.round((await FinancialService.rebuildVehicleBalance(VEHICLE.id)).balance * 100);
const officeBalanceCents = async () =>
  Math.round((await FinancialService.getOfficeBalance(OFFICE.id)).balance * 100);
const kartaCount = async () => (await DB.findByFields('vehicle_ledger', {
  reference_type: 'receipt_row',
  is_reversed: false,
})).length;

console.log('\n— Driver Details UI contract —');
ok(!INDEX_SRC.includes('data-action="open-driver-deposit"'),
  'Driver Details no longer contains the إيداع رصيد action');
ok(INDEX_SRC.includes('data-action="open-driver-salfa"')
  && INDEX_SRC.includes('>سلفة</button>')
  && INDEX_SRC.includes('data-action="open-driver-salfa-recovery"')
  && INDEX_SRC.includes('>استرداد سلفة</button>'),
  'Driver Details keeps سلفة and adds استرداد سلفة');
ok(ENTITIES_SRC.includes('FinancialService.createDriverSalfaRecovery(_currentUsername(), {')
  && ENTITIES_SRC.includes('FinancialService.deleteDriverSalfaRecovery(username, refId)'),
  'Driver Details recovery modal and audit-preserving delete route use FinancialService');
ok(ENTITIES_SRC.includes("if (noteEl) noteEl.value = 'استرداد سلفة';")
  && INDEX_SRC.includes('placeholder="استرداد سلفة"')
  && !INDEX_SRC.includes('for="driverSalfaRecoveryNote">السبب / ملاحظة <span'),
  'recovery note UI defaults to استرداد سلفة and is not marked required');

console.log('\n— receipt / vehicle / company / Karta baseline —');
ok((await vehicleBalanceCents()) === 1100 && (await officeBalanceCents()) === 1800,
  'existing paid receipt-row posting remains vehicle=net 11 and company=net+sarf 18');
ok((await ReceiptRepository.getRowById(receiptRow.row_id)).payment_status === 'paid',
  'receipt-row payment status baseline is paid');
const kartaBefore = await kartaCount();
ok(kartaBefore === 0, 'no Karta Settlement entries exist before driver salfa/recovery operations');

console.log('\n— existing salfa remains unchanged —');
const salfa = await FinancialService.createDriverSalfa(U, {
  driver_id: DRIVER_A.id,
  amount: 100,
  date: '2026-08-10',
  note: 'سلفة أصلية',
});
ok(salfa.reference_type === 'salfa' && salfa.effect === 'salfa'
  && salfa.type === 'withdraw' && salfa.amount === 100,
  'existing salfa convention remains a driver withdrawal in the salfa namespace');
ok((await driverBalanceCents(DRIVER_A.id)) === -10000 && (await driverBalanceCents(DRIVER_B.id)) === 0,
  'existing salfa creates driver A debt state only; driver B remains isolated');

let invalidAmount = '';
try {
  await FinancialService.createDriverSalfaRecovery(U, {
    driver_id: DRIVER_A.id, amount: 0, date: '2026-08-10', note: 'غير صالح',
  });
} catch (error) { invalidAmount = error.message; }
ok(/amount must be greater than zero/.test(invalidAmount),
  'recovery still requires a positive amount');

console.log('\n— recovery —');
const recoveryOne = await FinancialService.createDriverSalfaRecovery(U, {
  driver_id: DRIVER_A.id,
  amount: 40,
  date: '2026-08-11',
  // Intentionally empty: it must save with the default without failure.
  note: '',
});
ok(recoveryOne.reference_type === 'salfa_recovery'
  && recoveryOne.effect === 'salfa_recovery'
  && recoveryOne.type === 'deposit'
  && recoveryOne.amount === 40
  && recoveryOne.note === 'استرداد سلفة'
  && recoveryOne.vehicle_id === null,
  'recovery with an empty note succeeds and persists the default استرداد سلفة note');
ok((await driverBalanceCents(DRIVER_A.id)) === -6000 && (await driverBalanceCents(DRIVER_B.id)) === 0,
  'recovery moves driver A balance from -100 to -60 without affecting driver B');
ok((await vehicleBalanceCents()) === 1100 && (await officeBalanceCents()) === 1800,
  'recovery does not affect vehicle or company balances');
ok((await ReceiptRepository.getRowById(receiptRow.row_id)).payment_status === 'paid'
  && (await kartaCount()) === kartaBefore,
  'recovery does not affect receipt-row status or Karta Settlement entries');

const recoveryTwo = await FinancialService.createDriverSalfaRecovery(U, {
  driver_id: DRIVER_A.id,
  amount: 10,
  date: '2026-08-12',
  note: 'استرداد مخصص',
});
ok(recoveryTwo.note === 'استرداد مخصص',
  'recovery with a custom note persists the custom note unchanged');
const recoveryThree = await FinancialService.createDriverSalfaRecovery(U, {
  driver_id: DRIVER_A.id,
  amount: 5,
  date: '2026-08-13',
  // Intentionally omit note: the default must be applied without validation failure.
});
ok(recoveryThree.note === 'استرداد سلفة',
  'recovery with an omitted note succeeds and persists the default note');
ok((await driverBalanceCents(DRIVER_A.id)) === -4500,
  'multiple recoveries accumulate correctly (-100 + 40 + 10 + 5 = -45)');
const ledgerA = await FinancialService.getDriverLedger(DRIVER_A.id);
ok(ledgerA.filter(entry => entry.reference_type === 'salfa_recovery').length === 3,
  'all recovery movements appear in the authoritative driver ledger');

console.log('\n— audit-preserving reversal —');
await FinancialService.deleteDriverSalfaRecovery(U, recoveryOne.reference_id);
ok((await driverBalanceCents(DRIVER_A.id)) === -8500,
  'reversing one recovery restores only its 40 amount while later recoveries remain');
const recoveryAudit = (await DB.getByIndex('vehicle_ledger', 'by_reference_id', recoveryOne.reference_id))[0];
ok(recoveryAudit.is_reversed === true && recoveryAudit.reversed_at && recoveryAudit.reversed_by === U,
  'deleting recovery uses is_reversed audit metadata and preserves the original record');
await FinancialService.deleteDriverSalfaRecovery(U, recoveryTwo.reference_id);
ok((await driverBalanceCents(DRIVER_A.id)) === -9500,
  'reversing the custom recovery leaves only the omitted-note recovery active');
await FinancialService.deleteDriverSalfaRecovery(U, recoveryThree.reference_id);
ok((await driverBalanceCents(DRIVER_A.id)) === -10000,
  'reversing all recoveries restores the unchanged original salfa debt state');
ok((await vehicleBalanceCents()) === 1100 && (await officeBalanceCents()) === 1800
  && (await ReceiptRepository.getRowById(receiptRow.row_id)).payment_status === 'paid'
  && (await kartaCount()) === kartaBefore,
  'recovery reversals remain isolated from receipt, vehicle, company, and Karta domains');

ok(FINANCIAL_SRC.includes("const SALFA_RECOVERY_REF_TYPE = 'salfa_recovery';")
  && FINANCIAL_SRC.includes("const SALFA_RECOVERY_EFFECT = 'salfa_recovery';"),
  'salfa recovery uses an explicit ledger namespace distinct from salfa and driver deposit');
ok(!FINANCIAL_SRC.includes('SALFA_RECOVERY_REF_TYPE = \'salfa\'')
  && !FINANCIAL_SRC.includes('SALFA_RECOVERY_EFFECT = \'salfa\''),
  'salfa recovery does not reuse the original salfa financial reference');

console.log(failures === 0
  ? '\n✅ ALL DRIVER-SALFA-RECOVERY ASSERTIONS PASSED'
  : `\n❌ ${failures} DRIVER-SALFA-RECOVERY FAILURES`);
process.exit(failures === 0 ? 0 : 1);
