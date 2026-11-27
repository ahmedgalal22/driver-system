import { DBProvider } from './dbProvider.js';
import { normalizeDriverName } from './nameNorm.js';

export const ClientRepository = {
  // ── Vehicle Owners ──────────────────────────────────────────────────────
  async getOwnerById(id, { tx } = {}) {
    const normId = typeof id === 'string' && !isNaN(Number(id)) ? Number(id) : id;
    return (tx ? tx.getById('vehicleOwners', normId) : DBProvider.get('vehicleOwners', normId));
  },
  async getAllOwners() {
    return DBProvider.getAll('vehicleOwners');
  },
  async findOwnersByNumber(vehicleNumber) {
    const n = String(vehicleNumber ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!n) return [];
    const all = await DBProvider.getAll('vehicleOwners');
    return all.filter((o) => {
      const vn = String(o.vehicle_number || o.name || '').trim().replace(/\s+/g, ' ').toLowerCase();
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
  /**
   * Duplicate-safe driver creation (quick-add flows, e.g. the receipt-row
   * driver autocomplete). Lookup ignores leading/trailing whitespace, multiple
   * consecutive spaces, Arabic diacritics/tatweel and the alef family
   * (أ / إ / آ / ٱ → ا) — visually identical drivers are never created twice.
   * Two-tier resolution: an exact (trimmed) name wins over a normalization-only
   * coincidence, so pre-existing near-duplicate records stay addressable.
   * Uses the exact saveDriver payload the owners/drivers page uses
   * (phone: null) — one creation path for the whole system.
   */
  async createDriverUnique(username, name) {
    const trimmed = String(name ?? '').trim();
    if (!username) throw new Error('[ClientRepository:createDriverUnique] username is required.');
    if (!trimmed)  throw new Error('[ClientRepository:createDriverUnique] name is required.');
    const list = (await this.getDriversForUser(username))
      .filter(d => d && d.deleted_at == null);
    const existing = list.find(d => String(d.name || '').trim() === trimmed)
      || list.find(d => normalizeDriverName(d.name) === normalizeDriverName(trimmed));
    if (existing) return existing;
    return this.saveDriver({ username, name: trimmed, phone: null }, { username });
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
