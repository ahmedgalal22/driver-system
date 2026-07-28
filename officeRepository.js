import { DBProvider } from './dbProvider.js';

export const OfficeRepository = {
  async getById(id, { tx } = {}) {
    const normId = typeof id === 'string' && !isNaN(Number(id)) ? Number(id) : id;
    return (tx ? tx.getById('offices', normId) : DBProvider.get('offices', normId));
  },
  async getAll(username) {
    return DBProvider.findByFields('offices', { username });
  },
  async findByFields(filters) {
    return DBProvider.findByFields('offices', filters);
  },
  async save(payload, meta) {
    return DBProvider.save('offices', payload, meta);
  },
  async update(id, patch, meta) {
    return DBProvider.update('offices', String(id), patch, meta);
  },
  async delete(id, meta) {
    return DBProvider.delete('offices', String(id), meta);
  },
  async transaction(ops, meta) {
    return DBProvider.transaction(ops, meta);
  },
};
