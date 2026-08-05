import { DBProvider } from './dbProvider.js';

export const ClientRepository = {
  // ── Vehicle Owners ──────────────────────────────────────────────────────
  async getOwnerById(id, { tx } = {}) {
    const normId = typeof id === 'string' && !isNaN(Number(id)) ? Number(id) : id;
    return (tx ? tx.getById('vehicleOwners', normId) : DBProvider.get('vehicleOwners', normId));
  },
  async getAllOwners() {
    return DBProvider.getAll('vehicleOwners');
  },
  async findOwnersByName(name) {
    const n = String(name ?? '').trim().toLowerCase();
    if (!n) return [];
    const all = await DBProvider.getAll('vehicleOwners');
    return all.filter((o) => {
      const vn = String(o.vehicle_name || o.name || '').trim().toLowerCase();
      return vn === n;
    });
  },
  async saveOwner(payload, meta) {
    return DBProvider.save('vehicleOwners', payload, meta);
  },
  async updateOwner(id, patch, meta) {
    return DBProvider.update('vehicleOwners', id, patch, meta);
  },
  async deleteOwner(id, meta) {
    return DBProvider.delete('vehicleOwners', id, meta);
  },

  // ── Vehicles ────────────────────────────────────────────────────────────
  async getVehicleById(id, { tx } = {}) {
    const normId = typeof id === 'string' && !isNaN(Number(id)) ? Number(id) : id;
    return (tx ? tx.getById('vehicles', normId) : DBProvider.get('vehicles', normId));
  },
  async getAllVehicles() {
    return DBProvider.getAll('vehicles');
  },
  async getVehiclesByPlate(plate) {
    return DBProvider.findByFields('vehicles', { plate });
  },
  async saveVehicle(payload, meta) {
    return DBProvider.save('vehicles', payload, meta);
  },
  async updateVehicle(id, patch, meta) {
    return DBProvider.update('vehicles', id, patch, meta);
  },
  async deleteVehicle(id, meta) {
    return DBProvider.delete('vehicles', id, meta);
  },

  // ── Drivers ─────────────────────────────────────────────────────────────
  async getDriverById(id, { tx } = {}) {
    const normId = typeof id === 'string' && !isNaN(Number(id)) ? Number(id) : id;
    return (tx ? tx.getById('drivers', normId) : DBProvider.get('drivers', normId));
  },
  async getDriversForUser(username) {
    return DBProvider.findByFields('drivers', { username });
  },
  async getDrivers(username) {
    return DBProvider.getByIndex('drivers', 'by_username', username);
  },
  async saveDriver(payload, meta) {
    return DBProvider.save('drivers', payload, meta);
  },
  async addDriver(payload, meta) {
    return DBProvider.save('drivers', payload, meta);
  },
  async updateDriver(id, patch, meta) {
    const normId = typeof id === 'string' && !isNaN(Number(id)) ? Number(id) : id;
    return DBProvider.update('drivers', normId, patch, meta);
  },
  async deleteDriver(id, meta) {
    const normId = typeof id === 'string' && !isNaN(Number(id)) ? Number(id) : id;
    return DBProvider.delete('drivers', normId, meta);
  },
};
