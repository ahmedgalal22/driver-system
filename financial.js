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
 *   entries (effect/reference_type 'receipt_row_payment', reference_id = row
 *   UUID); status transitions post/reverse them atomically with the row write.
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
import { WriteDataSource } from './services/writeDataSource.js';
import { createPersistenceCommand, PersistenceCommandType } from './services/persistenceCommand.js';
import { DriverKartaReadRepository } from './services/driverKartaReadRepository.js';
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
const RECEIPT_ROW_COMPANY_CHARGE_REF_TYPE = 'receipt_row_company_charge';
const RECEIPT_ROW_COMPANY_CHARGE_EFFECT = 'receipt_row_company_charge';
const SALFA_RECOVERY_REF_TYPE = 'salfa_recovery';
const SALFA_RECOVERY_EFFECT = 'salfa_recovery';


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

function _buildReceiptRowEntities(validatedRows, receiptId) {
  return validatedRows.map(row => ({
    row_id: row.row_id,
    receipt_id: receiptId,
    driver_id: row.driver_id || null,
    vehicle_id: row.vehicle_id,
    vehicle_plate: row.vehicle_plate || null,
    driver_price: Money.toCents(row.driver_price ?? 0),
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
    // payment_status: 'unpaid' | 'paid' — default unpaid; any non-'paid'
    // value (incl. legacy rows without the field) clamps to 'unpaid'.
    payment_status: row.payment_status === PAYMENT_STATUS.PAID
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

// ─── RECEIPT ROW PAYMENT POSTINGS (تم صرفه / لم يتم صرفه) ───────────────────
// Financial effect exists ONLY while a row is paid. One ACTIVE posting set
// per receipt row UUID, durable in vehicle_ledger:
//   • vehicle leg — client_type 'vehicle', vehicle_id set (by_vehicle index →
//     rebuildVehicleBalance), amount = الصافي (row.net, cents)
//   • company leg — client_type 'office', amount = الصافي + الصرف
//     (row.net + row.sarf, cents); NO vehicle_id (would double-count in
//     rebuildVehicleBalance)
// Reversal = is_reversed:true (project audit convention), never hard delete.

async function _getActivePaymentPostings(rowId) {
  const entries = await DB.getByIndex(STORE.LEDGER, 'by_reference_id', String(rowId));
  return entries.filter(e =>
    e.reference_type === PAYMENT_REF_TYPE &&
    e.effect === PAYMENT_EFFECT &&
    e.is_reversed === false &&
    e.deleted_at === null
  );
}

async function _resolvePaymentTargets(row) {
  // Guards evaluated BEFORE the write transaction (same race rationale as
  // createKartaSettlement): unknown/deleted relations fail LOUDLY so nothing
  // is silently associated with the wrong vehicle or company.
  const vehicle = await ClientRepository.getVehicleById(String(row.vehicle_id || ''));
  if (!vehicle || vehicle.deleted_at !== null) {
    throw new Error('[FinancialService] cannot post payment: vehicle not found for the row.');
  }
  const officeName = String(row.office || '').trim();
  if (!officeName) {
    throw new Error('[FinancialService] cannot post payment: row has no company (اسم الشركة).');
  }
  const offices = await OfficeRepository.findByName(officeName);
  const office = (offices || []).find(o => o && o.deleted_at === null);
  if (!office) {
    throw new Error(`[FinancialService] unknown office: ${officeName}`);
  }
  return { vehicle, office };
}

function _paymentLegPayloads(username, row, targets, receiptDate) {
  const now = DateUtils.nowLocal();
  const date = row.date || receiptDate || DateUtils.todayLocal();
  const netCents  = Number(row.net)  || 0; // persisted rows: already cents
  const sarfCents = Number(row.sarf) || 0;
  const { vehicle, office } = targets;
  return [
    { // vehicle leg — الصافي
      username,
      owner_id: String(vehicle.owner_id || ''),
      owner_name: vehicle.owner_name || null,
      client_id: String(vehicle.id),
      client_type: 'vehicle',
      client_name: vehicle.plate || row.vehicle_plate || null,
      vehicle_id: vehicle.id,
      vehicle_plate: vehicle.plate || row.vehicle_plate || null,
      type: 'deposit',
      effect: PAYMENT_EFFECT,
      amount: netCents,
      reference_type: PAYMENT_REF_TYPE,
      reference_id: String(row.row_id),
      date,
      applied_at: now,
      is_reversed: false,
      note: `صرف كارتة — الصافي (مركبة ${vehicle.plate || row.vehicle_plate || ''})`,
    },
    { // company leg — الصافي + الصرف (explicitly NOT just الصافي)
      username,
      owner_id: String(office.id),
      owner_name: office.name || null,
      client_id: String(office.id),
      client_type: 'office',
      client_name: office.name || null,
      vehicle_id: null, // by_vehicle sums must never see the company leg
      vehicle_plate: row.vehicle_plate || null,
      type: 'deposit',
      effect: PAYMENT_EFFECT,
      amount: netCents + sarfCents,
      reference_type: PAYMENT_REF_TYPE,
      reference_id: String(row.row_id),
      date,
      applied_at: now,
      is_reversed: false,
      note: `صرف كارتة — الصافي + الصرف (${office.name || ''})`,
    },
  ];
}

async function _paymentAddCommands(username, row, receiptDate) {
  const targets = await _resolvePaymentTargets(row);
  return _paymentLegPayloads(username, row, targets, receiptDate)
    .map(payload => createPersistenceCommand(PersistenceCommandType.ADD, 'Ledger', null, { payload }));
}

function _paymentReverseCommands(entries, username) {
  const now = DateUtils.nowLocal();
  const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
  return entries.map(e =>
    createPersistenceCommand(PersistenceCommandType.UPDATE, 'Ledger', e.id, { patch: reversePatch })
  );
}

// ─── RECEIPT-ROW COMPANY CHARGES (Karta creation) ───────────────────────────
// Every persisted receipt row with a resolved company creates one independent
// company withdrawal. This is intentionally separate from receipt_row_payment:
// it exists at receipt creation regardless of payment_status and remains linked
// to the row UUID through the receipt lifecycle.
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

async function createReceipt(username, data) {
  if (!username) throw new Error('[FinancialService:create] username is required.');

  const receiptId = data.id || _uuid();
  const clean = _validate(data);

  // Build Receipt header
  const receiptHeader = _buildReceiptHeaderEntity(clean, username, receiptId);

  // Build ReceiptRow entities
  const receiptRows = _buildReceiptRowEntities(clean.rows, receiptId);

  // Assemble the full persistence record ONCE.
  const receiptRecord = {
    ...receiptHeader,
    total: clean.total,
    notes: data.notes ?? null,
  };

  // Prepare PersistenceCommands via ReceiptRepository (Add)
  const receiptCommand = ReceiptRepository.prepareReceiptOperation(receiptRecord, { username });

  const receiptRowCommands = ReceiptRepository.prepareReceiptRowOperations(receiptRows, { username });

  // Receipt creation charges each resolved company once per row UUID. These
  // withdrawals are independent from the later paid/unpaid payment postings.
  const companyChargeAddCommands = [];
  for (const row of receiptRows) {
    companyChargeAddCommands.push(...(await _receiptRowCompanyChargeAddCommands(
      username, row, receiptRecord.receipt_date
    )));
  }

  // Payment postings: a newly created row enters paid only if explicitly
  // collected as such (form default is unpaid → normally zero commands here).
  // Fresh row UUIDs → no pre-existing postings can exist for these ids.
  const paymentAddCommands = [];
  for (const row of receiptRows) {
    if (row.payment_status === PAYMENT_STATUS.PAID) {
      paymentAddCommands.push(...(await _paymentAddCommands(username, row, receiptRecord.receipt_date)));
    }
  }

  // Combine all commands: header + rows + company charges + any paid-row
  // payment postings commit atomically through the existing write boundary.
  const allCommands = [
    receiptCommand,
    ...receiptRowCommands,
    ...companyChargeAddCommands,
    ...paymentAddCommands,
  ];

  // Execute through WriteDataSource
  const results = await WriteDataSource.execute(allCommands, { username });

  const receipt = Money.decimalizeRecord(results[0]);

  return { receipt };
}

// ─── PUBLIC: updateReceipt ─────────────────────────────────────────────────────

async function updateReceipt(username, id, data) {
  if (!username) throw new Error('[FinancialService:update] username is required.');
  if (!id)       throw new Error('[FinancialService:update] id is required.');

  const clean = _validate(data);

  // Build updated Receipt header
  const receiptHeader = _buildReceiptHeaderEntity(clean, username, id);

  // Build updated ReceiptRow entities
  const newReceiptRows = _buildReceiptRowEntities(clean.rows, id);

  // Assemble the full persistence record ONCE (Update semantics:
  // notes is only patched when provided).
  const receiptRecord = {
    ...receiptHeader,
    total: clean.total,
    ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
  };

  // Retrieve existing ReceiptRows (they must be REPLACED, not appended —
  // new row entities get fresh row_ids on every edit, so failing to delete
  // the old set would duplicate every karta in receipt_rows).
  const existingReceiptRows = await _getExistingReceiptRows(id);

  // Payment reconciliation (atomic with the row replacement below):
  // replacement issues fresh row UUIDs, and every posting is linked to its
  // row UUID — so each paid OLD row's ACTIVE postings reverse into audit and
  // each paid NEW row posts exactly once. Unchanged paid rows therefore have
  // ZERO net balance effect; changed vehicle/company/الصافي/الصرف rows are
  // safely adjusted (old effect reversed, new effect posted) — never
  // duplicated, never lost.
  const paymentReverseCommands = [];
  for (const oldRow of existingReceiptRows) {
    const active = await _getActivePaymentPostings(oldRow.row_id);
    if (active.length > 0) {
      paymentReverseCommands.push(..._paymentReverseCommands(active, username));
    }
  }
  const paymentAddCommands = [];
  for (const newRow of newReceiptRows) {
    if (newRow.payment_status === PAYMENT_STATUS.PAID) {
      paymentAddCommands.push(...(await _paymentAddCommands(username, newRow, receiptRecord.receipt_date)));
    }
  }

  // Row replacement mints fresh row UUIDs. Reverse every old receipt-created
  // company charge into audit history, then create exactly one charge for every
  // new row with a resolved company.
  const companyChargeReverseCommands = [];
  for (const oldRow of existingReceiptRows) {
    const active = await _getActiveReceiptRowCompanyCharges(oldRow.row_id);
    if (active.length > 0) {
      companyChargeReverseCommands.push(..._receiptRowCompanyChargeReverseCommands(active, username));
    }
  }
  const companyChargeAddCommands = [];
  for (const newRow of newReceiptRows) {
    companyChargeAddCommands.push(...(await _receiptRowCompanyChargeAddCommands(
      username, newRow, receiptRecord.receipt_date
    )));
  }

  // Prepare PersistenceCommands via ReceiptRepository
  const receiptCommand = ReceiptRepository.prepareReceiptOperation(
    receiptRecord, { username }, PersistenceCommandType.UPDATE
  );

  const deleteRowCommands = existingReceiptRows.map(row =>
    ReceiptRepository.prepareReceiptRowOperations(
      [{ row_id: row.row_id }], { username }, PersistenceCommandType.DELETE
    )[0]
  );

  const receiptRowCommands = ReceiptRepository.prepareReceiptRowOperations(newReceiptRows, { username });

  // Combine all commands: header update → replace rows → reverse/recreate both
  // independent financial namespaces in one atomic write batch.
  const allCommands = [
    receiptCommand,
    ...deleteRowCommands,
    ...receiptRowCommands,
    ...paymentReverseCommands,
    ...companyChargeReverseCommands,
    ...companyChargeAddCommands,
    ...paymentAddCommands,
  ];

  // Execute through WriteDataSource
  const results = await WriteDataSource.execute(allCommands, { username });

  const receipt = Money.decimalizeRecord(results[0]); // First command is the header update

  return { receipt };
}

// ─── PUBLIC: deleteReceipt ─────────────────────────────────────────────────────

async function deleteReceipt(username, id) {
  if (!username) throw new Error('[FinancialService:delete] username is required.');
  if (!id)       throw new Error('[FinancialService:delete] id is required.');

  // Prepare delete command for Receipt via ReceiptRepository (Delete carries id only)
  const receiptDeleteCommand = ReceiptRepository.prepareReceiptOperation(
    { id },
    { username },
    PersistenceCommandType.DELETE
  );

  // Prepare delete commands for ReceiptRows
  const existingRows = await _getExistingReceiptRows(id);

  // Payment reconciliation: deleting a receipt whose rows were paid reverses
  // exactly those postings (is_reversed audit, never hard delete) inside the
  // same atomic execute — a deleted row can never leave a live effect behind.
  const paymentReverseCommands = [];
  for (const row of existingRows) {
    const active = await _getActivePaymentPostings(row.row_id);
    if (active.length > 0) {
      paymentReverseCommands.push(..._paymentReverseCommands(active, username));
    }
  }

  const companyChargeReverseCommands = [];
  for (const row of existingRows) {
    const active = await _getActiveReceiptRowCompanyCharges(row.row_id);
    if (active.length > 0) {
      companyChargeReverseCommands.push(..._receiptRowCompanyChargeReverseCommands(active, username));
    }
  }

  const receiptRowDeleteCommands = existingRows.map(row =>
    ReceiptRepository.prepareReceiptRowOperations(
      [{ row_id: row.row_id }], { username }, PersistenceCommandType.DELETE
    )[0]
  );

  // Combine all commands: delete rows/header and reverse both independent
  // receipt-row financial namespaces atomically.
  const allCommands = [
    ...receiptRowDeleteCommands,
    receiptDeleteCommand,
    ...paymentReverseCommands,
    ...companyChargeReverseCommands,
  ];

  // Execute through WriteDataSource
  await WriteDataSource.execute(allCommands, { username });

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
      && ((e.reference_type === PAYMENT_REF_TYPE && e.effect === PAYMENT_EFFECT)
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
 * Create one manual vehicle balance movement in the existing vehicle_ledger.
 * This is intentionally a single vehicle leg: it has no receipt-row, company,
 * driver, or Karta Settlement side effect.
 */
async function createManualVehicleBalanceEntry(username, data) {
  if (!username) throw new Error('[FinancialService:createManualVehicleBalanceEntry] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createManualVehicleBalanceEntry] data must be a plain object.');
  }

  const vehicle_id = String(data.vehicle_id || '').trim();
  const entry_type = data.entry_type === 'withdraw' ? 'withdraw' : data.entry_type === 'deposit' ? 'deposit' : '';
  const amount = Money.toCents(data.amount);
  const date = data.date || DateUtils.todayLocal();
  const note = typeof data.note === 'string' ? data.note.trim() : '';

  if (!vehicle_id) throw new Error('[FinancialService:createManualVehicleBalanceEntry] vehicle_id is required.');
  if (!entry_type) throw new Error('[FinancialService:createManualVehicleBalanceEntry] entry_type must be deposit or withdraw.');
  if (amount <= 0) throw new Error('[FinancialService:createManualVehicleBalanceEntry] amount must be greater than zero.');
  if (!note) throw new Error('[FinancialService:createManualVehicleBalanceEntry] note is required.');
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createManualVehicleBalanceEntry] date must be a valid ISO date string.');
  }

  // Resolve the vehicle before scheduling the atomic ledger write. A missing
  // vehicle must fail loudly; manual entry must never create a fallback record.
  const vehicle = await ClientRepository.getVehicleById(vehicle_id);
  if (!vehicle || vehicle.deleted_at !== null) {
    throw new Error('[FinancialService:createManualVehicleBalanceEntry] vehicle not found.');
  }

  const reference_id = _uuid();
  const now = DateUtils.nowLocal();
  const [saved] = await DB.transaction([{
    op: 'add',
    store: STORE.LEDGER,
    payload: {
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
 * Reverse one logical manual vehicle movement without removing its audit row.
 */
async function deleteManualVehicleBalanceEntry(username, reference_id) {
  if (!username) throw new Error('[FinancialService:deleteManualVehicleBalanceEntry] username is required.');
  const referenceKey = String(reference_id || '').trim();
  if (!referenceKey) throw new Error('[FinancialService:deleteManualVehicleBalanceEntry] reference_id is required.');

  const entries = await DB.getByIndex(STORE.LEDGER, 'by_reference_id', referenceKey);
  const active = entries.filter(entry =>
    entry.reference_type === MANUAL_VEHICLE_REF_TYPE
    && entry.effect === MANUAL_VEHICLE_EFFECT
    && entry.is_reversed === false
    && entry.deleted_at === null
  );
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

async function createDriverDeposit(username, data) {
  if (!username) throw new Error('[FinancialService:createDriverDeposit] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createDriverDeposit] data must be a plain object.');
  }

  const driver_id = String(data.driver_id || '').trim();
  const vehicle_id = String(data.vehicle_id || '').trim();
  const amount = Money.toCents(data.amount);
  const date = data.date || DateUtils.todayLocal();
  const note = typeof data.note === 'string' && data.note.trim() ? data.note.trim() : 'إيداع رصيد من المركبة';

  if (!driver_id) throw new Error('[FinancialService:createDriverDeposit] driver_id is required.');
  if (!vehicle_id) throw new Error('[FinancialService:createDriverDeposit] vehicle_id is required.');
  if (amount <= 0) throw new Error('[FinancialService:createDriverDeposit] amount must be greater than zero.');
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createDriverDeposit] date must be a valid ISO date string.');
  }

  const referenceId = _uuid();
  const now = DateUtils.nowLocal();

  return DB.transaction(async (tx) => {
    const driver = await ClientRepository.getDriverById(driver_id, { tx });
    if (!driver || driver.deleted_at !== null) {
      throw new Error('[FinancialService:createDriverDeposit] driver not found.');
    }
    const vehicle = await ClientRepository.getVehicleById(vehicle_id, { tx });
    if (!vehicle || vehicle.deleted_at !== null) {
      throw new Error('[FinancialService:createDriverDeposit] vehicle not found.');
    }

    const ops = [
      {
        op: 'add',
        store: STORE.LEDGER,
        payload: {
          username,
          owner_id: String(vehicle.owner_id || ''),
          owner_name: vehicle.owner_name || null,
          client_id: String(vehicle.owner_id || ''),
          client_type: 'owner',
          vehicle_id: vehicle.id,
          vehicle_plate: vehicle.plate,
          type: 'withdraw',
          amount,
          reference_type: 'driver_deposit',
          reference_id: referenceId,
          date,
          applied_at: now,
          is_reversed: false,
          note: `إيداع للسائق ${driver.name} من المركبة ${vehicle.plate}`,
        },
      },
      {
        op: 'add',
        store: STORE.LEDGER,
        payload: {
          username,
          owner_id: driver_id,
          owner_name: driver.name || null,
          client_id: driver_id,
          client_type: 'driver',
          client_name: driver.name || null,
          vehicle_id: vehicle.id,
          vehicle_plate: vehicle.plate,
          type: 'deposit',
          amount,
          reference_type: 'driver_deposit',
          reference_id: referenceId,
          date,
          applied_at: now,
          is_reversed: false,
          note: note,
        },
      },
    ];

    const results = await tx.runOps(ops);
    return results.map(Money.decimalizeRecord);
  }, { username, stores: [STORE.LEDGER, 'drivers', 'vehicles'] });
}

async function createDriverSalfa(username, data) {
  if (!username) throw new Error('[FinancialService:createDriverSalfa] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createDriverSalfa] data must be a plain object.');
  }

  const driver_id = String(data.driver_id || '').trim();
  const amount = Money.toCents(data.amount);
  const date = data.date || DateUtils.todayLocal();
  const note = typeof data.note === 'string' && data.note.trim() ? data.note.trim() : 'سلفة سائق';

  if (!driver_id) throw new Error('[FinancialService:createDriverSalfa] driver_id is required.');
  if (amount <= 0) throw new Error('[FinancialService:createDriverSalfa] amount must be greater than zero.');
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createDriverSalfa] date must be a valid ISO date string.');
  }

  const referenceId = _uuid();
  const now = DateUtils.nowLocal();

  return DB.transaction(async (tx) => {
    const driver = await ClientRepository.getDriverById(driver_id, { tx });
    if (!driver || driver.deleted_at !== null) {
      throw new Error('[FinancialService:createDriverSalfa] driver not found.');
    }

    const ops = [
      {
        op: 'add',
        store: STORE.LEDGER,
        payload: {
          username,
          owner_id: driver_id,
          owner_name: driver.name || null,
          client_id: driver_id,
          client_type: 'driver',
          client_name: driver.name || null,
          vehicle_id: null,
          vehicle_plate: null,
          type: 'withdraw',
          effect: 'salfa',
          amount,
          reference_type: 'salfa',
          reference_id: referenceId,
          date,
          applied_at: now,
          is_reversed: false,
          note,
        },
      },
    ];

    const results = await tx.runOps(ops);
    return Money.decimalizeRecord(results[0]);
  }, { username, stores: [STORE.LEDGER, 'drivers'] });
}

/**
 * Record repayment of a driver's existing salfa. This is the exact ledger
 * opposite of createDriverSalfa: the driver receives a deposit, so their
 * derived balance moves back toward zero without rewriting the original salfa.
 */
async function createDriverSalfaRecovery(username, data) {
  if (!username) throw new Error('[FinancialService:createDriverSalfaRecovery] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createDriverSalfaRecovery] data must be a plain object.');
  }

  const driver_id = String(data.driver_id || '').trim();
  const amount = Money.toCents(data.amount);
  const date = data.date || DateUtils.todayLocal();
  const note = typeof data.note === 'string' && data.note.trim()
    ? data.note.trim()
    : 'استرداد سلفة';

  if (!driver_id) throw new Error('[FinancialService:createDriverSalfaRecovery] driver_id is required.');
  if (amount <= 0) throw new Error('[FinancialService:createDriverSalfaRecovery] amount must be greater than zero.');
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createDriverSalfaRecovery] date must be a valid ISO date string.');
  }

  const driver = await ClientRepository.getDriverById(driver_id);
  if (!driver || driver.deleted_at !== null) {
    throw new Error('[FinancialService:createDriverSalfaRecovery] driver not found.');
  }

  const referenceId = _uuid();
  const now = DateUtils.nowLocal();
  const [saved] = await DB.transaction([{
    op: 'add',
    store: STORE.LEDGER,
    payload: {
      username,
      owner_id: driver_id,
      owner_name: driver.name || null,
      client_id: driver_id,
      client_type: 'driver',
      client_name: driver.name || null,
      vehicle_id: null,
      vehicle_plate: null,
      type: 'deposit',
      effect: SALFA_RECOVERY_EFFECT,
      amount,
      reference_type: SALFA_RECOVERY_REF_TYPE,
      reference_id: referenceId,
      date,
      applied_at: now,
      is_reversed: false,
      note,
    },
  }], { username });

  return Money.decimalizeRecord(saved);
}

async function updateDriverDeposit(username, reference_id, data) {
  if (!username) throw new Error('[FinancialService:updateDriverDeposit] username is required.');
  if (!reference_id) throw new Error('[FinancialService:updateDriverDeposit] reference_id is required.');

  return DB.transaction(async (tx) => {
    const existingEntries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', reference_id);
    const activeEntries = existingEntries.filter(e => e.is_reversed === false && e.deleted_at === null);
    if (activeEntries.length === 0) {
      throw new Error('[FinancialService:updateDriverDeposit] Transaction reference not found.');
    }

    const now = DateUtils.nowLocal();
    const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
    const reverseOps = activeEntries.map(e => ({
      op: 'update',
      store: STORE.LEDGER,
      id: e.id,
      patch: reversePatch,
    }));

    await tx.runOps(reverseOps);

    const first = activeEntries[0];
    return createDriverDeposit(username, {
      driver_id: data.driver_id || first.owner_id,
      vehicle_id: data.vehicle_id || first.vehicle_id,
      amount: data.amount,
      date: data.date,
      note: data.note,
    });
  }, { username, stores: [STORE.LEDGER, 'drivers', 'vehicles'] });
}

async function deleteDriverDeposit(username, reference_id) {
  if (!username) throw new Error('[FinancialService:deleteDriverDeposit] username is required.');
  if (!reference_id) throw new Error('[FinancialService:deleteDriverDeposit] reference_id is required.');

  return DB.transaction(async (tx) => {
    const existingEntries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', reference_id);
    const activeEntries = existingEntries.filter(e => e.is_reversed === false && e.deleted_at === null);
    if (activeEntries.length === 0) {
      throw new Error('[FinancialService:deleteDriverDeposit] Transaction reference not found.');
    }

    const now = DateUtils.nowLocal();
    const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
    const reverseOps = activeEntries.map(e => ({
      op: 'update',
      store: STORE.LEDGER,
      id: e.id,
      patch: reversePatch,
    }));

    return tx.runOps(reverseOps);
  }, { username, stores: [STORE.LEDGER] });
}

async function updateDriverSalfa(username, reference_id, data) {
  if (!username) throw new Error('[FinancialService:updateDriverSalfa] username is required.');
  if (!reference_id) throw new Error('[FinancialService:updateDriverSalfa] reference_id is required.');

  return DB.transaction(async (tx) => {
    const existingEntries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', reference_id);
    const activeEntries = existingEntries.filter(e => e.is_reversed === false && e.deleted_at === null);
    if (activeEntries.length === 0) {
      throw new Error('[FinancialService:updateDriverSalfa] Transaction reference not found.');
    }

    const now = DateUtils.nowLocal();
    const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
    const reverseOps = activeEntries.map(e => ({
      op: 'update',
      store: STORE.LEDGER,
      id: e.id,
      patch: reversePatch,
    }));

    await tx.runOps(reverseOps);

    const first = activeEntries[0];
    return createDriverSalfa(username, {
      driver_id: data.driver_id || first.owner_id,
      amount: data.amount,
      date: data.date,
      note: data.note,
    });
  }, { username, stores: [STORE.LEDGER, 'drivers'] });
}

async function deleteDriverSalfa(username, reference_id) {
  if (!username) throw new Error('[FinancialService:deleteDriverSalfa] username is required.');
  if (!reference_id) throw new Error('[FinancialService:deleteDriverSalfa] reference_id is required.');

  return DB.transaction(async (tx) => {
    const existingEntries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', reference_id);
    const activeEntries = existingEntries.filter(e => e.is_reversed === false && e.deleted_at === null);
    if (activeEntries.length === 0) {
      throw new Error('[FinancialService:deleteDriverSalfa] Transaction reference not found.');
    }

    const now = DateUtils.nowLocal();
    const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
    const reverseOps = activeEntries.map(e => ({
      op: 'update',
      store: STORE.LEDGER,
      id: e.id,
      patch: reversePatch,
    }));

    return tx.runOps(reverseOps);
  }, { username, stores: [STORE.LEDGER] });
}

/**
 * Reverse one manual salfa recovery without removing its financial audit row.
 */
async function deleteDriverSalfaRecovery(username, reference_id) {
  if (!username) throw new Error('[FinancialService:deleteDriverSalfaRecovery] username is required.');
  const referenceKey = String(reference_id || '').trim();
  if (!referenceKey) throw new Error('[FinancialService:deleteDriverSalfaRecovery] reference_id is required.');

  const entries = await DB.getByIndex(STORE.LEDGER, 'by_reference_id', referenceKey);
  const active = entries.filter(entry =>
    entry.reference_type === SALFA_RECOVERY_REF_TYPE
    && entry.effect === SALFA_RECOVERY_EFFECT
    && entry.is_reversed === false
    && entry.deleted_at === null
  );
  if (active.length === 0) {
    throw new Error('[FinancialService:deleteDriverSalfaRecovery] salfa recovery not found or already reversed.');
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

const PAYMENT_STATUS = Object.freeze({ UNPAID: 'unpaid', PAID: 'paid' }); // receipt_rows.payment_status whitelist
const PAYMENT_EFFECT   = 'receipt_row_payment'; // effect tag: exactly one ACTIVE posting set per receipt row UUID
const PAYMENT_REF_TYPE = 'receipt_row_payment'; // reference_type tag: reference_id = the receipt row's stable UUID

const KARTA_REF_TYPE = 'receipt_row';
const KARTA_SETTLEMENT_TYPE = 'driver_karta_payment';
// Vehicle-balance leg of a karta settlement — follows the existing ledger
// architecture (rebuildVehicleBalance reads type deposit/withdraw by_vehicle;
// origin classification via `effect`, exactly like 'salfa').
const KARTA_CHARGE_EFFECT = 'karta_settlement_charge';

// The receipt row persists the driver's display-name snapshot specifically for
// receipt/Karta presentation. Use that existing association for the vehicle
// movement label; no extra ledger field or financial lookup is needed.
function _kartaVehicleSettlementNote(kartaRow) {
  const driverName = String(kartaRow?.driver_name || '').trim();
  return driverName ? `تسوية كارتة (${driverName})` : 'تسوية كارتة';
}

async function _getActiveKartaSettlements() {
  const all = await DB.findByFields(STORE.LEDGER, {
    reference_type: KARTA_REF_TYPE,
    is_reversed: false,
  });
  return all.filter(e => e.type === KARTA_SETTLEMENT_TYPE);
}

async function getDriverKartas(driverId) {
  if (!driverId) throw new Error('[FinancialService:getDriverKartas] driverId is required');

  // Get projection data from the dedicated read repository
  const projectionData = await DriverKartaReadRepository.getDriverKartasData(driverId);

  // Load active settlements from vehicle_ledger
  const settlements = await _getActiveKartaSettlements();
  const settlementMap = new Map();

  for (const s of settlements) {
    if (s.owner_id !== driverId) continue;
    const rid = s.reference_id;
    if (!settlementMap.has(rid)) settlementMap.set(rid, []);
    settlementMap.get(rid).push(s);
  }

  const result = [];

  for (const { row, receipt } of projectionData) {
    if (!row || !row.row_id || row.driver_id !== driverId) continue;

    // BUSINESS RULE: the receipt's driver_price (نولون) is IRRELEVANT on this
    // screen — never used as the payable base, never displayed, never a
    // filter. The driver's payable amount (السعر) is the settlement price
    // entered manually in Driver Details; kartas appear regardless of نولون.
    const rowSettlements = settlementMap.get(row.row_id) || [];
    let settled = 0;
    let lastDate = null;
    let priceCents = null;   // settlement price (cents) from the LATEST active settlement
    let latestSettledAt = -Infinity;

    for (const s of rowSettlements) {
      settled += Math.abs(Number(s.amount) || 0); // ledger amounts are persisted cents
      if (!lastDate || new Date(s.date) > new Date(lastDate)) lastDate = s.date;
      const enteredAt = new Date(s.applied_at || s.date || 0).getTime() || 0;
      if (typeof s.price === 'number' && enteredAt >= latestSettledAt) {
        latestSettledAt = enteredAt;
        priceCents = s.price;
      }
    }

    // Payments / remaining / status are anchored ONLY to the settlement price.
    const remaining = priceCents === null ? null : Math.max(0, priceCents - settled);
    let status = 'unpaid';
    if (priceCents !== null && settled > 0) {
      if (remaining > 0) status = 'partial';
      else status = 'paid';
    }

    result.push({
      row_id: row.row_id,
      receipt_id: row.receipt_id,
      date: receipt?.receipt_date || null,
      vehicle_id: row.vehicle_id || null,
      vehicle_plate: row.vehicle_plate || null,
      company: row.office || null,
      loading: row.loading || null,
      destination: row.destination || null,
      advance: Money.toDecimal(row.advance ?? 0), // persisted cents → decimal, single conversion
      price: priceCents === null ? null : Money.toDecimal(priceCents), // settlement price only — NEVER نولون
      status,
      last_settlement_date: lastDate,
    });
  }

  return result.sort((a, b) => new Date(b.date) - new Date(a.date));
}

async function getDriverKartasSummary(driverId) {
  const kartas = await getDriverKartas(driverId);
  let total_kartas = 0, unpaid_kartas = 0, paid_kartas = 0;
  let total_price = 0;

  for (const k of kartas) {
    total_kartas++;
    if (k.status === 'unpaid') unpaid_kartas++;
    else if (k.status === 'paid') paid_kartas++;

    // Summed over the settlement price ONLY (نولون never enters this summary);
    // kartas with no settlement yet contribute 0.
    total_price += Money.toCents(k.price ?? 0);
  }

  return {
    total_kartas,
    unpaid_kartas,
    paid_kartas,
    total_price: Money.toDecimal(total_price),
  };
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
  if (!username) throw new Error('[FinancialService:createKartaSettlement] username is required');
  if (!data?.row_id || typeof data.amount !== 'number' || !data?.vehicle_id) {
    throw new Error('[FinancialService:createKartaSettlement] row_id, amount and vehicle_id are required');
  }

  const rowId = data.row_id;
  const amount = Money.toCents(data.amount);
  if (amount <= 0) throw new Error('[FinancialService:createKartaSettlement] amount must be positive');
  const chargeVehicleId = String(data.vehicle_id).trim();
  if (!chargeVehicleId) throw new Error('[FinancialService:createKartaSettlement] vehicle_id (the vehicle to charge) is required');

  const referenceId = _uuid();
  const now = DateUtils.nowLocal();
  const date = data.date || DateUtils.todayLocal();
  const note = data.note || 'تسوية كارتة سائق';

  // Attribute the settlement to the karta's driver via the permanent id key
  // (row.driver_id) — getDriverKartas matches settlements to drivers by it.
  // No name-based matching anywhere in this chain.
  const kartaRow = await ReceiptRepository.getRowById(String(rowId));
  const settlementDriverId = kartaRow?.driver_id ?? null;
  const vehicleMovementNote = _kartaVehicleSettlementNote(kartaRow);

  // The vehicle-to-charge must exist — validated BEFORE the atomic write
  // transaction (guards evaluated inside DB.transaction callbacks race with
  // transaction auto-commit in database.js; write-path failures inside the tx
  // are what abort it reliably).
  const chargeVehicle = await ClientRepository.getVehicleById(chargeVehicleId);
  if (!chargeVehicle || chargeVehicle.deleted_at !== null) {
    throw new Error('[FinancialService:createKartaSettlement] vehicle to charge not found.');
  }

  // BUSINESS RULE: the manually entered amount is the SETTLEMENT PRICE — the
  // driver's payable amount for this karta (never the receipt نولون). The
  // settlement is a REAL financial transaction integrated into the existing
  // vehicle-balance architecture (vehicle_ledger, by_vehicle index,
  // rebuildVehicleBalance): ONE atomic transaction posts BOTH legs —
  //   1. driver settlement payment (driver is paid: type driver_karta_payment)
  //   2. vehicle charge (the selected vehicle's balance is reduced by the
  //      settlement price: type 'withdraw' + effect tag, the exact convention
  //      used by createDriverDeposit's vehicle leg and 'salfa')
  // Both legs share reference_type/reference_id → they reverse together.
  await DB.transaction(async (tx) => {
    // Leg 1 — driver settlement payment
    await tx.add(STORE.LEDGER, {
      username,
      owner_id: settlementDriverId,
      owner_name: null,
      client_id: null,
      client_type: 'driver',
      type: KARTA_SETTLEMENT_TYPE,
      amount: -amount,
      price: amount, // settlement price (cents) — the payable base
      vehicle_id: chargeVehicle.id, // the vehicle charged by this settlement
      reference_type: KARTA_REF_TYPE,
      reference_id: rowId,
      date,
      applied_at: now,
      is_reversed: false,
      note,
    });

    // Leg 2 — vehicle balance reduction (settlement price charged to the vehicle)
    await tx.add(STORE.LEDGER, {
      username,
      owner_id: String(chargeVehicle.owner_id || ''),
      owner_name: chargeVehicle.owner_name || null,
      client_id: String(chargeVehicle.owner_id || ''),
      client_type: 'owner',
      client_name: chargeVehicle.owner_name || null,
      vehicle_id: chargeVehicle.id,
      vehicle_plate: chargeVehicle.plate || null,
      type: 'withdraw',
      effect: KARTA_CHARGE_EFFECT,
      amount, // settlement price (cents, positive — withdraw convention)
      reference_type: KARTA_REF_TYPE,
      reference_id: rowId,
      date,
      applied_at: now,
      is_reversed: false,
      note: vehicleMovementNote,
    });
  }, { username, stores: [STORE.LEDGER] });

  return {
    success: true,
    settlement_reference_id: referenceId,
    row_id: rowId,
  };
}

/**
 * Edit the EXISTING settlement of a karta — "settlement edited", never a second
 * settlement. The logical settlement identity (reference_type='receipt_row',
 * reference_id=rowId) is preserved: the old legs reverse into audit history
 * and the replacement legs post for THE SAME reference with an edited_from
 * link to the superseded payment leg. ONE atomic transaction covers both
 * halves, so exactly one ACTIVE settlement exists per karta at every instant.
 */
async function updateKartaSettlement(username, data) {
  if (!username) throw new Error('[FinancialService:updateKartaSettlement] username is required');
  if (!data?.row_id || typeof data.amount !== 'number' || !data?.vehicle_id) {
    throw new Error('[FinancialService:updateKartaSettlement] row_id, amount and vehicle_id are required');
  }

  const rowId = data.row_id;
  const amount = Money.toCents(data.amount);
  if (amount <= 0) throw new Error('[FinancialService:updateKartaSettlement] amount must be positive');
  const chargeVehicleId = String(data.vehicle_id).trim();
  if (!chargeVehicleId) throw new Error('[FinancialService:updateKartaSettlement] vehicle_id (the vehicle to charge) is required');

  const now = DateUtils.nowLocal();
  const date = data.date || DateUtils.todayLocal();
  const note = data.note || 'تسوية كارتة سائق';

  // ── Pre-transaction reads/validation (house atomicity convention — guards
  // inside DB.transaction callbacks race with tx auto-commit in database.js) ──
  const kartaRow = await ReceiptRepository.getRowById(String(rowId));
  if (!kartaRow) throw new Error('[FinancialService:updateKartaSettlement] karta row not found');
  const settlementDriverId = kartaRow?.driver_id ?? null;
  const vehicleMovementNote = _kartaVehicleSettlementNote(kartaRow);

  const existing = await DB.getByIndex(STORE.LEDGER, 'by_reference_id', rowId);
  const activeLegs = existing.filter(e =>
    e.reference_type === KARTA_REF_TYPE &&
    (e.type === KARTA_SETTLEMENT_TYPE || e.effect === KARTA_CHARGE_EFFECT) &&
    e.is_reversed === false
  );
  const prevPaymentLeg = activeLegs.find(e => e.type === KARTA_SETTLEMENT_TYPE);
  if (!prevPaymentLeg) {
    throw new Error('[FinancialService:updateKartaSettlement] no active settlement for this karta (nothing to edit)');
  }

  const chargeVehicle = await ClientRepository.getVehicleById(chargeVehicleId);
  if (!chargeVehicle || chargeVehicle.deleted_at !== null) {
    throw new Error('[FinancialService:updateKartaSettlement] vehicle to charge not found.');
  }

  const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };

  // ONE atomic BATCH transaction (array-ops API → transactionBatch): every op
  // is scheduled synchronously inside a single IDB transaction, so there is no
  // pending==0 window between sequential awaits (the DB.transaction callback
  // race). Either ALL ops commit or the whole edit rolls back.
  const leg1 = {
    username,
    owner_id: settlementDriverId,
    owner_name: null,
    client_id: null,
    client_type: 'driver',
    type: KARTA_SETTLEMENT_TYPE,
    amount: -amount,
    price: amount, // settlement price (cents) — the payable base
    vehicle_id: chargeVehicle.id, // the vehicle charged by this settlement
    reference_type: KARTA_REF_TYPE,
    reference_id: rowId,
    edited_from: prevPaymentLeg.id, // audit: supersedes the previous version
    date,
    applied_at: now,
    is_reversed: false,
    note,
  };
  const leg2 = {
    username,
    owner_id: String(chargeVehicle.owner_id || ''),
    owner_name: chargeVehicle.owner_name || null,
    client_id: String(chargeVehicle.owner_id || ''),
    client_type: 'owner',
    client_name: chargeVehicle.owner_name || null,
    vehicle_id: chargeVehicle.id,
    vehicle_plate: chargeVehicle.plate || null,
    type: 'withdraw',
    effect: KARTA_CHARGE_EFFECT,
    amount, // settlement price (cents, positive — withdraw convention)
    reference_type: KARTA_REF_TYPE,
    reference_id: rowId,
    edited_from: prevPaymentLeg.id,
    date,
    applied_at: now,
    is_reversed: false,
    note: vehicleMovementNote,
  };

  const ops = [
    // 1) Previous version → audit history (flag-flip reversal — the
    //    reverseKartaSettlement convention). Balances are
    //    derived, so the previously charged vehicle restores automatically.
    ...activeLegs.map(leg => ({ op: 'update', store: STORE.LEDGER, id: leg.id, patch: reversePatch })),
    // 2) Replacement legs for THE SAME logical settlement (edited version).
    { op: 'add', store: STORE.LEDGER, payload: leg1 },
    { op: 'add', store: STORE.LEDGER, payload: leg2 },
  ];
  await DB.transaction(ops, { username });

  return {
    success: true,
    settlement_reference_id: rowId, // SAME logical settlement identity
    row_id: rowId,
    edited: true,
  };
}

async function reverseKartaSettlement(username, settlementReferenceId) {
  if (!username) throw new Error('[FinancialService:reverseKartaSettlement] username is required');
  if (!settlementReferenceId) throw new Error('[FinancialService:reverseKartaSettlement] settlementReferenceId is required');

  const now = DateUtils.nowLocal();
  const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };

  await DB.transaction(async (tx) => {
    const entries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', settlementReferenceId);
    // Both settlement legs reverse ATOMICALLY: the driver payment
    // (type-based, existing) and the vehicle charge leg (effect-based).
    const active = entries.filter(e =>
      e.reference_type === KARTA_REF_TYPE &&
      (e.type === KARTA_SETTLEMENT_TYPE || e.effect === KARTA_CHARGE_EFFECT) &&
      e.is_reversed === false
    );
    if (active.length === 0) {
      throw new Error('[FinancialService:reverseKartaSettlement] settlement not found or already reversed');
    }
    const ops = active.map(e => ({ op: 'update', store: STORE.LEDGER, id: e.id, patch: reversePatch }));
    await tx.runOps(ops);
  }, { username, stores: [STORE.LEDGER] });

  const entries = await DB.getByIndex(STORE.LEDGER, 'by_reference_id', settlementReferenceId);
  const rowId = entries[0]?.reference_id || null;

  return {
    success: true,
    settlement_reference_id: settlementReferenceId,
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

  const row = await ReceiptRepository.getRowById(rowKey);
  if (!row || row.deleted_at !== null) {
    throw new Error('[FinancialService:setReceiptRowPaymentStatus] receipt row not found.');
  }
  const current = row.payment_status === PAYMENT_STATUS.PAID
    ? PAYMENT_STATUS.PAID
    : PAYMENT_STATUS.UNPAID;

  // ── no-transition guard: unchanged status ⇒ ZERO financial operation ──
  if (current === target) {
    return { row_id: rowKey, payment_status: current, changed: false };
  }

  if (target === PAYMENT_STATUS.PAID) {
    // Idempotency: if an ACTIVE posting set already exists for this row UUID,
    // never create another one (this also answers «was the posting created?»).
    const active = await _getActivePaymentPostings(rowKey);
    const legs = active.length > 0
      ? []
      : _paymentLegPayloads(username, row, await _resolvePaymentTargets(row), null);

    await DB.transaction(async (tx) => {
      const ops = legs.map(payload => ({ op: 'add', store: STORE.LEDGER, payload }));
      ops.push({ op: 'update', store: 'receipt_rows', id: rowKey, patch: { payment_status: PAYMENT_STATUS.PAID } });
      await tx.runOps(ops);
    }, { username, stores: [STORE.LEDGER, 'receipt_rows'] });
  } else {
    // paid → unpaid: reverse the exact previously created ACTIVE postings.
    await DB.transaction(async (tx) => {
      const entries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', rowKey);
      const active = entries.filter(e =>
        e.reference_type === PAYMENT_REF_TYPE &&
        e.effect === PAYMENT_EFFECT &&
        e.is_reversed === false &&
        e.deleted_at === null
      );
      const now = DateUtils.nowLocal();
      const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
      const ops = active.map(e => ({ op: 'update', store: STORE.LEDGER, id: e.id, patch: reversePatch }));
      ops.push({ op: 'update', store: 'receipt_rows', id: rowKey, patch: { payment_status: PAYMENT_STATUS.UNPAID } });
      await tx.runOps(ops);
    }, { username, stores: [STORE.LEDGER, 'receipt_rows'] });
  }

  return { row_id: rowKey, payment_status: target, changed: true };
}

export const FinancialService = Object.freeze({
  createReceipt,
  updateReceipt,
  deleteReceipt,
  rebuildVehicleBalance,
  getVehicleLedger,
  getOfficeBalance,
  createManualVehicleBalanceEntry,
  deleteManualVehicleBalanceEntry,
  createManualOfficeBalanceEntry,
  deleteManualOfficeBalanceEntry,
  getDriverBalance,
  getDriverLedger,
  createDriverDeposit,
  updateDriverDeposit,
  deleteDriverDeposit,
  createDriverSalfa,
  updateDriverSalfa,
  deleteDriverSalfa,
  createDriverSalfaRecovery,
  deleteDriverSalfaRecovery,
  getDriverKartas,
  getDriverKartasSummary,
  getKartaSettlementHistory,
  createKartaSettlement,
  updateKartaSettlement,
  reverseKartaSettlement,
  setReceiptRowPaymentStatus,
});
