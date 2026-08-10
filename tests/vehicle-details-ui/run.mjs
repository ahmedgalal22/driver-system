// run.mjs — Vehicle Details visual/functional rendering regression.
import { readFileSync } from 'node:fs';

const SRC = readFileSync('./entities.src.js', 'utf8');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`extractFn: ${name} not found`);
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

console.log('\n— Vehicle Details structure and scoped styles —');
ok(SRC.includes('function _injectVehicleDetailsStyles()')
  && SRC.includes('#ownerDetailsPage .vehicle-details-page')
  && SRC.includes('#ownerDetailsPage .vehicle-ledger-table'),
  'Vehicle Details visual styles are injected and scoped only to #ownerDetailsPage');
ok(SRC.includes('class="vehicle-details-hero"')
  && SRC.includes('class="vehicle-details-title"')
  && SRC.includes('vehicle-details-meta-grid')
  && SRC.includes('data-action="back-to-customers"'),
  'Vehicle Details renders a dominant vehicle header, identity metadata, and preserved back action');
ok(SRC.includes('vehicle-balance-card')
  && SRC.includes('_fmt(financials.balance)')
  && SRC.includes('data-action="open-balance-entry" data-entry-type="deposit"')
  && SRC.includes('data-action="open-balance-entry" data-entry-type="withdraw"'),
  'Vehicle Details keeps authoritative displayed balance and both existing deposit/withdraw actions');
ok(SRC.includes('data-action="edit-vehicle"')
  && SRC.includes('data-action="delete-vehicle"')
  && SRC.includes('data-action="add-vehicle-manual"'),
  'Vehicle Details preserves vehicle add, edit, and delete actions');
ok(SRC.includes('لا توجد حركات مالية حتى الآن')
  && SRC.includes('vehicle-ledger-empty'),
  'Vehicle Details provides a professional movement empty state');

console.log('\n— Vehicle movement rendering —');
const ledgerRenderer = new Function(`
  const _dateLabel = (value) => String(value || '').split('T')[0] || '-';
  const _fmt = (value) => Number(value || 0).toFixed(2);
  const _ledgerNote = (entry) => entry.note || '';
  ${extractFn(SRC, '_vehicleLedgerSource')}
  ${extractFn(SRC, '_renderLedger')}
  return _renderLedger;
`)();

const kartaHtml = ledgerRenderer({ id: 'owner-1', type: 'owner' }, [{
  type: 'withdraw',
  amount: 50,
  date: '2026-08-10',
  vehicle_plate: '123 أ ب',
  effect: 'karta_settlement_charge',
  reference_type: 'receipt_row',
  reference_id: 'row-1',
  note: 'تسوية كارتة (أحمد محمد)',
}]);
ok(kartaHtml.includes('تسوية كارتة (أحمد محمد)')
  && kartaHtml.includes('سحب')
  && kartaHtml.includes('المصدر / المرجع')
  && kartaHtml.includes('الوصف'),
  'Vehicle movements display Karta settlement description, direction, source/reference, and note');

const receiptHtml = ledgerRenderer({ id: 'owner-1', type: 'owner' }, [{
  type: 'deposit',
  amount: 11,
  date: '2026-08-10',
  vehicle_plate: '123 أ ب',
  reference_type: 'receipt_row_payment',
  reference_id: 'row-2',
  note: 'صرف كارتة',
}]);
ok(receiptHtml.includes('إيداع') && receiptHtml.includes('+11.00') && receiptHtml.includes('صرف كارتة'),
  'Vehicle movements retain receipt-row payment deposits with clear positive direction');

const emptyHtml = ledgerRenderer({ id: 'owner-1', type: 'owner' }, []);
ok(emptyHtml.includes('لا توجد حركات مالية حتى الآن'),
  'Empty vehicle ledger renders the redesigned empty state instead of a bare table row');

console.log(failures === 0
  ? '\n✅ ALL VEHICLE-DETAILS-UI ASSERTIONS PASSED'
  : `\n❌ ${failures} VEHICLE-DETAILS-UI FAILURES`);
process.exit(failures === 0 ? 0 : 1);
