// run.mjs — Vehicle Management balance-column regression.
import { installIDB } from './idb-shim.mjs';
import { readFileSync } from 'node:fs';
installIDB();

const { DB } = await import('./database.js');
const { FinancialService } = await import('./financial.js');
const { ClientRepository } = await import('./services/clientRepository.js');

const SRC = readFileSync('./entities.src.js', 'utf8');
const U = 'vehicle-management-balance-tester';
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const uuid = () => crypto.randomUUID();

function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`extractFn: ${name} not found`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
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

console.log('\n— Vehicle Management table contract —');
const dynamicHeader = SRC.match(/<th style="color:#fff;">رقم المركبة<\/th>\s*<th style="color:#fff;">كارتات<\/th>\s*<th style="color:#fff;">الرصيد<\/th>\s*<th style="color:#fff;">إجراءات<\/th>/s);
ok(!!dynamicHeader,
  'Vehicle Management headers are exactly Vehicle Number, Karta Count, Balance, Actions');
ok(SRC.includes('FinancialService.rebuildVehicleBalance(vehicle.id)'),
  'Vehicle Management balance uses the existing authoritative rebuildVehicleBalance source');
ok(SRC.includes("return _buildClientRow(client, stats.kartaCount, stats.balance, 'owner', stats.vehicle_id);")
   && SRC.includes("data-vehicle-id=\"${vehicleId || ''}\""),
  'Vehicle list renderer supplies Karta Count, authoritative balance, and the specific Vehicle Details context');
ok(SRC.includes('data-action="edit-account"') && SRC.includes('data-action="delete-account"'),
  'existing vehicle owner actions remain present');

console.log('\n— authoritative per-vehicle balance isolation —');
await DB.init();
const OWNER_A = uuid();
const OWNER_B = uuid();
const V1 = { id: uuid(), username: U, plate: '111 أ ب', owner_id: OWNER_A, owner_name: '111 أ ب' };
const V2 = { id: uuid(), username: U, plate: '222 ج د', owner_id: OWNER_B, owner_name: '222 ج د' };
await ClientRepository.saveVehicle(V1, { username: U });
await ClientRepository.saveVehicle(V2, { username: U });
await FinancialService.createManualVehicleBalanceEntry(U, {
  vehicle_id: V1.id, entry_type: 'deposit', amount: 100, date: '2026-08-10', note: 'إيداع V1',
});
await FinancialService.createManualVehicleBalanceEntry(U, {
  vehicle_id: V2.id, entry_type: 'withdraw', amount: 40, date: '2026-08-10', note: 'سحب V2',
});

const ownerFinancialsFn = new Function('ClientRepository', 'FinancialService', `
  ${extractFn(SRC, '_getVehicleOwnerListFinancials')}
  return _getVehicleOwnerListFinancials;
`)(ClientRepository, FinancialService);
const f1 = await ownerFinancialsFn({ id: OWNER_A, vehicle_number: V1.plate });
const f2 = await ownerFinancialsFn({ id: OWNER_B, vehicle_number: V2.plate });
const b1 = f1.balance;
const b2 = f2.balance;
ok(b1 === 100 && b2 === -40 && f1.vehicle_id === V1.id && f2.vehicle_id === V2.id,
  'each Vehicle Management row obtains its matching vehicle balance and passes the specific vehicle ID to Vehicle Details');

const rowRenderer = new Function('_fmt', '_balanceClass', `
  ${extractFn(SRC, '_buildClientRow')}
  return _buildClientRow;
`)((n) => Number(n).toFixed(2), (n) => n > 0 ? 'balance-positive' : n < 0 ? 'balance-negative' : '');
const rowHtml = rowRenderer({ id: OWNER_A, vehicle_number: V1.plate }, 3, b1, 'owner');
ok(rowHtml.indexOf(V1.plate) < rowHtml.indexOf('ent-karta-badge')
  && rowHtml.includes('balance-positive')
  && rowHtml.includes('100.00'),
  'rendered row keeps Vehicle Number → Karta Count → positive Balance → Actions ordering and styling');

console.log(failures === 0
  ? '\n✅ ALL VEHICLE-MANAGEMENT-BALANCE ASSERTIONS PASSED'
  : `\n❌ ${failures} VEHICLE-MANAGEMENT-BALANCE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
