// idb-shim.mjs — minimal, faithful IndexedDB subset sufficient for database.js.
// Implements: indexedDB.open (with onupgradeneeded), object stores with
// keyPath/autoIncrement, unique ConstraintError, indexes with getAll,
// single & multi-store transactions with oncomplete/onabort semantics.

function keyOf(def, record) { return record?.[def.keyPath]; }
function idxVal(kp, record) { return Array.isArray(kp) ? kp.map(k => record[k]) : record[kp]; }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

class FakeError extends Error { constructor(name, msg) { super(msg); this.name = name; } }

class FakeRequest {
  constructor(executor, tx) {
    this.onsuccess = null; this.onerror = null;
    this.result = undefined; this.error = null;
    if (tx) tx._pending++;
    queueMicrotask(() => {
      try {
        this.result = executor();
        const h = this.onsuccess;
        h && h({ target: this });
        if (tx) tx._done();
      } catch (e) {
        this.error = (e && e.name) ? e : new FakeError('AbortError', String(e?.message || e));
        const h = this.onerror;
        if (h) h({ target: this });
        if (tx) tx._done();
      }
    });
  }
}

class FakeKeyRange { constructor(value) { this.__kr = true; this.value = value; } }

class FakeIndex {
  constructor(store, def) { this.store = store; this.def = def; }
  getAll(key) {
    const val = (key instanceof FakeKeyRange) ? key.value : key;
    return new FakeRequest(() => {
      const all = [...this.store.records.values()];
      const out = (val === undefined) ? all : all.filter(r => eq(idxVal(this.def.keyPath, r), val));
      return out.map(v => structuredClone(v));
    }, this.store._tx);
  }
}

class FakeStore {
  constructor(def) { this.def = def; this.name = def.name; this.records = new Map(); this.auto = 0; this.indexDefs = new Map(); this._tx = null; }
  _withTx(tx) { this._tx = tx; return this; } // single sequential tx at a time — safe
  createIndex(name, keyPath, options = {}) { this.indexDefs.set(name, { name, keyPath, options }); }
  index(name) {
    const def = this.indexDefs.get(name);
    if (!def) throw new FakeError('NotFoundError', `index ${name} not found in ${this.name}`);
    return new FakeIndex(this._withTx(this._tx), def);
  }
  get(id)   { return new FakeRequest(() => { const r = this.records.get(id); return r ? structuredClone(r) : undefined; }, this._tx); }
  getAll()  { return new FakeRequest(() => [...this.records.values()].map(v => structuredClone(v)), this._tx); }
  add(rec)  {
    return new FakeRequest(() => {
      const r = structuredClone(rec);
      let key = keyOf(this.def, r);
      if (key == null) {
        if (!this.def.autoIncrement) throw new FakeError('DataError', 'no key provided');
        key = ++this.auto; r[this.def.keyPath] = key;
      } else if (this.def.autoIncrement && typeof key === 'number' && key > this.auto) this.auto = key;
      if (this.records.has(key)) throw new FakeError('ConstraintError', `ConstraintError: duplicate key ${key} in ${this.name}`);
      // unique index enforcement
      for (const def of this.indexDefs.values()) {
        if (!def.options?.unique) continue;
        const v = idxVal(def.keyPath, r);
        if (v === undefined) continue;
        for (const other of this.records.values()) if (eq(idxVal(def.keyPath, other), v)) throw new FakeError('ConstraintError', `ConstraintError: unique index ${def.name}`);
      }
      this.records.set(key, r);
      return key;
    }, this._tx);
  }
  put(rec)  {
    return new FakeRequest(() => {
      const r = structuredClone(rec);
      let key = keyOf(this.def, r);
      if (key == null) { if (!this.def.autoIncrement) throw new FakeError('DataError', 'no key'); key = ++this.auto; r[this.def.keyPath] = key; }
      this.records.set(key, r);
      return key;
    }, this._tx);
  }
  delete(id){ return new FakeRequest(() => { this.records.delete(id); return undefined; }, this._tx); }
}

class FakeStoreNameList extends Array { contains(n) { return this.includes(n); } }

class FakeTx {
  constructor(db, storeNames, mode) {
    this.db = db; this.storeNames = storeNames; this.mode = mode;
    this._pending = 0; this._settled = false; this._errored = false;
    this.oncomplete = null; this.onerror = null; this.onabort = null; this.error = null;
  }
  objectStore(name) {
    const s = this.db.stores.get(name);
    if (!s || !this.storeNames.includes(name)) throw new FakeError('NotFoundError', `NotFoundError: store "${name}" not in transaction`);
    return s._withTx(this);
  }
  _done() {
    this._pending--;
    if (this._pending === 0 && !this._settled && !this._errored) queueMicrotask(() => {
      if (!this._settled && !this._errored) { this._settled = true; this.oncomplete && this.oncomplete({ target: this }); }
    });
  }
  _fail(err) { if (!this._errored) { this._errored = true; this.error = err; } }
  abort() {
    if (this._settled) return;
    this._settled = true;
    queueMicrotask(() => { this.onabort && this.onabort({ target: this }); });
  }
}

class FakeDB {
  constructor(name) { this.name = name; this.stores = new Map(); this.objectStoreNames = new FakeStoreNameList(); this.onversionchange = null; }
  createObjectStore(name, opts) {
    const s = new FakeStore({ name, keyPath: opts.keyPath, autoIncrement: !!opts.autoIncrement });
    this.stores.set(name, s); this.objectStoreNames.push(name);
    return s;
  }
  deleteObjectStore(name) {
    this.stores.delete(name);
    const i = this.objectStoreNames.indexOf(name); if (i >= 0) this.objectStoreNames.splice(i, 1);
  }
  transaction(storeNames, mode) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    for (const n of names) if (!this.stores.has(n)) throw new FakeError('NotFoundError', `NotFoundError: unknown store "${n}"`);
    return new FakeTx(this, names, mode);
  }
  close() {}
}

const _dbs = new Map();

export function installIDB() {
  globalThis.IDBKeyRange = { only: (v) => new FakeKeyRange(v) };
  globalThis.indexedDB = {
    open(name, _version) {
      const req = new FakeRequest(() => {
        let db = _dbs.get(name);
        const isNew = !db;
        if (isNew) { db = new FakeDB(name); _dbs.set(name, db); }
        req.result = db;
        if (isNew) queueMicrotask(() => req.onupgradeneeded && req.onupgradeneeded({ target: req }));
        return db;
      });
      return req;
    }
  };
}
