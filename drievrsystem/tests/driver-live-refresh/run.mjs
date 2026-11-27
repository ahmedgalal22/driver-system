// Focused regression: Receipt Form driver selection is identified by stable
// driver ID, never display text. Browser-coupled functions are extracted
// verbatim from receipts.js and run against the smallest DOM double needed.
import { readFileSync } from 'node:fs';

const SRC = readFileSync('./_src/receipts.js', 'utf8');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};

function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`extractFn: ${name} not found`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;

  // Find the function body, not an object-destructuring brace in its parameters.
  let parenDepth = 0;
  let brace = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')') parenDepth--;
    else if (src[i] === '{' && parenDepth === 0) { brace = i; break; }
  }
  if (brace < 0) throw new Error(`extractFn: ${name} body not found`);

  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`extractFn: ${name} has unbalanced braces`);
}

const renamedDriverId = 'driver-a';
const sameDisplayNameDriverId = 'driver-b';
const rows = [
  { value: 'أحمد', dataset: { driverId: renamedDriverId } },
  { value: 'أحمد', dataset: { driverId: sameDisplayNameDriverId } },
  { value: 'أحمد', dataset: {} },
  { value: 'محذوف', dataset: { driverId: 'removed-driver' } },
];
const document = {
  querySelectorAll(selector) {
    if (selector !== '#receiptTableBody .receipt-data') throw new Error(`unexpected selector: ${selector}`);
    return rows;
  },
};
const refreshedDrivers = [
  { id: renamedDriverId, name: 'أحمد علي' },
  { id: sameDisplayNameDriverId, name: 'أحمد' },
];

const refreshScope = new Function('document', 'refreshedDrivers', `
  let _receiptDriversCache = [];
  let loadCalls = 0;
  async function _receiptLoadDriverOptions() {
    loadCalls++;
    _receiptDriversCache = refreshedDrivers.map(driver => ({ ...driver }));
  }
  const _driverAC = { open: false, input: null, items: [], active: -1 };
  const _driverACRankedItems = () => [];
  const _driverACRender = () => {};
  const _driverACPosition = () => {};
  ${extractFn(SRC, '_receiptRefreshDriverOptions')}
  return {
    refresh: _receiptRefreshDriverOptions,
    loadCalls: () => loadCalls,
  };
`)(document, refreshedDrivers);

console.log('\n— stable-ID rename propagation —');
await refreshScope.refresh({
  driverId: renamedDriverId,
  driverName: 'أحمد علي',
  previousName: 'أحمد',
});
ok(refreshScope.loadCalls() === 1, 'drivers:changed refresh reloads the autocomplete cache once');
ok(rows[0].value === 'أحمد علي' && rows[0].dataset.driverId === renamedDriverId,
  'the row selected as the renamed driver updates its display name and retains its ID');
ok(rows[1].value === 'أحمد' && rows[1].dataset.driverId === sameDisplayNameDriverId,
  'a different selected driver with the identical old display name is not renamed');
ok(rows[2].value === 'أحمد' && !rows[2].dataset.driverId,
  'an unselected text-only row with the identical old display name is not renamed');
ok(rows[3].value === '' && !rows[3].dataset.driverId,
  'a stale stable selection is cleared when its driver no longer exists');

console.log('\n— stable-ID selection maintenance —');
const acInput = {
  value: '',
  dataset: {},
  focusCalls: 0,
  focus() { this.focusCalls++; },
};
const commitScope = new Function('input', `
  const _driverAC = { input };
  let closed = 0;
  function _driverACClose() { closed++; _driverAC.input = null; }
  ${extractFn(SRC, '_driverACCommit')}
  return { commit: _driverACCommit, closed: () => closed };
`)(acInput);
commitScope.commit({ d: { id: renamedDriverId, name: 'أحمد علي' } });
ok(acInput.value === 'أحمد علي' && acInput.dataset.driverId === renamedDriverId,
  'autocomplete commit stores the selected stable driver ID on the input');
ok(acInput.focusCalls === 1 && commitScope.closed() === 1,
  'autocomplete commit retains its existing close-and-refocus behavior');

const clearScope = new Function(`
  let _receiptDriversCache = [{ id: '${renamedDriverId}', name: 'أحمد علي' }];
  ${extractFn(SRC, '_clearReceiptDriverSelectionOnInput')}
  return _clearReceiptDriverSelectionOnInput;
`)();
const changedInput = { value: 'أحمد مختلف', dataset: { driverId: renamedDriverId } };
clearScope(changedInput);
ok(!changedInput.dataset.driverId,
  'editing a selected driver input clears its stale stable ID');
const unchangedInput = { value: 'أحمد علي', dataset: { driverId: renamedDriverId } };
clearScope(unchangedInput);
ok(unchangedInput.dataset.driverId === renamedDriverId,
  'an unchanged selected driver input retains its stable ID');

console.log('\n— event and edit-load contracts —');
ok(/window\.addEventListener\('drivers:changed',\s*\(event\)\s*=>\s*\{\s*_receiptRefreshDriverOptions\(event\.detail \|\| \{\}\)/.test(SRC),
  'module-level drivers:changed listener forwards event.detail to the existing refresh helper');
ok(SRC.includes('driverInput.dataset.driverId = String(rowData.driver_id);'),
  'loading an existing receipt restores its persisted driver ID onto the row input');
ok(SRC.includes('input.dataset.driverId = String(record.id);'),
  'receipt-side quick-create stores the newly selected driver ID on the row input');

if (failures) {
  console.error(`\n❌ ${failures} DRIVER LIVE-REFRESH ASSERTION(S) FAILED`);
  process.exit(1);
}
console.log('\n✅ ALL DRIVER LIVE-REFRESH ASSERTIONS PASSED');
