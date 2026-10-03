import { DBProvider } from './dbProvider.js';
import { PersistenceCommandType } from './persistenceCommand.js';

// ── Explicit aggregate → physical store map ────────────────────────────────
// Store names are a data-layer detail and MUST NOT be derived from aggregate
// names (the previous `aggregate.toLowerCase() + 's'` derivation produced
// 'receiptrows' / 'ledgers', which do not exist — every
// transaction was rejected with "[DB] Invalid store").
const AGGREGATE_STORES = Object.freeze({
  Receipt    : 'receipts',
  ReceiptRow : 'receipt_rows',
  Ledger     : 'vehicle_ledger',
  LoadPrice  : 'loadPrices',
});

function _resolveStore(aggregate) {
  const store = AGGREGATE_STORES[aggregate];
  if (!store) {
    throw new Error(
      `[WriteDataSource] Unknown aggregate "${aggregate}". ` +
      `Expected one of: ${Object.keys(AGGREGATE_STORES).join(', ')}.`
    );
  }
  return store;
}

function _toDbOp(cmd) {
  const store = _resolveStore(cmd?.aggregate);
  switch (cmd?.type) {
    case PersistenceCommandType.ADD:
      return { op: 'add',    store, payload: cmd.payload };
    case PersistenceCommandType.UPDATE:
      return { op: 'update', store, id: cmd.id, patch: cmd.patch };
    case PersistenceCommandType.DELETE:
      return { op: 'delete', store, id: cmd.id };
    default:
      throw new Error(`[WriteDataSource] Unknown command type: ${cmd?.type}`);
  }
}

export const WriteDataSource = {
  /**
   * Execute an ordered list of PersistenceCommands atomically.
   * - Commands are converted to DB batch ops via the explicit store map.
   * - One DB.transaction() per execute() call (single atomic commit).
   * - meta ({ username }) is propagated to the DB layer for audit injection.
   */
  async execute(commands, meta) {
    if (!Array.isArray(commands) || commands.length === 0) {
      return [];
    }

    const ops = commands.map(_toDbOp);

    return DBProvider.transaction(ops, meta);
  },

  /**
   * Execute the existing PersistenceCommand contract inside a transaction
   * already opened by a FinancialService lifecycle guard. This avoids a
   * check-then-write gap while preserving the same aggregate/store mapping.
   */
  async executeWithinTransaction(tx, commands) {
    if (!tx || typeof tx.runOps !== 'function') {
      throw new Error('[WriteDataSource] transaction context with runOps is required.');
    }
    if (!Array.isArray(commands) || commands.length === 0) {
      return [];
    }
    return tx.runOps(commands.map(_toDbOp));
  }
};
