import { DBProvider } from './dbProvider.js';

export const TreasuryRepository = {
  async getById(id) {
    return DBProvider.get('treasury', id);
  },
  async getAll(username) {
    return DBProvider.getAll('treasury', { username });
  },
};
