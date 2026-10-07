/**
 * financial.js — receipts, vehicle_ledger, shared financial operations
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN DECISION: Pre-generated UUID for receipts
 *   receipts.id is a UUID string (not autoIncrement integer).
 *   This lets us pass reference_id to vehicle_ledger entries
 *   BEFORE any insert fires — enabling a single atomic DB.transaction()
 *   across stores with zero orphan-record risk.
 *
 * RULE 2  : ALL money operations live here. Zero receipt/ledger writes elsewhere.
 * RULE 3  : Every operation executes inside ONE DB.transaction() call.
 * RULE 4  : update/delete MUST reverse old entries before applying new ones.
 * RULE 10 : receipt-row payment postings (تم صرفه) are durable vehicle_ledger
 *   entries with separate company/vehicle payment namespaces, both linked by
 *   reference_id = receipt row UUID; status transitions post/reverse only those
 *   payment effects atomically with the row write.
 * RULE 5  : Every financial record carries { reference_type, reference_id }.
 * RULE 6  : All monetary values are numbers — never strings.
 * RULE 9  : DB stores integers (cents). money.js handles all conversion.
 *
 * Reversal strategy: is_reversed: true  (NOT soft-delete)
 *   Reversed entries remain fully visible in the audit trail.
 *   Soft-delete (deleted_at) is reserved for user-initiated receipt deletion only.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { DB } from './database.js';
import { ClientRepository } from './services/clientRepository.js';
import { ReceiptRepository } from './services/receiptRepository.js';
import { OfficeRepository } from './services/officeRepository.js';
import { LoadPriceRepository } from './services/loadPriceRepository.js';
import { canonicalizeRoutePlace, canonicalRouteKey, displayRoutePlace } from './services/routeNameNorm.js';
import { WriteDataSource } from './services/writeDataSource.js';
import { createPersistenceCommand, PersistenceCommandType } from './services/persistenceCommand.js';
import { DriverKartaReadRepository } from './services/driverKartaReadRepository.js';
import { LedgerIntegrityDiagnosticService } from './services/ledgerIntegrityDiagnosticService.js';
import { Money } from './money.js';
import { DateUtils } from './dateUtils.js';

// ─── CONSTANTS ─────────────────────────────────────────────────────────────────

const STORE = Object.freeze({
  RECEIPTS : 'receipts',
  LEDGER   : 'vehicle_ledger',
  OFFICES  : 'offices',
});

// Manual vehicle movements use the same normalized vehicle_ledger and audit
// reversal convention as every other financial operation. They are deliberately
// distinct from receipt-row payments and Karta Settlement.
const MANUAL_VEHICLE_REF_TYPE = 'manual_vehicle_balance';
const MANUAL_VEHICLE_EFFECT = 'manual_vehicle_balance';
const MANUAL_OFFICE_REF_TYPE = 'manual_office_balance';
const MANUAL_OFFICE_EFFECT = 'manual_office_balance';
const MANUAL_DRIVER_REF_TYPE = 'manual_driver_balance';
const MANUAL_DRIVER_EFFECT = 'manual_driver_balance';
const RECEIPT_ROW_COMPANY_CHARGE_REF_TYPE = 'receipt_row_company_charge';
const RECEIPT_ROW_COMPANY_CHARGE_EFFECT = 'receipt_row_company_charge';

// Receipt-row financial lifecycle namespaces are deliberately independent:
// creation charge ≠ payment company effect ≠ payment vehicle effect.
const PAYMENT_STATUS = Object.freeze({ UNPAID: 'unpaid', PAID: 'paid' });
const RECEIPT_ROW_PAYMENT_COMPANY_REF_TYPE = 'receipt_row_payment_company';
const RECEIPT_ROW_PAYMENT_COMPANY_EFFECT = 'receipt_row_payment_company';
const RECEIPT_ROW_PAYMENT_VEHICLE_REF_TYPE = 'receipt_row_payment_vehicle';
const RECEIPT_ROW_PAYMENT_VEHICLE_EFFECT = 'receipt_row_payment_vehicle';


// ─── UUID GENERATOR ────────────────────────────────────────────────────────────

function _uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 0x0f;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─── INTERNAL HELPERS ──────────────────────────────────────────────────────────

function _storesForOps(ops, extra = []) {
  return [...new Set([
    ...extra,
    ...(Array.isArray(ops) ? ops.map((op) => op.store).filter(Boolean) : []),
  ])];
}

// ─── RECEIPT VALIDATION HELPERS ────────────────────────────────────────────────

function _validateReceiptHeader(data) {
  const client_id = data.client_id != null ? String(data.client_id).trim() : '';
  const client_type = data.client_type === 'owner' || data.client_type === 'office'
    ? data.client_type
    : '';
  const client_name = typeof data.client_name === 'string' ? data.client_name.trim() : '';

  if (!client_id) throw new Error('[FinancialService] client_id is required.');
  if (!client_type) throw new Error('[FinancialService] client_type must be owner or office.');

  const receipt_date = data.receipt_date;
  if (!receipt_date || isNaN(Date.parse(receipt_date))) {
    throw new Error('[FinancialService] receipt_date must be a valid ISO date string.');
  }


  return {
    client_id,
    client_type,
    client_name,
    receipt_date,
  };
}

function _validateReceiptRows(rows) {
  const dataRows = Array.isArray(rows) ? rows.filter(r => r && r._type !== 'separator') : [];
  if (dataRows.length === 0) {
    throw new Error('[FinancialService] rows must contain at least one data row.');
  }

  for (const row of dataRows) {
    if (!row.row_id || typeof row.row_id !== 'string') {
      throw new Error('[FinancialService] every receipt row must have a valid immutable row_id');
    }
    const owner_id = typeof row.owner_id === 'string' ? row.owner_id.trim() : '';
    if (!owner_id) throw new Error('[FinancialService] row.owner_id must be a non-empty UUID string.');
    const vehicle_id = typeof row.vehicle_id === 'string' ? row.vehicle_id.trim() : '';
    if (!vehicle_id) throw new Error('[FinancialService] row.vehicle_id must be a non-empty UUID string.');
  }

  return dataRows;
}

function _buildReceiptHeaderEntity(cleanHeader, username, receiptId = null) {
  return {
    id: receiptId || _uuid(),
    username,
    client_id: cleanHeader.client_id,
    client_type: cleanHeader.client_type,
    client_name: cleanHeader.client_name || null,
    receipt_date: cleanHeader.receipt_date,
  };
}

/**
 * Normalize the optional Driver Details settlement price. It is deliberately
 * independent from receipt_rows.driver_price (نولون): null means no intended
 * settlement amount has been entered; zero remains an explicit valid value.
 */
function _normalizeDriverSettlementPrice(value, label = 'driver_settlement_price') {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`[FinancialService] ${label} must be a numeric value, blank, or null.`);
  }

  const decimal = Number(value);
  const cents = Money.toCents(decimal);
  if (!Number.isFinite(decimal) || !Number.isFinite(cents) || !Number.isInteger(cents)) {
    throw new Error(`[FinancialService] ${label} must be a finite numeric value.`);
  }
  if (cents < 0) {
    throw new Error(`[FinancialService] ${label} must not be negative.`);
  }
  return cents;
}

/** Validate a stored (already-cents) Driver Karta settlement price. */
function _readDriverSettlementPriceCents(value, label = 'driver_settlement_price') {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') {
    throw new Error(`[FinancialService] persisted ${label} must be numeric integer cents.`);
  }
  const cents = value;
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) {
    throw new Error(`[FinancialService] persisted ${label} must be finite integer cents.`);
  }
  if (cents < 0) {
    throw new Error(`[FinancialService] persisted ${label} must not be negative.`);
  }
  return cents;
}

function _buildReceiptRowEntities(validatedRows, receiptId, { forceUnpaid = false } = {}) {
  return validatedRows.map(row => ({
    row_id: row.row_id,
    receipt_id: receiptId,
    driver_id: row.driver_id || null,
    vehicle_id: row.vehicle_id,
    vehicle_plate: row.vehicle_plate || null,
    driver_price: Money.toCents(row.driver_price ?? 0),
    driver_settlement_price: _normalizeDriverSettlementPrice(row.driver_settlement_price),
    loading: row.loading || null,
    destination: row.destination || null,
    office: row.office || null,
    advance: Money.toCents(row.advance ?? 0),
    net: Money.toCents(row.net ?? 0),
    sarf: Money.toCents(row.sarf ?? 0),
    // ── Restored user-entered row fields (previously dropped from the audit
    // list). Money fields follow the existing cents convention; quantities and
    // strings are stored in their original form. company_* fields remain
    // intentionally excluded (form-dead, per audit).
    kartano: row.kartano || null,
    date: row.date || null,
    driver_name: row.driver_name || null,
    type: row.type || null,
    weight: row.weight ?? null,
    weight2: row.weight2 ?? null,
    deficit: row.deficit ?? null,
    weightTotal: row.weightTotal ?? null,
    officeAmount: Money.toCents(row.officeAmount ?? 0),
    discount: Money.toCents(row.discount ?? 0),
    add: Money.toCents(row.add ?? 0),
    row_order: row.row_order ?? null,
    // New receipt creation is always unpaid. Receipt edits preserve the
    // explicit row lifecycle status supplied by the persisted edit form.
    payment_status: forceUnpaid
      ? PAYMENT_STATUS.UNPAID
      : row.payment_status === PAYMENT_STATUS.PAID
        ? PAYMENT_STATUS.PAID
        : PAYMENT_STATUS.UNPAID,
  }));
}

async function _getExistingReceiptRows(receiptId, tx) {
  return ReceiptRepository.getRowsByReceipt(receiptId, { tx });
}

// ─── VALIDATION ────────────────────────────────────────────────────────────────

/**
 * Validate and normalise raw input.
 * INPUT:  decimal values from UI  (e.g. total: 1500.50)
 * OUTPUT: clean object with cents (e.g. total: 150050)
 */
function _validate(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService] data must be a plain object.');
  }

  // Delegate header validation to the dedicated helper
  const header = _validateReceiptHeader(data);

  // Delegate row validation to the dedicated helper
  const dataRows = _validateReceiptRows(data.rows);

  // Continue with existing business logic that builds groups and calculates totals
  const clientVehicleGroups = new Map();
  for (const row of dataRows) {
    const owner_id = typeof row.owner_id === 'string' ? row.owner_id.trim() : '';
    if (!owner_id) {
      throw new Error('[FinancialService] row.owner_id must be a non-empty UUID string.');
    }
    const vehicle_id = typeof row.vehicle_id === 'string' ? row.vehicle_id.trim() : '';
    if (!vehicle_id) {
      throw new Error('[FinancialService] row.vehicle_id must be a non-empty UUID string.');
    }

    const owner_name = typeof row.owner_name === 'string' ? row.owner_name.trim() : '';
    const vehicle_plate = typeof row.vehicle_plate === 'string' ? row.vehicle_plate.trim() : '';
    const rowNet = Money.toCents(row.net ?? 0);
    const key = `${header.client_id}__${vehicle_id}`;
    const prev = clientVehicleGroups.get(key) || {
      owner_id: header.client_id,
      owner_name: header.client_name || null,
      client_id: header.client_id,
      client_type: header.client_type,
      client_name: header.client_name || null,
      vehicle_owner_id: owner_id,
      vehicle_owner_name: owner_name || null,
      vehicle_id,
      vehicle_plate: vehicle_plate || null,
      total: 0,
    };
    prev.total += rowNet;
    clientVehicleGroups.set(key, prev);
  }

  const receipt_date = header.receipt_date;

  // Convert decimals → cents (RULE 9)
  const total = Money.toCents(data.total);
  if (total < 0) {
    throw new Error('[FinancialService] total must be a non-negative number.');
  }

  const groups = [...clientVehicleGroups.values()].filter(g => g.total !== 0);
  if (groups.length === 0) {
    throw new Error('[FinancialService] rows total must be greater than zero.');
  }

  return {
    receipt_date,
    total,
    groups,
    client_id: header.client_id,
    client_type: header.client_type,
    client_name: header.client_name,
    rows: dataRows,
    raw_rows: data.rows ?? [],
  };
}

// ─── PUBLIC: createReceipt ─────────────────────────────────────────────────────

// ─── RECEIPT-ROW PAYMENT EFFECTS (تم صرفه / لم يتم صرفه) ───────────────
// Payment effects are intentionally distinct from receipt creation charges.
// A complete active payment state contains exactly one company effect and one
// vehicle effect for the same immutable receipt-row UUID.

function _isActiveLedgerEntry(entry) {
  return entry?.is_reversed === false && entry?.deleted_at === null;
}

function _analyzeReceiptPaymentEffects(entries, rowId) {
  const rowKey = String(rowId || '').trim();
  const active = (entries || []).filter(entry => _isActiveLedgerEntry(entry)
    && String(entry.reference_id || '') === rowKey);
  const companyLegs = active.filter(entry =>
    entry.reference_type === RECEIPT_ROW_PAYMENT_COMPANY_REF_TYPE
    && entry.effect === RECEIPT_ROW_PAYMENT_COMPANY_EFFECT
  );
  const vehicleLegs = active.filter(entry =>
    entry.reference_type === RECEIPT_ROW_PAYMENT_VEHICLE_REF_TYPE
    && entry.effect === RECEIPT_ROW_PAYMENT_VEHICLE_EFFECT
  );

  let state = 'none';
  if (companyLegs.length === 1 && vehicleLegs.length === 1) state = 'complete';
  else if (companyLegs.length || vehicleLegs.length) {
    state = companyLegs.length <= 1 && vehicleLegs.length <= 1 ? 'partial' : 'duplicate';
  }

  return {
    state,
    companyLegs,
    vehicleLegs,
    activePaymentLegs: [...companyLegs, ...vehicleLegs],
  };
}

function _assertNoActiveReceiptPaymentEffects(pair, operation, rowId) {
  if (pair.state === 'none') return;
  throw new Error(
    `[FinancialService:${operation}] receipt row ${rowId} has ${pair.state} active payment effects; expected none.`
  );
}

function _assertCompleteReceiptPaymentPair(pair, operation, row) {
  if (pair.state !== 'complete') {
    throw new Error(
      `[FinancialService:${operation}] receipt row ${row.row_id} has ${pair.state} active payment effects; expected one complete payment pair.`
    );
  }

  const company = pair.companyLegs[0];
  const vehicle = pair.vehicleLegs[0];
  const netCents = Number(row.net) || 0;
  const sarfCents = Number(row.sarf) || 0;
  if (company.type !== 'deposit'
    || vehicle.type !== 'deposit'
    || company.vehicle_id !== null
    || String(vehicle.vehicle_id || '') !== String(row.vehicle_id || '')
    || Number(company.amount) !== netCents + sarfCents
    || Number(vehicle.amount) !== netCents
    || String(company.reference_id || '') !== String(row.row_id)
    || String(vehicle.reference_id || '') !== String(row.row_id)) {
    throw new Error(
      `[FinancialService:${operation}] receipt row ${row.row_id} has inconsistent active payment effects.`
    );
  }
}

async function _resolveReceiptPaymentTargets(row, { tx } = {}) {
  const vehicle = await ClientRepository.getVehicleById(String(row.vehicle_id || ''), { tx });
  if (!vehicle || vehicle.deleted_at !== null) {
    throw new Error('[FinancialService] cannot post payment: vehicle not found for the row.');
  }

  const officeName = String(row.office || '').trim();
  if (!officeName) {
    throw new Error('[FinancialService] cannot post payment: row has no company (اسم الشركة).');
  }
  const offices = tx
    ? await tx.findByFields('offices', { name: officeName })
    : await OfficeRepository.findByName(officeName);
  const office = (offices || []).find(candidate => candidate && candidate.deleted_at === null);
  if (!office) {
    throw new Error(`[FinancialService] unknown office: ${officeName}`);
  }
  return { vehicle, office };
}

function _receiptPaymentDate(row, receiptDate = null) {
  return row.date || receiptDate || DateUtils.todayLocal();
}

function _buildReceiptPaymentCompanyLeg(username, row, office, receiptDate = null, appliedAt = DateUtils.nowLocal()) {
  const netCents = Number(row.net) || 0;
  const sarfCents = Number(row.sarf) || 0;
  return {
    username,
    owner_id: String(office.id),
    owner_name: office.name || null,
    client_id: String(office.id),
    client_type: 'office',
    client_name: office.name || null,
    vehicle_id: null,
    vehicle_plate: row.vehicle_plate || null,
    type: 'deposit',
    effect: RECEIPT_ROW_PAYMENT_COMPANY_EFFECT,
    amount: netCents + sarfCents,
    reference_type: RECEIPT_ROW_PAYMENT_COMPANY_REF_TYPE,
    reference_id: String(row.row_id),
    date: _receiptPaymentDate(row, receiptDate),
    applied_at: appliedAt,
    is_reversed: false,
    note: `صرف كارتة — الصافي + الصرف (${office.name || ''})`,
  };
}

function _buildReceiptPaymentVehicleLeg(username, row, vehicle, receiptDate = null, appliedAt = DateUtils.nowLocal()) {
  const netCents = Number(row.net) || 0;
  return {
    username,
    owner_id: String(vehicle.owner_id || ''),
    owner_name: vehicle.owner_name || null,
    client_id: String(vehicle.id),
    client_type: 'vehicle',
    client_name: vehicle.plate || row.vehicle_plate || null,
    vehicle_id: vehicle.id,
    vehicle_plate: vehicle.plate || row.vehicle_plate || null,
    type: 'deposit',
    effect: RECEIPT_ROW_PAYMENT_VEHICLE_EFFECT,
    amount: netCents,
    reference_type: RECEIPT_ROW_PAYMENT_VEHICLE_REF_TYPE,
    reference_id: String(row.row_id),
    date: _receiptPaymentDate(row, receiptDate),
    applied_at: appliedAt,
    is_reversed: false,
    note: `صرف كارتة — الصافي (مركبة ${vehicle.plate || row.vehicle_plate || ''})`,
  };
}

function _buildReceiptPaymentLegs(username, row, targets, receiptDate = null, appliedAt = DateUtils.nowLocal()) {
  return [
    _buildReceiptPaymentCompanyLeg(username, row, targets.office, receiptDate, appliedAt),
    _buildReceiptPaymentVehicleLeg(username, row, targets.vehicle, receiptDate, appliedAt),
  ];
}

async function _receiptPaymentAddCommands(username, row, receiptDate = null) {
  const targets = await _resolveReceiptPaymentTargets(row);
  return _buildReceiptPaymentLegs(username, row, targets, receiptDate)
    .map(payload => createPersistenceCommand(PersistenceCommandType.ADD, 'Ledger', null, { payload }));
}

function _receiptPaymentReverseCommands(entries, username) {
  const now = DateUtils.nowLocal();
  const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
  return entries.map(entry =>
    createPersistenceCommand(PersistenceCommandType.UPDATE, 'Ledger', entry.id, { patch: reversePatch })
  );
}

async function _getReceiptPaymentPair(rowId, { tx } = {}) {
  const entries = tx
    ? await tx.getByIndex(STORE.LEDGER, 'by_reference_id', String(rowId))
    : await DB.getByIndex(STORE.LEDGER, 'by_reference_id', String(rowId));
  return _analyzeReceiptPaymentEffects(entries, rowId);
}

// ─── RECEIPT-ROW COMPANY CHARGES (Karta creation) ───────────────────────────
// Every persisted receipt row with a resolved company creates one independent
// creation-side company withdrawal. It is intentionally separate from both
// payment-company and payment-vehicle effects, exists regardless of
// payment_status, and remains linked to the row UUID through the lifecycle.
async function _resolveReceiptRowCompany(row) {
  const officeName = String(row.office || '').trim();
  if (!officeName) return null;

  const offices = await OfficeRepository.findByName(officeName);
  const office = (offices || []).find(candidate => candidate && candidate.deleted_at === null);
  if (!office) {
    throw new Error(`[FinancialService] unknown office: ${officeName}`);
  }
  return office;
}

function _receiptRowCompanyChargePayload(username, row, office, receiptDate) {
  const now = DateUtils.nowLocal();
  const date = row.date || receiptDate || DateUtils.todayLocal();
  const netCents = Number(row.net) || 0;
  const sarfCents = Number(row.sarf) || 0;

  return {
    username,
    owner_id: String(office.id),
    owner_name: office.name || null,
    client_id: String(office.id),
    client_type: 'office',
    client_name: office.name || null,
    vehicle_id: null,
    type: 'withdraw',
    amount: netCents + sarfCents,
    reference_type: RECEIPT_ROW_COMPANY_CHARGE_REF_TYPE,
    effect: RECEIPT_ROW_COMPANY_CHARGE_EFFECT,
    reference_id: String(row.row_id),
    date,
    applied_at: now,
    is_reversed: false,
    note: `تحميل كارتة على الشركة — الصافي + الصرف (${office.name || ''})`,
  };
}

async function _receiptRowCompanyChargeAddCommands(username, row, receiptDate) {
  const office = await _resolveReceiptRowCompany(row);
  if (!office) return [];
  const payload = _receiptRowCompanyChargePayload(username, row, office, receiptDate);
  return [createPersistenceCommand(PersistenceCommandType.ADD, 'Ledger', null, { payload })];
}

async function _getActiveReceiptRowCompanyCharges(rowId) {
  const entries = await DB.getByIndex(STORE.LEDGER, 'by_reference_id', String(rowId));
  return entries.filter(entry =>
    entry.reference_type === RECEIPT_ROW_COMPANY_CHARGE_REF_TYPE
    && entry.effect === RECEIPT_ROW_COMPANY_CHARGE_EFFECT
    && entry.is_reversed === false
    && entry.deleted_at === null
  );
}

function _receiptRowCompanyChargeReverseCommands(entries, username) {
  const now = DateUtils.nowLocal();
  const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
  return entries.map(entry =>
    createPersistenceCommand(PersistenceCommandType.UPDATE, 'Ledger', entry.id, { patch: reversePatch })
  );
}

/**
 * Block a receipt lifecycle mutation when any current receipt row has active
 * Karta settlement evidence. A complete pair and every partial/duplicate state
 * block equally: receipt rows must never be replaced or deleted underneath an
 * active financial settlement.
 */
async function _assertReceiptRowsHaveNoActiveKartaSettlement(tx, rows, operation) {
  const blockers = [];
  for (const row of rows || []) {
    const rowId = String(row?.row_id || '').trim();
    if (!rowId) continue;
    const entries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', rowId);
    const pair = _analyzeKartaSettlementPair(entries, rowId);
    if (pair.state !== 'none') blockers.push({ rowId, state: pair.state });
  }

  if (blockers.length > 0) {
    const affected = blockers.map(blocker => `${blocker.rowId} (${blocker.state})`).join(', ');
    const action = operation === 'deleteReceipt' ? 'deleted' : 'edited';
    throw new Error(
      `[FinancialService:${operation}] receipt row(s) ${affected} cannot be ${action} while Karta settlement is active. `
      + 'Reverse the Karta settlement first.'
    );
  }
}

function _assertReceiptRowSetMatches(expectedRows, currentRows, operation) {
  const expected = new Set((expectedRows || []).map(row => String(row.row_id || '')));
  const current = new Set((currentRows || []).map(row => String(row.row_id || '')));
  const same = expected.size === current.size && [...expected].every(rowId => current.has(rowId));
  if (!same) {
    throw new Error(`[FinancialService:${operation}] receipt rows changed before mutation; reload and retry.`);
  }
}

// ─── LOAD PRICE ROUTE DISCOVERY ──────────────────────────────────────────────
// Reference/master-data only. It neither posts financial entries nor changes a
// user-managed price. Duplicate rows in one receipt collapse to one route key.
async function _loadPriceDiscoveryCommands(username, receiptRows) {
  const candidates = new Map();

  for (const row of receiptRows) {
    const loading = displayRoutePlace(row.loading);
    const destination = displayRoutePlace(row.destination);
    const canonical_route = canonicalRouteKey(loading, destination);
    if (!canonical_route || candidates.has(canonical_route)) continue;

    candidates.set(canonical_route, {
      id: _uuid(),
      username,
      loading,
      destination,
      canonical_loading: canonicalizeRoutePlace(loading),
      canonical_destination: canonicalizeRoutePlace(destination),
      canonical_route,
      price: 0,
    });
  }

  const commands = [];
  for (const route of candidates.values()) {
    const existing = await LoadPriceRepository.findActiveByCanonicalRoute(route.canonical_route);
    if (existing) continue;
    commands.push(LoadPriceRepository.prepareCreate(route, { username }));
  }

  return commands;
}

async function createReceipt(username, data) {
  if (!username) throw new Error('[FinancialService:create] username is required.');

  const receiptId = data.id || _uuid();
  const clean = _validate(data);

  // Build Receipt header
  const receiptHeader = _buildReceiptHeaderEntity(clean, username, receiptId);

  // Build ReceiptRow entities
  const receiptRows = _buildReceiptRowEntities(clean.rows, receiptId, { forceUnpaid: true });

  // Assemble the full persistence record ONCE.
  const receiptRecord = {
    ...receiptHeader,
    total: clean.total,
    notes: data.notes ?? null,
  };

  // Prepare PersistenceCommands via ReceiptRepository (Add)
  const receiptCommand = ReceiptRepository.prepareReceiptOperation(receiptRecord, { username });

  const receiptRowCommands = ReceiptRepository.prepareReceiptRowOperations(receiptRows, { username });

  // New routes are master-data discoveries. Include their commands in the same
  // receipt write batch so receipt rows and newly discovered routes commit or
  // roll back together.
  const loadPriceCommands = await _loadPriceDiscoveryCommands(username, receiptRows);

  // Receipt creation charges each resolved company once per row UUID. These
  // withdrawals are independent from the later paid/unpaid payment postings.
  const companyChargeAddCommands = [];
  for (const row of receiptRows) {
    companyChargeAddCommands.push(...(await _receiptRowCompanyChargeAddCommands(
      username, row, receiptRecord.receipt_date
    )));
  }

  // New receipt rows always begin unpaid. Payment postings are created only
  // by the explicit receipt-row payment status lifecycle.

  // New receipt creation commits only header, rows, route discovery, and the
  // independent company creation charges. Payment lifecycle entries are absent.
  const allCommands = [
    receiptCommand,
    ...receiptRowCommands,
    ...loadPriceCommands,
    ...companyChargeAddCommands,
  ];

  // Execute through WriteDataSource
  const results = await WriteDataSource.execute(allCommands, { username });

  const receipt = Money.decimalizeRecord(results[0]);

  return { receipt };
}

// ─── PUBLIC: updateReceipt ─────────────────────────────────────────────────────

function _receiptCreationIdentity(row, receiptDate) {
  return JSON.stringify({
    net: Number(row.net) || 0,
    sarf: Number(row.sarf) || 0,
    office: String(row.office || '').trim(),
    date: row.date || receiptDate || null,
  });
}

function _receiptPaymentIdentity(row, receiptDate) {
  return JSON.stringify({
    payment_status: row.payment_status === PAYMENT_STATUS.PAID ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.UNPAID,
    net: Number(row.net) || 0,
    sarf: Number(row.sarf) || 0,
    vehicle_id: String(row.vehicle_id || ''),
    office: String(row.office || '').trim(),
    date: row.date || receiptDate || null,
  });
}

async function updateReceipt(username, id, data) {
  if (!username) throw new Error('[FinancialService:update] username is required.');
  if (!id) throw new Error('[FinancialService:update] id is required.');

  const clean = _validate(data);
  const receiptHeader = _buildReceiptHeaderEntity(clean, username, id);
  const nextRows = _buildReceiptRowEntities(clean.rows, id);
  const receiptRecord = {
    ...receiptHeader,
    total: clean.total,
    ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
  };
  const existingRows = await _getExistingReceiptRows(id);
  const existingById = new Map(existingRows.map(row => [String(row.row_id), row]));
  const nextById = new Map(nextRows.map(row => [String(row.row_id), row]));
  if (nextById.size !== nextRows.length) {
    throw new Error('[FinancialService:update] duplicate receipt row_id in edit payload.');
  }

  // A row added during an edit is still a new receipt row and therefore starts
  // unpaid. Existing rows retain their persisted payment lifecycle status.
  for (const nextRow of nextRows) {
    if (!existingById.has(String(nextRow.row_id))) {
      nextRow.payment_status = PAYMENT_STATUS.UNPAID;
    }
  }

  const loadPriceCommands = await _loadPriceDiscoveryCommands(username, nextRows);
  const creationReverseCommands = [];
  const paymentReverseCommands = [];
  const creationAddRows = [];
  const paymentAddRows = [];

  for (const oldRow of existingRows) {
    const rowKey = String(oldRow.row_id);
    const nextRow = nextById.get(rowKey) || null;
    const creationChanged = !nextRow
      || _receiptCreationIdentity(oldRow, receiptHeader.receipt_date)
        !== _receiptCreationIdentity(nextRow, receiptRecord.receipt_date);
    const paymentChanged = !nextRow
      || _receiptPaymentIdentity(oldRow, receiptHeader.receipt_date)
        !== _receiptPaymentIdentity(nextRow, receiptRecord.receipt_date);

    if (creationChanged) {
      const creation = await _getActiveReceiptRowCompanyCharges(oldRow.row_id);
      if (creation.length > 0) {
        creationReverseCommands.push(..._receiptRowCompanyChargeReverseCommands(creation, username));
      }
      if (nextRow) creationAddRows.push(nextRow);
    }

    if (paymentChanged) {
      const paymentPair = await _getReceiptPaymentPair(oldRow.row_id);
      const oldPaid = oldRow.payment_status === PAYMENT_STATUS.PAID;
      if (oldPaid) {
        _assertCompleteReceiptPaymentPair(paymentPair, 'updateReceipt', oldRow);
        paymentReverseCommands.push(..._receiptPaymentReverseCommands(paymentPair.activePaymentLegs, username));
      } else {
        _assertNoActiveReceiptPaymentEffects(paymentPair, 'updateReceipt', oldRow.row_id);
      }
      if (nextRow?.payment_status === PAYMENT_STATUS.PAID) paymentAddRows.push(nextRow);
    }
  }

  for (const nextRow of nextRows) {
    if (!existingById.has(String(nextRow.row_id))) {
      creationAddRows.push(nextRow);
    }
  }

  const creationAddCommands = [];
  for (const row of creationAddRows) {
    creationAddCommands.push(...(await _receiptRowCompanyChargeAddCommands(
      username, row, receiptRecord.receipt_date
    )));
  }
  const paymentAddCommands = [];
  for (const row of paymentAddRows) {
    paymentAddCommands.push(...(await _receiptPaymentAddCommands(
      username, row, receiptRecord.receipt_date
    )));
  }

  const receiptCommand = ReceiptRepository.prepareReceiptOperation(
    receiptRecord, { username }, PersistenceCommandType.UPDATE
  );
  const rowCommands = [];
  for (const oldRow of existingRows) {
    if (!nextById.has(String(oldRow.row_id))) {
      rowCommands.push(ReceiptRepository.prepareReceiptRowOperations(
        [{ row_id: oldRow.row_id }], { username }, PersistenceCommandType.DELETE
      )[0]);
    }
  }
  for (const nextRow of nextRows) {
    const type = existingById.has(String(nextRow.row_id))
      ? PersistenceCommandType.UPDATE
      : PersistenceCommandType.ADD;
    rowCommands.push(ReceiptRepository.prepareReceiptRowOperations([nextRow], { username }, type)[0]);
  }

  const allCommands = [
    receiptCommand,
    ...rowCommands,
    ...loadPriceCommands,
    ...creationReverseCommands,
    ...paymentReverseCommands,
    ...creationAddCommands,
    ...paymentAddCommands,
  ];

  const results = await DB.transaction(async (tx) => {
    const currentRows = await _getExistingReceiptRows(id, tx);
    _assertReceiptRowSetMatches(existingRows, currentRows, 'updateReceipt');
    await _assertReceiptRowsHaveNoActiveKartaSettlement(tx, currentRows, 'updateReceipt');
    return WriteDataSource.executeWithinTransaction(tx, allCommands);
  }, { username, stores: ['receipts', 'receipt_rows', STORE.LEDGER, 'loadPrices'] });

  return { receipt: Money.decimalizeRecord(results[0]) };
}

// ─── PUBLIC: deleteReceipt ─────────────────────────────────────────────────────

async function deleteReceipt(username, id) {
  if (!username) throw new Error('[FinancialService:delete] username is required.');
  if (!id) throw new Error('[FinancialService:delete] id is required.');

  const existingRows = await _getExistingReceiptRows(id);
  // Paid-row deletion is intentionally blocked pending explicit business
  // approval of the final paid-delete company accounting rule. This prevents a
  // namespace migration from silently choosing that accounting interpretation.
  for (const row of existingRows) {
    const paymentPair = await _getReceiptPaymentPair(row.row_id);
    if (row.payment_status === PAYMENT_STATUS.PAID || paymentPair.state !== 'none') {
      throw new Error(
        '[FinancialService:deleteReceipt] paid receipt row deletion requires approved lifecycle accounting. '
        + 'Change the row to unpaid first, then delete the receipt.'
      );
    }
  }

  const receiptDeleteCommand = ReceiptRepository.prepareReceiptOperation(
    { id }, { username }, PersistenceCommandType.DELETE
  );
  const receiptRowDeleteCommands = existingRows.map(row =>
    ReceiptRepository.prepareReceiptRowOperations(
      [{ row_id: row.row_id }], { username }, PersistenceCommandType.DELETE
    )[0]
  );
  const creationReverseCommands = [];
  for (const row of existingRows) {
    const creation = await _getActiveReceiptRowCompanyCharges(row.row_id);
    if (creation.length > 0) {
      creationReverseCommands.push(..._receiptRowCompanyChargeReverseCommands(creation, username));
    }
  }

  await DB.transaction(async (tx) => {
    const currentRows = await _getExistingReceiptRows(id, tx);
    _assertReceiptRowSetMatches(existingRows, currentRows, 'deleteReceipt');
    await _assertReceiptRowsHaveNoActiveKartaSettlement(tx, currentRows, 'deleteReceipt');
    await WriteDataSource.executeWithinTransaction(tx, [
      ...receiptRowDeleteCommands,
      receiptDeleteCommand,
      ...creationReverseCommands,
    ]);
  }, { username, stores: ['receipts', 'receipt_rows', STORE.LEDGER] });

  return { id, deleted: true };
}

// ─── PUBLIC: rebuildVehicleBalance ────────────────────────────────────────────

async function rebuildVehicleBalance(vehicle_id) {
  if (!vehicle_id) throw new Error('[FinancialService:rebuildVehicleBalance] vehicle_id is required.');

  const allEntries = await DB.getByIndex(STORE.LEDGER, 'by_vehicle', vehicle_id);
  const active     = allEntries.filter(e => e.is_reversed === false && e.deleted_at === null);

  let deposit_total  = 0;
  let withdraw_total = 0;

  for (const entry of active) {
    if (entry.type === 'deposit')  deposit_total  += Number(entry.amount) || 0;
    if (entry.type === 'withdraw') withdraw_total += Number(entry.amount) || 0;
  }

  const balance = deposit_total - withdraw_total;

  return {
    vehicle_id,
    balance        : Money.toDecimal(balance),
    deposit_total  : Money.toDecimal(deposit_total),
    withdraw_total : Money.toDecimal(withdraw_total),
    entry_count    : active.length,
  };
}

/**
 * Read active vehicle-balance movements from the existing vehicle_ledger.
 * This is a read projection only: its inclusion criteria intentionally match
 * rebuildVehicleBalance (same vehicle, active, deposit/withdraw types).
 */
async function getVehicleLedger(vehicle_id) {
  if (!vehicle_id) throw new Error('[FinancialService:getVehicleLedger] vehicle_id is required.');

  const allEntries = await DB.getByIndex(STORE.LEDGER, 'by_vehicle', vehicle_id);
  return allEntries
    .filter(e => e.is_reversed === false
      && e.deleted_at === null
      && (e.type === 'deposit' || e.type === 'withdraw'))
    .sort((a, b) => {
      const db = new Date(b.date || b.applied_at || b.created_at || 0).getTime();
      const da = new Date(a.date || a.applied_at || a.created_at || 0).getTime();
      return db - da;
    })
    .map(Money.decimalizeRecord);
}

// ─── PUBLIC: Ledger Integrity Diagnostics (read-only) ─────────────────────────
// The diagnostic adapter reads through ReadDataSource and delegates all
// classification to the persistence-agnostic ledgerIntegrityDiagnostics module.
async function getVehicleLedgerDateIntegrityDiagnostic() {
  return LedgerIntegrityDiagnosticService.getVehicleLedgerDateIntegrityDiagnostic();
}

async function getLedgerIntegrityDiagnosticSnapshot() {
  return LedgerIntegrityDiagnosticService.getLedgerIntegrityDiagnosticSnapshot();
}

function _parseMonthlyReportMonthKey(monthKey) {
  if (typeof monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new Error('[FinancialService:getVehicleMonthlyReport] monthKey must be YYYY-MM.');
  }
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('[FinancialService:getVehicleMonthlyReport] monthKey must contain a valid calendar month.');
  }
  if (year === 9999 && month === 12) {
    throw new Error('[FinancialService:getVehicleMonthlyReport] monthKey is outside the supported reporting range.');
  }

  const monthStart = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextMonthStart = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
  return { monthKey, monthStart, nextMonthStart };
}

function _classifyMonthlyReportBusinessDate(value, today) {
  if (value === null || value === undefined || value === '') {
    return { classification: 'missing_date', future: false };
  }
  if (typeof value !== 'string') {
    return { classification: 'invalid_type', future: false };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { classification: 'invalid_format', future: false };
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    return { classification: 'invalid_calendar_date', future: false };
  }

  return { classification: 'valid_date', future: value > today };
}

function _monthlyReportCategory(entry) {
  const type = entry.type;
  const effect = entry.effect || null;
  const referenceType = entry.reference_type || null;
  const hasMaintenance = String(entry.maintenance_type || '').trim().length > 0;

  if (type === 'deposit') {
    if (effect === RECEIPT_ROW_PAYMENT_VEHICLE_EFFECT && referenceType === RECEIPT_ROW_PAYMENT_VEHICLE_REF_TYPE) return 'receipt_row_payment';
    if (effect === 'manual_vehicle_balance' && !hasMaintenance) return 'manual_vehicle_deposit';
    return 'other';
  }

  if (type === 'withdraw') {
    if (effect === 'karta_settlement_charge' && referenceType === 'receipt_row') return 'karta_settlement';
    if (effect === 'manual_vehicle_balance' && hasMaintenance) return 'maintenance';
    if (effect === 'manual_vehicle_balance' && !hasMaintenance) return 'manual_vehicle_withdrawal';
    return 'other';
  }

  return 'other';
}

function _monthlyReportEntryAmountCents(entry) {
  return Number(entry.amount) || 0;
}

function _compareMonthlyReportMovements(a, b) {
  const dateCompare = String(a.date).localeCompare(String(b.date));
  if (dateCompare !== 0) return dateCompare;
  const appliedCompare = String(a.applied_at || '').localeCompare(String(b.applied_at || ''));
  if (appliedCompare !== 0) return appliedCompare;
  const createdCompare = (Number(a.created_at) || 0) - (Number(b.created_at) || 0);
  if (createdCompare !== 0) return createdCompare;
  const aId = Number(a.id);
  const bId = Number(b.id);
  if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) return aId - bId;
  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

function _newMonthlyReportBreakdown() {
  return {
    inflows: {
      receiptRowPayment: { amountCents: 0, count: 0 },
      manualVehicleDeposit: { amountCents: 0, count: 0 },
      other: { amountCents: 0, count: 0 },
    },
    outflows: {
      kartaSettlement: { amountCents: 0, count: 0 },
      maintenance: { amountCents: 0, count: 0 },
      manualVehicleWithdrawal: { amountCents: 0, count: 0 },
      other: { amountCents: 0, count: 0 },
    },
  };
}

function _addMonthlyReportBreakdown(breakdown, entry, amountCents) {
  const category = _monthlyReportCategory(entry);
  const target = entry.type === 'deposit' ? breakdown.inflows : breakdown.outflows;
  const key = entry.type === 'deposit'
    ? ({ receipt_row_payment: 'receiptRowPayment', manual_vehicle_deposit: 'manualVehicleDeposit' }[category] || 'other')
    : ({ karta_settlement: 'kartaSettlement', maintenance: 'maintenance', manual_vehicle_withdrawal: 'manualVehicleWithdrawal' }[category] || 'other');
  target[key].amountCents += amountCents;
  target[key].count += 1;
}

/**
 * Read-only monthly Vehicle Ledger projection. All financial arithmetic uses
 * active, vehicle-linked deposit/withdraw rows with strict business dates.
 */
async function getVehicleMonthlyReport(vehicleId, monthKey) {
  const vehicleKey = String(vehicleId ?? '').trim();
  if (!vehicleKey) throw new Error('[FinancialService:getVehicleMonthlyReport] vehicleId is required.');
  const { monthStart, nextMonthStart } = _parseMonthlyReportMonthKey(monthKey);
  const today = DateUtils.todayLocal();

  // Existing by_vehicle index scopes the read to one vehicle; no store-wide
  // scan and no new index are required for the initial report contract.
  const indexedRows = await DB.getByIndex(STORE.LEDGER, 'by_vehicle', vehicleKey);
  const activeVehicleRows = indexedRows.filter(entry =>
    String(entry.vehicle_id || '') === vehicleKey
    && entry.is_reversed === false
    && entry.deleted_at === null
  );
  const reportRows = activeVehicleRows.filter(entry => entry.type === 'deposit' || entry.type === 'withdraw');
  const dateRows = reportRows.map(entry => ({
    entry,
    dateInfo: _classifyMonthlyReportBusinessDate(entry.date, today),
  }));
  const validRows = dateRows.filter(item => item.dateInfo.classification === 'valid_date');
  const invalidRows = dateRows.filter(item => item.dateInfo.classification !== 'valid_date');

  let openingBalanceCents = 0;
  let monthlyInflowsCents = 0;
  let monthlyOutflowsCents = 0;
  let cumulativeClosingBalanceCents = 0;
  let inflowTransactionCount = 0;
  let outflowTransactionCount = 0;
  const monthlyEntries = [];
  const breakdown = _newMonthlyReportBreakdown();

  for (const { entry } of validRows) {
    const amountCents = _monthlyReportEntryAmountCents(entry);
    const signedCents = entry.type === 'deposit' ? amountCents : -amountCents;
    if (entry.date < monthStart) openingBalanceCents += signedCents;
    if (entry.date < nextMonthStart) cumulativeClosingBalanceCents += signedCents;
    if (entry.date >= monthStart && entry.date < nextMonthStart) {
      if (entry.type === 'deposit') {
        monthlyInflowsCents += amountCents;
        inflowTransactionCount++;
      } else {
        monthlyOutflowsCents += amountCents;
        outflowTransactionCount++;
      }
      monthlyEntries.push({ entry, amountCents, category: _monthlyReportCategory(entry) });
      _addMonthlyReportBreakdown(breakdown, entry, amountCents);
    }
  }

  const closingBalanceCents = openingBalanceCents + monthlyInflowsCents - monthlyOutflowsCents;
  const sortedEntries = monthlyEntries.sort((a, b) => _compareMonthlyReportMovements(a.entry, b.entry));
  let runningBalanceCents = openingBalanceCents;
  const movements = sortedEntries.map(({ entry, amountCents, category }) => {
    runningBalanceCents += entry.type === 'deposit' ? amountCents : -amountCents;
    return {
      id: entry.id,
      date: entry.date,
      type: entry.type,
      amountCents,
      category,
      effect: entry.effect || null,
      referenceType: entry.reference_type || null,
      referenceId: entry.reference_id || null,
      batchId: entry.batch_id || null,
      note: entry.note || null,
      maintenanceType: entry.maintenance_type || null,
      maintenanceQuantity: entry.maintenance_quantity ?? null,
      appliedAt: entry.applied_at || null,
      createdAt: entry.created_at ?? null,
      runningBalanceCents,
    };
  });

  const invalidDepositRows = invalidRows.filter(item => item.entry.type === 'deposit');
  const invalidWithdrawRows = invalidRows.filter(item => item.entry.type === 'withdraw');
  const amountOf = rows => rows.reduce((sum, item) => sum + _monthlyReportEntryAmountCents(item.entry), 0);
  const futureRows = validRows.filter(item => item.dateInfo.future);
  const futureDeposits = futureRows.filter(item => item.entry.type === 'deposit');
  const futureWithdrawals = futureRows.filter(item => item.entry.type === 'withdraw');

  return {
    vehicleId: vehicleKey,
    monthKey,
    monthStart,
    nextMonthStart,
    openingBalanceCents,
    monthlyInflowsCents,
    monthlyOutflowsCents,
    closingBalanceCents,
    movementCount: movements.length,
    inflowTransactionCount,
    outflowTransactionCount,
    breakdown,
    movements,
    integrity: {
      hasInvalidDates: invalidRows.length > 0,
      isFinanciallyComplete: invalidRows.length === 0,
      invalidDateCount: invalidRows.length,
      invalidDepositCount: invalidDepositRows.length,
      invalidWithdrawCount: invalidWithdrawRows.length,
      invalidDepositAmountCents: amountOf(invalidDepositRows),
      invalidWithdrawAmountCents: amountOf(invalidWithdrawRows),
      invalidNetEffectCents: amountOf(invalidDepositRows) - amountOf(invalidWithdrawRows),
      invalidRows: invalidRows.map(({ entry, dateInfo }) => ({
        id: entry.id,
        vehicleId: entry.vehicle_id || null,
        type: entry.type,
        amountCents: _monthlyReportEntryAmountCents(entry),
        date: Object.hasOwn(entry, 'date') ? entry.date : null,
        effect: entry.effect || null,
        referenceType: entry.reference_type || null,
        referenceId: entry.reference_id || null,
        classification: dateInfo.classification,
      })),
    },
    future: {
      count: futureRows.length,
      depositCount: futureDeposits.length,
      withdrawCount: futureWithdrawals.length,
      depositAmountCents: amountOf(futureDeposits),
      withdrawAmountCents: amountOf(futureWithdrawals),
      netEffectCents: amountOf(futureDeposits) - amountOf(futureWithdrawals),
      rows: futureRows.map(({ entry }) => ({
        id: entry.id,
        vehicleId: entry.vehicle_id || null,
        type: entry.type,
        amountCents: _monthlyReportEntryAmountCents(entry),
        date: entry.date,
        effect: entry.effect || null,
        referenceType: entry.reference_type || null,
        referenceId: entry.reference_id || null,
      })),
    },
    reconciliation: {
      cumulativeClosingBalanceCents,
      isReconciled: cumulativeClosingBalanceCents === closingBalanceCents,
      finalRunningBalanceCents: runningBalanceCents,
    },
    excludedActiveVehicleCustomTypeCount: activeVehicleRows.length - reportRows.length,
  };
}

/**
 * Read active company movements from the existing vehicle_ledger. Company
 * balances have no dedicated ledger/store: this projection combines only the
 * two company-only namespaces, both isolated from vehicle balances by
 * vehicle_id:null — automatic receipt-row payments and explicit manual office
 * deposits/withdrawals.
 */
async function getOfficeBalance(office_id) {
  const officeKey = String(office_id ?? '').trim();
  if (!officeKey) throw new Error('[FinancialService:getOfficeBalance] office_id is required.');

  const entries = await DB.findByFields(STORE.LEDGER, {
    client_type: 'office',
    client_id: officeKey,
    owner_id: officeKey,
    is_reversed: false,
  });
  const active = entries
    .filter(e => e.deleted_at === null
      && e.vehicle_id === null
      && ((e.reference_type === RECEIPT_ROW_PAYMENT_COMPANY_REF_TYPE && e.effect === RECEIPT_ROW_PAYMENT_COMPANY_EFFECT)
        || (e.reference_type === RECEIPT_ROW_COMPANY_CHARGE_REF_TYPE && e.effect === RECEIPT_ROW_COMPANY_CHARGE_EFFECT)
        || (e.reference_type === MANUAL_OFFICE_REF_TYPE && e.effect === MANUAL_OFFICE_EFFECT)))
    .sort((a, b) => {
      const da = new Date(a.date || a.applied_at || a.created_at || 0).getTime();
      const db = new Date(b.date || b.applied_at || b.created_at || 0).getTime();
      return da - db;
    });

  let deposit_total = 0;
  let withdraw_total = 0;
  for (const entry of active) {
    if (entry.type === 'deposit') deposit_total += Number(entry.amount) || 0;
    if (entry.type === 'withdraw') withdraw_total += Number(entry.amount) || 0;
  }

  const balance = deposit_total - withdraw_total;
  return {
    office_id: officeKey,
    balance: Money.toDecimal(balance),
    deposit_total: Money.toDecimal(deposit_total),
    withdraw_total: Money.toDecimal(withdraw_total),
    entry_count: active.length,
    entries: active.map(Money.decimalizeRecord),
  };
}

// ─── MANUAL VEHICLE BALANCE MOVEMENTS ────────────────────────────────────────

/**
 * Prepare the existing single-leg manual vehicle movement payload. Maintenance
 * is a structured manual withdrawal, not a separate financial engine: when
 * maintenance metadata is absent, the existing manual deposit/withdraw
 * contract remains unchanged.
 */
async function _prepareManualVehicleBalancePayload(username, data) {
  if (!username) throw new Error('[FinancialService:createManualVehicleBalanceEntry] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createManualVehicleBalanceEntry] data must be a plain object.');
  }

  const vehicle_id = String(data.vehicle_id || '').trim();
  const entry_type = data.entry_type === 'withdraw' ? 'withdraw' : data.entry_type === 'deposit' ? 'deposit' : '';
  const amount = Money.toCents(data.amount);
  const date = data.date || DateUtils.todayLocal();
  const note = typeof data.note === 'string' ? data.note.trim() : '';
  const maintenance_type = typeof data.maintenance_type === 'string' ? data.maintenance_type.trim() : '';
  const hasMaintenance = maintenance_type.length > 0;
  const rawMaintenanceQuantity = data.maintenance_quantity;
  const hasMaintenanceQuantity = rawMaintenanceQuantity !== null
    && rawMaintenanceQuantity !== undefined
    && String(rawMaintenanceQuantity).trim() !== '';
  const maintenance_quantity = hasMaintenance && hasMaintenanceQuantity ? Number(rawMaintenanceQuantity) : null;

  if (!vehicle_id) throw new Error('[FinancialService:createManualVehicleBalanceEntry] vehicle_id is required.');
  if (!entry_type) throw new Error('[FinancialService:createManualVehicleBalanceEntry] entry_type must be deposit or withdraw.');
  if (amount <= 0) throw new Error('[FinancialService:createManualVehicleBalanceEntry] amount must be greater than zero.');
  // Preserve the existing generic-manual validation order and note rule.
  if (!hasMaintenance && !note) {
    throw new Error('[FinancialService:createManualVehicleBalanceEntry] note is required.');
  }
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createManualVehicleBalanceEntry] date must be a valid ISO date string.');
  }
  if (hasMaintenance) {
    if (entry_type !== 'withdraw') {
      throw new Error('[FinancialService:createManualVehicleBalanceEntry] maintenance entries must be withdrawals.');
    }
    if (hasMaintenanceQuantity && (!Number.isFinite(maintenance_quantity) || maintenance_quantity <= 0)) {
      throw new Error('[FinancialService:createManualVehicleBalanceEntry] maintenance_quantity must be greater than zero when provided.');
    }
  }

  // Resolve the vehicle before scheduling the atomic ledger write. A missing
  // vehicle must fail loudly; manual entry must never create a fallback record.
  const vehicle = await ClientRepository.getVehicleById(vehicle_id);
  if (!vehicle || vehicle.deleted_at !== null) {
    throw new Error('[FinancialService:createManualVehicleBalanceEntry] vehicle not found.');
  }

  const now = DateUtils.nowLocal();
  return {
    username,
    owner_id: String(vehicle.owner_id || ''),
    owner_name: vehicle.owner_name || null,
    client_id: String(vehicle.id),
    client_type: 'vehicle',
    client_name: vehicle.plate || null,
    vehicle_id: vehicle.id,
    vehicle_plate: vehicle.plate || null,
    type: entry_type,
    effect: MANUAL_VEHICLE_EFFECT,
    amount,
    reference_type: MANUAL_VEHICLE_REF_TYPE,
    reference_id: _uuid(),
    date,
    applied_at: now,
    is_reversed: false,
    // Existing manual entries still require a note. Maintenance allows an
    // intentionally empty note while preserving it as null in the ledger.
    note: note || null,
    ...(hasMaintenance ? {
      maintenance_type,
      maintenance_quantity,
    } : {}),
  };
}

async function _getActiveManualVehicleBalanceEntries(reference_id) {
  const referenceKey = String(reference_id || '').trim();
  if (!referenceKey) throw new Error('[FinancialService:deleteManualVehicleBalanceEntry] reference_id is required.');

  const entries = await DB.getByIndex(STORE.LEDGER, 'by_reference_id', referenceKey);
  return entries.filter(entry =>
    entry.reference_type === MANUAL_VEHICLE_REF_TYPE
    && entry.effect === MANUAL_VEHICLE_EFFECT
    && entry.is_reversed === false
    && entry.deleted_at === null
  );
}

/**
 * Create one manual vehicle balance movement in the existing vehicle_ledger.
 * This is intentionally a single vehicle leg: it has no receipt-row, company,
 * driver, or Karta Settlement side effect.
 */
async function createManualVehicleBalanceEntry(username, data) {
  const payload = await _prepareManualVehicleBalancePayload(username, data);
  const [saved] = await DB.transaction([{
    op: 'add',
    store: STORE.LEDGER,
    payload,
  }], { username });

  return Money.decimalizeRecord(saved);
}

/**
 * Replace one active structured maintenance withdrawal atomically. The old
 * manual record is audit-reversed and a fresh record is created, so an amount
 * or vehicle correction never leaves duplicate active withdrawals.
 */
async function updateVehicleMaintenanceEntry(username, reference_id, data) {
  if (!username) throw new Error('[FinancialService:updateVehicleMaintenanceEntry] username is required.');
  const active = await _getActiveManualVehicleBalanceEntries(reference_id);
  const previous = active.find(entry => entry.type === 'withdraw' && String(entry.maintenance_type || '').trim());
  if (!previous) {
    throw new Error('[FinancialService:updateVehicleMaintenanceEntry] maintenance transaction not found or already reversed.');
  }

  const payload = await _prepareManualVehicleBalancePayload(username, {
    ...data,
    entry_type: 'withdraw',
  });
  if (!String(payload.maintenance_type || '').trim()) {
    throw new Error('[FinancialService:updateVehicleMaintenanceEntry] maintenance_type is required.');
  }

  const now = DateUtils.nowLocal();
  const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
  const results = await DB.transaction([
    ...active.map(entry => ({ op: 'update', store: STORE.LEDGER, id: entry.id, patch: reversePatch })),
    { op: 'add', store: STORE.LEDGER, payload },
  ], { username });

  return Money.decimalizeRecord(results[results.length - 1]);
}

/**
 * Reverse one logical manual vehicle movement without removing its audit row.
 */
async function deleteManualVehicleBalanceEntry(username, reference_id) {
  if (!username) throw new Error('[FinancialService:deleteManualVehicleBalanceEntry] username is required.');
  const active = await _getActiveManualVehicleBalanceEntries(reference_id);
  if (active.length === 0) {
    throw new Error('[FinancialService:deleteManualVehicleBalanceEntry] manual vehicle transaction not found or already reversed.');
  }

  const now = DateUtils.nowLocal();
  const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
  return DB.transaction(
    active.map(entry => ({ op: 'update', store: STORE.LEDGER, id: entry.id, patch: reversePatch })),
    { username }
  );
}

// ─── MANUAL OFFICE BALANCE MOVEMENTS ─────────────────────────────────────────

/**
 * Create one manual company movement in the existing vehicle_ledger. This is
 * company-only and cannot affect a vehicle, receipt row, driver, or settlement.
 */
async function createManualOfficeBalanceEntry(username, data) {
  if (!username) throw new Error('[FinancialService:createManualOfficeBalanceEntry] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createManualOfficeBalanceEntry] data must be a plain object.');
  }

  const office_id = String(data.office_id || '').trim();
  const entry_type = data.entry_type === 'withdraw' ? 'withdraw' : data.entry_type === 'deposit' ? 'deposit' : '';
  const amount = Money.toCents(data.amount);
  const date = data.date || DateUtils.todayLocal();
  const note = typeof data.note === 'string' ? data.note.trim() : '';

  if (!office_id) throw new Error('[FinancialService:createManualOfficeBalanceEntry] office_id is required.');
  if (!entry_type) throw new Error('[FinancialService:createManualOfficeBalanceEntry] entry_type must be deposit or withdraw.');
  if (amount <= 0) throw new Error('[FinancialService:createManualOfficeBalanceEntry] amount must be greater than zero.');
  if (!note) throw new Error('[FinancialService:createManualOfficeBalanceEntry] note is required.');
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createManualOfficeBalanceEntry] date must be a valid ISO date string.');
  }

  const office = await OfficeRepository.getById(office_id);
  if (!office || office.deleted_at !== null) {
    throw new Error('[FinancialService:createManualOfficeBalanceEntry] office not found.');
  }

  const reference_id = _uuid();
  const now = DateUtils.nowLocal();
  const [saved] = await DB.transaction([{
    op: 'add',
    store: STORE.LEDGER,
    payload: {
      username,
      owner_id: String(office.id),
      owner_name: office.name || null,
      client_id: String(office.id),
      client_type: 'office',
      client_name: office.name || null,
      vehicle_id: null,
      vehicle_plate: null,
      type: entry_type,
      effect: MANUAL_OFFICE_EFFECT,
      amount,
      reference_type: MANUAL_OFFICE_REF_TYPE,
      reference_id,
      date,
      applied_at: now,
      is_reversed: false,
      note,
    },
  }], { username });

  return Money.decimalizeRecord(saved);
}

/**
 * Reverse one logical manual company movement while retaining its audit row.
 */
async function deleteManualOfficeBalanceEntry(username, reference_id) {
  if (!username) throw new Error('[FinancialService:deleteManualOfficeBalanceEntry] username is required.');
  const referenceKey = String(reference_id || '').trim();
  if (!referenceKey) throw new Error('[FinancialService:deleteManualOfficeBalanceEntry] reference_id is required.');

  const entries = await DB.getByIndex(STORE.LEDGER, 'by_reference_id', referenceKey);
  const active = entries.filter(entry =>
    entry.reference_type === MANUAL_OFFICE_REF_TYPE
    && entry.effect === MANUAL_OFFICE_EFFECT
    && entry.is_reversed === false
    && entry.deleted_at === null
  );
  if (active.length === 0) {
    throw new Error('[FinancialService:deleteManualOfficeBalanceEntry] manual office transaction not found or already reversed.');
  }

  const now = DateUtils.nowLocal();
  const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
  return DB.transaction(
    active.map(entry => ({ op: 'update', store: STORE.LEDGER, id: entry.id, patch: reversePatch })),
    { username }
  );
}

// ─── SHARED LEDGER & BALANCE HELPERS ──────────────────────────────────────────

async function _fetchLedgerEntries(id, label) {
  const key = id != null ? String(id).trim() : '';
  if (!key) throw new Error(`[FinancialService] ${label} is required.`);

  const entries = await DB.findByFields(STORE.LEDGER, {
    owner_id: key,
    is_reversed: false,
  });

  return entries
    .slice()
    .sort((a, b) => {
      const db = new Date(b.date || b.applied_at || b.created_at || 0).getTime();
      const da = new Date(a.date || a.applied_at || a.created_at || 0).getTime();
      return db - da;
    })
    .map(Money.decimalizeRecord);
}

// ─── DRIVER FINANCIAL OPERATIONS ──────────────────────────────────────────────

/**
 * Validate and shape one direct Driver Balance movement. These movements are
 * intentionally driver-only: no vehicle, office, capital-book, receipt, or Karta
 * posting is created alongside this ledger row.
 */
async function _prepareManualDriverBalancePayload(username, data) {
  if (!username) throw new Error('[FinancialService:createManualDriverBalanceEntry] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createManualDriverBalanceEntry] data must be a plain object.');
  }

  const driver_id = String(data.driver_id || '').trim();
  const entry_type = data.entry_type === 'deposit'
    ? 'deposit'
    : data.entry_type === 'withdraw'
      ? 'withdraw'
      : '';
  const rawAmount = Number(data.amount);
  const amount = Money.toCents(rawAmount);
  const date = data.date || DateUtils.todayLocal();
  const note = typeof data.note === 'string' ? data.note.trim() : '';

  if (!driver_id) throw new Error('[FinancialService:createManualDriverBalanceEntry] driver_id is required.');
  if (!entry_type) throw new Error('[FinancialService:createManualDriverBalanceEntry] entry_type must be deposit or withdraw.');
  if (!Number.isFinite(rawAmount) || !Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    throw new Error('[FinancialService:createManualDriverBalanceEntry] amount must be a finite value greater than zero.');
  }
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createManualDriverBalanceEntry] date must be a valid ISO date string.');
  }

  const driver = await ClientRepository.getDriverById(driver_id);
  if (!driver || driver.deleted_at !== null) {
    throw new Error('[FinancialService:createManualDriverBalanceEntry] driver not found.');
  }

  return {
    username,
    owner_id: String(driver.id),
    owner_name: driver.name || null,
    client_id: String(driver.id),
    client_type: 'driver',
    client_name: driver.name || null,
    vehicle_id: null,
    vehicle_plate: null,
    type: entry_type,
    effect: MANUAL_DRIVER_EFFECT,
    amount,
    reference_type: MANUAL_DRIVER_REF_TYPE,
    reference_id: _uuid(),
    date,
    applied_at: DateUtils.nowLocal(),
    is_reversed: false,
    note: note || null,
  };
}

async function _getActiveManualDriverBalanceEntries(reference_id) {
  const referenceKey = String(reference_id || '').trim();
  if (!referenceKey) throw new Error('[FinancialService:manualDriverBalance] reference_id is required.');

  const entries = await DB.getByIndex(STORE.LEDGER, 'by_reference_id', referenceKey);
  return entries.filter(entry =>
    entry.reference_type === MANUAL_DRIVER_REF_TYPE
    && entry.effect === MANUAL_DRIVER_EFFECT
    && entry.is_reversed === false
    && entry.deleted_at === null
  );
}

/**
 * Create exactly one direct driver balance movement. A deposit raises the
 * driver's balance and a withdrawal lowers it; neither posts to a vehicle.
 */
async function createManualDriverBalanceEntry(username, data) {
  const payload = await _prepareManualDriverBalancePayload(username, data);
  const [saved] = await DB.transaction([{
    op: 'add',
    store: STORE.LEDGER,
    payload,
  }], { username });

  return Money.decimalizeRecord(saved);
}

/**
 * Edit a direct driver movement through the established audit convention:
 * reverse its active row, then atomically add a replacement row.
 */
async function updateManualDriverBalanceEntry(username, reference_id, data) {
  if (!username) throw new Error('[FinancialService:updateManualDriverBalanceEntry] username is required.');
  const active = await _getActiveManualDriverBalanceEntries(reference_id);
  if (active.length === 0) {
    throw new Error('[FinancialService:updateManualDriverBalanceEntry] manual driver transaction not found or already reversed.');
  }

  const previous = active[0];
  const payload = await _prepareManualDriverBalancePayload(username, {
    ...data,
    driver_id: data?.driver_id || previous.owner_id,
  });
  const now = DateUtils.nowLocal();
  const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
  const results = await DB.transaction([
    ...active.map(entry => ({ op: 'update', store: STORE.LEDGER, id: entry.id, patch: reversePatch })),
    { op: 'add', store: STORE.LEDGER, payload },
  ], { username });

  return Money.decimalizeRecord(results[results.length - 1]);
}

/**
 * Reverse one direct driver movement while retaining its audit history.
 */
async function deleteManualDriverBalanceEntry(username, reference_id) {
  if (!username) throw new Error('[FinancialService:deleteManualDriverBalanceEntry] username is required.');
  const active = await _getActiveManualDriverBalanceEntries(reference_id);
  if (active.length === 0) {
    throw new Error('[FinancialService:deleteManualDriverBalanceEntry] manual driver transaction not found or already reversed.');
  }

  const now = DateUtils.nowLocal();
  const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
  return DB.transaction(
    active.map(entry => ({ op: 'update', store: STORE.LEDGER, id: entry.id, patch: reversePatch })),
    { username }
  );
}

async function getDriverLedger(driver_id) {
  const entries = await _fetchLedgerEntries(driver_id, 'driver_id');

  const sorted = entries.slice().sort((a, b) => {
    const da = new Date(a.date || a.applied_at || a.created_at || 0).getTime();
    const db = new Date(b.date || b.applied_at || b.created_at || 0).getTime();
    return da - db;
  });

  let runningCents = 0;
  const withRunningBalance = sorted.map((entry) => {
    const amtCents = Money.toCents(entry.amount);
    const deltaCents = (entry.type === 'deposit') ? Math.abs(amtCents) : -Math.abs(amtCents);
    runningCents += deltaCents;
    return {
      ...entry,
      running_balance: Money.toDecimal(runningCents),
    };
  });

  return withRunningBalance.slice().reverse();
}

async function getDriverBalance(driver_id) {
  const ledger = await getDriverLedger(driver_id);
  let deposit_total = 0;
  let withdraw_total = 0;

  for (const entry of ledger) {
    const cents = Money.toCents(entry.amount);
    if (entry.type === 'deposit') deposit_total += cents;
    else if (entry.type === 'withdraw') withdraw_total += Math.abs(cents);
  }

  return {
    driver_id: String(driver_id),
    balance: Money.toDecimal(deposit_total - withdraw_total),
    deposit_total: Money.toDecimal(deposit_total),
    withdraw_total: Money.toDecimal(withdraw_total),
    entry_count: ledger.length,
    last_transaction_date: ledger[0]?.date || ledger[0]?.applied_at || ledger[0]?.created_at || null,
  };
}

// ─── EXPORT ────────────────────────────────────────────────────────────────────


// ─── DRIVER KARTA SETTLEMENT (Phase 6B) ──────────────────────────────────────

const KARTA_REF_TYPE = 'receipt_row';
const KARTA_SETTLEMENT_TYPE = 'driver_karta_payment';
// Vehicle-balance leg of a karta settlement — follows the existing ledger
// architecture (rebuildVehicleBalance reads type deposit/withdraw by_vehicle;
// origin classification via the settlement effect tag).
const KARTA_CHARGE_EFFECT = 'karta_settlement_charge';

// The receipt row persists the driver's display-name snapshot specifically for
// receipt/Karta presentation. Use that existing association for the vehicle
// movement label; no extra ledger field or financial lookup is needed.
function _kartaVehicleSettlementNote(kartaRow) {
  const driverName = String(kartaRow?.driver_name || '').trim();
  return driverName ? `تسوية كارتة (${driverName})` : 'تسوية كارتة';
}

function _normalizeKartaSettlementAmount(value, label) {
  const decimal = Number(value);
  const cents = Money.toCents(decimal);
  if (!Number.isFinite(decimal) || !Number.isFinite(cents) || !Number.isInteger(cents) || cents <= 0) {
    throw new Error(`[FinancialService:${label}] amount must be a finite value greater than zero.`);
  }
  return cents;
}

function _activeKartaSettlementLegs(entries, rowId) {
  const rowKey = String(rowId || '').trim();
  return (entries || []).filter(entry =>
    entry.reference_type === KARTA_REF_TYPE
    && String(entry.reference_id || '') === rowKey
    && entry.is_reversed === false
    && entry.deleted_at === null
    && (entry.type === KARTA_SETTLEMENT_TYPE || entry.effect === KARTA_CHARGE_EFFECT)
  );
}

function _analyzeKartaSettlementPair(entries, rowId) {
  const activeLegs = _activeKartaSettlementLegs(entries, rowId);
  const driverLegs = activeLegs.filter(entry => entry.type === KARTA_SETTLEMENT_TYPE);
  const vehicleLegs = activeLegs.filter(entry => entry.effect === KARTA_CHARGE_EFFECT);

  let state = 'none';
  if (driverLegs.length === 1 && vehicleLegs.length === 1 && activeLegs.length === 2) state = 'complete';
  else if (driverLegs.length || vehicleLegs.length) {
    state = driverLegs.length <= 1 && vehicleLegs.length <= 1 ? 'partial' : 'duplicate';
  }

  return { state, activeLegs, driverLegs, vehicleLegs };
}

function _assertCompleteKartaSettlementPair(context, operation) {
  const { pair, row, rowId, driverId, vehicleId } = context;
  if (pair.state !== 'complete') {
    throw new Error(`[FinancialService:${operation}] Karta row ${rowId} has ${pair.state} active settlement state; expected one complete pair.`);
  }

  const driverLeg = pair.driverLegs[0];
  const vehicleLeg = pair.vehicleLegs[0];
  const driverAmount = Number(driverLeg.amount);
  const vehicleAmount = Number(vehicleLeg.amount);
  if (String(driverLeg.owner_id || '') !== driverId
    || String(driverLeg.vehicle_id || '') !== vehicleId
    || String(vehicleLeg.vehicle_id || '') !== vehicleId
    || driverLeg.reference_id !== row.row_id
    || vehicleLeg.reference_id !== row.row_id
    || !Number.isFinite(driverAmount)
    || !Number.isFinite(vehicleAmount)
    || driverAmount >= 0
    || vehicleAmount <= 0
    || Math.abs(driverAmount) !== vehicleAmount) {
    throw new Error(`[FinancialService:${operation}] Karta row ${rowId} has inconsistent active settlement legs.`);
  }
}

function _assertNoActiveKartaSettlementPair(context, operation) {
  if (context.pair.state === 'none') return;
  if (context.pair.state === 'complete') {
    throw new Error(`[FinancialService:${operation}] Karta row ${context.rowId} already has an active settlement.`);
  }
  throw new Error(`[FinancialService:${operation}] Karta row ${context.rowId} has ${context.pair.state} active settlement state.`);
}

function _buildKartaSettlementLegPayloads({
  username,
  row,
  driverId,
  vehicle,
  amount,
  date,
  note,
  batch_id = undefined,
  edited_from = undefined,
  applied_at = undefined,
}) {
  const now = applied_at || DateUtils.nowLocal();
  const shared = {
    ...(batch_id !== undefined ? { batch_id } : {}),
    ...(edited_from !== undefined ? { edited_from } : {}),
  };

  return [
    {
      username,
      owner_id: driverId,
      owner_name: null,
      client_id: null,
      client_type: 'driver',
      type: KARTA_SETTLEMENT_TYPE,
      amount: -amount,
      price: amount,
      vehicle_id: vehicle.id,
      reference_type: KARTA_REF_TYPE,
      reference_id: row.row_id,
      ...shared,
      date,
      applied_at: now,
      is_reversed: false,
      note,
    },
    {
      username,
      owner_id: String(vehicle.owner_id || ''),
      owner_name: vehicle.owner_name || null,
      client_id: String(vehicle.owner_id || ''),
      client_type: 'owner',
      client_name: vehicle.owner_name || null,
      vehicle_id: vehicle.id,
      vehicle_plate: vehicle.plate || null,
      type: 'withdraw',
      effect: KARTA_CHARGE_EFFECT,
      amount,
      reference_type: KARTA_REF_TYPE,
      reference_id: row.row_id,
      ...shared,
      date,
      applied_at: now,
      is_reversed: false,
      note: _kartaVehicleSettlementNote(row),
    },
  ];
}

async function _loadKartaSettlementContext(tx, { rowId, driverId, operation, requireActiveEntities = true }) {
  const rowKey = String(rowId || '').trim();
  if (!rowKey) throw new Error(`[FinancialService:${operation}] row_id is required.`);

  const row = await ReceiptRepository.getRowById(rowKey, { tx });
  if (!row) {
    throw new Error(`[FinancialService:${operation}] Karta row ${rowKey} not found or deleted.`);
  }

  const rowDriverId = String(row.driver_id || '').trim();
  if (!rowDriverId) {
    throw new Error(`[FinancialService:${operation}] Karta row ${rowKey} has no driver.`);
  }
  const expectedDriverId = String(driverId || '').trim();
  if (expectedDriverId && expectedDriverId !== rowDriverId) {
    throw new Error(`[FinancialService:${operation}] Karta row ${rowKey} does not belong to the selected driver.`);
  }

  const rowVehicleId = String(row.vehicle_id || '').trim();
  if (!rowVehicleId) {
    throw new Error(`[FinancialService:${operation}] Karta row ${rowKey} has no vehicle.`);
  }

  let driver = null;
  let vehicle = null;
  if (requireActiveEntities) {
    driver = await ClientRepository.getDriverById(rowDriverId, { tx });
    if (!driver || driver.deleted_at !== null) {
      throw new Error(`[FinancialService:${operation}] driver for Karta row ${rowKey} not found or inactive.`);
    }
    vehicle = await ClientRepository.getVehicleById(rowVehicleId, { tx });
    if (!vehicle || vehicle.deleted_at !== null) {
      throw new Error(`[FinancialService:${operation}] vehicle for Karta row ${rowKey} not found or inactive.`);
    }
  }

  const entries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', rowKey);
  return {
    rowId: rowKey,
    row,
    driverId: rowDriverId,
    vehicleId: rowVehicleId,
    driver,
    vehicle,
    pair: _analyzeKartaSettlementPair(entries, rowKey),
  };
}

async function _getActiveKartaSettlements() {
  const all = await DB.findByFields(STORE.LEDGER, {
    reference_type: KARTA_REF_TYPE,
    is_reversed: false,
  });
  return all.filter(e => e.type === KARTA_SETTLEMENT_TYPE);
}

/**
 * Return the Driver Details Karta projection. Settlement status is derived
 * exclusively from active driver_karta_payment legs; the persisted
 * driver_settlement_price is intentionally separate from those ledger prices
 * and from receipt_rows.driver_price (نولون).
 */
async function getDriverKartas(driverId) {
  if (!driverId) throw new Error('[FinancialService:getDriverKartas] driverId is required');

  const projectionData = await DriverKartaReadRepository.getDriverKartasData(driverId);
  const settlements = await _getActiveKartaSettlements();
  const settledRowIds = new Set();

  for (const settlement of settlements) {
    if (settlement.owner_id === driverId && settlement.reference_id) {
      settledRowIds.add(String(settlement.reference_id));
    }
  }

  const result = [];
  for (const { row, receipt } of projectionData) {
    if (!row || !row.row_id || row.driver_id !== driverId) continue;

    const settlementPriceCents = _readDriverSettlementPriceCents(row.driver_settlement_price);
    const settled = settledRowIds.has(String(row.row_id));
    result.push({
      row_id: row.row_id,
      receipt_id: row.receipt_id,
      date: receipt?.receipt_date || null,
      vehicle_id: row.vehicle_id || null,
      vehicle_plate: row.vehicle_plate || null,
      company: row.office || null,
      loading: row.loading || null,
      destination: row.destination || null,
      advance: Money.toDecimal(row.advance ?? 0),
      driver_settlement_price: settlementPriceCents === null
        ? null
        : Money.toDecimal(settlementPriceCents),
      status: settled ? 'settled' : 'unsettled',
    });
  }

  return result.sort((a, b) => new Date(b.date) - new Date(a.date));
}

async function getDriverKartasSummary(driverId) {
  const kartas = await getDriverKartas(driverId);
  let total_kartas = 0;
  let unsettled_kartas = 0;
  let settled_kartas = 0;
  let total_price = 0;

  for (const karta of kartas) {
    total_kartas++;
    if (karta.status === 'settled') settled_kartas++;
    else unsettled_kartas++;
    total_price += Money.toCents(karta.driver_settlement_price ?? 0);
  }

  return {
    total_kartas,
    unsettled_kartas,
    settled_kartas,
    total_price: Money.toDecimal(total_price),
  };
}

/**
 * Patch only the persisted Driver Details settlement price of one receipt row.
 * This write never creates or changes vehicle_ledger records.
 */
async function updateDriverKartaSettlementPrice(username, rowId, value) {
  if (!username) throw new Error('[FinancialService:updateDriverKartaSettlementPrice] username is required.');
  const rowKey = String(rowId ?? '').trim();
  if (!rowKey) throw new Error('[FinancialService:updateDriverKartaSettlementPrice] row_id is required.');

  const row = await ReceiptRepository.getRowById(rowKey);
  if (!row || row.deleted_at !== null) {
    throw new Error('[FinancialService:updateDriverKartaSettlementPrice] receipt row not found.');
  }
  if (!row.driver_id) {
    throw new Error('[FinancialService:updateDriverKartaSettlementPrice] receipt row must belong to a driver.');
  }

  const driver_settlement_price = _normalizeDriverSettlementPrice(value);
  const [saved] = await DB.transaction([{
    op: 'update',
    store: 'receipt_rows',
    id: rowKey,
    patch: { driver_settlement_price },
  }], { username });

  const decimalized = Money.decimalizeRecord(saved);
  return {
    ...decimalized,
    driver_settlement_price: driver_settlement_price === null
      ? null
      : Money.toDecimal(driver_settlement_price),
  };
}

/**
 * Settle multiple Driver Karta rows in ONE transaction. Each Karta preserves
 * its own receipt-row reference and vehicle withdrawal; batch_id only groups
 * the audit records created together.
 */
async function createKartaSettlementBatch(username, driverId, rowIds) {
  if (!username) throw new Error('[FinancialService:createKartaSettlementBatch] username is required.');
  const driverKey = String(driverId ?? '').trim();
  if (!driverKey) throw new Error('[FinancialService:createKartaSettlementBatch] driver_id is required.');
  if (!Array.isArray(rowIds) || rowIds.length === 0) {
    throw new Error('[FinancialService:createKartaSettlementBatch] row_ids must contain at least one row.');
  }

  const normalizedRowIds = rowIds.map(rowId => String(rowId ?? '').trim());
  if (normalizedRowIds.some(rowId => !rowId)) {
    throw new Error('[FinancialService:createKartaSettlementBatch] every row_id is required.');
  }
  if (new Set(normalizedRowIds).size !== normalizedRowIds.length) {
    throw new Error('[FinancialService:createKartaSettlementBatch] duplicate row_id in batch input.');
  }

  return DB.transaction(async (tx) => {
    // Schedule every authoritative read inside the same transaction before
    // validation or writes, so the active-settlement state is checked at the
    // exact transaction boundary that commits the new batch.
    const [rows, vehicles, drivers, ledger] = await Promise.all([
      tx.getAll('receipt_rows'),
      tx.getAll('vehicles'),
      tx.getAll('drivers'),
      tx.findByFields(STORE.LEDGER, { is_reversed: false }),
    ]);

    const driver = drivers.find(record => String(record.id) === driverKey);
    if (!driver) {
      throw new Error('[FinancialService:createKartaSettlementBatch] driver not found.');
    }

    const rowsById = new Map(rows.map(row => [String(row.row_id), row]));
    const vehiclesById = new Map(vehicles.map(vehicle => [String(vehicle.id), vehicle]));
    const activeByReference = new Map();
    for (const entry of ledger) {
      if (entry.reference_type !== KARTA_REF_TYPE || !entry.reference_id) continue;
      const key = String(entry.reference_id);
      if (!activeByReference.has(key)) activeByReference.set(key, []);
      activeByReference.get(key).push(entry);
    }

    const eligible = [];
    const skippedRowIds = [];
    for (const rowId of normalizedRowIds) {
      const row = rowsById.get(rowId);
      if (!row) {
        throw new Error(`[FinancialService:createKartaSettlementBatch] Karta row ${rowId} not found.`);
      }
      if (String(row.driver_id || '') !== driverKey) {
        throw new Error(`[FinancialService:createKartaSettlementBatch] Karta row ${rowId} does not belong to the selected driver.`);
      }

      const priceCents = _readDriverSettlementPriceCents(row.driver_settlement_price);
      if (priceCents === null || priceCents === 0) {
        skippedRowIds.push(rowId);
        continue;
      }

      const activeEntries = activeByReference.get(rowId) || [];
      const activePayment = activeEntries.find(entry => entry.type === KARTA_SETTLEMENT_TYPE);
      const activeCharge = activeEntries.find(entry => entry.effect === KARTA_CHARGE_EFFECT);
      if (activePayment) {
        // The row became settled after the UI loaded or was supplied directly.
        // Never duplicate either existing settlement leg.
        skippedRowIds.push(rowId);
        continue;
      }
      if (activeCharge) {
        throw new Error(`[FinancialService:createKartaSettlementBatch] Karta row ${rowId} has an active vehicle settlement charge without an active driver settlement.`);
      }

      const vehicleId = String(row.vehicle_id || '').trim();
      if (!vehicleId) {
        throw new Error(`[FinancialService:createKartaSettlementBatch] Karta row ${rowId} requires an active vehicle.`);
      }
      const vehicle = vehiclesById.get(vehicleId);
      if (!vehicle) {
        throw new Error(`[FinancialService:createKartaSettlementBatch] vehicle for Karta row ${rowId} not found or inactive.`);
      }

      eligible.push({ row, rowId, vehicle, priceCents });
    }

    if (eligible.length === 0) {
      return {
        success: true,
        batch_id: null,
        settled_row_ids: [],
        skipped_row_ids: skippedRowIds,
        settled_count: 0,
        total: 0,
        affected_vehicle_count: 0,
      };
    }

    const batch_id = _uuid();
    const now = DateUtils.nowLocal();
    const date = DateUtils.todayLocal();
    const ops = [];
    for (const { row, vehicle, priceCents } of eligible) {
      const [driverLeg, vehicleLeg] = _buildKartaSettlementLegPayloads({
        username,
        row,
        driverId: driverKey,
        vehicle,
        amount: priceCents,
        date,
        note: 'تسوية عامة للكارتات',
        batch_id,
        applied_at: now,
      });
      ops.push(
        { op: 'add', store: STORE.LEDGER, payload: driverLeg },
        { op: 'add', store: STORE.LEDGER, payload: vehicleLeg },
      );
    }

    await tx.runOps(ops);
    const totalCents = eligible.reduce((sum, item) => sum + item.priceCents, 0);
    return {
      success: true,
      batch_id,
      settled_row_ids: eligible.map(item => item.rowId),
      skipped_row_ids: skippedRowIds,
      settled_count: eligible.length,
      total: Money.toDecimal(totalCents),
      affected_vehicle_count: new Set(eligible.map(item => String(item.vehicle.id))).size,
    };
  }, { username, stores: [STORE.LEDGER, 'receipt_rows', 'vehicles', 'drivers'] });
}

async function getKartaSettlementHistory(rowId) {
  if (!rowId) throw new Error('[FinancialService:getKartaSettlementHistory] rowId is required');
  const entries = await DB.findByFields(STORE.LEDGER, {
    reference_type: KARTA_REF_TYPE,
    reference_id: rowId,
  });
  return entries
    .filter(e => e.type === KARTA_SETTLEMENT_TYPE)
    .sort((a, b) => new Date(a.date || a.applied_at) - new Date(b.date || b.applied_at))
    .map(Money.decimalizeRecord);
}

async function createKartaSettlement(username, data) {
  if (!username) throw new Error('[FinancialService:createKartaSettlement] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createKartaSettlement] data must be a plain object.');
  }

  const rowId = String(data.row_id || '').trim();
  const selectedDriverId = String(data.driver_id || '').trim();
  if (!rowId) throw new Error('[FinancialService:createKartaSettlement] row_id is required.');
  if (!selectedDriverId) throw new Error('[FinancialService:createKartaSettlement] driver_id is required.');
  const amount = _normalizeKartaSettlementAmount(data.amount, 'createKartaSettlement');
  const date = data.date || DateUtils.todayLocal();
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createKartaSettlement] date must be a valid ISO date string.');
  }
  const note = data.note || 'تسوية كارتة سائق';

  await DB.transaction(async (tx) => {
    const context = await _loadKartaSettlementContext(tx, {
      rowId,
      driverId: selectedDriverId,
      operation: 'createKartaSettlement',
    });
    if (data.vehicle_id !== undefined && String(data.vehicle_id || '').trim() !== context.vehicleId) {
      throw new Error('[FinancialService:createKartaSettlement] caller vehicle_id does not match the Karta row vehicle.');
    }
    _assertNoActiveKartaSettlementPair(context, 'createKartaSettlement');

    const [driverLeg, vehicleLeg] = _buildKartaSettlementLegPayloads({
      username,
      row: context.row,
      driverId: context.driverId,
      vehicle: context.vehicle,
      amount,
      date,
      note,
    });
    await tx.runOps([
      { op: 'add', store: STORE.LEDGER, payload: driverLeg },
      { op: 'add', store: STORE.LEDGER, payload: vehicleLeg },
    ]);
  }, { username, stores: [STORE.LEDGER, 'receipt_rows', 'drivers', 'vehicles'] });

  return {
    success: true,
    settlement_reference_id: rowId,
    row_id: rowId,
  };
}

/**
 * Replace one complete active Karta settlement with a corrected pair. The row
 * driver and vehicle remain authoritative; old legs are audit-reversed.
 */
async function updateKartaSettlement(username, data) {
  if (!username) throw new Error('[FinancialService:updateKartaSettlement] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:updateKartaSettlement] data must be a plain object.');
  }

  const rowId = String(data.row_id || '').trim();
  const selectedDriverId = String(data.driver_id || '').trim();
  if (!rowId) throw new Error('[FinancialService:updateKartaSettlement] row_id is required.');
  if (!selectedDriverId) throw new Error('[FinancialService:updateKartaSettlement] driver_id is required.');
  const amount = _normalizeKartaSettlementAmount(data.amount, 'updateKartaSettlement');
  const date = data.date || DateUtils.todayLocal();
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:updateKartaSettlement] date must be a valid ISO date string.');
  }
  const note = data.note || 'تسوية كارتة سائق';

  await DB.transaction(async (tx) => {
    const context = await _loadKartaSettlementContext(tx, {
      rowId,
      driverId: selectedDriverId,
      operation: 'updateKartaSettlement',
    });
    if (data.vehicle_id !== undefined && String(data.vehicle_id || '').trim() !== context.vehicleId) {
      throw new Error('[FinancialService:updateKartaSettlement] caller vehicle_id does not match the Karta row vehicle.');
    }
    _assertCompleteKartaSettlementPair(context, 'updateKartaSettlement');

    const reversePatch = { is_reversed: true, reversed_at: DateUtils.nowLocal(), reversed_by: username };
    const [driverLeg, vehicleLeg] = _buildKartaSettlementLegPayloads({
      username,
      row: context.row,
      driverId: context.driverId,
      vehicle: context.vehicle,
      amount,
      date,
      note,
      edited_from: context.pair.driverLegs[0].id,
    });
    await tx.runOps([
      ...context.pair.activeLegs.map(leg => ({ op: 'update', store: STORE.LEDGER, id: leg.id, patch: reversePatch })),
      { op: 'add', store: STORE.LEDGER, payload: driverLeg },
      { op: 'add', store: STORE.LEDGER, payload: vehicleLeg },
    ]);
  }, { username, stores: [STORE.LEDGER, 'receipt_rows', 'drivers', 'vehicles'] });

  return {
    success: true,
    settlement_reference_id: rowId,
    row_id: rowId,
    edited: true,
  };
}

async function reverseKartaSettlement(username, settlementReferenceId) {
  if (!username) throw new Error('[FinancialService:reverseKartaSettlement] username is required.');
  const rowId = String(settlementReferenceId || '').trim();
  if (!rowId) throw new Error('[FinancialService:reverseKartaSettlement] settlementReferenceId is required.');

  await DB.transaction(async (tx) => {
    const context = await _loadKartaSettlementContext(tx, {
      rowId,
      operation: 'reverseKartaSettlement',
      requireActiveEntities: false,
    });
    _assertCompleteKartaSettlementPair(context, 'reverseKartaSettlement');

    const now = DateUtils.nowLocal();
    const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
    await tx.runOps(context.pair.activeLegs.map(leg => ({
      op: 'update',
      store: STORE.LEDGER,
      id: leg.id,
      patch: reversePatch,
    })));
  }, { username, stores: [STORE.LEDGER, 'receipt_rows'] });

  return {
    success: true,
    settlement_reference_id: rowId,
    row_id: rowId,
  };
}

// ─── EXPORT ────────────────────────────────────────────────────────────────────

// ─── PUBLIC: setReceiptRowPaymentStatus — explicit row payment state machine ─
// unpaid → unpaid : no-op          paid → paid : no-op
// unpaid → paid   : post vehicle (الصافي) + company (الصافي + الصرف) exactly once
// paid   → unpaid : reverse exactly those postings, exactly once
// Status write and financial postings commit in ONE atomic DB.transaction —
// never «paid without posting», never «posting without paid».
async function setReceiptRowPaymentStatus(username, rowId, targetStatus) {
  if (!username) throw new Error('[FinancialService:setReceiptRowPaymentStatus] username is required.');
  const rowKey = String(rowId ?? '').trim();
  if (!rowKey) throw new Error('[FinancialService:setReceiptRowPaymentStatus] row_id is required.');
  const target = targetStatus === PAYMENT_STATUS.PAID ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.UNPAID;

  return DB.transaction(async (tx) => {
    const row = await ReceiptRepository.getRowById(rowKey, { tx });
    if (!row || row.deleted_at !== null) {
      throw new Error('[FinancialService:setReceiptRowPaymentStatus] receipt row not found.');
    }
    const current = row.payment_status === PAYMENT_STATUS.PAID
      ? PAYMENT_STATUS.PAID
      : PAYMENT_STATUS.UNPAID;
    const paymentPair = await _getReceiptPaymentPair(rowKey, { tx });

    if (current === target) {
      if (target === PAYMENT_STATUS.PAID) {
        _assertCompleteReceiptPaymentPair(paymentPair, 'setReceiptRowPaymentStatus', row);
      } else {
        _assertNoActiveReceiptPaymentEffects(paymentPair, 'setReceiptRowPaymentStatus', rowKey);
      }
      return {
        row_id: rowKey,
        receipt_id: row.receipt_id,
        payment_status: current,
        changed: false,
        vehicle_id: row.vehicle_id,
        office_id: target === PAYMENT_STATUS.PAID
          ? paymentPair.companyLegs[0].client_id
          : null,
      };
    }

    if (target === PAYMENT_STATUS.PAID) {
      _assertNoActiveReceiptPaymentEffects(paymentPair, 'setReceiptRowPaymentStatus', rowKey);
      const targets = await _resolveReceiptPaymentTargets(row, { tx });
      const legs = _buildReceiptPaymentLegs(username, row, targets, null);
      await tx.runOps([
        ...legs.map(payload => ({ op: 'add', store: STORE.LEDGER, payload })),
        { op: 'update', store: 'receipt_rows', id: rowKey, patch: { payment_status: PAYMENT_STATUS.PAID } },
      ]);
      return {
        row_id: rowKey,
        receipt_id: row.receipt_id,
        payment_status: PAYMENT_STATUS.PAID,
        changed: true,
        vehicle_id: targets.vehicle.id,
        office_id: targets.office.id,
      };
    }

    _assertCompleteReceiptPaymentPair(paymentPair, 'setReceiptRowPaymentStatus', row);
    const now = DateUtils.nowLocal();
    const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
    await tx.runOps([
      ...paymentPair.activePaymentLegs.map(entry => ({
        op: 'update', store: STORE.LEDGER, id: entry.id, patch: reversePatch,
      })),
      { op: 'update', store: 'receipt_rows', id: rowKey, patch: { payment_status: PAYMENT_STATUS.UNPAID } },
    ]);
    return {
      row_id: rowKey,
      receipt_id: row.receipt_id,
      payment_status: PAYMENT_STATUS.UNPAID,
      changed: true,
      vehicle_id: row.vehicle_id,
      office_id: paymentPair.companyLegs[0].client_id,
    };
  }, { username, stores: [STORE.LEDGER, 'receipt_rows', 'vehicles', 'offices'] });
}

export const FinancialService = Object.freeze({
  createReceipt,
  updateReceipt,
  deleteReceipt,
  rebuildVehicleBalance,
  getVehicleLedger,
  getVehicleLedgerDateIntegrityDiagnostic,
  getLedgerIntegrityDiagnosticSnapshot,
  getVehicleMonthlyReport,
  getOfficeBalance,
  createManualVehicleBalanceEntry,
  updateVehicleMaintenanceEntry,
  deleteManualVehicleBalanceEntry,
  createManualOfficeBalanceEntry,
  deleteManualOfficeBalanceEntry,
  getDriverBalance,
  getDriverLedger,
  createManualDriverBalanceEntry,
  updateManualDriverBalanceEntry,
  deleteManualDriverBalanceEntry,
  getDriverKartas,
  getDriverKartasSummary,
  updateDriverKartaSettlementPrice,
  createKartaSettlementBatch,
  getKartaSettlementHistory,
  createKartaSettlement,
  updateKartaSettlement,
  reverseKartaSettlement,
  setReceiptRowPaymentStatus,
});
