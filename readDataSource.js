import { DBProvider } from './dbProvider.js';

export const ReadDataSource = {
  async getById(storeName, id, { tx } = {}) {
    return tx
      ? tx.getById(storeName, id)
      : DBProvider.get(storeName, id);
  },

  async getAll(storeName, filters = null, { tx } = {}) {
    return tx
      ? tx.getAll(storeName, filters)
      : DBProvider.getAll(storeName, filters);
  },

  async findByFields(storeName, filters = {}, options = {}, { tx } = {}) {
    return tx
      ? tx.findByFields(storeName, filters, options)
      : DBProvider.findByFields(storeName, filters, options);
  },

  async getByIndex(storeName, indexName, value, options = {}, { tx } = {}) {
    return tx
      ? tx.getByIndex(storeName, indexName, value, options)
      : DBProvider.getByIndex(storeName, indexName, value);
  },

  async transaction(opsOrCallback, meta) {
    return DBProvider.transaction(opsOrCallback, meta);
  }
};