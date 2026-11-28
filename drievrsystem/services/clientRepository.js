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
  async saveOwner(payload) {
    return DBProvider.save('vehicleOwners', payload);
  },
  async updateOwner(id, patch) {
    return DBProvider.update('vehicleOwners', id, patch);
  },
  async deleteOwner(id) {
    return DBProvider.delete('vehicleOwners', id);
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
  async saveVehicle(payload) {
    return DBProvider.save('vehicles', payload);
  },
  async updateVehicle(id, patch) {
    return DBProvider.update('vehicles', id, patch);
  },
  async deleteVehicle(id) {
    return DBProvider.delete('vehicles', id);
  },

  // ── Drivers ─────────────────────────────────────────────────────────────
  async getDriverById(id, { tx } = {}) {
    const normId = typeof id === 'string' && !isNaN(Number(id)) ? Number(id) : id;
    return (tx ? tx.getById('drivers', normId) : DBProvider.get('drivers', normId));
  },
  async getDrivers() {
    return DBProvider.getAll('drivers');
  },
  async saveDriver(payload) {
    return DBProvider.save('drivers', payload);
  },
  async addDriver(payload) {
    return DBProvider.save('drivers', payload);
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
  async createDriverUnique(name) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed)  throw new Error('[ClientRepository:createDriverUnique] name is required.');
    const list = (await this.getDrivers())
      .filter(d => d && d.deleted_at == null);
    const existing = list.find(d => String(d.name || '').trim() === trimmed)
      || list.find(d => normalizeDriverName(d.name) === normalizeDriverName(trimmed));
    if (existing) return existing;
    return this.saveDriver({ name: trimmed, phone: null });
  },
  async updateDriver(id, patch) {
    const normId = typeof id === 'string' && !isNaN(Number(id)) ? Number(id) : id;
    return DBProvider.update('drivers', normId, patch);
  },
  async deleteDriver(id) {
    const normId = typeof id === 'string' && !isNaN(Number(id)) ? Number(id) : id;
    return DBProvider.delete('drivers', normId);
  },
};
