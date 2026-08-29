// Vehicle Maintenance regression suite.
// Proves structured maintenance remains an existing-style manual vehicle
// withdrawal, with no new store or impact outside its selected vehicle.
import { installIDB } from './idb-shim.mjs';
import { existsSync, readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');
const { ReceiptRepository } = await import('./services/receiptRepository.js');

const U = 'vehicle-maintenance-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();
const cents = async vehicleId => Math.round((await FinancialService.rebuildVehicleBalance(vehicleId)).balance * 100);
const DB_SRC = readFileSync('./database.js', 'utf8');
const FINANCIAL_SRC = readFileSync('./financial.js', 'utf8');
const ENTITIES_SRC = readFileSync('./_src/entities.js', 'utf8');

function extractFunction(source, name) {
  const starts = [`async function ${name}(`, `function ${name}(`];
  const start = starts.map(marker => source.indexOf(marker)).find(index => index >= 0);
  if (start === undefined) throw new Error(`Missing function ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

await DB.init();

const OWNER_ID = uuid();
const DRIVER_ID = uuid();
const OFFICE = { id: uuid(), username: U, name: 'شركة صيانة الاختبار', phone: null };
const V1 = { id: uuid(), username: U, plate: '111 ص ي', owner_id: OWNER_ID, owner_name: 'مالك الصيانة' };
const V2 = { id: uuid(), username: U, plate: '222 ص ي', owner_id: OWNER_ID, owner_name: 'مالك الصيانة' };
await DB.add('offices', OFFICE, { username: U });
await ClientRepository.saveDriver({ id: DRIVER_ID, username: U, name: 'سائق الصيانة', phone: null }, { username: U });
await ClientRepository.saveVehicle(V1, { username: U });
await ClientRepository.saveVehicle(V2, { username: U });

console.log('\n— no schema/store or standalone Treasury regression —');
ok(DB_SRC.includes('const DB_VERSION = 16;') && !DB.STORES.maintenance && !/name\s*:\s*'maintenance'/.test(DB_SRC),
  'maintenance adds no IndexedDB store and leaves the approved DB version unchanged');
ok(!existsSync('./treasury.js') && !existsSync('./services/treasuryRepository.js')
   && !ENTITIES_SRC.includes('treasuryPage') && !FINANCIAL_SRC.includes('treasury:changed'),
  'maintenance does not restore a standalone Treasury subsystem');
ok(FINANCIAL_SRC.includes("const MANUAL_VEHICLE_REF_TYPE = 'manual_vehicle_balance';")
   && FINANCIAL_SRC.includes("const MANUAL_VEHICLE_EFFECT = 'manual_vehicle_balance';")
   && !FINANCIAL_SRC.includes("reference_type: 'vehicle_maintenance'"),
  'maintenance retains the existing manual vehicle namespace without a second maintenance ledger');

console.log('\n— existing receipt/payment and Karta Settlement baseline —');
const rowId = uuid();
await FinancialService.createReceipt(U, {
  receipt_date: '2026-08-29',
  client_id: OWNER_ID,
  client_type: 'owner',
  client_name: 'مالك الصيانة',
  total: 1000,
  rows: [{
    _type: 'data', row_id: rowId, owner_id: OWNER_ID, owner_name: 'مالك الصيانة',
    driver_id: DRIVER_ID, driver_name: 'سائق الصيانة', vehicle_id: V1.id,
    vehicle_plate: V1.plate, driver_price: 0, loading: 'طنطا', destination: 'القاهرة',
    office: OFFICE.name, advance: 0, net: 1000, sarf: 0,
  }],
});
await FinancialService.setReceiptRowPaymentStatus(U, rowId, 'paid');
await FinancialService.createKartaSettlement(U, {
  row_id: rowId, vehicle_id: V1.id, amount: 50, date: '2026-08-29', note: 'تسوية اختبار',
});
const officeBefore = await FinancialService.getOfficeBalance(OFFICE.id);
const driverBefore = await FinancialService.getDriverBalance(DRIVER_ID);
const kartaLegsBefore = (await DB.getByIndex('vehicle_ledger', 'by_reference_id', rowId))
  .filter(entry => entry.reference_type === 'receipt_row' && entry.is_reversed === false);
ok((await ReceiptRepository.getRowById(rowId)).payment_status === 'paid' && await cents(V1.id) === 95000,
  'existing receipt payment and Karta Settlement baseline remains intact before maintenance');
ok(kartaLegsBefore.length === 2,
  'existing Karta Settlement still has its exact two active ledger legs');

console.log('\n— maintenance creation is one total vehicle withdrawal —');
const maintenance = await FinancialService.createManualVehicleBalanceEntry(U, {
  vehicle_id: V1.id,
  entry_type: 'withdraw',
  maintenance_type: 'زيت',
  maintenance_quantity: 4,
  amount: 800,
  date: '2026-08-29',
  note: '',
});
const maintenanceRaw = (await DB.getByIndex('vehicle_ledger', 'by_reference_id', maintenance.reference_id))[0];
ok(maintenanceRaw.type === 'withdraw'
   && maintenanceRaw.reference_type === 'manual_vehicle_balance'
   && maintenanceRaw.effect === 'manual_vehicle_balance'
   && maintenanceRaw.vehicle_id === V1.id,
  'maintenance creates exactly one existing-style manual vehicle withdrawal for its selected vehicle');
ok(maintenanceRaw.maintenance_type === 'زيت' && maintenanceRaw.maintenance_quantity === 4,
  'maintenance type and informational quantity persist structurally');
ok(maintenanceRaw.amount === 80000 && maintenanceRaw.note === null,
  'amount persists as 800.00 total cents and an empty optional note is preserved as null');
ok((await cents(V1.id)) === 15000 && (await cents(V2.id)) === 0,
  'quantity 4 does not multiply the total 800.00 withdrawal; only V1 balance decreases');
ok((await FinancialService.getOfficeBalance(OFFICE.id)).balance === officeBefore.balance
   && (await FinancialService.getDriverBalance(DRIVER_ID)).balance === driverBefore.balance,
  'maintenance does not alter Office or Driver Balance');
ok((await ReceiptRepository.getRowById(rowId)).payment_status === 'paid'
   && (await DB.getByIndex('vehicle_ledger', 'by_reference_id', rowId))
     .filter(entry => entry.reference_type === 'receipt_row' && entry.is_reversed === false).length === kartaLegsBefore.length,
  'maintenance does not alter receipt payment status or Karta Settlement behavior');

const vehicleMovements = await FinancialService.getVehicleLedger(V1.id);
const isActiveMaintenance = new Function(`${extractFunction(ENTITIES_SRC, '_isActiveMaintenanceEntry')}\nreturn _isActiveMaintenanceEntry;`)();
ok(vehicleMovements.some(entry => entry.reference_id === maintenance.reference_id),
  'maintenance naturally appears in active Financial Movements');
ok(vehicleMovements.filter(isActiveMaintenance).some(entry => entry.reference_id === maintenance.reference_id),
  'maintenance qualifies for the separate active Maintenance tab projection');

console.log('\n— maintenance reversal/delete audit behavior —');
await FinancialService.deleteManualVehicleBalanceEntry(U, maintenance.reference_id);
const maintenanceAudit = (await DB.getByIndex('vehicle_ledger', 'by_reference_id', maintenance.reference_id))[0];
ok(maintenanceAudit.is_reversed === true && maintenanceAudit.reversed_at && maintenanceAudit.reversed_by === U,
  'maintenance delete preserves audit history through the existing manual reversal mechanism');
ok((await cents(V1.id)) === 95000
   && !(await FinancialService.getVehicleLedger(V1.id)).some(entry => entry.reference_id === maintenance.reference_id),
  'reversal restores Vehicle Balance and removes maintenance from active Financial Movements');
ok(!(await FinancialService.getVehicleLedger(V1.id)).filter(isActiveMaintenance)
   .some(entry => entry.reference_id === maintenance.reference_id),
  'reversed maintenance is excluded from the active Maintenance projection');

console.log('\n— atomic edit: reverse old entry and create one corrected entry —');
const original = await FinancialService.createManualVehicleBalanceEntry(U, {
  vehicle_id: V1.id, entry_type: 'withdraw', maintenance_type: 'جاز', maintenance_quantity: 4,
  amount: 800, date: '2026-08-29', note: '',
});
const amountEdited = await FinancialService.updateVehicleMaintenanceEntry(U, original.reference_id, {
  vehicle_id: V1.id, maintenance_type: 'فلاتر', maintenance_quantity: 5,
  amount: 900, date: '2026-08-30', note: '',
});
const originalAudit = (await DB.getByIndex('vehicle_ledger', 'by_reference_id', original.reference_id))[0];
const v1ActiveMaintenance = (await FinancialService.getVehicleLedger(V1.id)).filter(isActiveMaintenance);
ok(originalAudit.is_reversed === true && amountEdited.reference_id !== original.reference_id,
  'editing preserves the old maintenance record as reversed audit history and creates a fresh entry');
ok(v1ActiveMaintenance.length === 1 && v1ActiveMaintenance[0].reference_id === amountEdited.reference_id
   && v1ActiveMaintenance[0].amount === 900 && v1ActiveMaintenance[0].maintenance_quantity === 5
   && v1ActiveMaintenance[0].note === null,
  'editing quantity and empty note preserves a single corrected active withdrawal at the edited total amount');
ok((await cents(V1.id)) === 5000,
  'editing amount from 800.00 to 900.00 updates Vehicle Balance through reversal plus replacement only');

const vehicleEdited = await FinancialService.updateVehicleMaintenanceEntry(U, amountEdited.reference_id, {
  vehicle_id: V2.id, maintenance_type: 'صيانة مخصصة', maintenance_quantity: 6,
  amount: 123, date: '2026-08-31', note: 'ملاحظة مخصصة',
});
const amountEditAudit = (await DB.getByIndex('vehicle_ledger', 'by_reference_id', amountEdited.reference_id))[0];
const v1AfterMove = (await FinancialService.getVehicleLedger(V1.id)).filter(isActiveMaintenance);
const v2AfterMove = (await FinancialService.getVehicleLedger(V2.id)).filter(isActiveMaintenance);
ok(amountEditAudit.is_reversed === true && v1AfterMove.length === 0 && v2AfterMove.length === 1,
  'editing the vehicle reverses the old vehicle effect and leaves no duplicate active maintenance withdrawal');
ok(vehicleEdited.vehicle_id === V2.id && vehicleEdited.maintenance_type === 'صيانة مخصصة'
   && vehicleEdited.maintenance_quantity === 6 && vehicleEdited.amount === 123,
  'custom maintenance types and informational quantity are accepted without changing total amount semantics');
ok((await cents(V1.id)) === 95000 && (await cents(V2.id)) === -12300,
  'vehicle edit moves only the corrected financial withdrawal to the newly selected vehicle');

console.log('\n— existing manual vehicle behavior and UI contracts —');
const ordinaryManual = await FinancialService.createManualVehicleBalanceEntry(U, {
  vehicle_id: V2.id, entry_type: 'deposit', amount: 20, date: '2026-08-31', note: 'إيداع يدوي قائم',
});
ok(ordinaryManual.type === 'deposit' && !('maintenance_type' in ordinaryManual)
   && !('maintenance_quantity' in ordinaryManual) && (await cents(V2.id)) === -10300,
  'existing manual vehicle deposits continue unchanged when maintenance metadata is absent');
ok(ENTITIES_SRC.includes('الحركات المالية') && ENTITIES_SRC.includes('الصيانة') && ENTITIES_SRC.includes('المركبات')
   && ENTITIES_SRC.includes('vehicleDetailsTabFinancial')
   && ENTITIES_SRC.includes('vehicleDetailsTabMaintenance')
   && ENTITIES_SRC.includes('vehicleDetailsTabVehicles')
   && ENTITIES_SRC.includes("classList.toggle('hidden', !isFinancial)")
   && ENTITIES_SRC.includes("classList.toggle('hidden', !isMaintenance)")
   && ENTITIES_SRC.includes("classList.toggle('hidden', !isVehicles)"),
  'Vehicle Details uses three real mutually exclusive Financial Movements, Maintenance, and Vehicles tabs');
ok(ENTITIES_SRC.includes("const vehicle_id = String(_selectedVehicle?.id || '');")
   && ENTITIES_SRC.includes('_getVehicleDetailsFinancials(vehicle.id)')
   && ENTITIES_SRC.includes("showOwnerDetails(viewBtn.dataset.id, 'owner', viewBtn.dataset.vehicleId || null)")
   && !ENTITIES_SRC.includes('maintenanceVehicleFilter')
   && !ENTITIES_SRC.includes('vehicleMaintenanceVehicle')
   && !ENTITIES_SRC.includes('vehicleBalanceEntryVehicle'),
  'current Vehicle Details context supplies the vehicle_id automatically; neither maintenance nor manual balance forms show a vehicle selector');
ok(ENTITIES_SRC.includes('<section id="vehicleDetailsTabVehicles" class="hidden" role="tabpanel">')
   && ENTITIES_SRC.includes('${relatedHtml}')
   && ENTITIES_SRC.includes('vehicleDetailsTabFinancial')
   && ENTITIES_SRC.includes('vehicleDetailsTabMaintenance'),
  'Vehicles content is isolated inside its own tab panel, not rendered below financial or maintenance content');
ok(['جاز', 'فلاتر', 'زيت', 'كاوتش', 'ميكانيكي', 'اكسسوارت'].every(type => ENTITIES_SRC.includes(`'${type}'`))
   && ENTITIES_SRC.includes("e.target.id === 'vehicleMaintenanceType'")
   && ENTITIES_SRC.includes('select-maintenance-type'),
  'all predefined maintenance suggestions are locally available on focus/input without restricting custom text');
ok(ENTITIES_SRC.includes('edit-vehicle-maintenance') && ENTITIES_SRC.includes('delete-vehicle-maintenance')
   && ENTITIES_SRC.includes("confirm('هل تريد حذف حركة الصيانة؟')")
   && ENTITIES_SRC.includes('_vehicleDetailsTab = \'maintenance\''),
  'Maintenance UI exposes edit/delete confirmation and preserves the Maintenance tab after mutation');

console.log(failures === 0
  ? '\n✅ ALL VEHICLE-MAINTENANCE ASSERTIONS PASSED'
  : `\n❌ ${failures} VEHICLE-MAINTENANCE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
