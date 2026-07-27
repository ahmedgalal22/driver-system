import { ReadDataSource } from './readDataSource.js';

export const DriverKartaReadRepository = {
  async getDriverKartasData(driverId, { tx } = {}) {
    // Get all receipt rows for this driver
    const rows = await ReadDataSource.findByFields(
      'receipt_rows',
      { driver_id: driverId },
      {},
      { tx }
    );

    if (!rows.length) return [];

    // Get unique receipt IDs
    const receiptIds = [...new Set(rows.map(r => r.receipt_id))];

    // Fetch receipt headers in parallel
    const receiptPromises = receiptIds.map(id =>
      ReadDataSource.getById('receipts', id, { tx })
    );
    const receipts = await Promise.all(receiptPromises);

    // Create receipt lookup map
    const receiptMap = new Map();
    receipts.forEach(receipt => {
      if (receipt) receiptMap.set(receipt.id, receipt);
    });

    // Build projection data
    return rows.map(row => {
      const receipt = receiptMap.get(row.receipt_id);
      return {
        row,
        receipt: receipt ? {
          id: receipt.id,
          receipt_number: receipt.receipt_number,
          receipt_date: receipt.receipt_date
        } : null
      };
    });
  }
};