import { DBProvider } from './dbProvider.js';
import { createPersistenceCommand, PersistenceCommandType } from './persistenceCommand.js';

// Patch builder for Update commands: the record's own key and any
// undefined-valued fields must not overwrite stored data on merge.
function _toPatch(record) {
  const patch = {};
  for (const [k, v] of Object.entries(record || {})) {
    if (k === 'id') continue;
    if (v === undefined) continue;
    patch[k] = v;
  }
  return patch;
}

export const ReceiptRepository = {
  // ── Receipt operations ─────────────────────────────────────────────
  async getById(id, { tx } = {}) {
    return tx
      ? tx.getById('receipts', id)
      : DBProvider.get('receipts', id);
  },

  async getAll(username, { tx } = {}) {
    return tx
      ? tx.getAll('receipts', { username })
      : DBProvider.getAll('receipts', { username });
  },

  async update(id, patch, meta) {
    return DBProvider.update('receipts', id, patch, meta);
  },

  // ── Persistence Command Preparation (Frozen Architecture) ───────────
  // type defaults to ADD so create-flow call sites stay unchanged.
  // Update carries a sanitized patch; Delete carries id only.
  // (Previously hard-coded 'Add' — which made update flows collide on
  // existing keys and made delete flows INSERT phantom records.)
  prepareReceiptOperation(receipt, meta = {}, type = PersistenceCommandType.ADD) {
    if (type === PersistenceCommandType.UPDATE) {
      return createPersistenceCommand(type, 'Receipt', receipt.id, { patch: _toPatch(receipt), meta });
    }
    if (type === PersistenceCommandType.DELETE) {
      return createPersistenceCommand(type, 'Receipt', receipt.id, { meta });
    }
    return createPersistenceCommand(PersistenceCommandType.ADD, 'Receipt', receipt.id, { payload: receipt, meta });
  },

  prepareReceiptRowOperations(rows, meta = {}, type = PersistenceCommandType.ADD) {
    return rows.map(row => {
      if (type === PersistenceCommandType.UPDATE) {
        return createPersistenceCommand(type, 'ReceiptRow', row.row_id, { patch: _toPatch(row), meta });
      }
      if (type === PersistenceCommandType.DELETE) {
        return createPersistenceCommand(type, 'ReceiptRow', row.row_id, { meta });
      }
      return createPersistenceCommand(PersistenceCommandType.ADD, 'ReceiptRow', row.row_id, { payload: row, meta });
    });
  },

  // ── ReceiptRow operations ──────────────────────────────────────────
  async getRowById(rowId, { tx } = {}) {
    return tx
      ? tx.getById('receipt_rows', rowId)
      : DBProvider.get('receipt_rows', rowId);
  },

  async getRowsByReceipt(receiptId, { tx } = {}) {
    if (tx) {
      return tx.findByFields('receipt_rows', { receipt_id: receiptId });
    }
    return DBProvider.findByFields('receipt_rows', { receipt_id: receiptId });
  },

};