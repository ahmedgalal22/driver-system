/**
 * offices.js — consolidated module
 * Internal structure: Constants → State → Services → Helpers → Rendering → Events → Public API → Boot
 */

import { AuthModule } from './auth.js';
import { Money } from './money.js';
import { calculateWeightTotal } from './services/financialCalculator.js';
import { OfficeRepository } from './services/officeRepository.js';
import { ReceiptRepository } from './services/receiptRepository.js';
import { ReceiptReadRepository } from './services/receiptReadRepository.js';


// ========================================
// Services — OfficesService
// ========================================

const STORE = 'offices';

function _uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  throw new Error('[OfficesService] crypto.randomUUID is required');
}

function _requireUsername(username, ctx) {
  if (!username) throw new Error(`[OfficesService:${ctx}] username is required.`);
  return username;
}

function _toText(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function _requireText(value, label) {
  const text = _toText(value).trim();
  if (!text) throw new Error(`[OfficesService] ${label} is required.`);
  return text;
}

function _optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

// ── Hamola rows (تفاصيل الحمولة) — office-level reference master data ──
// A hamola row is plain reference data embedded on the office record
// (office.hamolaRows): التحميل + الجهة + النوع ONLY — no pricing, no money
// fields. The receipt form uses it as a lookup/auto-fill source and learns
// new combinations at save time. It feeds no financial calculation.
function _normalizeHamolaRow(input, keepId = false) {
  if (!input || typeof input !== 'object') {
    throw new Error('[OfficesService] hamola row must be a plain object.');
  }

  const loading_place = _requireText(
    input.loading_place ?? input.loading,
    'loading_place'
  );
  const destination_place = _requireText(
    input.destination_place ?? input.direction ?? input.taktik,
    'destination_place'
  );
  const item_type = _optionalText(input.item_type ?? input.type) || null;

  return {
    id: keepId && input.id ? String(input.id) : _uuid(),
    loading_place,
    destination_place,
    item_type,
  };
}

function _applyHamolaPatch(existing, patch) {
  // Rebuild a clean master-data record (never spreads the old row) so only the
  // three reference fields survive every edit — no stale keys of any kind.
  const next = {
    id: existing.id,
    loading_place: existing.loading_place,
    destination_place: existing.destination_place,
    item_type: existing.item_type ?? null,
  };

  if ('loading_place' in patch || 'loading' in patch) {
    next.loading_place = _requireText(
      patch.loading_place ?? patch.loading,
      'loading_place'
    );
  }
  if ('destination_place' in patch || 'direction' in patch || 'taktik' in patch) {
    next.destination_place = _requireText(
      patch.destination_place ?? patch.direction ?? patch.taktik,
      'destination_place'
    );
  }
  if ('item_type' in patch || 'type' in patch) {
    next.item_type = _optionalText(patch.item_type ?? patch.type) || null;
  }

  return next;
}

async function createOffices(username, rows) {
  _requireUsername(username, 'createOffices');
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('[OfficesService] rows must be a non-empty array.');
  }

  const existing = await OfficeRepository.getAll(username);
  const existingNames = new Set(
    existing.map((o) => String(o.name || '').trim().toLowerCase()).filter(Boolean)
  );

  const seen = new Set();
  const payloads = rows.map((row) => {
    if (!row || typeof row !== 'object') {
      throw new Error('[OfficesService] office row must be a plain object.');
    }

    const name = _requireText(row.name, 'name');
    const lower = name.toLowerCase();

    if (existingNames.has(lower) || seen.has(lower)) {
      throw new Error(`[OfficesService] duplicate office name: ${name}`);
    }
    seen.add(lower);

    return {
      id: _uuid(),
      username,
      name,
      phone: _optionalText(row.phone),
    };
  });

  const ops = payloads.map((payload) => ({
    op: 'add',
    store: STORE,
    payload,
  }));

  const saved = await OfficeRepository.transaction(ops, { username });

  window.dispatchEvent(new CustomEvent('offices:changed'));
  return saved;
}

async function updateOffice(username, id, patch) {
  _requireUsername(username, 'updateOffice');
  if (!id) throw new Error('[OfficesService:updateOffice] id is required.');
  if (!patch || typeof patch !== 'object') {
    throw new Error('[OfficesService] patch must be a plain object.');
  }

  await getOfficeById(id, username); // ownership guard (throws on cross-user)

  if ('name' in patch) {
    const name = _requireText(patch.name, 'name');
    const existing = await OfficeRepository.getAll(username);
    const dup = existing.some((o) => String(o.id) !== String(id)
      && String(o.name || '').trim().toLowerCase() === name.toLowerCase());
    if (dup) throw new Error(`[OfficesService] duplicate office name: ${name}`);
  }

  const nextPatch = {
    ...(patch.name !== undefined ? { name: _requireText(patch.name, 'name') } : {}),
    ...(patch.phone !== undefined ? { phone: _optionalText(patch.phone) } : {}),
  };

  const updated = await OfficeRepository.update(String(id), nextPatch, { username });
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return updated;
}

async function deleteOffice(username, id) {
  _requireUsername(username, 'deleteOffice');
  if (!id) throw new Error('[OfficesService:deleteOffice] id is required.');
  const office = await getOfficeById(id, username);
  if (!office) throw new Error('[OfficesService] office not found.');
  const deleted = await OfficeRepository.delete(String(id), { username });
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return deleted;
}

async function getOffices(username) {
  _requireUsername(username, 'getOffices');
  const offices = await OfficeRepository.getAll(username);
  return offices;
}

async function getOfficeById(id, username) {
  _requireUsername(username, 'getOfficeById');
  if (!id) throw new Error('[OfficesService:getOfficeById] id is required.');
  const office = await OfficeRepository.getById(String(id));
  if (!office || office.deleted_at !== null) return null;
  if (office.username !== username) {
    throw new Error('[OfficesService] cross-user access is forbidden.');
  }
  return office;
}

// ── Hamola CRUD (تفاصيل الحمولة) — independent office master-data editor ──
// These functions persist ONLY office.hamolaRows on the office record itself.
// They never touch receipts, receipt rows, FinancialService, or any financial
// calculation.

async function addHamolaRow(username, office_id, row) {
  _requireUsername(username, 'addHamolaRow');
  if (!office_id) throw new Error('[OfficesService:addHamolaRow] office_id is required.');
  const office = await getOfficeById(office_id, username);
  if (!office) throw new Error('[OfficesService] office not found.');

  const nextRow = _normalizeHamolaRow(row, false);
  const hamolaRows = [...(office.hamolaRows || []), nextRow];

  const updated = await OfficeRepository.update(String(office_id), { hamolaRows }, { username });
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return updated;
}

async function updateHamolaRow(username, office_id, row_id, patch) {
  _requireUsername(username, 'updateHamolaRow');
  if (!office_id) throw new Error('[OfficesService:updateHamolaRow] office_id is required.');
  if (!row_id) throw new Error('[OfficesService:updateHamolaRow] row_id is required.');
  if (!patch || typeof patch !== 'object') {
    throw new Error('[OfficesService] patch must be a plain object.');
  }

  const office = await getOfficeById(office_id, username);
  if (!office) throw new Error('[OfficesService] office not found.');

  const rows = office.hamolaRows || [];
  const idx = rows.findIndex((r) => String(r.id) === String(row_id));
  if (idx === -1) throw new Error('[OfficesService] hamola row not found.');

  const updatedRow = _applyHamolaPatch(rows[idx], patch);
  const nextRows = rows.slice();
  nextRows[idx] = updatedRow;

  const updated = await OfficeRepository.update(String(office_id), { hamolaRows: nextRows }, { username });
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return updated;
}

async function deleteHamolaRow(username, office_id, row_id) {
  _requireUsername(username, 'deleteHamolaRow');
  if (!office_id) throw new Error('[OfficesService:deleteHamolaRow] office_id is required.');
  if (!row_id) throw new Error('[OfficesService:deleteHamolaRow] row_id is required.');

  const office = await getOfficeById(office_id, username);
  if (!office) throw new Error('[OfficesService] office not found.');

  const rows = office.hamolaRows || [];
  const nextRows = rows.filter((r) => String(r.id) !== String(row_id));
  if (nextRows.length === rows.length) {
    throw new Error('[OfficesService] hamola row not found.');
  }

  const updated = await OfficeRepository.update(String(office_id), { hamolaRows: nextRows }, { username });
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return updated;
}

// _calcWeight replaced by financialCalculator import.
// Alias kept for minimal call-site diff:
const _calcWeight = calculateWeightTotal;


function _resolveRange(filters) {
  if (!filters || typeof filters !== 'object') return null;

  const now = new Date();
  if (filters.range === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const end = start + 24 * 60 * 60 * 1000 - 1;
    return { from: start, to: end };
  }
  if (filters.range === 'week') {
    const day = now.getDay();
    const diff = now.getDate() - day;
    const start = new Date(now.getFullYear(), now.getMonth(), diff).getTime();
    const end = start + 7 * 24 * 60 * 60 * 1000 - 1;
    return { from: start, to: end };
  }
  if (filters.range === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - 1;
    return { from: start, to: end };
  }

  const from = filters.from ? new Date(filters.from).getTime() : null;
  const to = filters.to ? new Date(filters.to).getTime() : null;
  if ((filters.from && Number.isNaN(from)) || (filters.to && Number.isNaN(to))) {
    throw new Error('[OfficesService] invalid date range.');
  }
  if (from == null && to == null) return null;

  return {
    from: from ?? 0,
    to: to ?? Date.now(),
  };
}

// ── Read-side ReceiptRow projection (normalized Receipt/ReceiptRow) ──
// Persisted receipt HEADERS (receipts store) no longer carry row entities;
// rows live in the separate receipt_rows store. They are fetched through the
// frozen ReceiptReadRepository and projected in-memory, keyed by receipt id —
// mirroring the allReceipts.js projection pattern. Rows are NEVER
// attached onto receipt header objects — there is no embedded receipt.rows
// anywhere in this module.
async function _loadReceiptRowsProjection(receipts) {
  const projection = new Map();
  await Promise.all((receipts || []).map(async (rec) => {
    const key = String(rec?.id ?? '');
    if (!key) { projection.set(key, []); return; }
    try {
      const rows = await ReceiptReadRepository.getReceiptRowsByReceipt(rec.id);
      projection.set(key, rows || []);
    } catch (err) {
      console.warn('[OfficesService] row projection failed for receipt', key, err);
      projection.set(key, []);
    }
  }));
  return projection;
}

/**
 * Bridge one persisted ReceiptRow (frozen contract, money in CENTS)
 * into the office-side vocabulary the calculators/cards consume (money in
 * DECIMALS). Mirrors the receipts.js / allReceipts.js read boundaries.
 * Every user-entered column is restored straight from its persisted slot —
 * nothing is fabricated; slots null on old rows render blank/zero.
 * `net` is the authoritative save-time row net, persisted in cents on the row.
 */
function _persistedRowToOfficeShape(row) {
  return {
    office : row.office || '',
    loading: row.loading || '',
    taktik : row.destination || '', // destination → الجهة
    // ── persisted user-entered columns (original form) ──
    weight: row.weight ?? '', weight2: row.weight2 ?? '', deficit: row.deficit ?? '',
    type: row.type || '',
    // ── money: persisted cents → decimals ──
    officeAmount: Money.toDecimal(row.officeAmount ?? 0),
    discount: Money.toDecimal(row.discount ?? 0),
    add: Money.toDecimal(row.add ?? 0),
    noloon: Money.toDecimal(row.driver_price ?? 0), // driver_price → نولون
    ohda  : Money.toDecimal(row.advance ?? 0),      // advance     → عهدة
    sarf  : Money.toDecimal(row.sarf ?? 0),
    net   : Money.toDecimal(row.net ?? 0),          // persisted row net
  };
}

async function getOfficeFinancialSummary(username, filters = null) {
  _requireUsername(username, 'getOfficeFinancialSummary');

  const offices = await getOffices(username);
  const nameMap = new Map(
    offices.map((o) => [String(o.name || '').trim().toLowerCase(), o])
  );

  const summary = new Map();
  for (const office of offices) {
    summary.set(String(office.id), {
      office,
      net: 0,
      weight: 0,
    });
  }

  const range = _resolveRange(filters);

  const receipts = await ReceiptRepository.getAll(username);
  const filteredReceipts = range
    ? receipts.filter((r) => {
        const ts = new Date(r.receipt_date || 0).getTime();
        return ts >= range.from && ts <= range.to;
      })
    : receipts;

  // Rows live in the receipt_rows store (normalized architecture) — fetched
  // once for the in-range receipts and projected by receipt id.
  const rowsProjection = await _loadReceiptRowsProjection(filteredReceipts);

  for (const receipt of filteredReceipts) {
    const rows = rowsProjection.get(String(receipt.id)) || [];
    for (const row of rows) {
      if (!row) continue; // separators are UI-local — never persisted in receipt_rows
      const shape = _persistedRowToOfficeShape(row);
      const officeName = shape.office.trim();
      if (!officeName) continue;
      const office = nameMap.get(officeName.toLowerCase());
      if (!office) {
        throw new Error(`[OfficesService] unknown office: ${officeName}`);
      }
      const item = summary.get(String(office.id));
      item.weight += _calcWeight(shape); // persisted weight slots → real totals
      item.net += shape.net;             // persisted authoritative save-time row net
    }
  }

  const rows = Array.from(summary.values());

  const totals = rows.reduce(
    (acc, item) => {
      acc.total_net += item.net;
      acc.total_weight += item.weight;
      return acc;
    },
    { total_net: 0, total_weight: 0 }
  );

  return {
    total_offices: rows.length,
    total_net: totals.total_net,
    total_weight: totals.total_weight,
    rows,
  };
}

const OfficesService = Object.freeze({
  createOffices,
  updateOffice,
  deleteOffice,
  getOffices,
  getOfficeById,
  addHamolaRow,
  updateHamolaRow,
  deleteHamolaRow,
  getOfficeFinancialSummary,
});



// ========================================
// Module — OfficesModule
// ========================================

function _moduleSessionUsername() {
  const session = AuthModule.getSession();
  if (!session?.username) {
    throw new Error('Username required');
  }
  return session.username;
}

const OfficesModule = Object.freeze({
  createOffices: (rows) => OfficesService.createOffices(_moduleSessionUsername(), rows),
  updateOffice: (id, patch) => OfficesService.updateOffice(_moduleSessionUsername(), id, patch),
  deleteOffice: (id) => OfficesService.deleteOffice(_moduleSessionUsername(), id),
  addHamolaRow: (office_id, row) =>
    OfficesService.addHamolaRow(_moduleSessionUsername(), office_id, row),
  updateHamolaRow: (office_id, row_id, patch) =>
    OfficesService.updateHamolaRow(_moduleSessionUsername(), office_id, row_id, patch),
  deleteHamolaRow: (office_id, row_id) =>
    OfficesService.deleteHamolaRow(_moduleSessionUsername(), office_id, row_id),
  getOfficeDetails: (id) => OfficesService.getOfficeById(id, _moduleSessionUsername()),
  getOfficeSummary: (filters = null) =>
    OfficesService.getOfficeFinancialSummary(_moduleSessionUsername(), filters),
});



// ========================================
// Offices Page — Rendering / Events
// ========================================

let _searchQuery = '';
let _editingOfficeId = null;
let _editingOfficeDraft = null;
let _activeDetailsTab = 'hamola';
let _detailsOfficeId = null;
let _hamolaEditId = null;
const LAST_PAGE_CTX_KEY = 'financial_last_page_ctx';

function _requireSession() {
  const session = AuthModule.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }
  return session;
}

function _fmt(n) {
  return Money.fmt(n);
}

function _text(value) {
  return value == null ? '' : String(value);
}

// _balanceClass — visual class helper for the رصيد الشركة tab (UI only).
function _balanceClass(value) {
  return Number(value) < 0 ? 'balance-negative' : 'balance-positive';
}

function _renderListShell() {
  const page = document.getElementById('officesPage');
  if (!page) return;

  page.innerHTML = `
    <div class="p-6 card">

      <!-- العنوان والأزرار -->
      <div class="flex items-center justify-between flex-wrap gap-3 mb-6">
        <h2 class="text-2xl font-bold text-gray-800 mb-0">إدارة الشركات</h2>
        <div class="flex gap-2">
          <button type="button" data-action="office-add" style="background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;border:none;border-radius:10px;padding:8px 18px;font-weight:700;font-size:0.875rem;cursor:pointer;font-family:inherit;transition:box-shadow 0.2s;">➕ إضافة شركة</button>
        </div>
      </div>

      <!-- بطاقات الملخص -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <div style="background:linear-gradient(135deg,#22c55e,#16a34a);border-radius:12px;padding:16px;color:#fff;">
          <p style="font-size:0.75rem;opacity:0.9;margin:0 0 4px;">عدد الشركات</p>
          <p style="font-size:1.5rem;font-weight:800;margin:0;" id="officeTotalCount">0</p>
        </div>
        <div style="background:linear-gradient(135deg,#10b981,#059669);border-radius:12px;padding:16px;color:#fff;">
          <p style="font-size:0.75rem;opacity:0.9;margin:0 0 4px;">إجمالي الوزن</p>
          <p style="font-size:1.5rem;font-weight:800;margin:0;" id="officeTotalWeight">0.00</p>
        </div>
      </div>

      <!-- شريط البحث -->
      <div class="mb-6">
        <input id="officeSearch" type="text" class="input" placeholder="🔍 ابحث عن شركة..." style="border-radius:12px;padding:10px 16px 10px 40px;" />
      </div>

      <!-- قائمة الشركات -->
      <div style="margin-bottom:8px;">
        <h3 class="text-lg font-bold text-gray-800 mb-3">قائمة الشركات</h3>
      </div>
      <div class="table-wrapper overflow-x-auto">
        <table class="table">
          <thead style="background:linear-gradient(135deg,#1e3a8a,#2563eb);">
            <tr>
              <th style="color:#fff;">اسم الشركة</th>
              <th style="color:#fff;">رقم الهاتف</th>
              <th style="color:#fff;">إجمالي الوزن</th>
              <th style="color:#fff;">إجراءات</th>
            </tr>
          </thead>
          <tbody id="officesTableBody"></tbody>
        </table>
      </div>

      <div id="officesInlineMsg" class="field-msg-inline field-msg-inline--error" role="alert" aria-live="polite"></div>
    </div>
  `;

  if (!document.getElementById('officeModal')) {
    const modal = document.createElement('div');
    modal.innerHTML = _renderOfficeModal();
    document.body.appendChild(modal.firstElementChild);
  }
}

function _renderOfficeModal() {
  return `
    <div id="officeModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-3xl">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold">إضافة شركات</h3>
          <button type="button" data-action="office-modal-close" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>

        <div class="table-wrapper overflow-x-auto mb-4">
          <table class="table">
            <thead>
              <tr>
                <th>الاسم</th>
                <th>الهاتف</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody id="officeModalBody"></tbody>
          </table>
        </div>

        <div class="flex gap-2">
          <button type="button" data-action="office-modal-add-row" class="btn btn-secondary btn-sm">➕ إضافة صف</button>
          <button type="button" data-action="office-modal-save" class="btn btn-primary btn-sm">حفظ الكل</button>
        </div>
        <div id="officeModalMsg" class="field-msg-inline field-msg-inline--error" role="alert" aria-live="polite"></div>
      </div>
    </div>
  `;
}

function _renderOfficeModalRow() {
  return `
    <tr>
      <td><input type="text" class="input input-sm office-modal-name" placeholder="اسم الشركة" /></td>
      <td><input type="text" class="input input-sm office-modal-phone" placeholder="الهاتف" /></td>
      <td><button type="button" data-action="office-modal-remove-row" class="btn btn-secondary btn-sm">حذف</button></td>
    </tr>
  `;
}

function _renderDetailsShell(office) {
  const page = document.getElementById('officeDetailsPage');
  if (!page) return;

  page.innerHTML = `
    <div class="p-6 card">

      <!-- رأس التفاصيل -->
      <div class="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div class="flex items-center gap-3">
          <button type="button" data-action="office-back" style="background:#6b7280;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">← العودة</button>
          <div>
            <h2 class="text-xl font-bold text-gray-800 mb-0">${office.name}</h2>
            <p class="text-muted text-xs mb-0">عرض وإدارة البيانات الكاملة</p>
          </div>
        </div>
        <button type="button" data-action="office-print" style="background:#7c3aed;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">🖨️ طباعة</button>
      </div>

      <!-- بيانات الشركة -->
      <div style="background:linear-gradient(135deg,#f0fdf4,#f0fdfa);border-radius:12px;padding:16px 20px;margin-bottom:20px;display:flex;flex-wrap:wrap;gap:20px;">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:200px;">
          <div style="width:40px;height:40px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.125rem;flex-shrink:0;">🏢</div>
          <div>
            <p style="font-size:0.6875rem;color:#6b7280;margin:0;">اسم الشركة</p>
            <p style="font-size:1.0625rem;font-weight:700;color:#1f2937;margin:0;">${office.name}</p>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:200px;">
          <div style="width:40px;height:40px;border-radius:50%;background:#0f766e;display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.125rem;flex-shrink:0;">📞</div>
          <div>
            <p style="font-size:0.6875rem;color:#6b7280;margin:0;">رقم الهاتف</p>
            <p style="font-size:1.0625rem;font-weight:700;color:#1f2937;margin:0;">${office.phone || '—'}</p>
          </div>
        </div>
      </div>

      <!-- التبويبات -->
      <div style="display:flex;border-bottom:2px solid #e5e7eb;margin-bottom:20px;" role="tablist">
        <button type="button" data-tab="balance" style="padding:12px 20px;border:none;border-bottom:3px solid ${_activeDetailsTab === 'balance' ? '#1f2937' : 'transparent'};background:${_activeDetailsTab === 'balance' ? '#f3f4f6' : 'transparent'};color:${_activeDetailsTab === 'balance' ? '#1f2937' : '#9ca3af'};font-weight:${_activeDetailsTab === 'balance' ? '700' : '500'};font-size:0.9375rem;cursor:pointer;font-family:inherit;transition:all 0.2s;">💰 رصيد الشركة</button>
        <button type="button" data-tab="hamola" style="padding:12px 20px;border:none;border-bottom:3px solid ${_activeDetailsTab === 'hamola' ? '#1f2937' : 'transparent'};background:${_activeDetailsTab === 'hamola' ? '#f3f4f6' : 'transparent'};color:${_activeDetailsTab === 'hamola' ? '#1f2937' : '#9ca3af'};font-weight:${_activeDetailsTab === 'hamola' ? '700' : '500'};font-size:0.9375rem;cursor:pointer;font-family:inherit;transition:all 0.2s;">🚚 تفاصيل الحمولة</button>
      </div>

      <div id="officeDetailsContent"></div>
    </div>
  `;

  if (!document.getElementById('hamolaModal')) {
    const modal = document.createElement('div');
    modal.innerHTML = _renderHamolaModal();
    document.body.appendChild(modal.firstElementChild);
  }
}

function _renderHamolaModal() {
  return `
    <div id="hamolaModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-lg">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold" id="hamolaModalTitle">إضافة حمولة</h3>
          <button type="button" data-action="hamola-modal-close" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <div>
            <label class="label mb-1" for="hamolaLoading">مكان التحميل</label>
            <input id="hamolaLoading" type="text" class="input input-sm" />
          </div>
          <div>
            <label class="label mb-1" for="hamolaDestination">الجهة</label>
            <input id="hamolaDestination" type="text" class="input input-sm" />
          </div>
          <div>
            <label class="label mb-1" for="hamolaType">النوع</label>
            <input id="hamolaType" type="text" class="input input-sm" />
          </div>
        </div>

        <div class="flex gap-2">
          <button type="button" data-action="hamola-modal-save" class="btn btn-primary btn-sm">حفظ</button>
        </div>
        <div id="hamolaModalMsg" class="field-msg-inline field-msg-inline--error" role="alert" aria-live="polite"></div>
      </div>
    </div>
  `;
}

function _renderHamolaTable(rows) {
  const body = rows.length
    ? rows.map((r) => {
        return `
      <tr>
        <td>${_text(r.loading_place)}</td>
        <td>${_text(r.destination_place)}</td>
        <td>${_text(r.item_type)}</td>
        <td>
          <button type="button" data-action="hamola-edit" data-id="${r.id}" class="btn-icon" title="تعديل" style="background:#dbeafe;color:#2563eb;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">✏️</button>
          <button type="button" data-action="hamola-delete" data-id="${r.id}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
        </td>
      </tr>`;
      }).join('')
    : `<tr><td colspan="4" class="text-center text-muted p-6" style="color:#94a3b8;">لا توجد بيانات — اضغط إضافة حمولة</td></tr>`;

  return `
    <div class="flex justify-between items-center flex-wrap gap-3 mb-4">
      <h3 class="text-xl font-bold text-gray-800">قائمة أماكن التحميل والتعتيق</h3>
      <div class="flex items-center gap-3 flex-wrap">
        <button type="button" data-action="hamola-add" style="background:#16a34a;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">➕ إضافة حمولة</button>
      </div>
    </div>
    <div class="table-wrapper">
      <table class="table">
        <thead style="background:linear-gradient(135deg,#16a34a,#15803d);">
          <tr>
            <th style="color:#fff;">التحميل</th>
            <th style="color:#fff;">الجهة</th>
            <th style="color:#fff;">النوع</th>
            <th style="color:#fff;">إجراءات</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

// ── رصيد الشركة tab — UI-ONLY restoration ──────────────────────────────────
// Exact pre-removal renderer kept verbatim. It is fed an EMPTY entry list on
// purpose: the balance/ledger/deposit functionality remains removed. The tab
// therefore shows its placeholder card (الرصيد الحالي = 0.00), the original
// 5-column empty table («لا توجد حركات»), and the original 💰 إيداع / سحب
// button — which has NO handler and performs NO action.
function _renderOfficeBalance(entries) {
  function entryDate(entry) {
    return entry.date || entry.applied_at || entry.created_at || '';
  }

  function entryTypeLabel(entry) {
    if (entry.type === 'OFFICE_DEPOSIT' || entry.type === 'deposit') return 'إيداع';
    if (entry.type === 'OFFICE_WITHDRAW_AUTO' || entry.type === 'withdraw') return 'سحب';
    return _text(entry.type || '');
  }

  function entryDelta(entry) {
    const amount = Number(entry.amount) || 0;
    if (entry.type === 'OFFICE_DEPOSIT' || entry.type === 'OFFICE_WITHDRAW_AUTO') return amount;
    if (entry.type === 'deposit') return Math.abs(amount);
    if (entry.type === 'withdraw') return -Math.abs(amount);
    return amount;
  }

  const sorted = entries.slice().sort((a, b) => {
    const da = new Date(entryDate(a) || 0).getTime();
    const db = new Date(entryDate(b) || 0).getTime();
    return da - db;
  });

  let running = 0;
  const withBalance = sorted.map((entry) => {
    const delta = entryDelta(entry);
    running += delta;
    return { entry, delta, balance: running };
  });

  const currentBalance = withBalance.length
    ? withBalance[withBalance.length - 1].balance
    : 0;
  const currentClass = _balanceClass(currentBalance);

  const displayRows = withBalance.slice().reverse();
  const rows = displayRows.length
    ? displayRows.map(({ entry, delta, balance }) => `
      <tr>
        <td>${_text(entryDate(entry))}</td>
        <td>${entryTypeLabel(entry)}</td>
        <td>${delta < 0 ? '-' : ''}${_fmt(Math.abs(delta))}</td>
        <td>${_fmt(balance)}</td>
        <td>${_text(entry.reference_number || entry.reference_id || '-')}</td>
      </tr>
    `).join('')
    : `<tr><td colspan="5" class="text-center text-muted p-4">لا توجد حركات</td></tr>`;

  return `
    <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;">
      <div>
        <p class="text-muted text-xs mb-1">الرصيد الحالي</p>
        <p class="text-2xl font-bold ${currentClass}">${_fmt(currentBalance)}</p>
      </div>
      <div class="flex gap-2">
        <button type="button" data-action="office-deposit-open" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">💰 إيداع / سحب</button>
      </div>
    </div>
    <div class="table-wrapper">
      <table class="table">
        <thead style="background:linear-gradient(135deg,#1e3a8a,#2563eb);">
          <tr>
            <th style="color:#fff;">التاريخ</th>
            <th style="color:#fff;">النوع</th>
            <th style="color:#fff;">المبلغ</th>
            <th style="color:#fff;">الرصيد بعد العملية</th>
            <th style="color:#fff;">المرجع</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}


async function loadOffices() {
  const session = _requireSession();
  if (!session) return;

  _renderListShell();

  const searchEl = document.getElementById('officeSearch');
  if (searchEl) searchEl.value = _searchQuery || '';

  const summary = await OfficesModule.getOfficeSummary();
  const totalCountEl = document.getElementById('officeTotalCount');
  const totalWeightEl = document.getElementById('officeTotalWeight');

  if (totalCountEl) totalCountEl.textContent = String(summary.total_offices || 0);
  if (totalWeightEl) totalWeightEl.textContent = _fmt(summary.total_weight);

  const tbody = document.getElementById('officesTableBody');
  if (!tbody) return;

  const query = _searchQuery.trim().toLowerCase();
  const rows = summary.rows.filter((item) => {
    if (!query) return true;
    const name = String(item.office.name || '').toLowerCase();
    const phone = String(item.office.phone || '').toLowerCase();
    return name.includes(query) || phone.includes(query);
  });

  tbody.innerHTML = rows.map((item) => {
    const office = item.office;
    const isEditing = _editingOfficeId && String(_editingOfficeId) === String(office.id);
    const nameVal = isEditing ? _editingOfficeDraft?.name ?? office.name : office.name;
    const phoneVal = isEditing ? _editingOfficeDraft?.phone ?? office.phone : office.phone;

    return `
      <tr data-id="${office.id}" style="transition:background 0.15s;">
        <td ${!isEditing ? `data-action="office-details" data-id="${office.id}" style="cursor:pointer;color:#2563eb;font-weight:700;" onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background=''"` : ''}>
          ${isEditing
            ? `<input type="text" class="input input-sm office-edit-name" value="${_text(nameVal)}" />`
            : _text(office.name)
          }
        </td>
        <td style="color:#374151;">
          ${isEditing
            ? `<input type="text" class="input input-sm office-edit-phone" value="${_text(phoneVal)}" />`
            : _text(office.phone || '—')
          }
        </td>
        <td style="color:#374151;">${_fmt(item.weight)}</td>
        <td>
          ${isEditing
            ? `
              <button type="button" data-action="office-save" data-id="${office.id}" class="btn btn-primary btn-sm">حفظ</button>
              <button type="button" data-action="office-cancel" class="btn btn-secondary btn-sm">إلغاء</button>
            `
            : `
              <button type="button" data-action="office-details" data-id="${office.id}" class="btn-icon" title="تفاصيل" style="background:#dbeafe;color:#2563eb;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">📋</button>
              <button type="button" data-action="office-delete" data-id="${office.id}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
            `
          }
        </td>
      </tr>
    `;
  }).join('') || `<tr><td colspan="4" class="text-center text-muted p-6">
    <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:24px;">
      <div style="width:64px;height:64px;background:#e2e8f0;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:2rem;">🏢</div>
      <p style="font-weight:700;color:#64748b;margin:0;">لا يوجد شركات</p>
      <p style="font-size:0.8125rem;color:#94a3b8;margin:0;">ابدأ بإضافة الشركات من الزر أعلاه</p>
    </div>
  </td></tr>`;
}

async function showOfficeDetails(id) {
  const session = _requireSession();
  if (!session) return;
  if (!id) throw new Error('[offices-page] office id is required');

  _detailsOfficeId = String(id);
  const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
  if (!office) throw new Error('Office not found');

  sessionStorage.setItem(LAST_PAGE_CTX_KEY, JSON.stringify({
    page: 'officeDetailsPage',
    officeId: _detailsOfficeId,
  }));

  _renderDetailsShell(office);
  await _renderDetailsContent(office);

  if (typeof window.showPage === 'function') {
    await window.showPage('officeDetailsPage');
  }
}



async function _renderDetailsContent(office) {
  const content = document.getElementById('officeDetailsContent');
  if (!content) return;

  if (_activeDetailsTab === 'balance') {
    // UI-only tab: placeholder card + empty ledger table — no ledger reads,
    // no balance computation (the feature itself remains removed).
    content.innerHTML = _renderOfficeBalance([]);
    return;
  }

  if (_activeDetailsTab === 'hamola') {
    content.innerHTML = _renderHamolaTable(office.hamolaRows || []);
  }
}

function _openOfficeModal() {
  const modal = document.getElementById('officeModal');
  const body = document.getElementById('officeModalBody');
  const msg = document.getElementById('officeModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  if (body) body.innerHTML = _renderOfficeModalRow();
  modal?.classList.remove('hidden');
}

function _closeOfficeModal() {
  document.getElementById('officeModal')?.classList.add('hidden');
}

function _openHamolaModal(title, row = null) {
  const modal = document.getElementById('hamolaModal');
  const msg = document.getElementById('hamolaModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }

  const t = document.getElementById('hamolaModalTitle');
  if (t) t.textContent = title;

  const loading = document.getElementById('hamolaLoading');
  const destination = document.getElementById('hamolaDestination');
  const typeInp = document.getElementById('hamolaType');

  if (loading) loading.value = row?.loading_place || '';
  if (destination) destination.value = row?.destination_place || '';
  if (typeInp) typeInp.value = row?.item_type ?? '';

  modal?.classList.remove('hidden');
}

function _closeHamolaModal() {
  document.getElementById('hamolaModal')?.classList.add('hidden');
}

async function _saveHamolaRow() {
  const msg = document.getElementById('hamolaModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }

  const loading = document.getElementById('hamolaLoading')?.value;
  const destination = document.getElementById('hamolaDestination')?.value;
  const itemType = document.getElementById('hamolaType')?.value;

  try {
    if (_hamolaEditId) {
      await OfficesModule.updateHamolaRow(_detailsOfficeId, _hamolaEditId, {
        loading_place: loading,
        destination_place: destination,
        item_type: itemType,
      });
    } else {
      await OfficesModule.addHamolaRow(_detailsOfficeId, {
        loading_place: loading,
        destination_place: destination,
        item_type: itemType,
      });
    }

    _hamolaEditId = null;
    _closeHamolaModal();
    const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
    await _renderDetailsContent(office);
  } catch (err) {
    if (msg) {
      msg.textContent = err.message || 'حدث خطأ أثناء الحفظ';
      msg.classList.add('is-visible');
    }
  }
}


function attachOfficesPageListeners() {
  if (document.body.dataset.officesBound) return;
  document.body.dataset.officesBound = '1';

  document.addEventListener('click', async (e) => {
    const target = e.target;

    if (target.closest('[data-action="office-add"]')) {
      _openOfficeModal();
      return;
    }
    if (target.closest('[data-action="office-modal-close"]')) {
      _closeOfficeModal();
      return;
    }
    if (target.closest('[data-action="office-modal-add-row"]')) {
      document.getElementById('officeModalBody')?.insertAdjacentHTML('beforeend', _renderOfficeModalRow());
      return;
    }
    if (target.closest('[data-action="office-modal-remove-row"]')) {
      target.closest('tr')?.remove();
      return;
    }
    if (target.closest('[data-action="office-modal-save"]')) {
      const rows = [...document.querySelectorAll('#officeModalBody tr')].map((tr) => ({
        name: tr.querySelector('.office-modal-name')?.value,
        phone: tr.querySelector('.office-modal-phone')?.value,
      }));
      try {
        await OfficesModule.createOffices(rows);
        _closeOfficeModal();
        await loadOffices();
      } catch (err) {
        const msg = document.getElementById('officeModalMsg');
        if (msg) {
          msg.textContent = err.message || 'حدث خطأ أثناء الحفظ';
          msg.classList.add('is-visible');
        }
      }
      return;
    }

    if (target.closest('[data-action="office-edit"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      _editingOfficeId = id;
      _editingOfficeDraft = null;
      await loadOffices();
      return;
    }
    if (target.closest('[data-action="office-cancel"]')) {
      _editingOfficeId = null;
      _editingOfficeDraft = null;
      await loadOffices();
      return;
    }
    if (target.closest('[data-action="office-save"]')) {
      const row = target.closest('tr');
      const id = row?.dataset.id;
      const name = row?.querySelector('.office-edit-name')?.value;
      const phone = row?.querySelector('.office-edit-phone')?.value;
      try {
        await OfficesModule.updateOffice(id, { name, phone });
        _editingOfficeId = null;
        _editingOfficeDraft = null;
        await loadOffices();
      } catch (err) {
        const msg = document.getElementById('officesInlineMsg');
        if (msg) {
          msg.textContent = err.message || 'حدث خطأ أثناء التعديل';
          msg.classList.add('is-visible');
        }
      }
      return;
    }
    if (target.closest('[data-action="office-delete"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      if (!id) return;
      if (!confirm('هل أنت متأكد من حذف الشركة؟')) return;
      await OfficesModule.deleteOffice(id);
      await loadOffices();
      return;
    }
    if (target.closest('[data-action="office-details"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      if (id) await showOfficeDetails(id);
      return;
    }

    if (target.closest('[data-action="office-back"]')) {
      _activeDetailsTab = 'hamola';
      _detailsOfficeId = null;
      if (typeof window.showPage === 'function') await window.showPage('officesPage');
      return;
    }

    if (target.closest('[data-action="office-print"]')) {
      if (_detailsOfficeId) {
        const content = document.getElementById('officeDetailsContent');
        if (content) {
          const { printHTML, buildPrintDocument } = await import('./printEngine.js');
          const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
          printHTML(buildPrintDocument({
            title: 'طباعة تفاصيل الشركة',
            body: '<h2 style="text-align:center;color:#0f766e;margin-bottom:12px;">' + (office?.name || '') + '</h2>' + content.innerHTML,
            orientation: 'portrait',
          }), { id: 'office-print-iframe' });
        }
      }
      return;
    }

    const tabBtn = target.closest('[data-tab]');
    if (tabBtn) {
      _activeDetailsTab = tabBtn.dataset.tab;
      if (_detailsOfficeId) {
        const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
        // Re-render full shell to update tab active state
        _renderDetailsShell(office);
        await _renderDetailsContent(office);
      }
      return;
    }

    if (target.closest('[data-action="hamola-add"]')) {
      _hamolaEditId = null;
      _openHamolaModal('إضافة حمولة');
      return;
    }

    if (target.closest('[data-action="hamola-edit"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
      const row = office?.hamolaRows?.find((r) => String(r.id) === String(id));
      if (!row) return;
      _hamolaEditId = id;
      _openHamolaModal('تعديل حمولة', row);
      return;
    }

    if (target.closest('[data-action="hamola-delete"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      if (!id) return;
      if (!confirm('هل أنت متأكد من حذف الحمولة؟')) return;
      await OfficesModule.deleteHamolaRow(_detailsOfficeId, id);
      const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
      await _renderDetailsContent(office);
      return;
    }

    if (target.closest('[data-action="hamola-modal-close"]')) {
      _hamolaEditId = null;
      _closeHamolaModal();
      return;
    }

    if (target.closest('[data-action="hamola-modal-save"]')) {
      await _saveHamolaRow();
      return;
    }

  });

  document.addEventListener('input', async (e) => {
    const target = e.target;
    if (target?.id === 'officeSearch') {
      _searchQuery = target.value || '';
      await loadOffices();
      return;
    }
  });


  window.addEventListener('offices:changed', () => {
    loadOffices();
  });
}


function initOfficesPage() {
  const session = _requireSession();
  if (!session) return;
  _renderListShell();
}

window.showOfficeDetails = showOfficeDetails;


// ========================================
// Public API
// ========================================

export { OfficesService, OfficesModule, initOfficesPage, loadOffices, attachOfficesPageListeners, showOfficeDetails };
