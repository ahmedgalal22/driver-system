import { ReadDataSource } from './readDataSource.js';

export const ReceiptReadRepository = {
  async getReceiptWithRows(receiptId, { tx } = {}) {
    const receipt = await ReadDataSource.getById('receipts', receiptId, { tx });
    if (!receipt) return null;

    const rows = await ReadDataSource.findByFields(
      'receipt_rows',
      { receipt_id: receiptId },
      {},
      { tx }
    );

    return { receipt, rows };
  },

  async getReceiptsByClient(clientId, { tx } = {}) {
    return ReadDataSource.findByFields(
      'receipts',
      { client_id: clientId },
      {},
      { tx }
    );
  },

  async getReceiptRowsByReceipt(receiptId, { tx } = {}) {
    return ReadDataSource.findByFields(
      'receipt_rows',
      { receipt_id: receiptId },
      {},
      { tx }
    );
  },

  async getReceiptRowsByDriver(driverId, { tx } = {}) {
    return ReadDataSource.findByFields(
      'receipt_rows',
      { driver_id: driverId },
      {},
      { tx }
    );
  }
};