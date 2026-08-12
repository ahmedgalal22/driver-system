import { DBProvider } from './dbProvider.js';
import { createPersistenceCommand, PersistenceCommandType } from './persistenceCommand.js';

export const LoadPriceRepository = {
  async getAll() {
    return DBProvider.getAll('loadPrices');
  },

  async getById(id) {
    return DBProvider.get('loadPrices', id);
  },

  async findActiveByCanonicalRoute(canonicalRoute) {
    if (!canonicalRoute) return null;
    const matches = await DBProvider.getByIndex('loadPrices', 'by_canonical_route', canonicalRoute);
    return matches[0] || null;
  },

  prepareCreate(record, meta = {}) {
    return createPersistenceCommand(PersistenceCommandType.ADD, 'LoadPrice', record.id, {
      payload: record,
      meta,
    });
  },

  async updatePrice(id, price, meta) {
    return DBProvider.update('loadPrices', id, { price }, meta);
  },

  async delete(id, meta) {
    if (!meta?.username) throw new Error('[LoadPriceRepository:delete] username is required.');
    return DBProvider.transaction(async (tx) => {
      const route = await tx.getById('loadPrices', id);
      if (!route) throw new Error('[LoadPriceRepository:delete] route not found.');
      // `undefined` removes the record from the unique active-route index while
      // preserving the soft-deleted audit record for future recreation.
      return tx.delete('loadPrices', id, { canonical_route: undefined });
    }, { username: meta.username, stores: ['loadPrices'] });
  },
};
