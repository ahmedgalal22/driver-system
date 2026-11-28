import { DBProvider } from './dbProvider.js';

/**
 * Persistence boundary for the embedded Dashboard Capital Treasury section.
 */
export const DashboardRepository = {
  async getCapitalTransactions() {
    const all = await DBProvider.getAll('mainCapitalTreasury');
    return all.filter(t => t && t.deleted_at === null);
  },
  async saveTransaction(payload) {
    return DBProvider.save('mainCapitalTreasury', payload);
  },
  async deleteTransaction(id) {
    return DBProvider.delete('mainCapitalTreasury', id);
  },
};
