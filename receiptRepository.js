import { DBProvider } from './dbProvider.js';

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

  async save(payload, meta) {
    return DBProvider.save('receipts', payload, meta);
  },

  async update(id, patch, meta) {
    return DBProvider.update('receipts', id, patch, meta);
  },

  async delete(id, meta) {
    return DBProvider.delete('receipts', id, meta);
  },

  // ── Persistence Command Preparation (Frozen Architecture) ───────────
  prepareReceiptOperation(receipt, meta = {}) {
    return {
      type: 'Add',
      aggregate: 'Receipt',
      id: receipt.id,
      payload: receipt,
      meta
    };
  },

  prepareReceiptRowOperations(rows, meta = {}) {
    return rows.map(row => ({
      type: 'Add',
      aggregate: 'ReceiptRow',
      id: row.row_id,
      payload: row,
      meta
    }));
  }

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

  async getRowsByDriver(driverId, { tx } = {}) {
    if (tx) {
      return tx.findByFields('receipt_rows', { driver_id: driverId });
    }
    return DBProvider.findByFields('receipt_rows', { driver_id: driverId });
  },

  async saveRow(payload, meta) {
    return DBProvider.save('receipt_rows', payload, meta);
  },

  async updateRow(rowId, patch, meta) {
    return DBProvider.update('receipt_rows', rowId, patch, meta);
  },

  // ── Cross-store transaction support ────────────────────────────────
  async transaction(ops, meta) {
    return DBProvider.transaction(ops, meta);
  }
};