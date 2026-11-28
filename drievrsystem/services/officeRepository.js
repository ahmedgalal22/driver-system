import { DBProvider } from './dbProvider.js';

export const OfficeRepository = {
  async getById(id, { tx } = {}) {
    const normId = typeof id === 'string' && !isNaN(Number(id)) ? Number(id) : id;
    return (tx ? tx.getById('offices', normId) : DBProvider.get('offices', normId));
  },
  async getAll() {
    return DBProvider.getAll('offices');
  },
  // Company name is the offices master-data identity (unique by_name index);
  // the receipt-row payment engine resolves its اسم الشركة snapshot through this.
  async findByName(name) {
    return DBProvider.findByFields('offices', { name });
  },
  async update(id, patch) {
    return DBProvider.update('offices', String(id), patch);
  },
  async delete(id) {
    return DBProvider.delete('offices', String(id));
  },
  async transaction(ops, meta) {
    return DBProvider.transaction(ops, meta);
  },
};
