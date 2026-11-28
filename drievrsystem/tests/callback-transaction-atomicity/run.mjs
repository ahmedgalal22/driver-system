import { installIDB } from './idb-shim.mjs';
installIDB();
const { DB } = await import('./database.js');
let failures = 0;
function ok(cond, label) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; }

await DB.init();

// helper to clean up test ids
async function clean(ids) {
  for (const id of ids) {
    try { await DB.hardDelete('drivers', id); } catch {}
  }
}

console.log('\n— tx.delete patch with throwing getter —');
{
  const existingId = 'atomic-existing-1';
  await DB.add('drivers', { id: existingId, name: 'existing' });
  let caughtInside = false;
  let outerFailed = false;
  try {
    await DB.transaction(async (tx) => {
      await tx.add('drivers', { id: 'atomic-new-1', name: 'new1' });
      try {
        const boomPatch = { get boom() { throw new Error('getter boom'); } };
        await tx.delete('drivers', existingId, boomPatch);
      } catch (e) { caughtInside = true; }
      try { await tx.add('drivers', { id: 'atomic-new-2', name: 'new2' }); } catch {}
    }, { stores: ['drivers'] });
  } catch (e) { outerFailed = true; }
  const new1 = await DB.getById('drivers', 'atomic-new-1');
  const new2 = await DB.getById('drivers', 'atomic-new-2');
  const existing = await DB.getById('drivers', existingId);
  ok(outerFailed && caughtInside && !new1 && !new2 && existing && existing.deleted_at === null,
    'tx.delete patch with throwing getter aborts and rolls back earlier writes even when caught');
  await clean([existingId, 'atomic-new-1', 'atomic-new-2']);
}

console.log('\n— tx.delete patch with throwing Proxy trap —');
{
  const existingId = 'atomic-existing-2';
  await DB.add('drivers', { id: existingId, name: 'existing' });
  let caughtInside = false;
  let outerFailed = false;
  try {
    await DB.transaction(async (tx) => {
      await tx.add('drivers', { id: 'atomic-new-3', name: 'new3' });
      try {
        const proxyPatch = new Proxy({ note: 'proxy' }, {
          ownKeys() { throw new Error('proxy boom'); }
        });
        await tx.delete('drivers', existingId, proxyPatch);
      } catch (e) { caughtInside = true; }
      try { await tx.add('drivers', { id: 'atomic-new-4', name: 'new4' }); } catch {}
    }, { stores: ['drivers'] });
  } catch (e) { outerFailed = true; }
  const new3 = await DB.getById('drivers', 'atomic-new-3');
  const new4 = await DB.getById('drivers', 'atomic-new-4');
  const existing = await DB.getById('drivers', existingId);
  ok(outerFailed && caughtInside && !new3 && !new4 && existing && existing.deleted_at === null,
    'tx.delete patch with throwing Proxy aborts and rolls back even when caught');
  await clean([existingId, 'atomic-new-3', 'atomic-new-4']);
}

console.log('\n— tx.update patch with throwing getter —');
{
  const existingId = 'atomic-existing-3';
  await DB.add('drivers', { id: existingId, name: 'orig' });
  let caughtInside = false;
  let outerFailed = false;
  try {
    await DB.transaction(async (tx) => {
      await tx.add('drivers', { id: 'atomic-new-5', name: 'new5' });
      try {
        const boomPatch = { get bad() { throw new Error('getter boom update'); } };
        await tx.update('drivers', existingId, boomPatch);
      } catch (e) { caughtInside = true; }
      try { await tx.add('drivers', { id: 'atomic-new-6', name: 'new6' }); } catch {}
    }, { stores: ['drivers'] });
  } catch (e) { outerFailed = true; }
  const new5 = await DB.getById('drivers', 'atomic-new-5');
  const new6 = await DB.getById('drivers', 'atomic-new-6');
  const existing = await DB.getById('drivers', existingId);
  ok(outerFailed && caughtInside && !new5 && !new6 && existing && existing.name === 'orig',
    'tx.update patch with throwing getter aborts and rolls back');
  await clean([existingId, 'atomic-new-5', 'atomic-new-6']);
}

console.log('\n— tx.update patch with throwing Proxy trap —');
{
  const existingId = 'atomic-existing-4';
  await DB.add('drivers', { id: existingId, name: 'orig' });
  let caughtInside = false;
  let outerFailed = false;
  try {
    await DB.transaction(async (tx) => {
      await tx.add('drivers', { id: 'atomic-new-7', name: 'new7' });
      try {
        const proxyPatch = new Proxy({ name: 'evil' }, {
          get(target, prop) { if (prop === 'name') throw new Error('proxy get boom'); return target[prop]; },
          ownKeys(target) { return Reflect.ownKeys(target); }
        });
        await tx.update('drivers', existingId, proxyPatch);
      } catch (e) { caughtInside = true; }
      try { await tx.add('drivers', { id: 'atomic-new-8', name: 'new8' }); } catch {}
    }, { stores: ['drivers'] });
  } catch (e) { outerFailed = true; }
  const new7 = await DB.getById('drivers', 'atomic-new-7');
  const new8 = await DB.getById('drivers', 'atomic-new-8');
  const existing = await DB.getById('drivers', existingId);
  ok(outerFailed && caughtInside && !new7 && !new8 && existing && existing.name === 'orig',
    'tx.update patch with throwing Proxy aborts and rolls back');
  await clean([existingId, 'atomic-new-7', 'atomic-new-8']);
}

console.log('\n— invalid store access inside callback —');
{
  const existingId = 'atomic-existing-5';
  await DB.add('drivers', { id: existingId, name: 'orig' });
  let caughtInside = false;
  let outerFailed = false;
  try {
    await DB.transaction(async (tx) => {
      await tx.add('drivers', { id: 'atomic-new-9', name: 'new9' });
      try {
        await tx.getAll('nonexistent-store-xyz');
      } catch (e) { caughtInside = true; }
      try { await tx.add('drivers', { id: 'atomic-new-10', name: 'new10' }); } catch {}
    }, { stores: ['drivers', 'nonexistent-store-xyz'] });
  } catch (e) { outerFailed = true; }
  // Note: invalid store in storesHint should be caught before transaction creation, but we test txStore invalid access
  // Alternative: try inside with valid storesHint but invalid store name
  let caughtInside2 = false;
  let outerFailed2 = false;
  try {
    await DB.transaction(async (tx) => {
      await tx.add('drivers', { id: 'atomic-new-11', name: 'new11' });
      try {
        await tx.getAll('invalidStoreName');
      } catch (e) { caughtInside2 = true; }
      try { await tx.add('drivers', { id: 'atomic-new-12', name: 'new12' }); } catch {}
    }, { stores: ['drivers'] });
  } catch (e) { outerFailed2 = true; }
  const new11 = await DB.getById('drivers', 'atomic-new-11');
  const new12 = await DB.getById('drivers', 'atomic-new-12');
  ok(outerFailed2 && caughtInside2 && !new11 && !new12,
    'invalid store access inside callback aborts and rolls back even when caught');
  await clean([existingId, 'atomic-new-9', 'atomic-new-10', 'atomic-new-11', 'atomic-new-12']);
  // Cleanup existing if needed
  await clean([existingId]);
}

console.log('\n— failed runOps call caught inside callback —');
{
  const existingId = 'atomic-existing-6';
  await DB.add('drivers', { id: existingId, name: 'orig' });
  let caughtInside = false;
  let outerFailed = false;
  try {
    await DB.transaction(async (tx) => {
      await tx.add('drivers', { id: 'atomic-new-13', name: 'new13' });
      try {
        await tx.runOps([{ op: 'add', store: 'drivers', payload: { id: 'atomic-new-14', name: 'new14' } }, { op: 'add', store: 'nonexistent', payload: { id: 'x' } }]);
      } catch (e) { caughtInside = true; }
      try { await tx.add('drivers', { id: 'atomic-new-15', name: 'new15' }); } catch {}
    }, { stores: ['drivers'] });
  } catch (e) { outerFailed = true; }
  const new13 = await DB.getById('drivers', 'atomic-new-13');
  const new14 = await DB.getById('drivers', 'atomic-new-14');
  const new15 = await DB.getById('drivers', 'atomic-new-15');
  ok(outerFailed && caughtInside && !new13 && !new14 && !new15,
    'failed runOps caught inside callback still aborts entire transaction');
  await clean([existingId, 'atomic-new-13', 'atomic-new-14', 'atomic-new-15']);
}

console.log('\n— callback catches failure and attempts another write —');
{
  const existingId = 'atomic-existing-7';
  await DB.add('drivers', { id: existingId, name: 'orig' });
  let caughtInside = false;
  let outerFailed = false;
  let secondWriteAttempted = false;
  try {
    await DB.transaction(async (tx) => {
      await tx.add('drivers', { id: 'atomic-new-16', name: 'new16' });
      try {
        const boomPatch = { get bad() { throw new Error('boom for catch test'); } };
        await tx.delete('drivers', existingId, boomPatch);
      } catch (e) { caughtInside = true; }
      secondWriteAttempted = true;
      try {
        await tx.add('drivers', { id: 'atomic-new-17', name: 'new17' });
      } catch {}
    }, { stores: ['drivers'] });
  } catch (e) { outerFailed = true; }
  const new16 = await DB.getById('drivers', 'atomic-new-16');
  const new17 = await DB.getById('drivers', 'atomic-new-17');
  const existing = await DB.getById('drivers', existingId);
  ok(outerFailed && caughtInside && secondWriteAttempted && !new16 && !new17 && existing && existing.deleted_at === null,
    'callback that catches failure and attempts another write still results in outer reject and rollback');
  await clean([existingId, 'atomic-new-16', 'atomic-new-17']);
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL CALLBACK ATOMICITY ASSERTIONS PASSED');
process.exit(failures ? 1 : 0);
