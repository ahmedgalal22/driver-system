// run.mjs — Direct Driver Deposit / Withdrawal verification.
// Uses the production FinancialService and the existing vehicle_ledger store.
// The test proves manual driver movements are one-row, driver-only entries
// that use cents and the established audit-reversal convention.

import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');

const U = 'manual-driver-balance-tester';
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

await DB.init();

const OWNER_ID = uuid();
const DRIVER = { id: uuid(), username: U, name: 'سائق اختبار', phone: null };
const VEHICLE = { id: uuid(), username: U, plate: '123 أ ب', owner_id: OWNER_ID, owner_name: 'مالك اختبار' };
await ClientRepository.saveDriver(DRIVER, { username: U });
await ClientRepository.saveVehicle(VEHICLE, { username: U });

const vehicleBalanceCents = async () => Math.round((await FinancialService.rebuildVehicleBalance(VEHICLE.id)).balance * 100);
const directRows = async () => (await DB.getAll('vehicle_ledger', {}, { includeDeleted: true }))
  .filter(entry => entry.reference_type === 'manual_driver_balance' && entry.effect === 'manual_driver_balance');

console.log('\n— direct Deposit —');
const beforeVehicle = await vehicleBalanceCents();
const deposit = await FinancialService.createManualDriverBalanceEntry(U, {
  driver_id: DRIVER.id,
  entry_type: 'deposit',
  amount: 123.45,
  date: '2026-09-21',
  note: '',
});
const rawDeposit = (await DB.getByIndex('vehicle_ledger', 'by_reference_id', deposit.reference_id))[0];
const afterDepositBalance = await FinancialService.getDriverBalance(DRIVER.id);
ok(deposit.reference_type === 'manual_driver_balance'
  && deposit.effect === 'manual_driver_balance'
  && deposit.type === 'deposit'
  && deposit.amount === 123.45,
  'direct Deposit returns the generic manual-driver contract in decimal form');
ok(rawDeposit.owner_id === DRIVER.id
  && rawDeposit.client_type === 'driver'
  && rawDeposit.vehicle_id === null
  && rawDeposit.type === 'deposit'
  && rawDeposit.amount === 12345,
  'direct Deposit persists exactly one driver-only ledger row with integer cents');
ok(rawDeposit.note === null && rawDeposit.reference_id === deposit.reference_id,
  'optional Deposit note is stored as null and the movement has a stable reference');
ok(afterDepositBalance.balance === 123.45
  && afterDepositBalance.deposit_total === 123.45
  && afterDepositBalance.withdraw_total === 0,
  'direct Deposit increases Driver Balance');
ok((await vehicleBalanceCents()) === beforeVehicle
  && (await FinancialService.getVehicleLedger(VEHICLE.id)).length === 0,
  'direct Deposit changes neither Vehicle Balance nor Vehicle Ledger');

console.log('\n— direct Withdrawal —');
const withdrawal = await FinancialService.createManualDriverBalanceEntry(U, {
  driver_id: DRIVER.id,
  entry_type: 'withdraw',
  amount: 200.25,
  date: '2026-09-22',
  note: 'سحب اختبار',
});
const rawWithdrawal = (await DB.getByIndex('vehicle_ledger', 'by_reference_id', withdrawal.reference_id))[0];
const afterWithdrawalBalance = await FinancialService.getDriverBalance(DRIVER.id);
const ledgerAfterWithdrawal = await FinancialService.getDriverLedger(DRIVER.id);
ok(withdrawal.type === 'withdraw' && withdrawal.amount === 200.25
  && rawWithdrawal.amount === 20025 && rawWithdrawal.vehicle_id === null,
  'direct Withdrawal is persisted in positive integer cents with no vehicle link');
ok(afterWithdrawalBalance.balance === -76.8
  && afterWithdrawalBalance.deposit_total === 123.45
  && afterWithdrawalBalance.withdraw_total === 200.25,
  'direct Withdrawal decreases Driver Balance and may make it negative');
ok(ledgerAfterWithdrawal.length === 2
  && ledgerAfterWithdrawal[0].type === 'withdraw'
  && ledgerAfterWithdrawal[0].amount === 200.25
  && ledgerAfterWithdrawal[0].running_balance === -76.8
  && ledgerAfterWithdrawal[1].type === 'deposit'
  && ledgerAfterWithdrawal[1].running_balance === 123.45,
  'Driver Ledger displays compatible signed running balances for direct movements');
ok((await vehicleBalanceCents()) === beforeVehicle
  && (await FinancialService.getVehicleLedger(VEHICLE.id)).length === 0,
  'direct Withdrawal changes neither Vehicle Balance nor Vehicle Ledger');

console.log('\n— input validation —');
const countBeforeInvalid = (await directRows()).length;
ok(await rejects(() => FinancialService.createManualDriverBalanceEntry(U, {
  driver_id: DRIVER.id, entry_type: 'deposit', amount: 0, date: '2026-09-23', note: '',
})), 'zero direct Driver amount is rejected');
ok(await rejects(() => FinancialService.createManualDriverBalanceEntry(U, {
  driver_id: DRIVER.id, entry_type: 'withdraw', amount: -1, date: '2026-09-23', note: '',
})), 'negative direct Driver amount is rejected');
ok(await rejects(() => FinancialService.createManualDriverBalanceEntry(U, {
  driver_id: DRIVER.id, entry_type: 'deposit', amount: Infinity, date: '2026-09-23', note: '',
})), 'non-finite direct Driver amount is rejected');
ok(await rejects(() => FinancialService.createManualDriverBalanceEntry(U, {
  driver_id: 'missing-driver', entry_type: 'deposit', amount: 1, date: '2026-09-23', note: '',
})), 'invalid Driver ID is rejected before a ledger write');
ok(await rejects(() => FinancialService.createManualDriverBalanceEntry(U, {
  driver_id: DRIVER.id, entry_type: 'deposit', amount: 1, date: 'not-a-date', note: '',
})), 'invalid direct Driver date is rejected');
ok((await directRows()).length === countBeforeInvalid,
  'invalid direct Driver inputs create no ledger history');

console.log('\n— audit-preserving edit and delete —');
const replacement = await FinancialService.updateManualDriverBalanceEntry(U, deposit.reference_id, {
  driver_id: DRIVER.id,
  entry_type: 'deposit',
  amount: 250.5,
  date: '2026-09-24',
  note: 'إيداع معدل',
});
const depositHistory = await DB.getByIndex('vehicle_ledger', 'by_reference_id', deposit.reference_id);
const afterEdit = await FinancialService.getDriverBalance(DRIVER.id);
ok(depositHistory.length === 1 && depositHistory[0].is_reversed === true
  && depositHistory[0].reversed_at && depositHistory[0].reversed_by === U,
  'editing reverses the prior direct Driver movement instead of deleting it');
ok(replacement.reference_id !== deposit.reference_id
  && replacement.type === 'deposit'
  && replacement.amount === 250.5
  && (await DB.getByIndex('vehicle_ledger', 'by_reference_id', replacement.reference_id))[0].amount === 25050,
  'editing creates one replacement movement with a fresh reference and cents amount');
ok(afterEdit.balance === 50.25 && afterEdit.deposit_total === 250.5 && afterEdit.withdraw_total === 200.25,
  'Driver Balance is the net of the active direct Deposit and Withdrawal after edit');
ok((await vehicleBalanceCents()) === beforeVehicle,
  'editing a direct Driver movement still has no Vehicle Balance effect');

await FinancialService.deleteManualDriverBalanceEntry(U, withdrawal.reference_id);
const withdrawalHistory = await DB.getByIndex('vehicle_ledger', 'by_reference_id', withdrawal.reference_id);
ok(withdrawalHistory.length === 1 && withdrawalHistory[0].is_reversed === true
  && withdrawalHistory[0].reversed_at && withdrawalHistory[0].reversed_by === U,
  'deleting a direct Withdrawal follows is_reversed audit history convention');
ok((await FinancialService.getDriverBalance(DRIVER.id)).balance === 250.5,
  'reversing a direct Withdrawal removes only its negative Driver Balance effect');

await FinancialService.deleteManualDriverBalanceEntry(U, replacement.reference_id);
ok((await FinancialService.getDriverBalance(DRIVER.id)).balance === 0
  && (await FinancialService.getDriverLedger(DRIVER.id)).length === 0,
  'reversing the replacement Deposit returns the direct Driver balance projection to zero');
ok((await directRows()).every(entry => entry.vehicle_id === null)
  && (await vehicleBalanceCents()) === beforeVehicle,
  'every direct Driver history row remains vehicle_id:null with no Vehicle Balance impact');

console.log('\n— existing Karta Settlement remains isolated —');
const kartaRow = {
  _type: 'data',
  row_id: uuid(),
  owner_id: OWNER_ID,
  owner_name: 'مالك اختبار',
  driver_id: DRIVER.id,
  driver_name: DRIVER.name,
  vehicle_id: VEHICLE.id,
  vehicle_plate: VEHICLE.plate,
  driver_price: 0,
  loading: 'طنطا',
  destination: 'القاهرة',
  office: null,
  advance: 0,
  net: 10,
  sarf: 0,
};
await FinancialService.createReceipt(U, {
  receipt_date: '2026-09-25',
  client_id: OWNER_ID,
  client_type: 'owner',
  client_name: 'مالك اختبار',
  total: 10,
  rows: [kartaRow],
});
await FinancialService.createKartaSettlement(U, {
  row_id: kartaRow.row_id,
  driver_id: DRIVER.id,
  vehicle_id: VEHICLE.id,
  amount: 10,
  date: '2026-09-25',
  note: 'تسوية مستقلة',
});
const kartaLegs = (await DB.getByIndex('vehicle_ledger', 'by_reference_id', kartaRow.row_id))
  .filter(entry => entry.is_reversed === false);
ok(kartaLegs.length === 2
  && kartaLegs.some(entry => entry.type === 'driver_karta_payment' && entry.amount === -1000)
  && kartaLegs.some(entry => entry.effect === 'karta_settlement_charge' && entry.type === 'withdraw' && entry.amount === 1000),
  'existing Karta Settlement still posts its unchanged two-leg ledger contract');
ok((await vehicleBalanceCents()) === -1000
  && (await FinancialService.getDriverBalance(DRIVER.id)).balance === 0,
  'existing Karta behavior remains separate from direct Driver Balance movements');

console.log('\n— UI and scope fingerprints —');
ok(ENTITIES_SRC.includes('FinancialService.createManualDriverBalanceEntry(username, data)')
  && ENTITIES_SRC.includes('FinancialService.updateManualDriverBalanceEntry(username, _editingDriverBalanceReferenceId, data)')
  && ENTITIES_SRC.includes('FinancialService.deleteManualDriverBalanceEntry(username, refId)'),
  'Driver Details delegates create, edit, and reversal to FinancialService');
ok(INDEX_SRC.includes('>💰 إيداع</button>')
  && INDEX_SRC.includes('>💸 سحب</button>')
  && INDEX_SRC.includes('id="driverBalanceEntryModal"')
  && !INDEX_SRC.includes(['driver', 'DepositVehicle'].join('')),
  'Driver Details exposes only direct amount/date/note movement controls with no vehicle selection');
const legacyDriverDepositMethods = ['createDriver', 'updateDriver', 'deleteDriver'].map(prefix => `${prefix}Deposit`);
const legacyDriverDepositReference = ['driver', 'deposit'].join('_');
ok(legacyDriverDepositMethods.every(method => !FINANCIAL_SRC.includes(method))
  && !FINANCIAL_SRC.includes(`reference_type: '${legacyDriverDepositReference}'`),
  'legacy paired Driver Deposit service behavior is removed');
ok(!FINANCIAL_SRC.includes('KARTA_CHARGE_EFFECT, MANUAL_DRIVER')
  && !FINANCIAL_SRC.includes('PAYMENT_REF_TYPE, MANUAL_DRIVER')
  && !FINANCIAL_SRC.includes('mainCapitalTreasury'),
  'direct Driver functionality introduces no Karta, receipt, or Treasury coupling');

console.log(failures === 0
  ? '\n✅ ALL DIRECT-DRIVER-BALANCE ASSERTIONS PASSED'
  : `\n❌ ${failures} DIRECT-DRIVER-BALANCE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
