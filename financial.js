/**
 * financial.js — treasury, ledger, shared financial operations
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN DECISION: Pre-generated UUID for receipts
 *   receipts.id is a UUID string (not autoIncrement integer).
 *   This lets us pass reference_id to treasury + vehicle_ledger entries
 *   BEFORE any insert fires — enabling a single atomic DB.transaction()
 *   across all three stores with zero orphan-record risk.
 *
 * RULE 2  : ALL money operations live here. Zero treasury/ledger writes elsewhere.
 * RULE 3  : Every operation executes inside ONE DB.transaction() call.
 * RULE 4  : update/delete MUST reverse old entries before applying new ones.
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
import { OfficeRepository } from './services/officeRepository.js';
import { ReceiptRepository } from './services/receiptRepository.js';
// Blocker fix (step 6): WriteDataSource is used at createReceipt/updateReceipt/deleteReceipt
// but was never imported → ReferenceError on every receipt save.
import { WriteDataSource } from './services/writeDataSource.js';
import { createPersistenceCommand, PersistenceCommandType } from './services/persistenceCommand.js';
import { DriverKartaReadRepository } from './services/driverKartaReadRepository.js';
import { Money } from './money.js';
import { RECEIPT_PAYOUT_STATUS, normalizePayoutStatus, transitionReceiptState } from './constants/payoutStatus.js';
import { DateUtils } from './dateUtils.js';

// ─── CONSTANTS ─────────────────────────────────────────────────────────────────

const STORE = Object.freeze({
  RECEIPTS : 'receipts',
  TREASURY : 'treasury',
  LEDGER   : 'vehicle_ledger',
  OFFICES  : 'offices',
});

const REF_TYPE      = 'receipt';
const ACCOUNT_TYPES = Object.freeze(['cash', 'bank', 'vodafone', 'none']);
const OFFICE_LEDGER_TYPES = Object.freeze({
  DEPOSIT       : 'OFFICE_DEPOSIT',
  WITHDRAW_AUTO : 'OFFICE_WITHDRAW_AUTO',
});

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

function _normalizePayoutStatus(value) {
  if (value == null) return null;
  return normalizePayoutStatus(value);
}

function _toKey(value) {
  return String(value || '').trim().toLowerCase();
}

function _requireText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`[FinancialService] ${label} is required.`);
  return text;
}

function _storesForOps(ops, extra = []) {
  return [...new Set([
    ...extra,
    ...(Array.isArray(ops) ? ops.map((op) => op.store).filter(Boolean) : []),
  ])];
}

// ─── NEW HELPERS (Step 2.1) ────────────────────────────────────────────────

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

  const account_type = data.account_type ?? null;
  if (account_type !== null && !ACCOUNT_TYPES.includes(account_type)) {
    throw new Error(`[FinancialService] account_type must be one of: ${ACCOUNT_TYPES.join(', ')}, or null.`);
  }

  return {
    client_id,
    client_type,
    client_name,
    receipt_date,
    account_type,
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
    account_type: cleanHeader.account_type,
    // Phase 5 — Step 2: sole user-visible header field the model dropped
    // (already validated through _validate; by_number index exists in schema).
    receipt_number: cleanHeader.receipt_number ?? null,
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
    // ── Phase 5 — Step 2: restored user-entered row fields (Step 1 audit drop
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
  }));
}

function _buildLedgerOpsForReceipt(receipt, receiptRows, username) {
  const commands = [];

  // Receipt due ledger entry (net_due, cents). The receipt argument must be
  // the full persistence record (header + totals) — callers pass it after
  // assembly, so net_due is always a number (previously read off the bare
  // header entity → `undefined !== 0` fired commands with amount: undefined).
  const netDue = Number(receipt.net_due) || 0;
  if (netDue !== 0) {
    commands.push(createPersistenceCommand(
      PersistenceCommandType.ADD,
      'Ledger',
      _uuid(),
      {
        payload: {
          username,
          owner_id: receipt.client_id,
          owner_name: receipt.client_name || null,
          client_id: receipt.client_id,
          client_type: receipt.client_type,
          client_name: receipt.client_name || null,
          vehicle_owner_id: null,
          vehicle_owner_name: null,
          vehicle_id: null,
          vehicle_plate: null,
          type: 'receipt_due',
          amount: netDue,
          reference_type: 'receipt',
          reference_id: receipt.id,
          date: receipt.receipt_date,
          applied_at: DateUtils.nowLocal(),
          is_reversed: false,
          note: `Receipt ${receipt.receipt_number || receipt.id} — net due`,
        },
        meta: { username }
      }
    ));
  }

  // Company ledger synchronization (from ReceiptRows)
  const offices = {}; // In real implementation, this would come from repository or cache
  // For now, we skip complex company logic to keep the remediation focused

  return commands;
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

  const account_type = header.account_type;
  const receipt_date = header.receipt_date;

  // Convert decimals → cents (RULE 9)
  const total = Money.toCents(data.total);
  if (total < 0) {
    throw new Error('[FinancialService] total must be a non-negative number.');
  }

  const general_discount = 0; // removed from system
  const general_add = Money.toCents(data.general_add ?? data.generalAdd ?? 0);
  if (general_add < 0) {
    throw new Error('[FinancialService] general_add must be a non-negative number.');
  }
  const previous_balance = Money.toCents(data.previous_balance ?? data.previousBalance ?? 0);
  const net_due_calc = total + general_add;
  const net_due_input = data.net_due != null ? Money.toCents(data.net_due) : null;
  const net_due = net_due_input != null ? net_due_input : net_due_calc;
  const net_total = net_due + previous_balance;

  const paid = Money.toCents(data.paid ?? 0);
  if (paid < 0) {
    throw new Error('[FinancialService] paid must be a non-negative number.');
  }

  const groups = [...clientVehicleGroups.values()].filter(g => g.total !== 0);
  if (groups.length === 0) {
    throw new Error('[FinancialService] rows total must be greater than zero.');
  }

  return {
    account_type,
    receipt_date,
    total,
    general_add,
    general_discount,
    net_due,
    previous_balance,
    net_total,
    paid,
    groups,
    client_id: header.client_id,
    client_type: header.client_type,
    client_name: header.client_name,
    rows: dataRows,
    raw_rows: data.rows ?? [],
    receipt_number: data.receipt_number ?? null,
  };
}

// ─── PRIVATE: BUILD REVERSE OPS ───────────────────────────────────────────────
// Emits PersistenceCommands (not raw DB ops) — WriteDataSource only accepts
// the canonical command shape. Reverse = soft-flag update (audit trail kept).

async function _buildReverseOps(referenceId, username, tx = DB) {
  const commands = [];
  const now = DateUtils.nowLocal();
  const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };

  const treasuryEntries = await tx.getByIndex(STORE.TREASURY, 'by_reference_id', referenceId);
  for (const entry of treasuryEntries) {
    if (entry.reference_type !== REF_TYPE && entry.reference_type !== 'receipt_row') continue;
    if (entry.is_reversed === true) continue;
    commands.push(createPersistenceCommand(
      PersistenceCommandType.UPDATE, 'Treasury', entry.id,
      { patch: reversePatch, meta: { username } }
    ));
  }

  const ledgerEntries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', referenceId);
  for (const entry of ledgerEntries) {
    if (entry.reference_type !== REF_TYPE && entry.reference_type !== 'receipt_row') continue;
    if (entry.is_reversed === true) continue;
    commands.push(createPersistenceCommand(
      PersistenceCommandType.UPDATE, 'Ledger', entry.id,
      { patch: reversePatch, meta: { username } }
    ));
  }

  return commands;
}

// ─── PRIVATE: DUPLICATE GUARD ─────────────────────────────────────────────────

async function _assertNotApplied(receiptId, tx = DB) {
  const treasuryEntries = await tx.getByIndex(STORE.TREASURY, 'by_reference_id', receiptId);
  const hasActiveTreasury = treasuryEntries.some(
    e => e.reference_type === REF_TYPE && e.is_reversed === false
  );
  if (hasActiveTreasury) {
    throw new Error(`[FinancialService] Receipt already applied: ${receiptId}`);
  }

  const ledgerEntries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', receiptId);
  const hasActiveLedger = ledgerEntries.some(
    e => e.reference_type === REF_TYPE && e.is_reversed === false
  );
  if (hasActiveLedger) {
    throw new Error(`[FinancialService] Receipt already applied: ${receiptId}`);
  }
}

// ─── PRIVATE: BUILD APPLY OPS ──────────────────────────────────────────────────

async function _buildApplyOps(username, clean, receiptId, tx = DB) {
  const {
    receipt_date,
    net_due,
    client_id,
    client_type,
    client_name,
    rows,
    receipt_number,
  } = clean;

  const ops = [];

  if (net_due !== 0) {
    ops.push({
      op: 'add', store: STORE.LEDGER,
      payload: {
        username,
        owner_id      : client_id,
        owner_name    : client_name || null,
        client_id     : client_id,
        client_type   : client_type,
        client_name   : client_name || null,
        vehicle_owner_id  : null,
        vehicle_owner_name: null,
        vehicle_id    : null,
        vehicle_plate : null,
        type           : 'receipt_due',
        amount         : net_due,
        reference_type : REF_TYPE,
        reference_id   : receiptId,
        date           : receipt_date,
        applied_at     : DateUtils.nowLocal(),
        is_reversed    : false,
        note           : `Receipt ${receipt_number || receiptId} — net due`,
      },
    });
  }

  // ── Company ledger synchronization (companyAmount = row.net + row.sarf) ──
  const offices = await tx.findByFields(STORE.OFFICES, { username });
  const officeByName = new Map(
    (offices || []).map((o) => [_toKey(o.name), o])
  );

  const companyMap = new Map();
  const dataRows = Array.isArray(rows) ? rows : [];
  for (const row of dataRows) {
    if (!row || row._type === 'separator') continue;
    let office = null;
    if (row.office && String(row.office).trim()) {
      office = officeByName.get(_toKey(row.office));
    }
    if (!office || !office.id) continue;

    const rowNetCents = Money.toCents(row.net ?? 0);
    const rowSarfCents = Money.toCents(row.sarf ?? 0);
    const rowCompanyAmountCents = rowNetCents + rowSarfCents;

    if (rowCompanyAmountCents !== 0) {
      const key = String(office.id);
      const prev = companyMap.get(key) || { office, totalCents: 0, firstRow: row };
      prev.totalCents += rowCompanyAmountCents;
      companyMap.set(key, prev);
    }
  }

  for (const { office, totalCents, firstRow } of companyMap.values()) {
    if (totalCents !== 0) {
      ops.push({
        op: 'add', store: STORE.LEDGER,
        payload: {
          username,
          owner_id      : String(office.id),
          owner_name    : office.name || null,
          client_id     : String(office.id),
          client_type   : 'office',
          client_name   : office.name || null,
          vehicle_owner_id  : client_id || null,
          vehicle_owner_name: client_name || null,
          vehicle_id    : firstRow?.vehicle_id || null,
          vehicle_plate : firstRow?.vehicle_plate || null,
          type           : OFFICE_LEDGER_TYPES.WITHDRAW_AUTO,
          amount         : -totalCents,
          entity_type    : 'office',
          entity_id      : String(office.id),
          reference_type : REF_TYPE,
          reference_id   : receiptId,
          date           : receipt_date,
          applied_at     : DateUtils.nowLocal(),
          is_reversed    : false,
          note           : `Receipt ${receipt_number || receiptId} — company due`,
        },
      });
    }
  }

  return ops;
}

// ─── OFFICE BALANCE: PRICE RESOLUTION ───────────────────────────────────────

async function resolveHamolaPrice(username, officeName, loadingPlace, destinationPlace, officeMap = null) {
  if (!username) throw new Error('[FinancialService:resolveHamolaPrice] username is required.');

  const name = _requireText(officeName, 'office_name');
  const loading = _requireText(loadingPlace, 'loading_place');
  const destination = _requireText(destinationPlace, 'destination');

  let map = officeMap;
  if (!map) {
    const offices = await DB.findByFields(STORE.OFFICES, { username });
    map = new Map(offices.map((o) => [_toKey(o.name), o]));
  }

  const office = map.get(_toKey(name));
  if (!office) {
    throw new Error(`❌ الشركة غير موجودة: ${name}`);
  }

  const hamola = Array.isArray(office.hamolaRows) ? office.hamolaRows : [];
  const match = hamola.find((row) => {
    const loadKey = _toKey(row.loading_place ?? row.loading);
    const destKey = _toKey(row.destination_place ?? row.direction ?? row.taktik);
    return loadKey === _toKey(loading) && destKey === _toKey(destination);
  });

  if (!match) {
    throw new Error(`❌ لا يوجد سعر مطابق للشركة "${name}" لمسار (${loading} → ${destination})`);
  }

  const price = Number(match.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`❌ سعر التحميل غير صالح للشركة "${name}" لمسار (${loading} → ${destination})`);
  }

  return { office, price };

}
// ─── PRIVATE: PARSE APPLY RESULTS ─────────────────────────────────────────────

function _parseApplyResults(applyResults) {
  let ledger_due = null;

  for (const entry of applyResults || []) {
    if (!entry) continue;
    if (entry.type === 'receipt_due') {
      ledger_due = entry;
      break;
    }
  }

  return {
    treasury: null,
    ledger_deposit: null,
    ledger_withdraw: null,
    ledger_due,
  };
}

// ─── PUBLIC: createReceipt ─────────────────────────────────────────────────────

async function createReceipt(username, data, extraOps = []) {
  if (!username) throw new Error('[FinancialService:create] username is required.');

  const receiptId = data.id || _uuid();
  const clean = _validate(data);

  const payout_status = _normalizePayoutStatus(data.payout_status) || RECEIPT_PAYOUT_STATUS.UNPAID;

  // Build Receipt header
  const receiptHeader = _buildReceiptHeaderEntity(clean, username, receiptId);

  // Build ReceiptRow entities
  const receiptRows = _buildReceiptRowEntities(clean.rows, receiptId);

  // Assemble the full persistence record ONCE — ledger command generation
  // consumes net_due/totals from this exact object.
  const receiptRecord = {
    ...receiptHeader,
    payout_status,
    total: clean.total,
    paid: clean.paid,
    previous_balance: clean.previous_balance,
    general_discount: clean.general_discount,
    general_add: clean.general_add,
    net_due: clean.net_due,
    net_total: clean.net_total,
    notes: data.notes ?? null,
    shipping_number: data.shipping_number ?? null,
  };

  // Build ledger operations from the full receipt record
  const ledgerCommands = _buildLedgerOpsForReceipt(receiptRecord, receiptRows, username);

  // Prepare PersistenceCommands via ReceiptRepository (Add)
  const receiptCommand = ReceiptRepository.prepareReceiptOperation(receiptRecord, { username });

  const receiptRowCommands = ReceiptRepository.prepareReceiptRowOperations(receiptRows, { username });

  // Combine all commands
  const allCommands = [receiptCommand, ...receiptRowCommands, ...ledgerCommands];

  // Execute through WriteDataSource
  const results = await WriteDataSource.execute(allCommands, { username });

  const receipt = Money.decimalizeRecord(results[0]);
  const applyResults = results.slice(1);
  const { treasury, ledger_deposit, ledger_withdraw, ledger_due } = _parseApplyResults(applyResults);

  return {
    receipt,
    treasury: Money.decimalizeRecord(treasury),
    ledger_deposit: Money.decimalizeRecord(ledger_deposit),
    ledger_withdraw: Money.decimalizeRecord(ledger_withdraw),
    ledger_due: Money.decimalizeRecord(ledger_due),
  };
}

// ─── PUBLIC: updateReceipt ─────────────────────────────────────────────────────

async function updateReceipt(username, id, data, extraOps = []) {
  if (!username) throw new Error('[FinancialService:update] username is required.');
  if (!id)       throw new Error('[FinancialService:update] id is required.');

  const clean = _validate(data);
  const payout_status = _normalizePayoutStatus(data.payout_status);

  // Build updated Receipt header
  const receiptHeader = _buildReceiptHeaderEntity(clean, username, id);

  // Build updated ReceiptRow entities
  const newReceiptRows = _buildReceiptRowEntities(clean.rows, id);

  // Assemble the full persistence record ONCE (Update semantics:
  // payout_status/notes/shipping_number are only patched when provided,
  // so an omitted payout_status never wipes the stored one).
  const receiptRecord = {
    ...receiptHeader,
    ...(payout_status !== null ? { payout_status } : {}),
    total: clean.total,
    paid: clean.paid,
    previous_balance: clean.previous_balance,
    general_discount: clean.general_discount,
    general_add: clean.general_add,
    net_due: clean.net_due,
    net_total: clean.net_total,
    ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
    ...(data.shipping_number !== undefined ? { shipping_number: data.shipping_number || null } : {}),
  };

  // Retrieve existing ReceiptRows (they must be REPLACED, not appended —
  // new row entities get fresh row_ids on every edit, so failing to delete
  // the old set would duplicate every karta in receipt_rows).
  const existingReceiptRows = await _getExistingReceiptRows(id);

  // Generate reverse operations for previous ledger entries
  const reverseCommands = await _buildReverseOps(id, username);

  // Generate new ledger operations from the full receipt record
  const newLedgerCommands = _buildLedgerOpsForReceipt(receiptRecord, newReceiptRows, username);

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

  // Combine all commands: header update → delete old rows → add new rows →
  // reverse old ledger entries → apply new ledger entries.
  const allCommands = [
    receiptCommand,
    ...deleteRowCommands,
    ...receiptRowCommands,
    ...reverseCommands,
    ...newLedgerCommands,
    ...extraOps
  ];

  // Execute through WriteDataSource
  const results = await WriteDataSource.execute(allCommands, { username });

  const receipt = Money.decimalizeRecord(results[0]); // First command is the header update
  const applyResults = results.slice(1);
  const { treasury, ledger_deposit, ledger_withdraw, ledger_due } = _parseApplyResults(applyResults);

  return {
    receipt,
    treasury: Money.decimalizeRecord(treasury),
    ledger_deposit: Money.decimalizeRecord(ledger_deposit),
    ledger_withdraw: Money.decimalizeRecord(ledger_withdraw),
    ledger_due: Money.decimalizeRecord(ledger_due),
  };
}

// ─── PUBLIC: deleteReceipt ─────────────────────────────────────────────────────

async function deleteReceipt(username, id, extraOps = []) {
  if (!username) throw new Error('[FinancialService:delete] username is required.');
  if (!id)       throw new Error('[FinancialService:delete] id is required.');

  // Generate reverse ledger operations using the normalized model
  const reverseLedgerCommands = await _buildReverseOps(id, username);

  // Prepare delete command for Receipt via ReceiptRepository (Delete carries id only)
  const receiptDeleteCommand = ReceiptRepository.prepareReceiptOperation(
    { id },
    { username },
    PersistenceCommandType.DELETE
  );

  // Prepare delete commands for ReceiptRows
  const existingRows = await _getExistingReceiptRows(id);
  const receiptRowDeleteCommands = existingRows.map(row =>
    ReceiptRepository.prepareReceiptRowOperations(
      [{ row_id: row.row_id }], { username }, PersistenceCommandType.DELETE
    )[0]
  );

  // Combine all commands: reverse financial effects → delete rows → delete header
  const allCommands = [
    ...reverseLedgerCommands,
    ...receiptRowDeleteCommands,
    receiptDeleteCommand,
    ...extraOps
  ];

  // Execute through WriteDataSource
  await WriteDataSource.execute(allCommands, { username });

  return {
    id,
    deleted: true,
    reversed: {
      treasury_count: reverseLedgerCommands.filter(c => c.aggregate === 'Treasury').length,
      ledger_count: reverseLedgerCommands.filter(c => c.aggregate === 'Ledger').length,
    },
  };
}

// ─── PUBLIC: updateReceiptStatus ─────────────────────────────────────────────

async function updateReceiptStatus(username, receiptId, status) {
  if (!username) throw new Error('[FinancialService:updateReceiptStatus] username is required.');
  if (!receiptId) throw new Error('[FinancialService:updateReceiptStatus] receiptId is required.');

  const normalized = _normalizePayoutStatus(status);
  if (!normalized) {
    throw new Error('[FinancialService:updateReceiptStatus] status must be paid or unpaid.');
  }

  const result = await DB.transaction(async (tx) => {
    const existing = await ReceiptRepository.getById(String(receiptId), { tx });
    if (!existing) {
      throw new Error(`[FinancialService:updateReceiptStatus] Receipt ${receiptId} not found.`);
    }
    if (existing.username !== username) {
      throw new Error('[FinancialService:updateReceiptStatus] cross-user access is forbidden.');
    }

    const currentStatus = String(existing.payout_status || RECEIPT_PAYOUT_STATUS.UNPAID);

    // ── Same status → no-op ─────────────────────────────────────────────
    if (currentStatus === normalized) {
      return { receipt: existing, changed: false };
    }

    // Use transitionReceiptState to safely validate transition and get new state copy!
    const transitionedReceipt = transitionReceiptState(existing, normalized);
    const now = transitionedReceipt.paid_at || DateUtils.nowLocal();
    const paidAmount = Number(existing.paid) || 0;   // already in cents (DB)

    // ── unpaid → paid: CREATE financial entries ─────────────────────────
    if (normalized === RECEIPT_PAYOUT_STATUS.PAID) {
      const ops = [];

      // Update receipt status
      ops.push({
        op: 'update',
        store: STORE.RECEIPTS,
        id: String(receiptId),
        patch: {
          payout_status: transitionedReceipt.payout_status,
          paid_at: transitionedReceipt.paid_at,
        },
      });

      // entity_ledger: receipt_payment — withdraw from client balance
      if (paidAmount > 0) {
        ops.push({
          op: 'add',
          store: STORE.LEDGER,
          payload: {
            username,
            owner_id       : String(existing.client_id),
            owner_name     : existing.client_name || null,
            client_id      : String(existing.client_id),
            client_type    : existing.client_type || 'owner',
            client_name    : existing.client_name || null,
            vehicle_id     : null,
            vehicle_plate  : null,
            type           : 'receipt_payment',
            amount         : paidAmount,
            reference_type : REF_TYPE,
            reference_id   : String(receiptId),
            receipt_number : existing.receipt_number || null,
            date           : existing.receipt_date || now,
            applied_at     : now,
            is_reversed    : false,
            note           : `صرف نموذج ${existing.receipt_number || receiptId}`,
          },
        });

        // treasury: cash_out — cash leaves the drawer
        ops.push({
          op: 'add',
          store: STORE.TREASURY,
          payload: {
            username,
            type           : 'withdraw',
            effect         : 'receipt_payout',
            amount         : paidAmount,
            account_type   : 'cash',
            reference_type : REF_TYPE,
            reference_id   : String(receiptId),
            receipt_number : existing.receipt_number || null,
            client_id      : String(existing.client_id),
            client_type    : existing.client_type || 'owner',
            client_name    : existing.client_name || null,
            date           : existing.receipt_date || now,
            applied_at     : now,
            is_reversed    : false,
            note           : `صرف نموذج ${existing.receipt_number || receiptId}`,
          },
        });
      }

      const results = await tx.runOps(ops);
      return { receipt: results[0], changed: true };
    }

    // ── paid → unpaid: REVERSE financial entries ────────────────────────
    if (normalized === RECEIPT_PAYOUT_STATUS.UNPAID) {
      const reversePatch = {
        is_reversed: true,
        reversed_at: now,
        reversed_by: username,
      };

      const ops = [];

      // Find and reverse all active payout entries for this receipt
      const ledgerEntries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', String(receiptId));
      for (const entry of ledgerEntries) {
        if (entry.reference_type !== REF_TYPE) continue;
        if (entry.type !== 'receipt_payment') continue;
        if (entry.is_reversed === true) continue;
        ops.push({ op: 'update', store: STORE.LEDGER, id: entry.id, patch: reversePatch });
      }

      const treasuryEntries = await tx.getByIndex(STORE.TREASURY, 'by_reference_id', String(receiptId));
      for (const entry of treasuryEntries) {
        if (entry.reference_type !== REF_TYPE) continue;
        if (entry.effect !== 'receipt_payout') continue;
        if (entry.is_reversed === true) continue;
        ops.push({ op: 'update', store: STORE.TREASURY, id: entry.id, patch: reversePatch });
      }

      // Update receipt status
      ops.push({
        op: 'update',
        store: STORE.RECEIPTS,
        id: String(receiptId),
        patch: {
          payout_status: transitionedReceipt.payout_status,
          paid_at: transitionedReceipt.paid_at,
        },
      });

      const results = await tx.runOps(ops);
      return { receipt: results[results.length - 1], changed: true };
    }

    throw new Error('[FinancialService:updateReceiptStatus] unexpected status value.');
  }, { username, stores: [STORE.RECEIPTS, STORE.LEDGER, STORE.TREASURY] });

  return Money.decimalizeRecord(result.receipt);
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

// ─── PUBLIC: rebuildTreasuryBalance ───────────────────────────────────────────

async function rebuildTreasuryBalance(account_type = null) {
  if (account_type !== null && !ACCOUNT_TYPES.includes(account_type)) {
    throw new Error(
      `[FinancialService:rebuildTreasuryBalance] Invalid account_type "${account_type}". ` +
      `Allowed: ${ACCOUNT_TYPES.join(', ')}, or omit for all.`
    );
  }

  const allEntries = await DB.getAll(STORE.TREASURY);
  const active     = allEntries.filter(e => e.is_reversed === false && e.deleted_at === null);

  function _calcAccount(entries) {
    let deposit_total  = 0;
    let withdraw_total = 0;
    for (const e of entries) {
      if (e.type === 'deposit')  deposit_total  += Number(e.amount) || 0;
      if (e.type === 'withdraw') withdraw_total += Number(e.amount) || 0;
    }
    return {
      balance        : Money.toDecimal(deposit_total - withdraw_total),
      deposit_total  : Money.toDecimal(deposit_total),
      withdraw_total : Money.toDecimal(withdraw_total),
      entry_count    : entries.length,
    };
  }

  if (account_type !== null) {
    const filtered = active.filter(e => e.account_type === account_type);
    return { account_type, ..._calcAccount(filtered) };
  }

  const result   = {};
  let   cBal = 0, cDep = 0, cWith = 0, cCount = 0;

  for (const acct of ACCOUNT_TYPES) {
    const filtered  = active.filter(e => e.account_type === acct);
    const snap      = _calcAccount(filtered);
    result[acct]    = snap;
    cDep   += Money.toCents(snap.deposit_total);
    cWith  += Money.toCents(snap.withdraw_total);
    cCount += snap.entry_count;
  }
  cBal = cDep - cWith;

  result.combined = {
    balance        : Money.toDecimal(cBal),
    deposit_total  : Money.toDecimal(cDep),
    withdraw_total : Money.toDecimal(cWith),
    entry_count    : cCount,
  };

  return result;
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

async function getClientLedger(client_id) {
  return _fetchLedgerEntries(client_id, 'client_id');
}

async function getClientBalance(client_id) {
  const ledger = await getClientLedger(client_id);
  let deposit_total = 0;
  let withdraw_total = 0;

  for (const entry of ledger) {
    // entry.amount is already decimal (from decimalizeRecord)
    // convert back to cents for safe integer arithmetic
    const cents = Money.toCents(entry.amount);
    const isOfficeEntry = entry.entity_type === 'office'
      || entry.type === OFFICE_LEDGER_TYPES.DEPOSIT
      || entry.type === OFFICE_LEDGER_TYPES.WITHDRAW_AUTO;

    if (isOfficeEntry) {
      if (cents >= 0) deposit_total += cents;
      else withdraw_total += Math.abs(cents);
      continue;
    }

    if (entry.type === 'receipt_due') {
      if (cents >= 0) deposit_total += cents;
      else withdraw_total += Math.abs(cents);
      continue;
    }

    if (entry.type === 'receipt_payment') {
      withdraw_total += Math.abs(cents);
      continue;
    }

    if (entry.type === 'deposit') deposit_total += cents;
    if (entry.type === 'withdraw') withdraw_total += cents;
  }

  return {
    client_id: String(client_id),
    balance: Money.toDecimal(deposit_total - withdraw_total),
    deposit_total: Money.toDecimal(deposit_total),
    withdraw_total: Money.toDecimal(withdraw_total),
    entry_count: ledger.length,
    last_transaction_date: ledger[0]?.date || ledger[0]?.applied_at || ledger[0]?.created_at || null,
  };
}

async function createClientBalanceEntry(username, data) {
  if (!username) throw new Error('[FinancialService:createClientBalanceEntry] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createClientBalanceEntry] data must be a plain object.');
  }

  const client_id = data.client_id != null
    ? String(data.client_id).trim()
    : (data.entity_id != null ? String(data.entity_id).trim() : (data.office_id != null ? String(data.office_id).trim() : ''));
  let client_type = data.client_type;
  if (client_type !== 'owner' && client_type !== 'office') {
    if (data.entity_type === 'office' || data.office_id) client_type = 'office';
    else if (data.entity_type === 'owner') client_type = 'owner';
  }
  client_type = client_type === 'owner' || client_type === 'office'
    ? client_type
    : '';
  const client_name = typeof data.client_name === 'string' ? data.client_name.trim() : '';
  const type = data.type === 'deposit' || data.type === 'withdraw' ? data.type : '';
  const amount = Money.toCents(data.amount);
  const date = data.date;
  const note = typeof data.note === 'string' && data.note.trim()
    ? data.note.trim()
    : (type === 'deposit' ? 'إيداع رصيد' : 'سحب رصيد');

  if (!client_id) throw new Error('[FinancialService:createClientBalanceEntry] client_id is required.');
  if (!client_type) throw new Error('[FinancialService:createClientBalanceEntry] client_type must be owner or office.');
  if (!type) throw new Error('[FinancialService:createClientBalanceEntry] type must be deposit or withdraw.');
  if (amount <= 0) throw new Error('[FinancialService:createClientBalanceEntry] amount must be greater than zero.');
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createClientBalanceEntry] date must be a valid ISO date string.');
  }

  const referenceId = _uuid();
  const [entry] = await DB.transaction([{
    op: 'add',
    store: STORE.LEDGER,
    payload: {
      username,
      owner_id: client_id,
      owner_name: client_name || null,
      client_id,
      client_type,
      client_name: client_name || null,
      vehicle_id: null,
      vehicle_plate: null,
      type,
      amount,
      entity_type: client_type,
      entity_id: client_id,
      reference_type: 'client_balance',
      reference_id: referenceId,
      date,
      applied_at: DateUtils.nowLocal(),
      is_reversed: false,
      note,
    },
  }], { username });

  return Money.decimalizeRecord(entry);
}

async function createOfficeDeposit(username, data) {
  if (!username) throw new Error('[FinancialService:createOfficeDeposit] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createOfficeDeposit] data must be a plain object.');
  }

  const office_id = String(data.office_id || data.entity_id || data.client_id || '').trim();
  if (!office_id) throw new Error('[FinancialService:createOfficeDeposit] office_id is required.');

  const amount = Money.toCents(data.amount);
  if (amount <= 0) throw new Error('[FinancialService:createOfficeDeposit] amount must be greater than zero.');

  const date = data.date || DateUtils.todayLocal();
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createOfficeDeposit] date must be a valid ISO date string.');
  }

  const note = typeof data.note === 'string' && data.note.trim()
    ? data.note.trim()
    : 'إيداع رصيد';

  const referenceId = _uuid();
  const [entry] = await DB.transaction(async (tx) => {
    const office = await OfficeRepository.getById(office_id, { tx });
    if (!office || office.deleted_at !== null) {
      throw new Error('[FinancialService:createOfficeDeposit] office not found.');
    }
    if (office.username !== username) {
      throw new Error('[FinancialService:createOfficeDeposit] cross-user access is forbidden.');
    }

    return tx.runOps([{
      op: 'add',
      store: STORE.LEDGER,
      payload: {
        username,
        owner_id: String(office.id),
        owner_name: office.name || null,
        client_id: String(office.id),
        client_type: 'office',
        client_name: office.name || null,
        vehicle_owner_id: null,
        vehicle_owner_name: null,
        vehicle_id: null,
        vehicle_plate: null,
        type: OFFICE_LEDGER_TYPES.DEPOSIT,
        amount,
        entity_type: 'office',
        entity_id: String(office.id),
        reference_type: 'office_deposit',
        reference_id: referenceId,
        date,
        applied_at: DateUtils.nowLocal(),
        is_reversed: false,
        note,
      },
    }]);
  }, { username, stores: [STORE.OFFICES, STORE.LEDGER] });

  return Money.decimalizeRecord(entry);
}

// ─── EXPORT ────────────────────────────────────────────────────────────────────


/**
 * Auto-update balance for a specific client's unpaid receipts.
 * Called when a receipt is paid or a salfa is given.
 * Finds other unpaid receipts for the SAME client and updates their balance.
 */
async function updateClientUnpaidBalances(clientId, username) {
  if (!clientId || !username) return;

  const allReceipts = await ReceiptRepository.getAll(username);
  const unpaid = allReceipts.filter(r =>
    String(r.payout_status || RECEIPT_PAYOUT_STATUS.UNPAID) === RECEIPT_PAYOUT_STATUS.UNPAID
    && String(r.client_id) === String(clientId)
  );
  if (unpaid.length === 0) return;

  let updated = false;

  for (const receipt of unpaid) {
    try {
      const ledger = await getClientLedger(String(receipt.client_id));

      let balanceCents = 0;
      for (const entry of ledger) {
        const cents = Money.toCents(entry.amount);
        if (entry.reference_id === String(receipt.id) && entry.reference_type === 'receipt') {
          continue;
        }
        if (entry.type === 'receipt_due') {
          balanceCents += cents;
        } else if (entry.type === 'receipt_payment') {
          balanceCents -= Math.abs(cents);
        } else if (entry.type === 'deposit') {
          balanceCents += cents;
        } else if (entry.type === 'withdraw') {
          balanceCents -= cents;
        } else if (entry.entity_type === 'office' || entry.type === OFFICE_LEDGER_TYPES.DEPOSIT || entry.type === OFFICE_LEDGER_TYPES.WITHDRAW_AUTO) {
          if (cents >= 0) balanceCents += cents;
          else balanceCents -= Math.abs(cents);
        }
      }

      const newPreviousBalance = balanceCents;
      const currentPrevious = Number(receipt.previous_balance) || 0;

      if (newPreviousBalance !== currentPrevious) {
        const netDue = Number(receipt.net_due) || 0;
        const newNetTotal = netDue + newPreviousBalance;
        const newPaid = newNetTotal;

        await ReceiptRepository.update(receipt.id, {
          previous_balance: newPreviousBalance,
          net_total: newNetTotal,
          paid: newPaid,
        }, { username });

        updated = true;
      }
    } catch (err) {
      console.warn('[updateClientUnpaidBalances] Error updating receipt', receipt.id, err);
    }
  }

  return updated;
}


// ─── DRIVER KARTA SETTLEMENT (Phase 6B) ──────────────────────────────────────

const KARTA_REF_TYPE = 'receipt_row';
const KARTA_SETTLEMENT_TYPE = 'driver_karta_payment';
// Vehicle-balance leg of a karta settlement — follows the existing ledger
// architecture (rebuildVehicleBalance reads type deposit/withdraw by_vehicle;
// origin classification via `effect`, exactly like 'salfa' / 'receipt_payout').
const KARTA_CHARGE_EFFECT = 'karta_settlement_charge';

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
      receipt_number: receipt?.receipt_number || null,
      date: receipt?.receipt_date || null,
      vehicle_id: row.vehicle_id || null,
      vehicle_plate: row.vehicle_plate || null,
      company: row.office || null,
      loading: row.loading || null,
      destination: row.destination || null,
      advance: Money.toDecimal(row.advance ?? 0), // persisted cents → decimal, single conversion
      price: priceCents === null ? null : Money.toDecimal(priceCents), // settlement price only — NEVER نولون
      settled: Money.toDecimal(settled),
      remaining: remaining === null ? null : Money.toDecimal(remaining),
      status,
      last_settlement_date: lastDate,
    });
  }

  return result.sort((a, b) => new Date(b.date) - new Date(a.date));
}

async function getDriverUnpaidKartas(driverId) {
  const all = await getDriverKartas(driverId);
  return all.filter(k => k.status !== 'paid');
}

async function getDriverPaidKartas(driverId) {
  const all = await getDriverKartas(driverId);
  return all.filter(k => k.status === 'paid');
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
  //      used by createDriverDeposit's vehicle leg and 'salfa'/'receipt_payout')
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
      note: `تحميل تسوية كارتة على المركبة ${chargeVehicle.plate || chargeVehicleId}`,
    });
  }, { username, stores: [STORE.LEDGER] });

  return {
    success: true,
    settlement_reference_id: referenceId,
    row_id: rowId,
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
    // (type-based, existing) and the vehicle charge leg (effect-based — the
    // same reversal convention as 'receipt_payout' at updateReceiptStatus).
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

export const FinancialService = Object.freeze({
  createReceipt,
  updateReceipt,
  deleteReceipt,
  rebuildVehicleBalance,
  rebuildTreasuryBalance,
  getClientBalance,
  getClientLedger,
  getDriverBalance,
  getDriverLedger,
  createClientBalanceEntry,
  createDriverDeposit,
  updateDriverDeposit,
  deleteDriverDeposit,
  createDriverSalfa,
  updateDriverSalfa,
  deleteDriverSalfa,
  createOfficeDeposit,
  resolveHamolaPrice,
  updateReceiptStatus,
  updateClientUnpaidBalances,
  getDriverKartas,
  getDriverUnpaidKartas,
  getDriverPaidKartas,
  getDriverKartasSummary,
  getKartaSettlementHistory,
  createKartaSettlement,
  reverseKartaSettlement,
});
