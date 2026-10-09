/**
 * entities.js — consolidated module
 * Internal structure: Constants → State → Services → Helpers → Rendering → Events → Public API → Boot
 */

import { FinancialService } from './financial.js';
import { AuthModule } from './auth.js';
import { Money } from './money.js';
import { printHTML } from './printEngine.js';
import { ExcelService } from './excelService.js';
import { DateUtils } from './dateUtils.js';
import { ClientRepository } from './services/clientRepository.js';
import { ReceiptReadRepository } from './services/receiptReadRepository.js';
import { ReceiptRepository } from './services/receiptRepository.js';


// ========================================
// Services — Vehicles
// ========================================

function _normalizePlate(rawPlate) {
  return String(rawPlate ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

async function resolveVehicle(username, rawPlate, owner = null) {
  if (!username) throw new Error('[VehiclesModule:resolveVehicle] username is required.');
  const normalizedPlate = _normalizePlate(rawPlate);

  if (!normalizedPlate) {
    throw new Error('رقم المركبة مطلوب');
  }

  const existing = await ClientRepository.getVehiclesByPlate(normalizedPlate);

  if (existing.length > 0) {
    const vehicle = existing[0];
    if (!vehicle.owner_id && owner?.id) {
      return ClientRepository.updateVehicle(vehicle.id, {
        owner_id: String(owner.id),
        owner_name: owner.name || null,
      }, { username });
    }
    return vehicle;
  }

  if (!owner?.id) {
    throw new Error('يجب تحديد مالك المركبة قبل تسجيل المركبة');
  }

  const vehicle = await ClientRepository.saveVehicle({
    id: crypto.randomUUID(),
    plate: normalizedPlate,
    owner_id: String(owner.id),
    owner_name: owner.name || null,
    notes: null,
  }, { username });

  return vehicle;
}

const VehiclesModule = { resolveVehicle };

window.VehiclesModule = VehiclesModule;



// ========================================
// Services — OwnersModule
// ========================================

function _uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 0x0f;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function _toText(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function _emitOwnersChanged() {
  window.dispatchEvent(new CustomEvent('owners:changed'));
}

async function createOwner(username, payload) {
  if (!username) throw new Error('[OwnersModule:createOwner] username is required.');
  const vehicle_number = _toText(payload?.vehicle_number).trim();
  const notes = _toText(payload?.notes).trim();

  if (!vehicle_number) {
    throw new Error('رقم المركبة مطلوب');
  }

  const exists = await ClientRepository.findOwnersByNumber(vehicle_number);
  if (exists.length > 0) {
    throw new Error('رقم المركبة مستخدم بالفعل');
  }

  const record = await ClientRepository.saveOwner({
    id: _uuid(),
    username,
    vehicle_number,
    name: vehicle_number,
    notes: notes || null,
  }, { username });

  _emitOwnersChanged();
  return record;
}

async function getAllOwners() {
  return ClientRepository.getAllOwners();
}

async function updateOwner(username, id, patch) {
  if (!username) throw new Error('[OwnersModule:updateOwner] username is required.');
  if (!id) throw new Error('معرّف المركبة مطلوب');
  const vehicle_number = patch?.vehicle_number === undefined
    ? undefined
    : _toText(patch.vehicle_number).trim();
  const notes = patch?.notes === undefined ? undefined : _toText(patch.notes).trim();

  if (vehicle_number !== undefined) {
    if (!vehicle_number) throw new Error('رقم المركبة مطلوب');
    const exists = (await ClientRepository.findOwnersByNumber(vehicle_number))
      .filter(o => String(o.id) !== String(id));
    if (exists.length > 0) {
      throw new Error('رقم المركبة مستخدم بالفعل');
    }
  }

  const updated = await ClientRepository.updateOwner(id, {
    ...(vehicle_number !== undefined ? { vehicle_number, name: vehicle_number } : {}),
    ...(notes !== undefined ? { notes: notes || null } : {}),
  }, { username });

  _emitOwnersChanged();
  return updated;
}

async function deleteOwner(username, id) {
  if (!username) throw new Error('[OwnersModule:deleteOwner] username is required.');
  if (!id) throw new Error('معرّف المركبة مطلوب');

  // Receipts contain immutable snapshots with owner_name — safe to delete entity
  const deleted = await ClientRepository.deleteOwner(id, { username });
  _emitOwnersChanged();
  return deleted;
}

async function getOwnerById(id) {
  if (!id) return null;
  const owner = await ClientRepository.getOwnerById(id);
  if (!owner || owner.deleted_at !== null) return null;
  return owner;
}


async function getClientByType(type, id) {
  if (type && type !== 'owner') return null;
  const owner = await ClientRepository.getOwnerById(String(id));
  return owner ? {
    id: String(owner.id),
    type: 'owner',
    name: owner.vehicle_number || owner.name || '',
    vehicle_number: owner.vehicle_number || '',
  } : null;
}


async function getOwnerVehicles(owner_id) {
  const vehicles = await ClientRepository.getAllVehicles();
  return vehicles.filter(v => String(v.owner_id || '') === String(owner_id));
}

async function addAccount(username, kind, payload) {
  if (!username) throw new Error('[OwnersModule:addAccount] username is required.');
  if (kind && kind !== 'owner') {
    throw new Error('[OwnersModule:addAccount] only vehicle owners are supported.');
  }
  const vehicle_number = _toText(payload?.vehicle_number).trim();
  const notes = _toText(payload?.notes).trim();
  if (!vehicle_number) throw new Error('❌ رقم المركبة مطلوب');
  await createOwner(username, { vehicle_number, notes });
}



const OwnersModule = Object.freeze({
  getAllOwners,
  updateOwner,
  deleteOwner,
  getOwnerById,
  getClientByType,
  getOwnerVehicles,
  addAccount,
});

window.OwnersModule = OwnersModule;



// ========================================
// Owners Page — Rendering / Events
// ========================================

let _ownersActiveSubTab = 'vehicles';
let _selectedClient = null;
let _selectedVehicle = null;
// Monotonic request token prevents a slower previous vehicle-details load from
// overwriting a newer selected vehicle render.
let _vehicleDetailsRequestVersion = 0;
let _editingDriverId = null;
let _editingDriverPreviousName = '';
const LAST_PAGE_CTX_KEY = 'financial_last_page_ctx';
function _getCurrentDriverId() {
  try {
    const raw = sessionStorage.getItem(LAST_PAGE_CTX_KEY);
    if (!raw) return null;
    const ctx = JSON.parse(raw);
    if (ctx?.page === 'driverDetailsPage' && ctx?.driverId) {
      return String(ctx.driverId);
    }
  } catch (_) {}
  return null;
}


function _fmt(n) {
  return Money.fmt(n);
}

function _dateLabel(value) {
  if (!value) return '-';
  return String(value).split('T')[0] || '-';
}

function _ledgerType(type) {
  if (type === 'deposit') return 'إضافة';
  if (type === 'withdraw') return 'سداد';
  return type || '-';
}

function _ledgerNote(entry) {
  const refType = entry.reference_type || '';
  const type = entry.type || '';
  const note = entry.note || '';

  if (refType === 'manual_driver_balance') {
    if (note) return note;
    return type === 'withdraw' ? 'سحب يدوي من رصيد السائق' : 'إيداع يدوي لرصيد السائق';
  }

  // Structured maintenance withdrawals remain normal manual vehicle
  // movements, while their note in the Financial Movements tab identifies the
  // maintenance type without changing any ledger calculation.
  const maintenanceType = String(entry.maintenance_type || '').trim();
  if (maintenanceType) {
    const quantity = entry.maintenance_quantity;
    const quantityText = quantity === null || quantity === undefined || quantity === ''
      ? ''
      : ` — العدد: ${quantity}`;
    return `صيانة — ${maintenanceType}${quantityText}${note ? ` — ${note}` : ''}`;
  }
  // Generic
  if (note) return note;
  return _ledgerType(type);
}

function _balanceClass(balance) {
  if (Number(balance) < 0) return 'balance-negative';
  if (Number(balance) > 0) return 'balance-positive';
  return '';
}

function _currentUsername() {
  const session = AuthModule.getSession();
  if (!session?.username) {
    throw new Error('Username required');
  }
  return session.username;
}

function _renderShell() {
  const page = document.getElementById('ownersPage');
  if (!page) return;
  if (!page.querySelector('#vehiclesSection')) {
    page.innerHTML = `
      <div class="ent-top-card">
        <div class="ent-header-row">
          <h2 class="ent-page-title">إدارة المركبات</h2>
          <div class="ent-header-actions" id="ownersHeaderActions">
            <div id="vehiclesHeaderActions" class="${_ownersActiveSubTab === 'vehicles' ? '' : 'hidden'}">
              <button type="button" data-action="add-owner-type" data-kind="owner" class="ent-btn-add">➕ إضافة مركبة</button>
              <button type="button" data-action="print-owners" class="ent-btn-print">🖨️ طباعة</button>
              <button type="button" data-action="export-owners-excel" class="ent-btn-print" style="background:#0f766e;" title="تصدير المركبات إلى Excel">📤 تصدير Excel</button>
              <button type="button" data-action="import-owners-excel" class="ent-btn-print" style="background:#7c3aed;" title="استيراد المركبات من Excel">📥 استيراد Excel</button>
            </div>
            <div id="driversHeaderActions" class="${_ownersActiveSubTab === 'drivers' ? '' : 'hidden'}">
              <button type="button" data-action="add-driver" class="ent-btn-add">➕ إضافة سائق</button>
            </div>
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-bottom:16px;border-bottom:2px solid #e5e7eb;padding-bottom:12px;">
          <button type="button" data-action="switch-owners-subtab" data-subtab="vehicles" id="tabBtnVehicles"
            style="padding:8px 16px;border-radius:8px;font-weight:700;font-size:0.875rem;cursor:pointer;border:none;background:${_ownersActiveSubTab === 'vehicles' ? '#2563eb' : '#f3f4f6'};color:${_ownersActiveSubTab === 'vehicles' ? '#fff' : '#4b5563'};">
            🚗 المركبات
          </button>
          <button type="button" data-action="switch-owners-subtab" data-subtab="drivers" id="tabBtnDrivers"
            style="padding:8px 16px;border-radius:8px;font-weight:700;font-size:0.875rem;cursor:pointer;border:none;background:${_ownersActiveSubTab === 'drivers' ? '#2563eb' : '#f3f4f6'};color:${_ownersActiveSubTab === 'drivers' ? '#fff' : '#4b5563'};">
            👨‍✈️ السائقين
          </button>
        </div>

        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;" class="ent-search-wrap">
          <input id="ownerSearchInput" type="text" class="ent-search-input" placeholder="${_ownersActiveSubTab === 'vehicles' ? '🔍 ابحث عن رقم المركبة...' : '🔍 ابحث عن اسم أو رقم هاتف السائق...'}" style="flex:1;min-width:200px;">
        </div>
      </div>

      <div class="ent-columns-grid" id="ownersColumnsGrid">
        <div id="vehiclesSection" class="ent-column-card ${_ownersActiveSubTab === 'vehicles' ? '' : 'hidden'}" style="grid-column:1/-1;">
          <div class="ent-column-header">
            <h3 class="ent-column-title ent-column-title--blue">🚗 المركبات</h3>
          </div>
          <div class="table-wrapper ent-column-scroll">
            <table class="table">
              <thead style="background:linear-gradient(135deg,#2563eb,#1d4ed8);">
                <tr>
                  <th style="color:#fff;">رقم المركبة</th>
                  <th style="color:#fff;">كارتات</th>
                  <th style="color:#fff;">الرصيد</th>
                  <th style="color:#fff;">إجراءات</th>
                </tr>
              </thead>
              <tbody id="ownersTableBody"></tbody>
            </table>
          </div>
        </div>

        <div id="driversSection" class="ent-column-card ${_ownersActiveSubTab === 'drivers' ? '' : 'hidden'}" style="grid-column:1/-1;">
          <div class="ent-column-header">
            <h3 class="ent-column-title ent-column-title--blue">👨‍✈️ السائقين</h3>
          </div>
          <div class="table-wrapper ent-column-scroll">
            <table class="table">
              <thead style="background:linear-gradient(135deg,#2563eb,#1d4ed8);">
                <tr>
                  <th style="color:#fff;">اسم السائق</th>
                  <th style="color:#fff;">رقم الهاتف</th>
                  <th style="color:#fff;">رصيد السائق</th>
                  <th style="color:#fff;">إجراءات</th>
                </tr>
              </thead>
              <tbody id="driversTableBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }
}

let _addModalKind = 'owner';
let _editingAccountId = null;
let _editingAccountKind = null;


function _openEditModal(id, kind, currentNumber) {
  let modal = document.getElementById('ownerAddModal');
  if (!modal) {
    _openAddModal('temp', kind);
    modal = document.getElementById('ownerAddModal');
    modal?.classList.add('hidden');
  }

  _addModalKind = kind;
  _editingAccountId = id;
  _editingAccountKind = kind;

  const header = document.getElementById('addModalHeader');
  if (header) {
    header.style.background = 'linear-gradient(135deg,#2563eb,#1d4ed8)';
  }
  const titleEl = document.getElementById('addModalTitle');
  if (titleEl) titleEl.textContent = '✏️ تعديل مركبة';

  const tbody = document.getElementById('addModalRows');
  if (tbody) tbody.innerHTML = `<tr><td><input type="text" class="input input-sm add-m-vehicle-number" placeholder="رقم المركبة" value="${currentNumber || ''}"></td><td></td></tr>`;

  const msg = document.getElementById('addModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal?.classList.remove('hidden');
}

function _openAddModal(title, kind) {
  _addModalKind = kind;
  _editingAccountId = null;
  _editingAccountKind = null;
  let modal = document.getElementById('ownerAddModal');
  if (!modal) {
    const div = document.createElement('div');
    div.innerHTML = `
      <div id="ownerAddModal" class="hidden fixed inset-0 flex items-center justify-center z-50 p-4" style="background:rgba(0,0,0,0.4);backdrop-filter:blur(2px);">
        <div style="background:#fff;border-radius:24px;box-shadow:0 25px 50px rgba(0,0,0,0.25);width:100%;max-width:32rem;max-height:90vh;overflow:auto;">
          <div id="addModalHeader" style="padding:20px 24px;border-radius:24px 24px 0 0;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;">
            <div>
              <h3 style="color:#fff;font-size:1.25rem;font-weight:700;margin:0;" id="addModalTitle">➕ إضافة مركبة</h3>
              <p style="color:rgba(255,255,255,0.8);font-size:0.8125rem;margin:4px 0 0;">أدخل البيانات ثم اضغط حفظ</p>
            </div>
            <button type="button" data-action="close-add-modal" style="background:rgba(255,255,255,0.2);border:none;border-radius:8px;color:#fff;padding:6px 10px;cursor:pointer;font-size:1.125rem;">✕</button>
          </div>
          <div style="padding:20px 24px;">
            <div class="table-wrapper mb-4">
              <table class="table"><thead><tr><th>رقم المركبة</th><th>حذف</th></tr></thead>
              <tbody id="addModalRows">
                <tr><td><input type="text" class="input input-sm add-m-vehicle-number" placeholder="رقم المركبة"></td><td><button type="button" data-action="add-modal-remove-row" class="btn-icon" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button></td></tr>
              </tbody></table>
            </div>
            <div class="flex gap-2">
              <button type="button" data-action="add-modal-add-row" class="btn btn-secondary btn-sm">➕ صف</button>
              <button type="button" data-action="save-add-modal" class="btn btn-primary btn-sm" style="margin-right:auto;">💾 حفظ</button>
            </div>
            <div id="addModalMsg" class="field-msg-inline field-msg-inline--error mt-3" role="alert" aria-live="polite"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div.firstElementChild);
    modal = document.getElementById('ownerAddModal');
  }

  const header = document.getElementById('addModalHeader');
  if (header) header.style.background = 'linear-gradient(135deg,#2563eb,#1d4ed8)';
  const titleEl = document.getElementById('addModalTitle');
  if (titleEl) titleEl.textContent = '➕ إضافة مركبة';

  const tbody = document.getElementById('addModalRows');
  if (tbody) tbody.innerHTML = '<tr><td><input type="text" class="input input-sm add-m-vehicle-number" placeholder="رقم المركبة"></td><td><button type="button" data-action="add-modal-remove-row" class="btn-icon" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button></td></tr>';

  const msg = document.getElementById('addModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal?.classList.remove('hidden');
}

async function _saveFromAddModal() {
  const msg = document.getElementById('addModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }

  if (_editingAccountId) {
    const numberVal = (document.querySelector('#addModalRows .add-m-vehicle-number')?.value || '').trim();
    if (!numberVal) { if (msg) { msg.textContent = '❌ رقم المركبة مطلوب'; msg.classList.add('is-visible'); } return; }
    try {
      await OwnersModule.updateOwner(_currentUsername(), _editingAccountId, {
        vehicle_number: numberVal,
      });
      window.dispatchEvent(new CustomEvent('owners:changed'));
    } catch (err) { if (msg) { msg.textContent = err.message; msg.classList.add('is-visible'); } return; }
    _editingAccountId = null;
    _editingAccountKind = null;
    document.getElementById('ownerAddModal')?.classList.add('hidden');
    await loadOwners();
    return;
  }

  const rows = [...document.querySelectorAll('#addModalRows tr')];
  const entries = rows
    .map(tr => (tr.querySelector('.add-m-vehicle-number')?.value || '').trim())
    .filter(Boolean);

  if (entries.length === 0) {
    if (msg) { msg.textContent = '❌ أدخل مركبة واحدة على الأقل'; msg.classList.add('is-visible'); }
    return;
  }

  const username = _currentUsername();
  for (const entry of entries) {
    try {
      await OwnersModule.addAccount(username, 'owner', {
        vehicle_number: entry,
      });
    } catch (err) {
      if (msg) { msg.textContent = err.message || '❌ حدث خطأ'; msg.classList.add('is-visible'); }
      return;
    }
  }

  document.getElementById('ownerAddModal')?.classList.add('hidden');
  await loadOwners();
}




function _printEntities(mode) {
  let rows = [];
  const ownerRows = document.querySelectorAll('#ownersTableBody tr');
  ownerRows.forEach(tr => {
    if (tr.style.display === 'none') return;
    const cells = tr.querySelectorAll('td');
    if (cells.length < 1) return;
    const number = (cells[0]?.textContent || '').trim();
    rows.push({ number });
  });

  if (rows.length === 0) {
    alert('لا توجد بيانات للطباعة');
    return;
  }

  const tableRows = rows.map(r => `
    <tr>
      <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:center;">${r.number}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <title>طباعة إدارة المركبات</title>
  <style>
    @import url('cairo-font.css');
    body { font-family: 'Cairo', Arial, sans-serif; direction: rtl; margin: 0; padding: 20px; }
    h2 { text-align: center; color: #1f2937; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #1e3a8a; color: #fff; padding: 10px 12px; text-align: center; border: 1px solid #1e3a8a; font-size: 0.875rem; }
    td { font-size: 0.875rem; }
    @page { size: A4 portrait; margin: 15mm; }
  </style>
</head>
<body>
  <h2>إدارة المركبات</h2>
  <table>
    <thead>
      <tr>
        <th>رقم المركبة</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`;

  printHTML(html);
}


async function _getKartaCount(clientId) {
  // Normalized read path: persisted receipts never embed rows.
  // Headers come from the client-scoped read-repository query; rows are
  // loaded per receipt via ReceiptReadRepository. DB.findByFields excludes
  // soft-deleted records by default (deleted guard is therefore implicit).
  const clientReceipts = await ReceiptReadRepository.getReceiptsByClient(clientId);
  const rowLists = await Promise.all(
    (clientReceipts || []).map(r => ReceiptReadRepository.getReceiptRowsByReceipt(r.id))
  );
  // NOTE: the frozen ReceiptRow contract persists data rows only (no
  // separators), so each persisted row counts as one karta; the row_type
  // guard is forward-compatible if separators ever become persisted.
  return rowLists.reduce(
    (sum, rows) => sum + (rows || []).filter(row => row && row.row_type !== 'separator').length,
    0
  );
}

async function _getVehicleOwnerListFinancials(owner) {
  const plate = String(owner?.vehicle_number || '').trim();
  if (!plate) return { vehicle_id: null, balance: 0 };
  const candidates = await ClientRepository.getVehiclesByPlate(plate);
  const vehicle = (candidates || []).find(v => String(v.owner_id || '') === String(owner.id)) || null;
  if (!vehicle) return { vehicle_id: null, balance: 0 };
  return {
    vehicle_id: String(vehicle.id),
    balance: (await FinancialService.rebuildVehicleBalance(vehicle.id)).balance,
  };
}

function _buildClientRow(client, kartaCount, balance, kind, vehicleId = null) {
  const vNumber = client.vehicle_number || '';
  return `
    <tr data-client-number="${(vNumber || '').toLowerCase()}">
      <td data-action="view-client" data-id="${client.id}" data-type="owner" data-vehicle-id="${vehicleId || ''}" class="ent-name-cell ent-name-cell--blue">
        ${vNumber || '—'}
      </td>
      <td class="text-center">${kartaCount > 0 ? '<span class="ent-karta-badge">' + kartaCount + '</span>' : '—'}</td>
      <td class="${_balanceClass(balance)} text-center">${_fmt(balance)}</td>
      <td>
        <button type="button" data-action="edit-account" data-id="${client.id}" data-kind="owner" class="ent-action-btn ent-action-btn--edit" title="تعديل">✏️</button>
        <button type="button" data-action="delete-account" data-id="${client.id}" data-kind="owner" class="ent-action-btn ent-action-btn--delete" title="حذف">🗑️</button>
      </td>
    </tr>`;
}


async function loadOwners() {
  _renderShell();

  const isVehicles = _ownersActiveSubTab === 'vehicles';

  const vehiclesSection = document.getElementById('vehiclesSection');
  const driversSection = document.getElementById('driversSection');
  const vehiclesHeaderActions = document.getElementById('vehiclesHeaderActions');
  const driversHeaderActions = document.getElementById('driversHeaderActions');
  const tabBtnVehicles = document.getElementById('tabBtnVehicles');
  const tabBtnDrivers = document.getElementById('tabBtnDrivers');
  const searchInput = document.getElementById('ownerSearchInput');

  if (vehiclesSection) vehiclesSection.classList.toggle('hidden', !isVehicles);
  if (driversSection) driversSection.classList.toggle('hidden', isVehicles);
  if (vehiclesHeaderActions) vehiclesHeaderActions.classList.toggle('hidden', !isVehicles);
  if (driversHeaderActions) driversHeaderActions.classList.toggle('hidden', isVehicles);

  if (tabBtnVehicles) {
    tabBtnVehicles.style.background = isVehicles ? '#2563eb' : '#f3f4f6';
    tabBtnVehicles.style.color = isVehicles ? '#fff' : '#4b5563';
  }
  if (tabBtnDrivers) {
    tabBtnDrivers.style.background = !isVehicles ? '#2563eb' : '#f3f4f6';
    tabBtnDrivers.style.color = !isVehicles ? '#fff' : '#4b5563';
  }
  if (searchInput) {
    searchInput.placeholder = isVehicles ? '🔍 ابحث عن رقم المركبة...' : '🔍 ابحث عن اسم أو رقم هاتف السائق...';
  }

  const tbodyId = isVehicles ? 'ownersTableBody' : 'driversTableBody';
  const ownersTbody = document.getElementById(tbodyId);
  if (!ownersTbody) return;

  if (isVehicles) {
    const owners = await ClientRepository.getAllOwners();
    const ownerList = owners.filter(o => o.deleted_at === null && (o.vehicle_number || o.name)).map(o => ({
      id: String(o.id),
      type: 'owner',
      name: o.vehicle_number || o.name || '',
      vehicle_number: o.vehicle_number || '',
      updated_at: o.updated_at ?? o.created_at ?? 0,
    }));
    const ownerStats = await Promise.all(ownerList.map(async (owner) => ({
      kartaCount: await _getKartaCount(owner.id),
      ...(await _getVehicleOwnerListFinancials(owner)),
    })));
    const sortedOwners = [...ownerList].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

    if (sortedOwners.length === 0) {
      ownersTbody.innerHTML = '<tr><td colspan="4" class="text-muted text-center p-6">لا توجد بيانات</td></tr>';
    } else {
      ownersTbody.innerHTML = sortedOwners.map((client) => {
        const idx = ownerList.indexOf(client);
        const stats = ownerStats[idx];
        return _buildClientRow(client, stats.kartaCount, stats.balance, 'owner', stats.vehicle_id);
      }).join('');
    }
  } else {
    const username = _currentUsername();
    const drivers = (await ClientRepository.getDrivers(username)).filter(d => d.deleted_at === null);
    
    const driverSnaps = await Promise.all(drivers.map(async (d) => {
      const bal = await FinancialService.getDriverBalance(d.id);
      return {
        ...d,
        balance: bal.balance,
      };
    }));

    if (driverSnaps.length === 0) {
      ownersTbody.innerHTML = '<tr><td colspan="4" class="text-muted text-center p-6">لا توجد بيانات سائقين</td></tr>';
    } else {
      ownersTbody.innerHTML = driverSnaps.map(d => `
        <tr data-driver-name="${(d.name || '').toLowerCase()}" data-driver-phone="${(d.phone || '').toLowerCase()}">
          <td data-action="view-driver" data-id="${d.id}" class="ent-name-cell ent-name-cell--blue" style="cursor:pointer;">
            ${d.name || '—'}
          </td>
          <td>${d.phone || '—'}</td>
          <td class="${_balanceClass(d.balance)}">${_fmt(d.balance)}</td>
          <td>
            <button type="button" data-action="edit-driver" data-id="${d.id}" class="ent-action-btn ent-action-btn--edit" title="تعديل">✏️</button>
            <button type="button" data-action="delete-driver" data-id="${d.id}" class="ent-action-btn ent-action-btn--delete" title="حذف">🗑️</button>
          </td>
        </tr>
      `).join('');
    }
  }

  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = '1';
    searchInput.addEventListener('input', () => {
      const q = (searchInput.value || '').trim().toLowerCase();
      if (_ownersActiveSubTab === 'vehicles') {
        document.querySelectorAll('#ownersTableBody tr').forEach(tr => {
          const number = tr.getAttribute('data-client-number') || '';
          tr.style.display = (!q || number.includes(q)) ? '' : 'none';
        });
      } else {
        document.querySelectorAll('#driversTableBody tr').forEach(tr => {
          const name = tr.getAttribute('data-driver-name') || '';
          const phone = tr.getAttribute('data-driver-phone') || '';
          tr.style.display = (!q || name.includes(q) || phone.includes(q)) ? '' : 'none';
        });
      }
    });
  }
}

let _editingDriverBalanceReferenceId = null;
let _editingDriverBalanceEntryType = 'deposit';

function _manualDriverEntryLabel(entryType) {
  return entryType === 'withdraw' ? 'سحب من رصيد السائق' : 'إيداع رصيد للسائق';
}

async function _openDriverBalanceEntryModal(entryType, txEntry = null) {
  const normalizedType = entryType === 'withdraw' ? 'withdraw' : 'deposit';
  _editingDriverBalanceReferenceId = txEntry ? txEntry.reference_id : null;
  _editingDriverBalanceEntryType = txEntry?.type === 'withdraw' ? 'withdraw' : normalizedType;

  const modal = document.getElementById('driverBalanceEntryModal');
  const titleEl = document.getElementById('driverBalanceEntryModalTitle');
  const amountEl = document.getElementById('driverBalanceEntryAmount');
  const dateEl = document.getElementById('driverBalanceEntryDate');
  const noteEl = document.getElementById('driverBalanceEntryNote');
  const msgEl = document.getElementById('driverBalanceEntryMsg');

  if (titleEl) titleEl.textContent = `💰 ${_manualDriverEntryLabel(_editingDriverBalanceEntryType)}`;
  if (msgEl) { msgEl.textContent = ''; msgEl.classList.remove('is-visible'); }
  if (dateEl) dateEl.value = txEntry?.date || DateUtils.todayLocal();
  if (amountEl) amountEl.value = txEntry ? Math.abs(Number(txEntry.amount) || 0) : '';
  if (noteEl) noteEl.value = txEntry?.note || '';

  modal?.classList.remove('hidden');
}

function _closeDriverBalanceEntryModal() {
  document.getElementById('driverBalanceEntryModal')?.classList.add('hidden');
  _editingDriverBalanceReferenceId = null;
  _editingDriverBalanceEntryType = 'deposit';
}

async function _saveDriverBalanceEntry() {
  const msgEl = document.getElementById('driverBalanceEntryMsg');
  const amount = Number(document.getElementById('driverBalanceEntryAmount')?.value);
  const date = document.getElementById('driverBalanceEntryDate')?.value;
  const note = document.getElementById('driverBalanceEntryNote')?.value || '';

  if (!Number.isFinite(amount) || amount <= 0) {
    if (msgEl) { msgEl.textContent = '❌ المبلغ يجب أن يكون أكبر من صفر'; msgEl.classList.add('is-visible'); }
    return;
  }
  if (!date) {
    if (msgEl) { msgEl.textContent = '❌ التاريخ مطلوب'; msgEl.classList.add('is-visible'); }
    return;
  }

  const driverId = _getCurrentDriverId();
  if (!driverId) {
    if (msgEl) { msgEl.textContent = '❌ السائق مطلوب'; msgEl.classList.add('is-visible'); }
    return;
  }

  const username = _currentUsername();
  const data = {
    driver_id: driverId,
    entry_type: _editingDriverBalanceEntryType,
    amount,
    date,
    note,
  };

  try {
    if (_editingDriverBalanceReferenceId) {
      await FinancialService.updateManualDriverBalanceEntry(username, _editingDriverBalanceReferenceId, data);
    } else {
      await FinancialService.createManualDriverBalanceEntry(username, data);
    }

    _closeDriverBalanceEntryModal();
    await showDriverDetails(driverId);
  } catch (err) {
    if (msgEl) { msgEl.textContent = err.message || `❌ فشل حفظ ${_manualDriverEntryLabel(_editingDriverBalanceEntryType)}`; msgEl.classList.add('is-visible'); }
  }
}

let _driverLedgerCache = [];

// ── Phase 6: Driver Details tab separation (UI only) ─────────────────────────
// kartas    → Receipts/Kartas panel (driverTabKartas)
// ledger    → Financial Transactions panel (driverTabLedger)
// Pure visual switch: both datasets are already loaded by showDriverDetails;
// nothing is re-fetched or recalculated here.
let _driverDetailsTab = 'kartas';

function _setDriverDetailsTab(tab) {
  _driverDetailsTab = tab === 'ledger' ? 'ledger' : 'kartas';
  const kartasPanel = document.getElementById('driverTabKartas');
  const ledgerPanel = document.getElementById('driverTabLedger');
  const kartasBtn = document.getElementById('driverTabBtnKartas');
  const ledgerBtn = document.getElementById('driverTabBtnLedger');
  const isKartas = _driverDetailsTab === 'kartas';
  if (kartasPanel) kartasPanel.classList.toggle('hidden', !isKartas);
  if (ledgerPanel) ledgerPanel.classList.toggle('hidden', isKartas);
  if (kartasBtn) { kartasBtn.classList.toggle('active-purple', isKartas); kartasBtn.setAttribute('aria-selected', String(isKartas)); }
  if (ledgerBtn) { ledgerBtn.classList.toggle('active-purple', !isKartas); ledgerBtn.setAttribute('aria-selected', String(!isKartas)); }
}

function _renderDriverLedgerTable(entries) {
  const tbody = document.getElementById('driverTransactionsBody');
  if (!tbody) return;

  if (!Array.isArray(entries) || entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted text-center p-6">لا توجد حركات</td></tr>';
    return;
  }

  tbody.innerHTML = entries.map((entry) => {
    const dateStr = _dateLabel(entry.date || entry.applied_at || entry.created_at);
    const typeStr = entry.reference_type === 'manual_driver_balance'
      ? (entry.type === 'withdraw' ? 'سحب' : 'إيداع')
      : _ledgerType(entry.type);
    const refStr = entry.vehicle_plate || entry.reference_number || entry.reference_id || '—';
    const amtStr = _fmt(entry.amount);
    const balStr = _fmt(entry.running_balance);
    const descStr = _ledgerNote(entry);

    const isManualDriverMovement = entry.reference_type === 'manual_driver_balance'
      && entry.effect === 'manual_driver_balance';
    const canEdit = entry.reference_id && isManualDriverMovement;
    const canDelete = canEdit;
    const actionsStr = canDelete ? `
      <div class="flex gap-1 justify-center">
        ${canEdit ? `<button type="button" data-action="edit-driver-tx" data-ref-id="${entry.reference_id}" class="btn-icon" title="تعديل" style="background:#dbeafe;color:#2563eb;width:24px;height:24px;border:none;border-radius:4px;cursor:pointer;">✏️</button>` : ''}
        <button type="button" data-action="delete-driver-tx" data-ref-id="${entry.reference_id}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:24px;height:24px;border:none;border-radius:4px;cursor:pointer;">🗑️</button>
      </div>
    ` : '—';

    return `
      <tr>
        <td>${dateStr}</td>
        <td>${typeStr}</td>
        <td>${refStr}</td>
        <td class="font-semibold">${amtStr}</td>
        <td>${balStr}</td>
        <td>${descStr}</td>
        <td class="text-center">${actionsStr}</td>
      </tr>
    `;
  }).join('');
}

async function showDriverDetails(id) {
  const driver = await ClientRepository.getDriverById(String(id));
  if (!driver || driver.deleted_at !== null) return;
  

  sessionStorage.setItem(LAST_PAGE_CTX_KEY, JSON.stringify({
    page: 'driverDetailsPage',
    driverId: String(id),
  }));

  const balanceData = await FinancialService.getDriverBalance(id);
  const ledger = await FinancialService.getDriverLedger(id);
  _driverLedgerCache = ledger || [];

  _renderDriverLedgerTable(_driverLedgerCache);

  const fromEl = document.getElementById('driverFromDate');
  const toEl = document.getElementById('driverToDate');
  const searchEl = document.getElementById('driverSearchQuery');

  if (fromEl && !fromEl.dataset.bound) {
    fromEl.dataset.bound = '1';
    fromEl.addEventListener('change', _applyDriverFilters);
  }
  if (toEl && !toEl.dataset.bound) {
    toEl.dataset.bound = '1';
    toEl.addEventListener('change', _applyDriverFilters);
  }
  if (searchEl && !searchEl.dataset.bound) {
    searchEl.dataset.bound = '1';
    searchEl.addEventListener('input', _applyDriverFilters);
  }

  if (typeof window.showPage === 'function') {
    await window.showPage('driverDetailsPage');
  }

  // Apply the active tab view (Phase 6) — preserved across re-entry and
  // post-mutation refreshes (manual driver movement, Karta settlement, transaction delete).
  _setDriverDetailsTab(_driverDetailsTab);

  // Load Kartas tab (Phase 7A)
  await _loadDriverKartasTab(id);
}

function _applyDriverFilters() {
  const fromVal = document.getElementById('driverFromDate')?.value || '';
  const toVal = document.getElementById('driverToDate')?.value || '';
  const query = (document.getElementById('driverSearchQuery')?.value || '').trim().toLowerCase();

  let filtered = _driverLedgerCache.slice();

  if (fromVal) {
    const fromTs = new Date(fromVal).getTime();
    filtered = filtered.filter(e => new Date(e.date || e.applied_at || e.created_at || 0).getTime() >= fromTs);
  }
  if (toVal) {
    const toTs = new Date(toVal).getTime() + 24 * 60 * 60 * 1000 - 1;
    filtered = filtered.filter(e => new Date(e.date || e.applied_at || e.created_at || 0).getTime() <= toTs);
  }
  if (query) {
    filtered = filtered.filter(e => {
      const hay = [
        e.date, e.applied_at, e.type, e.vehicle_plate, e.reference_number, e.reference_id, e.note, _ledgerNote(e)
      ].join(' ').toLowerCase();
      return hay.includes(query);
    });
  }

  _renderDriverLedgerTable(filtered);
}

function _handleViewDriver(id) {
  showDriverDetails(id);
}

// ─── Phase 7A: Driver Kartas Tab (UI only) ────────────────────────────────

async function _loadDriverKartasTab(driverId) {
  if (!driverId) return;

  const summaryContainer = document.getElementById('kartaSummaryCards');
  const tbody = document.getElementById('kartaTableBody');
  const searchInput = document.getElementById('kartaSearchInput');
  if (!summaryContainer || !tbody) return;

  try {
    const [kartas, summary] = await Promise.all([
      FinancialService.getDriverKartas(driverId),
      FinancialService.getDriverKartasSummary(driverId),
    ]);
    _currentKartas = kartas;

    summaryContainer.innerHTML = `
      <div class="card p-4"><div class="text-xs text-muted">إجمالي الكارتات</div><div class="text-2xl font-bold">${summary.total_kartas}</div></div>
      <div class="card p-4"><div class="text-xs text-muted">لم يتم تسويته</div><div class="text-2xl font-bold text-red-600">${summary.unsettled_kartas}</div></div>
      <div class="card p-4"><div class="text-xs text-muted">تمت تسويته</div><div class="text-2xl font-bold text-green-600">${summary.settled_kartas}</div></div>
      <div class="card p-4"><div class="text-xs text-muted">إجمالي السعر</div><div id="kartaFilteredTotalPrice" class="text-xl font-bold">${_fmt(summary.total_price)}</div></div>
    `;

    _applyKartaFilters(tbody, driverId);
    if (searchInput && !searchInput.dataset.bound) {
      searchInput.dataset.bound = '1';
      searchInput.addEventListener('input', () => _applyKartaFilters(tbody, _getCurrentDriverId()));
    }
  } catch (err) {
    console.error('[entities] Failed to load kartas tab', err);
    tbody.innerHTML = '<tr><td colspan="8" class="text-red-600 text-center p-6">فشل تحميل الكارتات</td></tr>';
  }
}

let _currentKartas = [];
let _kartaStatusFilter = 'unsettled'; // Required default: لم يتم تسويته.
let _editingKartaSettlementPriceRowId = null;

function _syncKartaFilterButtons() {
  document.querySelectorAll('[data-action="karta-status-filter"]').forEach(btn => {
    const active = btn.dataset.filter === _kartaStatusFilter;
    btn.classList.toggle('active-purple', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function _syncKartaTableColumns() {
  const actionsHeader = document.getElementById('kartaActionsHeader');
  if (actionsHeader) actionsHeader.classList.toggle('hidden', _kartaStatusFilter !== 'settled');
}

function _eligibleUnsettledKartasForBatch() {
  return _currentKartas.filter(karta => {
    if (karta.status !== 'unsettled') return false;
    const decimal = Number(karta.driver_settlement_price);
    return Number.isFinite(decimal) && Money.toCents(decimal) > 0;
  });
}

function _syncKartaBatchSettlementButton() {
  const button = document.getElementById('settleUnsettledKartasBtn');
  if (!button) return;
  const eligible = _eligibleUnsettledKartasForBatch();
  const visible = _kartaStatusFilter === 'unsettled' && eligible.length > 0;
  button.classList.toggle('hidden', !visible);
  button.textContent = `تسوية عام (${eligible.length})`;
}

async function _settleUnsettledKartasBatch() {
  const driverId = _getCurrentDriverId();
  const eligible = _eligibleUnsettledKartasForBatch();
  if (!driverId || eligible.length === 0) return;

  const totalCents = eligible.reduce(
    (sum, karta) => sum + Money.toCents(karta.driver_settlement_price),
    0
  );
  const affectedVehicles = new Set(eligible.map(karta => String(karta.vehicle_id || ''))).size;
  const confirmed = confirm(
    `عدد الكارتات: ${eligible.length}\n`
    + `إجمالي التسوية: ${_fmt(Money.toDecimal(totalCents))}\n`
    + `السيارات المتأثرة: ${affectedVehicles}\n\n`
    + 'هل تريد تنفيذ التسوية؟'
  );
  if (!confirmed) return;

  try {
    const result = await FinancialService.createKartaSettlementBatch(
      _currentUsername(),
      driverId,
      eligible.map(karta => karta.row_id)
    );
    if (result.settled_count > 0) {
      alert(`✅ تمت تسوية ${result.settled_count} كارتة بإجمالي ${_fmt(result.total)}`);
    } else {
      alert('لا توجد كارتات مؤهلة للتسوية.');
    }
  } catch (err) {
    alert(err.message || '❌ فشل تنفيذ التسوية العامة');
  } finally {
    // Always re-query the authoritative state after either commit or failure.
    await _loadDriverKartasTab(driverId);
  }
}

function _sumKartaPrices(kartas) {
  const cents = (kartas || []).reduce(
    (sum, karta) => sum + Money.toCents(karta?.driver_settlement_price ?? 0),
    0
  );
  return Money.toDecimal(cents);
}

function _renderFilteredKartaPriceTotal(kartas) {
  const totalEl = document.getElementById('kartaFilteredTotalPrice');
  if (totalEl) totalEl.textContent = _fmt(_sumKartaPrices(kartas));
}

function _kartaStatusLabel(status) {
  return status === 'settled' ? 'تمت تسويته' : 'لم يتم تسويته';
}

/**
 * Driver Details Karta filtering is an in-memory view of the active driver's
 * persisted rows. Settlement status itself is provided by FinancialService
 * from active driver_karta_payment ledger records.
 */
function _applyKartaFilters(tbody, driverId) {
  const target = tbody || document.getElementById('kartaTableBody');
  if (!target) return;

  const query = (document.getElementById('kartaSearchInput')?.value || '').trim().toLowerCase();
  const filtered = _currentKartas.filter(karta => {
    if (_kartaStatusFilter !== 'all' && karta.status !== _kartaStatusFilter) return false;
    if (query && !Object.values(karta).some(value => String(value ?? '').toLowerCase().includes(query))) return false;
    return true;
  });

  _renderKartaTable(filtered, target, driverId);
  _renderFilteredKartaPriceTotal(filtered);
  _syncKartaFilterButtons();
  _syncKartaTableColumns();
  _syncKartaBatchSettlementButton();
}

async function _saveInlineKartaSettlementPrice(input) {
  const rowId = String(input?.dataset.rowId || '').trim();
  if (!rowId) return;

  input.disabled = true;
  try {
    await FinancialService.updateDriverKartaSettlementPrice(_currentUsername(), rowId, input.value);
    const driverId = _getCurrentDriverId();
    if (driverId) await _loadDriverKartasTab(driverId);
  } catch (err) {
    alert(err.message || '❌ فشل حفظ السعر');
    input.disabled = false;
  }
}

function _bindUnsettledKartaPriceInputs(tbody) {
  tbody.querySelectorAll('[data-action="save-inline-karta-settlement-price"]').forEach(input => {
    input.addEventListener('change', () => _saveInlineKartaSettlementPrice(input));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
    });
  });
}

function _renderKartaTable(kartas, tbody) {
  const colspan = _kartaStatusFilter === 'settled' ? 9 : 8;
  if (!Array.isArray(kartas) || kartas.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="text-muted text-center p-6">لا توجد كارتات</td></tr>`;
    return;
  }

  tbody.innerHTML = kartas.map(karta => {
    const persistedPrice = karta.driver_settlement_price;
    const displayPrice = persistedPrice === null || persistedPrice === undefined ? '—' : _fmt(persistedPrice);
    const statusClass = karta.status === 'settled' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700';
    const priceCell = _kartaStatusFilter === 'unsettled'
      ? `<input type="number" step="0.01" min="0" inputmode="decimal" class="input input-sm" style="min-width:100px;" data-action="save-inline-karta-settlement-price" data-row-id="${karta.row_id}" value="${persistedPrice ?? ''}" placeholder="اختياري" aria-label="سعر تسوية الكارتة">`
      : `<span class="font-semibold">${displayPrice}</span>`;
    const actionsCell = _kartaStatusFilter === 'settled'
      ? `<td class="text-center"><button type="button" data-action="edit-karta-settlement-price" data-row-id="${karta.row_id}" class="btn btn-primary btn-sm">تعديل السعر</button></td>`
      : '';

    return `
      <tr data-row-id="${karta.row_id}">
        <td>${_dateLabel(karta.date)}</td>
        <td>${karta.vehicle_plate || '—'}</td>
        <td>${karta.company || '—'}</td>
        <td>${karta.loading || '—'}</td>
        <td>${karta.destination || '—'}</td>
        <td>${_fmt(karta.advance)}</td>
        <td>${priceCell}</td>
        <td><span class="px-2 py-0.5 rounded text-xs font-medium ${statusClass}">${_kartaStatusLabel(karta.status)}</span></td>
        ${actionsCell}
      </tr>
    `;
  }).join('');

  if (_kartaStatusFilter === 'unsettled') _bindUnsettledKartaPriceInputs(tbody);
}

function _openKartaSettlementPriceModal(rowId) {
  const karta = _currentKartas.find(item => String(item.row_id) === String(rowId));
  if (!karta || karta.status !== 'settled') return;

  _editingKartaSettlementPriceRowId = String(rowId);
  const modal = document.getElementById('kartaSettlementPriceModal');
  const priceEl = document.getElementById('kartaSettlementPriceInput');
  const msgEl = document.getElementById('kartaSettlementPriceMsg');
  if (priceEl) priceEl.value = karta.driver_settlement_price ?? '';
  if (msgEl) { msgEl.textContent = ''; msgEl.classList.remove('is-visible'); }
  modal?.classList.remove('hidden');
}

function _closeKartaSettlementPriceModal() {
  document.getElementById('kartaSettlementPriceModal')?.classList.add('hidden');
  _editingKartaSettlementPriceRowId = null;
}

async function _saveKartaSettlementPriceModal() {
  if (!_editingKartaSettlementPriceRowId) return;

  const priceEl = document.getElementById('kartaSettlementPriceInput');
  const msgEl = document.getElementById('kartaSettlementPriceMsg');
  try {
    await FinancialService.updateDriverKartaSettlementPrice(
      _currentUsername(),
      _editingKartaSettlementPriceRowId,
      priceEl?.value ?? ''
    );
    _closeKartaSettlementPriceModal();
    const driverId = _getCurrentDriverId();
    if (driverId) await _loadDriverKartasTab(driverId);
  } catch (err) {
    if (msgEl) {
      msgEl.textContent = err.message || '❌ فشل حفظ السعر';
      msgEl.classList.add('is-visible');
    }
  }
}

function _openDriverModal(driver = null) {
  _editingDriverId = driver ? driver.id : null;
  _editingDriverPreviousName = driver?.name || '';
  let modal = document.getElementById('driverModal');
  if (!modal) {
    const div = document.createElement('div');
    div.innerHTML = `
      <div id="driverModal" class="hidden fixed inset-0 flex items-center justify-center z-50 p-4" style="background:rgba(0,0,0,0.4);backdrop-filter:blur(2px);">
        <div style="background:#fff;border-radius:24px;box-shadow:0 25px 50px rgba(0,0,0,0.25);width:100%;max-width:30rem;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#2563eb,#1d4ed8);padding:20px 24px;display:flex;align-items:center;justify-content:space-between;">
            <div>
              <h3 style="color:#fff;font-size:1.25rem;font-weight:700;margin:0;" id="driverModalTitle">➕ إضافة سائق</h3>
              <p style="color:rgba(255,255,255,0.8);font-size:0.8125rem;margin:4px 0 0;">أدخل بيانات السائق</p>
            </div>
            <button type="button" data-action="close-driver-modal" style="background:rgba(255,255,255,0.2);border:none;border-radius:8px;color:#fff;padding:6px 10px;cursor:pointer;font-size:1.125rem;">✕</button>
          </div>
          <div style="padding:24px;">
            <div class="grid gap-4">
              <div>
                <label class="label mb-1" for="driverModalName">اسم السائق <span class="text-red-500">*</span></label>
                <input id="driverModalName" type="text" class="input input-sm" placeholder="أدخل اسم السائق">
              </div>
              <div>
                <label class="label mb-1" for="driverModalPhone">رقم الهاتف (اختياري)</label>
                <input id="driverModalPhone" type="text" class="input input-sm" placeholder="أدخل رقم الهاتف">
              </div>
            </div>
            <div class="flex gap-2 mt-6 justify-end">
              <button type="button" data-action="close-driver-modal" class="btn btn-secondary btn-sm">إلغاء</button>
              <button type="button" data-action="save-driver-modal" class="btn btn-primary btn-sm">💾 حفظ</button>
            </div>
            <div id="driverModalMsg" class="field-msg-inline field-msg-inline--error mt-3" role="alert"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div.firstElementChild);
    modal = document.getElementById('driverModal');
  }

  const titleEl = document.getElementById('driverModalTitle');
  const nameEl = document.getElementById('driverModalName');
  const phoneEl = document.getElementById('driverModalPhone');
  const msgEl = document.getElementById('driverModalMsg');

  if (titleEl) titleEl.textContent = driver ? '✏️ تعديل سائق' : '➕ إضافة سائق';
  if (nameEl) nameEl.value = driver?.name || '';
  if (phoneEl) phoneEl.value = driver?.phone || '';
  if (msgEl) { msgEl.textContent = ''; msgEl.classList.remove('is-visible'); }

  modal?.classList.remove('hidden');
}

async function _saveDriver() {
  const nameEl = document.getElementById('driverModalName');
  const phoneEl = document.getElementById('driverModalPhone');
  const msgEl = document.getElementById('driverModalMsg');

  const name = (nameEl?.value || '').trim();
  const phone = (phoneEl?.value || '').trim();

  if (!name) {
    if (msgEl) { msgEl.textContent = '❌ اسم السائق مطلوب'; msgEl.classList.add('is-visible'); }
    return;
  }

  const username = _currentUsername();
  try {
    const savedDriver = _editingDriverId
      ? await ClientRepository.updateDriver(_editingDriverId, {
        name,
        phone: phone || null,
      }, { username })
      : await ClientRepository.saveDriver({
        username,
        name,
        phone: phone || null,
      }, { username });

    // Narrow post-persistence notification: receipt autocomplete owns the
    // in-place cache refresh; FinancialService and page navigation stay out of it.
    window.dispatchEvent(new CustomEvent('drivers:changed', {
      detail: {
        driverId: String(savedDriver.id),
        driverName: savedDriver.name || name,
        previousName: _editingDriverPreviousName,
      },
    }));
    document.getElementById('driverModal')?.classList.add('hidden');
    await loadOwners();
  } catch (err) {
    if (msgEl) { msgEl.textContent = err.message || '❌ فشل الحفظ'; msgEl.classList.add('is-visible'); }
  }
}


async function _getClient(type, id) {
  return OwnersModule.getClientByType(type, id);
}

/**
 * Vehicle Details uses one selected vehicle only. The surrounding owner record
 * remains available solely for the separate «المركبات» management tab.
 */
async function _getVehicleDetailsFinancials(vehicleId) {
  const [balance, rawLedger] = await Promise.all([
    FinancialService.rebuildVehicleBalance(vehicleId),
    FinancialService.getVehicleLedger(vehicleId),
  ]);
  const ledger = await _resolveVehicleLedgerPresentation(rawLedger);
  return {
    balance: balance.balance,
    ledger,
  };
}

function _readRestoredVehicleId(ownerId) {
  try {
    const raw = sessionStorage.getItem(LAST_PAGE_CTX_KEY);
    const context = raw ? JSON.parse(raw) : null;
    if (context?.page === 'ownerDetailsPage'
      && String(context.ownerId || '') === String(ownerId || '')
      && context.vehicleId) {
      return String(context.vehicleId);
    }
  } catch (_) {}
  return null;
}

async function _resolveDetailVehicle(owner, preferredVehicleId = null) {
  const ownerId = String(owner?.id || '').trim();
  if (!ownerId) return null;

  const preferredId = String(preferredVehicleId || _readRestoredVehicleId(ownerId) || '').trim();
  if (preferredId) {
    const preferred = await ClientRepository.getVehicleById(preferredId);
    if (preferred && preferred.deleted_at === null && String(preferred.owner_id || '') === ownerId) {
      return preferred;
    }
  }

  // Vehicle Management rows identify the specific vehicle by the owner's
  // vehicle number. Some current development records have not reached receipt
  // creation yet, so their physical vehicles-store record does not exist. Use
  // the existing canonical resolver to materialize that exact selected vehicle
  // rather than silently falling back to another vehicle owned by the same owner.
  const vehicleNumber = String(owner?.vehicle_number || owner?.name || '').trim();
  if (!vehicleNumber) return null;
  return resolveVehicle(_currentUsername(), vehicleNumber, owner);
}

// ── Vehicle Details tabs + structured manual maintenance metadata ────────────
// Maintenance remains a normal `manual_vehicle_balance` withdrawal. These
// fields only classify the existing active vehicle-ledger movement for UI.
const MAINTENANCE_TYPE_SUGGESTIONS = Object.freeze([
  'جاز', 'فلاتر', 'زيت', 'كاوتش', 'ميكانيكي', 'اكسسوارت',
]);
let _vehicleDetailsTab = 'financial';
let _vehicleFinancialEntriesCache = [];
let _vehicleFinancialSearchQuery = '';
let _vehicleFinancialSearchVehicleId = null;
let _maintenanceEntriesCache = [];
let _maintenanceSearchQuery = '';
let _editingMaintenanceReferenceId = null;

function _escapeMaintenanceText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _isActiveMaintenanceEntry(entry) {
  return !!entry
    && entry.reference_type === 'manual_vehicle_balance'
    && entry.effect === 'manual_vehicle_balance'
    && entry.type === 'withdraw'
    && entry.is_reversed === false
    && entry.deleted_at === null
    && String(entry.maintenance_type || '').trim().length > 0;
}

function _setVehicleDetailsTab(tab) {
  _vehicleDetailsTab = ['maintenance', 'monthly'].includes(tab) ? tab : 'financial';
  const financialPanel = document.getElementById('vehicleDetailsTabFinancial');
  const maintenancePanel = document.getElementById('vehicleDetailsTabMaintenance');
  const monthlyPanel = document.getElementById('vehicleDetailsTabMonthly');
  const vehiclesPanel = document.getElementById('vehicleDetailsTabVehicles');
  const financialButton = document.getElementById('vehicleDetailsTabBtnFinancial');
  const maintenanceButton = document.getElementById('vehicleDetailsTabBtnMaintenance');
  const monthlyButton = document.getElementById('vehicleDetailsTabBtnMonthly');
  const isFinancial = _vehicleDetailsTab === 'financial';
  const isMaintenance = _vehicleDetailsTab === 'maintenance';
  const isMonthly = _vehicleDetailsTab === 'monthly';

  if (financialPanel) financialPanel.classList.toggle('hidden', !isFinancial);
  if (maintenancePanel) maintenancePanel.classList.toggle('hidden', !isMaintenance);
  if (monthlyPanel) monthlyPanel.classList.toggle('hidden', !isMonthly);
  // Keep the underlying Vehicles panel intact but hidden from this page's
  // visible tab surface. Vehicle Management itself remains unchanged.
  if (vehiclesPanel) vehiclesPanel.classList.add('hidden');
  if (financialButton) {
    financialButton.classList.toggle('active-purple', isFinancial);
    financialButton.setAttribute('aria-selected', String(isFinancial));
  }
  if (maintenanceButton) {
    maintenanceButton.classList.toggle('active-purple', isMaintenance);
    maintenanceButton.setAttribute('aria-selected', String(isMaintenance));
  }
  if (monthlyButton) {
    monthlyButton.classList.toggle('active-purple', isMonthly);
    monthlyButton.setAttribute('aria-selected', String(isMonthly));
  }
}

const _vehicleMonthlyReportState = {
  vehicleId: null,
  monthKey: '',
  loading: false,
  report: null,
  error: '',
  requestId: 0,
};

function _currentCairoMonthKey() {
  return DateUtils.todayLocal().slice(0, 7);
}

function _ensureVehicleMonthlyReportState(vehicleId) {
  const key = String(vehicleId || '').trim();
  if (_vehicleMonthlyReportState.vehicleId !== key) {
    _vehicleMonthlyReportState.vehicleId = key;
    _vehicleMonthlyReportState.monthKey = _currentCairoMonthKey();
    _vehicleMonthlyReportState.loading = false;
    _vehicleMonthlyReportState.report = null;
    _vehicleMonthlyReportState.error = '';
  }
  if (!_vehicleMonthlyReportState.monthKey) {
    _vehicleMonthlyReportState.monthKey = _currentCairoMonthKey();
  }
}

function _monthlyReportCents(cents) {
  return _fmt(Money.toDecimal(cents));
}

function _monthlyReportCategoryLabel(category, plural = false) {
  const labels = {
    receipt_row_payment: plural ? 'صرف الكارتات' : 'صرف كارتة',
    manual_vehicle_deposit: 'إيداع يدوي',
    karta_settlement: 'تسوية كارتة',
    maintenance: 'صيانة',
    manual_vehicle_withdrawal: 'سحب يدوي',
    other: 'أخرى',
  };
  return labels[category] || 'أخرى';
}

function _monthlyReportTypeLabel(type) {
  return type === 'deposit' ? 'إيداع' : type === 'withdraw' ? 'سحب' : '—';
}

function _monthlyReportReference(movement) {
  const type = String(movement?.referenceType || '').trim();
  const id = String(movement?.referenceId || '').trim();
  if (!type && !id) return '—';
  return `${type || '—'} / ${id || '—'}`;
}

function _monthlyReportMaintenanceDetails(movement) {
  const type = String(movement?.maintenanceType || '').trim();
  if (!type) return '—';
  const quantity = movement?.maintenanceQuantity;
  return quantity === null || quantity === undefined || quantity === ''
    ? type
    : `${type} — العدد: ${quantity}`;
}

function _renderMonthlyReportBreakdown(title, entries, labels) {
  return `
    <section class="vehicle-monthly-report__breakdown">
      <h4>${title}</h4>
      <div class="vehicle-monthly-report__breakdown-list">
        ${Object.entries(entries || {}).map(([key, item]) => `
          <div class="vehicle-monthly-report__breakdown-row">
            <span>${labels[key] || 'أخرى'}</span>
            <span>${Number(item?.count || 0)} عملية</span>
            <strong>${_monthlyReportCents(item?.amountCents || 0)}</strong>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function _renderVehicleMonthlyReportContent(vehicle) {
  const state = _vehicleMonthlyReportState;
  const plate = _escapeMaintenanceText(vehicle?.plate || '—');
  const monthKey = _escapeMaintenanceText(state.monthKey || '');
  const header = `
    <header class="vehicle-monthly-report__header">
      <div>
        <h3>التقرير الشهري</h3>
        <p>المركبة: <bdi>${plate}</bdi></p>
      </div>
      <div class="vehicle-monthly-report__controls">
        <label class="vehicle-monthly-report__month-field" for="vehicleMonthlyReportMonth">
          <span>الشهر</span>
          <input id="vehicleMonthlyReportMonth" type="month" class="input" value="${monthKey}">
        </label>
        <button type="button" data-action="load-vehicle-monthly-report" class="btn vehicle-details-action">عرض التقرير</button>
        <button type="button" data-action="vehicle-monthly-report-current-month" class="btn vehicle-details-secondary-action">الشهر الحالي</button>
      </div>
    </header>
  `;

  if (state.loading) {
    return `${header}<div class="vehicle-monthly-report__state">جاري تحميل التقرير...</div>`;
  }
  if (state.error) {
    return `${header}<div class="vehicle-monthly-report__state vehicle-monthly-report__state--error" role="alert"><strong>تعذر تحميل التقرير الشهري.</strong><span>حاول مرة أخرى.</span></div>`;
  }
  if (!state.report) {
    return `${header}<div class="vehicle-monthly-report__state">اختر الشهر ثم اضغط عرض التقرير.</div>`;
  }

  const report = state.report;
  const integrity = report.integrity || {};
  const future = report.future || {};
  const reconciliation = report.reconciliation || {};
  const summary = `
    <section class="vehicle-monthly-report__summary" aria-label="ملخص التقرير الشهري">
      <div class="vehicle-monthly-report__card"><span>الرصيد الافتتاحي</span><strong class="${_balanceClass(Money.toDecimal(report.openingBalanceCents))}">${_monthlyReportCents(report.openingBalanceCents)}</strong></div>
      <div class="vehicle-monthly-report__card vehicle-monthly-report__card--in"><span>إجمالي الداخل</span><strong>${_monthlyReportCents(report.monthlyInflowsCents)}</strong></div>
      <div class="vehicle-monthly-report__card vehicle-monthly-report__card--out"><span>إجمالي الخارج</span><strong>${_monthlyReportCents(report.monthlyOutflowsCents)}</strong></div>
      <div class="vehicle-monthly-report__card vehicle-monthly-report__card--closing"><span>الرصيد الختامي</span><strong class="${_balanceClass(Money.toDecimal(report.closingBalanceCents))}">${_monthlyReportCents(report.closingBalanceCents)}</strong></div>
      <div class="vehicle-monthly-report__card"><span>عدد الحركات</span><strong>${Number(report.movementCount || 0)}</strong></div>
    </section>
    <div class="vehicle-monthly-report__equation" aria-label="معادلة الرصيد الشهري">
      <span>الرصيد الافتتاحي</span><b>+</b><span>إجمالي الداخل</span><b>−</b><span>إجمالي الخارج</span><b>=</b><span>الرصيد الختامي</span>
    </div>
  `;

  const integrityWarning = integrity.hasInvalidDates ? `
    <section class="vehicle-monthly-report__notice vehicle-monthly-report__notice--warning" role="alert">
      <h4>تحذير سلامة البيانات</h4>
      <p>توجد ${Number(integrity.invalidDateCount || 0)} حركة مالية نشطة ذات تاريخ غير صالح. هذه الحركات لم تدخل في حساب التقرير، لذلك قد يكون الرصيد الافتتاحي أو الختامي غير مكتمل.</p>
      <div class="vehicle-monthly-report__notice-grid">
        <span>الإيداعات المستبعدة: <bdi>${_monthlyReportCents(integrity.invalidDepositAmountCents || 0)}</bdi></span>
        <span>المسحوبات المستبعدة: <bdi>${_monthlyReportCents(integrity.invalidWithdrawAmountCents || 0)}</bdi></span>
        <span>صافي الأثر المستبعد: <bdi>${_monthlyReportCents(integrity.invalidNetEffectCents || 0)}</bdi></span>
      </div>
      <details class="vehicle-monthly-report__invalid-details">
        <summary>تفاصيل الحركات ذات التاريخ غير الصالح</summary>
        <div class="table-wrapper vehicle-monthly-report__table-wrap">
          <table class="table vehicle-monthly-report__table">
            <thead><tr><th>رقم الحركة</th><th>التاريخ المخزن</th><th>النوع</th><th>المبلغ</th><th>التصنيف</th><th>المرجع</th></tr></thead>
            <tbody>${(integrity.invalidRows || []).map(row => `
              <tr>
                <td>${_escapeMaintenanceText(row.id)}</td>
                <td>${_escapeMaintenanceText(row.date ?? '—')}</td>
                <td>${_escapeMaintenanceText(_monthlyReportTypeLabel(row.type))}</td>
                <td>${_monthlyReportCents(row.amountCents || 0)}</td>
                <td>${_escapeMaintenanceText(row.classification || '—')}</td>
                <td>${_escapeMaintenanceText(`${row.referenceType || '—'} / ${row.referenceId || '—'}`)}</td>
              </tr>
            `).join('')}</tbody>
          </table>
        </div>
      </details>
    </section>
  ` : '';

  const futureNotice = Number(future.count || 0) > 0 ? `
    <section class="vehicle-monthly-report__notice vehicle-monthly-report__notice--info">
      <h4>معلومة</h4>
      <p>توجد ${Number(future.count)} حركة مؤرخة بتاريخ مستقبلي في سجل المركبة. تدخل الحركة في الحساب فقط إذا كانت تقع داخل الشهر المحدد، أما الحركات خارج فترة الشهر فلا تدخل في هذا التقرير.</p>
      <div class="vehicle-monthly-report__notice-grid">
        <span>إيداعات مستقبلية: <bdi>${_monthlyReportCents(future.depositAmountCents || 0)}</bdi></span>
        <span>مسحوبات مستقبلية: <bdi>${_monthlyReportCents(future.withdrawAmountCents || 0)}</bdi></span>
      </div>
    </section>
  ` : '';

  const reconciliationNotice = reconciliation.isReconciled
    ? integrity.isFinanciallyComplete === false
      ? '<div class="vehicle-monthly-report__reconciliation vehicle-monthly-report__reconciliation--conditional">✓ الحركات ذات التاريخ الصالح متطابقة — التقرير غير مكتمل</div>'
      : '<div class="vehicle-monthly-report__reconciliation vehicle-monthly-report__reconciliation--ok">✓ التقرير متطابق</div>'
    : '<div class="vehicle-monthly-report__reconciliation vehicle-monthly-report__reconciliation--warning">⚠ يوجد اختلاف في المطابقة</div>';

  const breakdown = `
    <section class="vehicle-monthly-report__breakdowns">
      ${_renderMonthlyReportBreakdown('تفصيل الداخل', report.breakdown?.inflows, {
        receiptRowPayment: 'صرف الكارتات', manualVehicleDeposit: 'إيداع يدوي', other: 'أخرى',
      })}
      ${_renderMonthlyReportBreakdown('تفصيل الخارج', report.breakdown?.outflows, {
        kartaSettlement: 'تسوية الكارتات', maintenance: 'صيانة', manualVehicleWithdrawal: 'سحب يدوي', other: 'أخرى',
      })}
    </section>
  `;

  const movementRows = (report.movements || []).map(movement => {
    const isDeposit = movement.type === 'deposit';
    return `
      <tr>
        <td>${_escapeMaintenanceText(movement.date || '—')}</td>
        <td>${_escapeMaintenanceText(_monthlyReportCategoryLabel(movement.category))}</td>
        <td>${_escapeMaintenanceText(_monthlyReportTypeLabel(movement.type))}</td>
        <td class="vehicle-monthly-report__amount--in">${isDeposit ? _monthlyReportCents(movement.amountCents) : '—'}</td>
        <td class="vehicle-monthly-report__amount--out">${!isDeposit ? _monthlyReportCents(movement.amountCents) : '—'}</td>
        <td class="${_balanceClass(Money.toDecimal(movement.runningBalanceCents))}">${_monthlyReportCents(movement.runningBalanceCents)}</td>
        <td>${_escapeMaintenanceText(movement.note || '—')}</td>
        <td>${_escapeMaintenanceText(_monthlyReportMaintenanceDetails(movement))}</td>
      </tr>
    `;
  }).join('');

  const movements = `
    <section class="vehicle-monthly-report__movements">
      <header><h4>الحركات الشهرية</h4>${reconciliationNotice}</header>
      <div class="table-wrapper vehicle-monthly-report__table-wrap">
        <table class="table vehicle-monthly-report__table">
          <thead><tr><th>التاريخ</th><th>البيان</th><th>النوع</th><th>المبلغ الداخل</th><th>المبلغ الخارج</th><th>الرصيد الجاري</th><th>ملاحظة</th><th>تفاصيل إضافية</th></tr></thead>
          <tbody>${movementRows || '<tr><td colspan="8" class="vehicle-details-empty-state">لا توجد حركات مالية صالحة لهذه المركبة خلال الشهر المحدد.</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  `;

  const loadedAnnouncement = `<span class="sr-only" role="status" aria-live="polite">تم تحميل التقرير الشهري للشهر ${_escapeMaintenanceText(report.monthKey || state.monthKey)}.</span>`;
  return `${loadedAnnouncement}${header}${summary}${integrityWarning}${futureNotice}${breakdown}${movements}`;
}

function _renderVehicleMonthlyReportTab(vehicle) {
  return `
    <section id="vehicleDetailsTabMonthly" class="vehicle-details-panel vehicle-monthly-report-panel" role="tabpanel" aria-labelledby="vehicleDetailsTabBtnMonthly" aria-busy="${_vehicleMonthlyReportState.loading ? 'true' : 'false'}">
      ${_renderVehicleMonthlyReportContent(vehicle)}
    </section>
  `;
}

function _refreshVehicleMonthlyReportPanel() {
  const panel = document.getElementById('vehicleDetailsTabMonthly');
  if (!panel || !_selectedVehicle) return;
  const active = document.activeElement;
  const restoreFocus = active && panel.contains(active)
    ? { id: active.id || '', action: active.dataset?.action || '' }
    : null;
  panel.outerHTML = _renderVehicleMonthlyReportTab(_selectedVehicle);
  _setVehicleDetailsTab(_vehicleDetailsTab);
  if (!restoreFocus) return;
  const replacement = document.getElementById('vehicleDetailsTabMonthly');
  const target = restoreFocus.id
    ? document.getElementById(restoreFocus.id)
    : restoreFocus.action
      ? replacement?.querySelector(`[data-action="${restoreFocus.action}"]`)
      : null;
  if (target && !target.disabled && !target.closest('.hidden')) {
    target.focus({ preventScroll: true });
  }
}

function _captureVehicleDetailsFocus(page) {
  const active = document.activeElement;
  if (!page || !active || !page.contains(active) || active.disabled) return null;
  if (active.id) return { id: active.id, action: '', tab: '' };
  const action = active.dataset?.action || '';
  if (!action) return null;
  return { id: '', action, tab: active.dataset?.tab || '' };
}

function _restoreVehicleDetailsFocus(snapshot) {
  if (!snapshot) return;
  const page = document.getElementById('ownerDetailsPage');
  if (!page) return;
  const target = snapshot.id
    ? document.getElementById(snapshot.id)
    : snapshot.action
      ? page.querySelector(`[data-action="${snapshot.action}"]${snapshot.tab ? `[data-tab="${snapshot.tab}"]` : ''}`)
      : null;
  if (target && !target.disabled && !target.closest('.hidden')) {
    target.focus({ preventScroll: true });
  }
}

async function _loadVehicleMonthlyReport() {
  const vehicle = _selectedVehicle;
  if (!vehicle?.id) return;
  _ensureVehicleMonthlyReportState(vehicle.id);
  const state = _vehicleMonthlyReportState;
  const requestId = ++state.requestId;
  const vehicleId = String(vehicle.id);
  const monthKey = state.monthKey;
  state.loading = true;
  state.report = null;
  state.error = '';
  _refreshVehicleMonthlyReportPanel();

  try {
    const report = await FinancialService.getVehicleMonthlyReport(vehicleId, monthKey);
    if (requestId !== state.requestId || String(_selectedVehicle?.id || '') !== vehicleId) return;
    if (!report || report.vehicleId !== vehicleId || report.monthKey !== monthKey) {
      throw new Error('Unexpected monthly report result.');
    }
    state.report = report;
  } catch (_) {
    if (requestId !== state.requestId || String(_selectedVehicle?.id || '') !== vehicleId) return;
    state.error = 'load_failed';
  } finally {
    if (requestId === state.requestId && String(_selectedVehicle?.id || '') === vehicleId) {
      state.loading = false;
      _refreshVehicleMonthlyReportPanel();
    }
  }
}

function _maintenanceSearchHaystack(entry) {
  return [
    _dateLabel(entry?.date || entry?.applied_at),
    entry?.maintenance_type,
    entry?.maintenance_quantity,
    _fmt(entry?.amount),
    entry?.amount,
    entry?.note,
  ].map(value => String(value ?? '').toLowerCase()).join(' ');
}

function _filterMaintenanceEntries(entries, query = _maintenanceSearchQuery) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return [...(entries || [])];
  return (entries || []).filter(entry => _maintenanceSearchHaystack(entry).includes(normalizedQuery));
}

function _renderMaintenanceRows(entries) {
  if (!entries.length) {
    return `<tr><td colspan="6" class="vehicle-details-empty-state">لا توجد حركات صيانة مطابقة</td></tr>`;
  }
  return entries.map(entry => `
    <tr>
      <td class="vehicle-details-date-cell">${_escapeMaintenanceText(_dateLabel(entry.date || entry.applied_at))}</td>
      <td class="vehicle-details-strong-cell">${_escapeMaintenanceText(entry.maintenance_type)}</td>
      <td class="vehicle-details-number-cell">${_escapeMaintenanceText(entry.maintenance_quantity ?? '—')}</td>
      <td class="vehicle-details-amount-cell">${_fmt(entry.amount)}</td>
      <td class="vehicle-details-note-cell">${_escapeMaintenanceText(entry.note || '—')}</td>
      <td class="vehicle-details-actions-cell">
        <div class="vehicle-details-row-actions">
          <button type="button" data-action="edit-vehicle-maintenance" data-ref-id="${_escapeMaintenanceText(entry.reference_id)}" class="btn vehicle-details-icon-action vehicle-details-icon-action--edit" title="تعديل" aria-label="تعديل حركة الصيانة">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button type="button" data-action="delete-vehicle-maintenance" data-ref-id="${_escapeMaintenanceText(entry.reference_id)}" class="btn vehicle-details-icon-action vehicle-details-icon-action--delete" title="حذف" aria-label="حذف حركة الصيانة">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

function _refreshMaintenanceTable() {
  const body = document.getElementById('vehicleMaintenanceBody');
  if (!body) return;
  body.innerHTML = _renderMaintenanceRows(_filterMaintenanceEntries(_maintenanceEntriesCache));
}

async function _renderMaintenanceTab(ledger = []) {
  const activeMaintenance = (ledger || []).filter(_isActiveMaintenanceEntry);
  _maintenanceEntriesCache = activeMaintenance;
  const tableRows = _renderMaintenanceRows(_filterMaintenanceEntries(activeMaintenance));

  return `
    <section class="vehicle-details-panel vehicle-maintenance-panel" role="tabpanel" id="vehicleDetailsTabMaintenance" aria-labelledby="vehicleDetailsTabBtnMaintenance">
      <header class="vehicle-details-panel-header">
        <div class="vehicle-details-panel-title-group">
          <span class="vehicle-details-panel-icon vehicle-details-panel-icon--maintenance" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m14.7 6.3 3 3"/><path d="m5 19 8.9-8.9a4.8 4.8 0 0 0 5.5-6.2l-3.2 3.2-2.8-2.8L16.6 1a4.8 4.8 0 0 0-6.2 5.5L1.5 15.4A2.12 2.12 0 0 0 4.6 18.5l8.9-8.9"/><path d="m15 15 4.5 4.5"/><path d="m18 18 2 2"/></svg>
          </span>
          <div>
            <h3>الصيانة</h3>
            <p>تسجيل ومتابعة سحوبات صيانة المركبة</p>
          </div>
        </div>
        <button type="button" data-action="open-vehicle-maintenance" class="btn vehicle-details-action vehicle-details-action--maintenance">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.7 6.3 3 3"/><path d="m5 19 8.9-8.9a4.8 4.8 0 0 0 5.5-6.2l-3.2 3.2-2.8-2.8L16.6 1a4.8 4.8 0 0 0-6.2 5.5L1.5 15.4A2.12 2.12 0 0 0 4.6 18.5l8.9-8.9"/></svg>
          <span>سحب للصيانة</span>
        </button>
      </header>
      <div class="vehicle-details-search-wrap">
        <svg class="vehicle-details-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2"/></svg>
        <input id="vehicleMaintenanceSearch" type="search" class="input vehicle-details-search-input" aria-label="بحث" value="${_escapeMaintenanceText(_maintenanceSearchQuery)}" placeholder="ابحث بالتاريخ أو النوع أو العدد أو المبلغ أو الملاحظة">
      </div>
      <div class="table-wrapper vehicle-details-table-wrap">
        <table class="table vehicle-details-table vehicle-details-table--maintenance">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>نوع الصيانة</th>
              <th>العدد</th>
              <th>المبلغ</th>
              <th>الملاحظة</th>
              <th class="vehicle-details-actions-heading">الإجراءات</th>
            </tr>
          </thead>
          <tbody id="vehicleMaintenanceBody">${tableRows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function _renderMaintenanceTypeSuggestions(query = '') {
  const box = document.getElementById('vehicleMaintenanceTypeSuggestions');
  if (!box) return;
  const normalized = String(query || '').trim().toLowerCase();
  const matches = MAINTENANCE_TYPE_SUGGESTIONS.filter(type => type.toLowerCase().includes(normalized));
  box.innerHTML = matches.length
    ? matches.map(type => `<button type="button" data-action="select-maintenance-type" data-value="${type}" class="vehicle-maintenance-suggestion">${type}</button>`).join('')
    : '<div class="vehicle-maintenance-suggestion-empty">يمكنك إدخال نوع مخصص</div>';
  box.classList.remove('hidden');
}

function _ensureVehicleMaintenanceModal() {
  if (document.getElementById('vehicleMaintenanceModal')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div id="vehicleMaintenanceModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4 vehicle-maintenance-modal">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md vehicle-maintenance-modal__dialog">
        <div class="vehicle-maintenance-modal__header">
          <div class="vehicle-maintenance-modal__title-group">
            <span class="vehicle-maintenance-modal__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14.7 6.3 3 3"/><path d="m5 19 8.9-8.9a4.8 4.8 0 0 0 5.5-6.2l-3.2 3.2-2.8-2.8L16.6 1a4.8 4.8 0 0 0-6.2 5.5L1.5 15.4A2.12 2.12 0 0 0 4.6 18.5l8.9-8.9"/></svg>
            </span>
            <div>
              <h3 id="vehicleMaintenanceTitle">صيانة مركبة</h3>
              <p>سحب مباشر من رصيد المركبة الحالية</p>
            </div>
          </div>
          <button type="button" data-action="close-vehicle-maintenance" class="btn vehicle-details-close-button" aria-label="إغلاق نافذة الصيانة">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </div>
        <div class="vehicle-maintenance-form">
          <div class="vehicle-maintenance-field">
            <label class="label" for="vehicleMaintenanceDate">التاريخ <span class="text-red-500">*</span></label>
            <input id="vehicleMaintenanceDate" type="date" class="input">
          </div>
          <div class="vehicle-maintenance-field vehicle-maintenance-field--suggestions">
            <label class="label" for="vehicleMaintenanceType">نوع الصيانة <span class="text-red-500">*</span></label>
            <input id="vehicleMaintenanceType" type="text" autocomplete="off" class="input" placeholder="اختر أو اكتب نوع الصيانة">
            <div id="vehicleMaintenanceTypeSuggestions" class="hidden vehicle-maintenance-suggestions"></div>
          </div>
          <div class="vehicle-maintenance-field">
            <label class="label" for="vehicleMaintenanceQuantity">العدد <span class="vehicle-maintenance-optional">اختياري</span></label>
            <input id="vehicleMaintenanceQuantity" type="number" min="0" step="any" class="input" placeholder="0">
          </div>
          <div class="vehicle-maintenance-field">
            <label class="label" for="vehicleMaintenanceAmount">المبلغ <span class="text-red-500">*</span></label>
            <input id="vehicleMaintenanceAmount" type="number" min="0" step="0.01" class="input" placeholder="0.00">
          </div>
          <div class="vehicle-maintenance-field vehicle-maintenance-field--full">
            <label class="label" for="vehicleMaintenanceNote">ملاحظة <span class="vehicle-maintenance-optional">اختيارية</span></label>
            <input id="vehicleMaintenanceNote" type="text" class="input" placeholder="أضف ملاحظة عند الحاجة">
          </div>
        </div>
        <div class="vehicle-maintenance-modal__footer">
          <button type="button" data-action="close-vehicle-maintenance" class="btn vehicle-details-secondary-action">إلغاء</button>
          <button type="button" data-action="save-vehicle-maintenance" class="btn vehicle-details-action vehicle-details-action--maintenance">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
            <span>حفظ السحب</span>
          </button>
        </div>
        <div id="vehicleMaintenanceMsg" class="field-msg-inline field-msg-inline--error vehicle-maintenance-modal__message" role="alert"></div>
      </div>
    </div>
  `;
  document.body.appendChild(div.firstElementChild);
}

async function _openVehicleMaintenanceModal(entry = null) {
  if (!_selectedVehicle?.id) return;
  _ensureVehicleMaintenanceModal();
  const modal = document.getElementById('vehicleMaintenanceModal');
  const title = document.getElementById('vehicleMaintenanceTitle');
  const date = document.getElementById('vehicleMaintenanceDate');
  const type = document.getElementById('vehicleMaintenanceType');
  const quantity = document.getElementById('vehicleMaintenanceQuantity');
  const amount = document.getElementById('vehicleMaintenanceAmount');
  const note = document.getElementById('vehicleMaintenanceNote');
  const msg = document.getElementById('vehicleMaintenanceMsg');

  _editingMaintenanceReferenceId = entry?.reference_id || null;
  if (title) title.textContent = `${entry ? 'تعديل صيانة مركبة' : 'صيانة مركبة'} — ${_selectedVehicle.plate || _selectedVehicle.id}`;
  if (date) date.value = entry?.date || DateUtils.todayLocal();
  if (type) type.value = entry?.maintenance_type || '';
  if (quantity) quantity.value = entry?.maintenance_quantity ?? '';
  if (amount) amount.value = entry?.amount ?? '';
  if (note) note.value = entry?.note || '';
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  document.getElementById('vehicleMaintenanceTypeSuggestions')?.classList.add('hidden');
  modal?.classList.remove('hidden');
}

function _closeVehicleMaintenanceModal() {
  document.getElementById('vehicleMaintenanceModal')?.classList.add('hidden');
  document.getElementById('vehicleMaintenanceTypeSuggestions')?.classList.add('hidden');
  _editingMaintenanceReferenceId = null;
}

async function _saveVehicleMaintenance() {
  const vehicle_id = String(_selectedVehicle?.id || '');
  const date = document.getElementById('vehicleMaintenanceDate')?.value || '';
  const maintenance_type = document.getElementById('vehicleMaintenanceType')?.value?.trim() || '';
  const rawMaintenanceQuantity = document.getElementById('vehicleMaintenanceQuantity')?.value ?? '';
  const maintenance_quantity = String(rawMaintenanceQuantity).trim() === '' ? null : Number(rawMaintenanceQuantity);
  const amount = parseFloat(document.getElementById('vehicleMaintenanceAmount')?.value) || 0;
  const note = document.getElementById('vehicleMaintenanceNote')?.value?.trim() || '';
  const msg = document.getElementById('vehicleMaintenanceMsg');

  if (!vehicle_id || !date || !maintenance_type
    || (maintenance_quantity !== null && (!Number.isFinite(maintenance_quantity) || maintenance_quantity <= 0))
    || amount <= 0) {
    if (msg) {
      msg.textContent = !vehicle_id ? '❌ لم يتم تحديد المركبة الحالية'
        : !date ? '❌ التاريخ مطلوب'
        : !maintenance_type ? '❌ نوع الصيانة مطلوب'
        : maintenance_quantity !== null && (!Number.isFinite(maintenance_quantity) || maintenance_quantity <= 0) ? '❌ العدد يجب أن يكون أكبر من صفر عند إدخاله'
        : '❌ المبلغ يجب أن يكون أكبر من صفر';
      msg.classList.add('is-visible');
    }
    return;
  }

  try {
    const data = { vehicle_id, entry_type: 'withdraw', amount, date, note, maintenance_type, maintenance_quantity };
    if (_editingMaintenanceReferenceId) {
      await FinancialService.updateVehicleMaintenanceEntry(_currentUsername(), _editingMaintenanceReferenceId, data);
    } else {
      await FinancialService.createManualVehicleBalanceEntry(_currentUsername(), data);
    }
    _vehicleDetailsTab = 'maintenance';
    _closeVehicleMaintenanceModal();
    if (_selectedClient?.id) await showOwnerDetails(_selectedClient.id, 'owner', vehicle_id);
  } catch (err) {
    if (msg) {
      msg.textContent = err.message || '❌ فشل حفظ حركة الصيانة';
      msg.classList.add('is-visible');
    }
  }
}

// ── Vehicle financial movements — read-only presentation ─────────────────
// Ledger rows remain the existing vehicle_ledger projection. Receipt-payment
// company names are resolved for display only; no ledger row is modified.
async function _resolveVehicleLedgerPresentation(entries) {
  const receiptPaymentRowIds = [...new Set((entries || [])
    .filter(entry => entry.reference_type === 'receipt_row_payment_vehicle' && entry.reference_id)
    .map(entry => String(entry.reference_id)))];
  const rows = await Promise.all(receiptPaymentRowIds.map(async (rowId) => {
    try { return await ReceiptRepository.getRowById(rowId); } catch (_) { return null; }
  }));
  const companyByRowId = new Map(rows
    .filter(row => row?.row_id && String(row.office || '').trim())
    .map(row => [String(row.row_id), String(row.office).trim()]));

  return (entries || []).map(entry => entry.reference_type === 'receipt_row_payment_vehicle'
    ? { ...entry, receipt_payment_company_name: companyByRowId.get(String(entry.reference_id || '')) || '' }
    : entry);
}

function _vehicleLedgerDescription(entry) {
  if (entry?.reference_type === 'receipt_row_payment_vehicle') {
    const companyName = String(entry.receipt_payment_company_name || '').trim();
    return companyName ? `صرف كارتة - ${companyName}` : 'صرف كارتة - الشركة';
  }
  return _ledgerNote(entry);
}

function _vehicleFinancialSearchHaystack(entry) {
  return [
    _dateLabel(entry?.date || entry?.applied_at),
    entry?.date,
    entry?.applied_at,
    _ledgerType(entry?.type),
    entry?.type,
    _fmt(entry?.amount),
    entry?.amount,
    entry?.vehicle_plate,
    _vehicleLedgerDescription(entry),
    entry?.note,
    entry?.receipt_payment_company_name,
    entry?.reference_number,
    entry?.reference_type,
  ].map(value => String(value ?? '').toLowerCase()).join(' ');
}

function _filterVehicleFinancialEntries(entries, query = _vehicleFinancialSearchQuery) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return [...(entries || [])];
  return (entries || []).filter(entry => _vehicleFinancialSearchHaystack(entry).includes(normalizedQuery));
}

function _renderVehicleFinancialRows(entries) {
  if (!entries.length) {
    const hasQuery = String(_vehicleFinancialSearchQuery || '').trim().length > 0;
    return `
      <tr>
        <td colspan="4" class="vehicle-details-empty-state">
          <span class="vehicle-details-empty-state__icon" aria-hidden="true">▱</span>
          ${hasQuery ? 'لا توجد حركات مالية مطابقة للبحث' : 'لا توجد حركات مالية للمركبة حتى الآن'}
        </td>
      </tr>
    `;
  }
  return entries.map(e => `
    <tr class="vehicle-details-financial-row vehicle-details-financial-row--${e.type === 'deposit' ? 'deposit' : 'withdraw'}">
      <td class="vehicle-details-date-cell">${_dateLabel(e.date || e.applied_at)}</td>
      <td class="vehicle-details-amount-cell">${_fmt(e.amount)}</td>
      <td class="vehicle-details-strong-cell">${e.vehicle_plate || '-'}</td>
      <td class="vehicle-details-note-cell">${_escapeMaintenanceText(_vehicleLedgerDescription(e))}</td>
    </tr>
  `).join('');
}

function _refreshVehicleFinancialTable() {
  const body = document.getElementById('clientLedgerBody');
  if (!body) return;
  body.innerHTML = _renderVehicleFinancialRows(_filterVehicleFinancialEntries(_vehicleFinancialEntriesCache));
}

function _renderLedger(client, ledger = []) {
  _vehicleFinancialEntriesCache = [...(ledger || [])];
  const tableRows = _renderVehicleFinancialRows(_filterVehicleFinancialEntries(_vehicleFinancialEntriesCache));
  return `
    <section class="vehicle-details-panel vehicle-financial-panel">
      <header class="vehicle-details-panel-header vehicle-details-panel-header--financial">
        <div class="vehicle-details-panel-title-group">
          <span class="vehicle-details-panel-icon vehicle-details-panel-icon--financial" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/></svg>
          </span>
          <div>
            <h3>الحركات المالية</h3>
            <p>سجل الحركات المرتبطة بالمركبة الحالية</p>
          </div>
        </div>
        <div class="filter-row vehicle-details-filter-bar vehicle-details-filter-bar--inline" aria-label="تحديد الفترة">
          <div class="form-group mb-0">
            <label class="label" for="clientFromDate">من</label>
            <input id="clientFromDate" type="date" class="input">
          </div>
          <div class="form-group mb-0">
            <label class="label" for="clientToDate">إلى</label>
            <input id="clientToDate" type="date" class="input">
          </div>
          <div class="vehicle-details-filter-actions">
            <button type="button" data-action="client-apply-filter" data-id="${client.id}" data-type="${client.type}" class="btn vehicle-details-secondary-action">
              تطبيق
            </button>
            <button type="button" data-action="client-clear-filter" data-id="${client.id}" data-type="${client.type}" class="btn vehicle-details-ghost-action">
              مسح التحديد
            </button>
          </div>
        </div>
      </header>
      <div class="vehicle-details-search-wrap">
        <svg class="vehicle-details-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2"/></svg>
        <input id="vehicleFinancialSearch" type="search" class="input vehicle-details-search-input" aria-label="بحث في الحركات المالية" value="${_escapeMaintenanceText(_vehicleFinancialSearchQuery)}" placeholder="ابحث بالتاريخ أو الحركة أو الشركة أو الملاحظة">
      </div>
      <div class="table-wrapper vehicle-details-table-wrap">
        <table class="table vehicle-details-table vehicle-details-table--financial">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>المبلغ</th>
              <th>المركبة</th>
              <th>ملاحظة</th>
            </tr>
          </thead>
          <tbody id="clientLedgerBody">${tableRows}</tbody>
        </table>
      </div>
    </section>
  `;
}


let _vehicleBalanceEntryType = 'deposit';

function _ensureVehicleBalanceEntryModal() {
  if (document.getElementById('vehicleBalanceEntryModal')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div id="vehicleBalanceEntryModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4 vehicle-balance-modal">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md vehicle-balance-modal__dialog">
        <div class="vehicle-maintenance-modal__header">
          <div class="vehicle-maintenance-modal__title-group">
            <span class="vehicle-maintenance-modal__icon vehicle-maintenance-modal__icon--balance" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/></svg>
            </span>
            <div>
              <h3 id="vehicleBalanceEntryTitle">حركة رصيد للمركبة</h3>
              <p>تسجيل حركة مباشرة على رصيد المركبة الحالية</p>
            </div>
          </div>
          <button type="button" data-action="close-vehicle-balance-entry" class="btn vehicle-details-close-button" aria-label="إغلاق نافذة حركة الرصيد">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </div>
        <div class="vehicle-maintenance-form">
          <div class="vehicle-maintenance-field">
            <label class="label" for="vehicleBalanceEntryAmount">المبلغ <span class="text-red-500">*</span></label>
            <input id="vehicleBalanceEntryAmount" type="number" step="0.01" min="0" class="input" placeholder="0.00">
          </div>
          <div class="vehicle-maintenance-field">
            <label class="label" for="vehicleBalanceEntryDate">التاريخ <span class="text-red-500">*</span></label>
            <input id="vehicleBalanceEntryDate" type="date" class="input">
          </div>
          <div class="vehicle-maintenance-field vehicle-maintenance-field--full">
            <label class="label" for="vehicleBalanceEntryNote">السبب / ملاحظة <span class="text-red-500">*</span></label>
            <input id="vehicleBalanceEntryNote" type="text" class="input" placeholder="اكتب سبب الحركة">
          </div>
        </div>
        <div class="vehicle-maintenance-modal__footer">
          <button type="button" data-action="close-vehicle-balance-entry" class="btn vehicle-details-secondary-action">إلغاء</button>
          <button type="button" data-action="save-vehicle-balance-entry" class="btn vehicle-details-action vehicle-details-action--primary">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
            <span>حفظ الحركة</span>
          </button>
        </div>
        <div id="vehicleBalanceEntryMsg" class="field-msg-inline field-msg-inline--error vehicle-maintenance-modal__message" role="alert"></div>
      </div>
    </div>
  `;
  document.body.appendChild(div.firstElementChild);
}

async function _openVehicleBalanceEntryModal(entryType) {
  if (!_selectedVehicle?.id) return;
  _ensureVehicleBalanceEntryModal();
  _vehicleBalanceEntryType = entryType === 'withdraw' ? 'withdraw' : 'deposit';

  const modal = document.getElementById('vehicleBalanceEntryModal');
  const title = document.getElementById('vehicleBalanceEntryTitle');
  const amount = document.getElementById('vehicleBalanceEntryAmount');
  const date = document.getElementById('vehicleBalanceEntryDate');
  const note = document.getElementById('vehicleBalanceEntryNote');
  const msg = document.getElementById('vehicleBalanceEntryMsg');

  if (title) title.textContent = `${_vehicleBalanceEntryType === 'deposit' ? 'إيداع رصيد للمركبة' : 'سحب رصيد من المركبة'} — ${_selectedVehicle.plate || _selectedVehicle.id}`;
  if (amount) amount.value = '';
  if (date) date.value = DateUtils.todayLocal();
  if (note) note.value = '';
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal?.classList.remove('hidden');
}

function _closeVehicleBalanceEntryModal() {
  document.getElementById('vehicleBalanceEntryModal')?.classList.add('hidden');
}

async function _saveVehicleBalanceEntry() {
  const vehicleId = String(_selectedVehicle?.id || '');
  const amount = parseFloat(document.getElementById('vehicleBalanceEntryAmount')?.value) || 0;
  const date = document.getElementById('vehicleBalanceEntryDate')?.value || '';
  const note = document.getElementById('vehicleBalanceEntryNote')?.value?.trim() || '';
  const msg = document.getElementById('vehicleBalanceEntryMsg');

  if (!vehicleId || amount <= 0 || !date || !note) {
    if (msg) {
      msg.textContent = !vehicleId ? '❌ لم يتم تحديد المركبة الحالية'
        : amount <= 0 ? '❌ المبلغ يجب أن يكون أكبر من صفر'
        : !date ? '❌ التاريخ مطلوب'
        : '❌ السبب / الملاحظة مطلوبة';
      msg.classList.add('is-visible');
    }
    return;
  }

  try {
    await FinancialService.createManualVehicleBalanceEntry(_currentUsername(), {
      vehicle_id: vehicleId,
      entry_type: _vehicleBalanceEntryType,
      amount,
      date,
      note,
    });
    _closeVehicleBalanceEntryModal();
    if (_selectedClient?.id) await showOwnerDetails(_selectedClient.id, 'owner', _selectedVehicle?.id);
  } catch (err) {
    if (msg) {
      msg.textContent = err.message || '❌ فشل حفظ حركة الرصيد';
      msg.classList.add('is-visible');
    }
  }
}

function _ensureVehicleModal() {
  if (document.getElementById('vehicleModal')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div id="vehicleModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold" id="vehicleModalTitle">إضافة مركبة</h3>
          <button type="button" data-action="vehicle-modal-close" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>
        <div class="grid gap-3 mb-4">
          <div>
            <label class="label mb-1" for="vehicleModalPlate">رقم المركبة</label>
            <input id="vehicleModalPlate" type="text" class="input input-sm" placeholder="أدخل رقم المركبة">
          </div>
          <!-- No driver field: a vehicle has NO permanent driver (Phase 6 — driver
               per receipt row). The driver is selected per receipt row and
               persisted on receipt_rows.driver_id. -->
        </div>
        <div class="flex gap-2">
          <button type="button" data-action="vehicle-modal-save" class="btn btn-primary btn-sm btn-full">حفظ</button>
        </div>
        <div id="vehicleModalMsg" class="field-msg-inline field-msg-inline--error mt-3" role="alert"></div>
      </div>
    </div>
  `;
  document.body.appendChild(div.firstElementChild);
}

let _vehicleEditId = null;
let _vehicleOwnerId = null;

function _openVehicleModal(title, plate, ownerId, editId) {
  _ensureVehicleModal();
  _vehicleOwnerId = ownerId || null;
  _vehicleEditId = editId || null;
  const modal = document.getElementById('vehicleModal');
  const titleEl = document.getElementById('vehicleModalTitle');
  const plateEl = document.getElementById('vehicleModalPlate');
  const msg = document.getElementById('vehicleModalMsg');
  if (titleEl) titleEl.textContent = title;
  if (plateEl) plateEl.value = plate || '';
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal?.classList.remove('hidden');
}

async function _renderOwnerVehicles(client) {
  const owned = await OwnersModule.getOwnerVehicles(client.id);

  return `
    <section>
      <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold mb-0">المركبات</h3>
        <div class="flex gap-2">
          <button type="button" data-action="add-vehicle-manual" data-owner-id="${client.id}" style="background:#16a34a;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">➕ إضافة مركبة</button>
        </div>
      </div>
      <div class="table-wrapper mb-10">
        <table class="table">
          <thead>
            <tr>
              <th>رقم المركبة</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${owned.length ? owned.map(v => `
              <tr>
                <td>${v.plate || '-'}</td>
                <td>
                  <button type="button" data-action="edit-vehicle" data-vehicle-id="${v.id}" data-plate="${v.plate || ''}" class="btn-icon" title="تعديل" style="background:#dbeafe;color:#2563eb;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">✏️</button>
                  <button type="button" data-action="delete-vehicle" data-vehicle-id="${v.id}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
                </td>
              </tr>
            `).join('') : `
              <tr>
                <td colspan="2" class="text-muted text-center">لا توجد مركبات</td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

async function showOwnerDetails(id, type = 'owner', vehicleId = null) {
  const requestVersion = ++_vehicleDetailsRequestVersion;
  const client = await _getClient('owner', id);
  if (!client || requestVersion !== _vehicleDetailsRequestVersion) return;
  const vehicle = await _resolveDetailVehicle(client, vehicleId);
  if (!vehicle || requestVersion !== _vehicleDetailsRequestVersion) return;

  _selectedClient = client;
  _selectedVehicle = vehicle;
  const vehicleKey = String(vehicle.id);
  if (_vehicleFinancialSearchVehicleId !== vehicleKey) {
    _vehicleFinancialSearchVehicleId = vehicleKey;
    _vehicleFinancialSearchQuery = '';
  }
  _ensureVehicleMonthlyReportState(vehicle.id);

  sessionStorage.setItem(LAST_PAGE_CTX_KEY, JSON.stringify({
    page: 'ownerDetailsPage',
    ownerId: String(id),
    ownerType: type,
    vehicleId: String(vehicle.id),
  }));

  const financials = await _getVehicleDetailsFinancials(vehicle.id);
  if (requestVersion !== _vehicleDetailsRequestVersion) return;
  const ledgerHtml = _renderLedger(client, financials.ledger);
  const maintenanceHtml = await _renderMaintenanceTab(financials.ledger);
  const monthlyReportHtml = _renderVehicleMonthlyReportTab(vehicle);
  const relatedHtml = await _renderOwnerVehicles(client);
  if (requestVersion !== _vehicleDetailsRequestVersion) return;

  const page = document.getElementById('ownerDetailsPage');
  if (!page || requestVersion !== _vehicleDetailsRequestVersion) return;
  const vehicleDetailsFocus = _captureVehicleDetailsFocus(page);

  page.innerHTML = `
    <div class="ent-details-page vehicle-details-page">
      <header class="vehicle-details-hero">
        <button type="button" data-action="back-to-customers" class="btn ent-btn-back vehicle-details-back" aria-label="العودة إلى إدارة المركبات">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
          <span>رجوع</span>
        </button>
        <div class="vehicle-details-identity">
          <span class="vehicle-details-identity__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="11" rx="2"/><path d="M6 7 8 4h8l2 3M7 18v2m10-2v2M7 12h.01M17 12h.01"/></svg>
          </span>
          <div>
            <p class="vehicle-details-eyebrow">تفاصيل مركبة</p>
            <p class="vehicle-details-caption">سجل مالي وصيانة للمركبة الحالية</p>
          </div>
        </div>
        <div class="vehicle-details-hero-spacer vehicle-details-vehicle-chip" aria-label="رقم المركبة الحالية">
          <span class="vehicle-details-vehicle-chip__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="11" rx="2"/><path d="M6 7 8 4h8l2 3M7 18v2m10-2v2M7 12h.01M17 12h.01"/></svg>
          </span>
          <span class="vehicle-details-vehicle-chip__content">
            <span class="vehicle-details-vehicle-chip__label">رقم المركبة</span>
            <bdi class="vehicle-details-vehicle-chip__value">${vehicle.plate || client.name}</bdi>
          </span>
        </div>
      </header>

      <section class="vehicle-details-balance-card" aria-label="رصيد المركبة الحالي">
        <div class="vehicle-details-balance-copy">
          <span class="vehicle-details-balance-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/></svg>
          </span>
          <div>
            <p>رصيد المركبة الحالي</p>
            <div class="vehicle-details-balance-value ${_balanceClass(financials.balance)}"><bdi>${_fmt(financials.balance)}</bdi><span>ج.م</span></div>
          </div>
        </div>
        <div class="vehicle-details-primary-actions">
          <button type="button" data-action="open-balance-entry" data-entry-type="deposit" class="btn vehicle-details-action vehicle-details-action--deposit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>
            <span>إيداع رصيد</span>
          </button>
          <button type="button" data-action="open-balance-entry" data-entry-type="withdraw" class="btn vehicle-details-action vehicle-details-action--withdraw">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14m6-6-6 6-6-6"/></svg>
            <span>سحب رصيد</span>
          </button>
        </div>
      </section>

      <div class="tabs vehicle-details-tabs" role="tablist" aria-label="تفاصيل المركبة">
        <button type="button" role="tab" id="vehicleDetailsTabBtnFinancial" data-action="vehicle-details-tab" data-tab="financial" class="tab-btn vehicle-details-tab active-purple" aria-selected="true" aria-controls="vehicleDetailsTabFinancial">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/></svg>
          <span>الحركات المالية</span>
        </button>
        <button type="button" role="tab" id="vehicleDetailsTabBtnMaintenance" data-action="vehicle-details-tab" data-tab="maintenance" class="tab-btn vehicle-details-tab" aria-selected="false" aria-controls="vehicleDetailsTabMaintenance">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.7 6.3 3 3"/><path d="m5 19 8.9-8.9a4.8 4.8 0 0 0 5.5-6.2l-3.2 3.2-2.8-2.8L16.6 1a4.8 4.8 0 0 0-6.2 5.5L1.5 15.4A2.12 2.12 0 0 0 4.6 18.5l8.9-8.9"/></svg>
          <span>الصيانة</span>
        </button>
        <button type="button" role="tab" id="vehicleDetailsTabBtnMonthly" data-action="vehicle-details-tab" data-tab="monthly" class="tab-btn vehicle-details-tab" aria-selected="false" aria-controls="vehicleDetailsTabMonthly">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/><path d="M8 15h.01M12 15h.01M16 15h.01"/></svg>
          <span>التقرير الشهري</span>
        </button>
      </div>

      <section id="vehicleDetailsTabFinancial" class="vehicle-details-tab-panel" role="tabpanel" aria-labelledby="vehicleDetailsTabBtnFinancial">
        ${ledgerHtml}
      </section>
      ${maintenanceHtml}
      ${monthlyReportHtml}
      <section id="vehicleDetailsTabVehicles" class="hidden" role="tabpanel">
        ${relatedHtml}
      </section>
    </div>
  `;

  if (typeof window.showPage === 'function') {
    await window.showPage('ownerDetailsPage');
  }
  _setVehicleDetailsTab(_vehicleDetailsTab);
  _restoreVehicleDetailsFocus(vehicleDetailsFocus);
  if (_vehicleDetailsTab === 'monthly') await _loadVehicleMonthlyReport();
}

// ─── EXCEL HANDLERS ───────────────────────────────────────────────────────────

/**
 * Reads all active vehicle owners and exports them to Excel
 * with the رقم المركبة column only. Export mirrors what the user sees on the page.
 */
async function _handleExportOwnersExcel() {
  try {
    const ownersRaw = await ClientRepository.getAllOwners();
    const owners = ownersRaw
      .filter(o => o.deleted_at === null && (o.vehicle_number || o.name))
      .map(o => ({
        vehicle_number: o.vehicle_number || o.name || '',
      }));
    if (owners.length === 0) {
      alert('لا توجد بيانات للتصدير');
      return;
    }
    ExcelService.exportEntitiesExcel({ owners });
  } catch (err) {
    console.error('[entities] Excel export failed:', err);
    alert(err.message || '❌ فشل تصدير Excel');
  }
}


/**
 * Opens a file picker, parses owners from the Excel
 * file, then writes each list into its own store. Duplicates (case-
 * insensitive trimmed-name match) are silently skipped per spec.
 */
function _handleImportOwnersExcel() {
  ExcelService.openFilePicker(async (file) => {
    try {
      const { owners } = await ExcelService.importEntitiesExcel(file);
      const username = _currentUsername();
      let ownersAdded = 0, ownersSkipped = 0;

      for (const row of (owners || [])) {
        try {
          const vehicle_number = String(row.vehicle_number || '').trim();
          if (!vehicle_number) { ownersSkipped++; continue; }
          const existing = await ClientRepository.findOwnersByNumber(vehicle_number);
          const dup = (existing || []).some(o => o.deleted_at === null);
          if (dup) { ownersSkipped++; continue; }
          await createOwner(username, { vehicle_number, notes: null });
          ownersAdded++;
        } catch (err) {
          console.warn('[entities] import vehicle skipped:', row, err);
          ownersSkipped++;
        }
      }

      if (ownersAdded > 0) window.dispatchEvent(new CustomEvent('owners:changed'));
      await loadOwners();

      const parts = [];
      if (ownersAdded > 0) parts.push(`✅ تم إضافة ${ownersAdded} مركبة`);
      if (ownersSkipped > 0) parts.push(`⏭️ تم تخطي ${ownersSkipped}`);
      alert(parts.join('\n') || 'لا توجد بيانات للاستيراد');
    } catch (err) {
      console.error('[entities] Excel import failed:', err);
      alert(err.message || '❌ فشل استيراد Excel');
    }
  });
}


// ─────────────────────────────────────────────────────────────────────────────

function attachOwnersPageListeners() {
  if (document.body.dataset.ownersListenersBound === '1') return;
  document.body.dataset.ownersListenersBound = '1';

  document.addEventListener('click', async (e) => {
    const suggestionBox = document.getElementById('vehicleMaintenanceTypeSuggestions');
    const clickedMaintenanceInput = e.target.closest('#vehicleMaintenanceType');
    const clickedSuggestion = e.target.closest('#vehicleMaintenanceTypeSuggestions');
    if (suggestionBox && !clickedMaintenanceInput && !clickedSuggestion) {
      suggestionBox.classList.add('hidden');
    }

    const vehicleDetailsTab = e.target.closest('[data-action="vehicle-details-tab"]');
    if (vehicleDetailsTab) {
      const tab = vehicleDetailsTab.dataset.tab;
      _setVehicleDetailsTab(tab);
      if (tab === 'monthly') await _loadVehicleMonthlyReport();
      return;
    }

    if (e.target.closest('[data-action="load-vehicle-monthly-report"]')) {
      await _loadVehicleMonthlyReport();
      return;
    }
    if (e.target.closest('[data-action="vehicle-monthly-report-current-month"]')) {
      _vehicleMonthlyReportState.monthKey = _currentCairoMonthKey();
      await _loadVehicleMonthlyReport();
      return;
    }

    if (e.target.closest('[data-action="open-vehicle-maintenance"]')) {
      await _openVehicleMaintenanceModal();
      return;
    }
    if (e.target.closest('[data-action="close-vehicle-maintenance"]')) {
      _closeVehicleMaintenanceModal();
      return;
    }
    const selectMaintenanceType = e.target.closest('[data-action="select-maintenance-type"]');
    if (selectMaintenanceType) {
      const typeInput = document.getElementById('vehicleMaintenanceType');
      if (typeInput) typeInput.value = selectMaintenanceType.dataset.value || '';
      document.getElementById('vehicleMaintenanceTypeSuggestions')?.classList.add('hidden');
      return;
    }
    if (e.target.closest('[data-action="save-vehicle-maintenance"]')) {
      await _saveVehicleMaintenance();
      return;
    }
    const editMaintenance = e.target.closest('[data-action="edit-vehicle-maintenance"]');
    if (editMaintenance) {
      const entry = _maintenanceEntriesCache.find(item => item.reference_id === editMaintenance.dataset.refId);
      if (entry) await _openVehicleMaintenanceModal(entry);
      return;
    }
    const deleteMaintenance = e.target.closest('[data-action="delete-vehicle-maintenance"]');
    if (deleteMaintenance) {
      const entry = _maintenanceEntriesCache.find(item => item.reference_id === deleteMaintenance.dataset.refId);
      if (!entry || !confirm('هل تريد حذف حركة الصيانة؟')) return;
      try {
        await FinancialService.deleteManualVehicleBalanceEntry(_currentUsername(), entry.reference_id);
        _vehicleDetailsTab = 'maintenance';
        if (_selectedClient?.id) await showOwnerDetails(_selectedClient.id, 'owner', _selectedVehicle?.id);
      } catch (err) {
        alert(err.message || '❌ فشل حذف حركة الصيانة');
      }
      return;
    }

    // Vehicle/customer manual balance entry — one explicit vehicle-ledger
    // movement, separate from receipt payments, company balances, and kartas.
    const openVehicleBalanceEntry = e.target.closest('[data-action="open-balance-entry"]');
    if (openVehicleBalanceEntry) {
      await _openVehicleBalanceEntryModal(openVehicleBalanceEntry.dataset.entryType);
      return;
    }
    if (e.target.closest('[data-action="close-vehicle-balance-entry"]')) {
      _closeVehicleBalanceEntryModal();
      return;
    }
    if (e.target.closest('[data-action="save-vehicle-balance-entry"]')) {
      await _saveVehicleBalanceEntry();
      return;
    }

    // Kartas status filter (Phase 8) — pure in-memory UI state; no queries, no writes
    const kartaFilterBtn = e.target.closest('[data-action="karta-status-filter"]');
    if (kartaFilterBtn) {
      _kartaStatusFilter = ['settled', 'unsettled'].includes(kartaFilterBtn.dataset.filter)
        ? kartaFilterBtn.dataset.filter
        : 'all';
      _applyKartaFilters();
      return;
    }

    if (e.target.closest('[data-action="settle-unsettled-kartas"]')) {
      await _settleUnsettledKartasBatch();
      return;
    }

    // Settled Karta price edit: this updates only receipt_rows.driver_settlement_price.
    const editKartaPrice = e.target.closest('[data-action="edit-karta-settlement-price"]');
    if (editKartaPrice) {
      _openKartaSettlementPriceModal(editKartaPrice.dataset.rowId);
      return;
    }
    if (e.target.closest('[data-action="close-karta-settlement-price"]')) {
      _closeKartaSettlementPriceModal();
      return;
    }
    if (e.target.closest('[data-action="save-karta-settlement-price"]')) {
      await _saveKartaSettlementPriceModal();
      return;
    }

    // Direct driver Deposit / Withdrawal modal.
    const openDriverBalanceEntry = e.target.closest('[data-action="open-driver-balance-entry"]');
    if (openDriverBalanceEntry) {
      await _openDriverBalanceEntryModal(openDriverBalanceEntry.dataset.entryType);
      return;
    }
    if (e.target.closest('[data-action="close-driver-balance-entry"]')) {
      _closeDriverBalanceEntryModal();
      return;
    }
    if (e.target.closest('[data-action="save-driver-balance-entry"]')) {
      await _saveDriverBalanceEntry();
      return;
    }

    // Edit a direct driver movement through the same amount/date/note modal.
    const editTxBtn = e.target.closest('[data-action="edit-driver-tx"]');
    if (editTxBtn) {
      const refId = editTxBtn.dataset.refId;
      const txEntry = _driverLedgerCache.find(entry => entry.reference_id === refId);
      if (txEntry?.reference_type === 'manual_driver_balance'
        && txEntry.effect === 'manual_driver_balance') {
        await _openDriverBalanceEntryModal(txEntry.type, txEntry);
      }
      return;
    }

    // Delete a direct driver movement by audit-preserving reversal, never hard delete.
    const delTxBtn = e.target.closest('[data-action="delete-driver-tx"]');
    if (delTxBtn) {
      const refId = delTxBtn.dataset.refId;
      const txEntry = _driverLedgerCache.find(entry => entry.reference_id === refId);
      if (!txEntry || txEntry.reference_type !== 'manual_driver_balance'
        || txEntry.effect !== 'manual_driver_balance' || !confirm('هل تريد حذف هذه الحركة؟')) return;
      try {
        const username = _currentUsername();
        await FinancialService.deleteManualDriverBalanceEntry(username, refId);
        const driverId = _getCurrentDriverId();
        if (driverId) await showDriverDetails(driverId);
      } catch (err) {
        alert(err.message || '❌ فشل حذف الحركة');
      }
      return;
    }

    // Switch owners sub-tab
    if (e.target.closest('[data-action="switch-owners-subtab"]')) {
      const subtab = e.target.closest('[data-action="switch-owners-subtab"]').dataset.subtab;
      if (subtab && (_ownersActiveSubTab !== subtab)) {
        _ownersActiveSubTab = subtab;
        await loadOwners();
      }
      return;
    }

    // Add driver
    if (e.target.closest('[data-action="add-driver"]')) {
      _openDriverModal(null);
      return;
    }
    if (e.target.closest('[data-action="close-driver-modal"]')) {
      document.getElementById('driverModal')?.classList.add('hidden');
      return;
    }
    if (e.target.closest('[data-action="save-driver-modal"]')) {
      await _saveDriver();
      return;
    }

    // Edit driver
    const editDriverBtn = e.target.closest('[data-action="edit-driver"]');
    if (editDriverBtn) {
      const id = editDriverBtn.dataset.id;
      try {
        const driver = await ClientRepository.getDriverById(String(id));
        if (driver) _openDriverModal(driver);
      } catch (err) {
        alert(err.message || '❌ فشل تحميل بيانات السائق');
      }
      return;
    }

    // Delete driver
    const delDriverBtn = e.target.closest('[data-action="delete-driver"]');
    if (delDriverBtn) {
      const id = delDriverBtn.dataset.id;
      if (!confirm('هل تريد حذف هذا السائق؟')) return;
      try {
        await ClientRepository.deleteDriver(String(id), { username: _currentUsername() });
        await loadOwners();
      } catch (err) {
        alert(err.message || '❌ فشل الحذف');
      }
      return;
    }

    // View driver details
    if (e.target.closest('[data-action="view-driver"]')) {
      const id = e.target.closest('[data-action="view-driver"]').dataset.id;
      if (id) {
        _handleViewDriver(id);
      }
      return;
    }

    // Add owner
    if (e.target.closest('[data-action="add-owner-type"]')) {
      _openAddModal('إضافة مركبة', 'owner');
      return;
    }

    // Print
    if (e.target.closest('[data-action="print-owners"]')) {
      _printEntities('all');
      return;
    }

    // Excel export/import
    if (e.target.closest('[data-action="export-owners-excel"]')) {
      await _handleExportOwnersExcel();
      return;
    }
    if (e.target.closest('[data-action="import-owners-excel"]')) {
      _handleImportOwnersExcel();
      return;
    }

    // Edit account (owners only)
    const editBtn = e.target.closest('[data-action="edit-account"]');
    if (editBtn) {
      const id = editBtn.dataset.id;
      const kind = editBtn.dataset.kind || 'owner';
      if (kind !== 'owner') return;
      let currentNumber = '';
      try {
        const owner = await ClientRepository.getOwnerById(String(id));
        currentNumber = owner?.vehicle_number || '';
      } catch (_) {}
      _openEditModal(id, 'owner', currentNumber);
      return;
    }

    // Delete account (owners only)
    const delBtn = e.target.closest('[data-action="delete-account"]');
    if (delBtn) {
      const id = delBtn.dataset.id;
      const kind = delBtn.dataset.kind || 'owner';
      if (kind !== 'owner') return;
      if (!confirm('هل تريد حذف هذا الحساب؟')) return;
      try {
        await OwnersModule.deleteOwner(_currentUsername(), String(id));
        window.dispatchEvent(new CustomEvent('owners:changed'));
        await loadOwners();
      } catch (err) {
        alert(err.message || '❌ فشل الحذف');
      }
      return;
    }

    // View client details
    const viewBtn = e.target.closest('[data-action="view-client"]');
    if (viewBtn) {
      await showOwnerDetails(viewBtn.dataset.id, 'owner', viewBtn.dataset.vehicleId || null);
      return;
    }

    // Reset driver filters
    if (e.target.closest('[data-action="driver-reset-filters"]')) {
      const fromEl = document.getElementById('driverFromDate');
      const toEl = document.getElementById('driverToDate');
      const searchEl = document.getElementById('driverSearchQuery');
      if (fromEl) fromEl.value = '';
      if (toEl) toEl.value = '';
      if (searchEl) searchEl.value = '';
      _renderDriverLedgerTable(_driverLedgerCache);
      return;
    }

    // Driver details tabs (Phase 6 — UI separation)
    if (e.target.closest('[data-action="driver-tab-kartas"]')) {
      _setDriverDetailsTab('kartas');
      return;
    }
    if (e.target.closest('[data-action="driver-tab-ledger"]')) {
      _setDriverDetailsTab('ledger');
      return;
    }

    // Back to drivers list
    if (e.target.closest('[data-action="back-to-drivers"]')) {
      if (typeof window.showPage === 'function') {
        _ownersActiveSubTab = 'drivers';
        await window.showPage('ownersPage');
      }
      await loadOwners();
      return;
    }

    // Back to list
    if (e.target.closest('[data-action="back-to-customers"]') || e.target.closest('[data-action="back-to-accounts"]')) {
      if (typeof window.showPage === 'function') {
        await window.showPage('ownersPage');
      }
      await loadOwners();
      return;
    }

    // Add modal controls
    if (e.target.closest('[data-action="close-add-modal"]')) {
      document.getElementById('ownerAddModal')?.classList.add('hidden');
      return;
    }
    if (e.target.closest('[data-action="save-add-modal"]')) {
      await _saveFromAddModal();
      return;
    }
    if (e.target.closest('[data-action="add-modal-add-row"]')) {
      const tbody = document.getElementById('addModalRows');
      if (!tbody) return;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="text" class="input input-sm add-m-vehicle-number" placeholder="رقم المركبة"></td>
        <td><button type="button" data-action="add-modal-remove-row" class="btn btn-secondary btn-sm">حذف</button></td>`;
      tbody.appendChild(tr);
      return;
    }
    if (e.target.closest('[data-action="add-modal-remove-row"]')) {
      e.target.closest('tr')?.remove();
      return;
    }

    // Vehicles
    if (e.target.closest('[data-action="add-vehicle-manual"]')) {
      if (!_selectedClient) return;
      _openVehicleModal('إضافة مركبة', '', _selectedClient.id, null);
      return;
    }
    const editVeh = e.target.closest('[data-action="edit-vehicle"]');
    if (editVeh) {
      _openVehicleModal('تعديل مركبة', editVeh.dataset.plate || '', editVeh.dataset.ownerId || _selectedClient?.id, editVeh.dataset.id);
      return;
    }
    const delVeh = e.target.closest('[data-action="delete-vehicle"]');
    if (delVeh) {
      if (!confirm('حذف المركبة؟')) return;
      try {
        await ClientRepository.deleteVehicle(delVeh.dataset.id, { username: _currentUsername() });
        if (_selectedClient) await showOwnerDetails(_selectedClient.id, 'owner', _selectedVehicle?.id);
      } catch (err) {
        alert(err.message || '❌ فشل حذف المركبة');
      }
      return;
    }
    if (e.target.closest('[data-action="vehicle-modal-close"]')) {
      document.getElementById('vehicleModal')?.classList.add('hidden');
      return;
    }
    if (e.target.closest('[data-action="vehicle-modal-save"]')) {
      const modal = document.getElementById('vehicleModal');
      if (!modal) return;
      const plate = document.getElementById('vehicleModalPlate')?.value?.trim() || '';
      const ownerId = modal.dataset.ownerId || _selectedClient?.id;
      const editId = modal.dataset.editId || null;
      if (!plate || !ownerId) {
        alert('❌ رقم المركبة مطلوب');
        return;
      }
      try {
        const username = _currentUsername();
        // Vehicles carry NO driver attribute (Phase 6 — driver per receipt row):
        // the driver relationship lives exclusively on receipt_rows.driver_id.
        const vehiclePayload = { plate, owner_id: String(ownerId) };
        if (editId) {
          await ClientRepository.updateVehicle(editId, vehiclePayload, { username });
        } else {
          await ClientRepository.saveVehicle({ username, ...vehiclePayload }, { username });
        }
        modal.classList.add('hidden');
        if (_selectedClient) await showOwnerDetails(_selectedClient.id, 'owner', _selectedVehicle?.id);
      } catch (err) {
        alert(err.message || '❌ فشل حفظ المركبة');
      }
      return;
    }
  });

  document.addEventListener('focusin', (e) => {
    if (e.target.id === 'vehicleMaintenanceType') {
      _renderMaintenanceTypeSuggestions(e.target.value);
    }
  });

  document.addEventListener('change', async (e) => {
    if (e.target.id === 'vehicleMonthlyReportMonth') {
      _vehicleMonthlyReportState.monthKey = e.target.value || '';
      await _loadVehicleMonthlyReport();
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'vehicleMaintenanceType') {
      _renderMaintenanceTypeSuggestions(e.target.value);
      return;
    }
    if (e.target.id === 'vehicleMaintenanceSearch') {
      _maintenanceSearchQuery = e.target.value || '';
      _refreshMaintenanceTable();
      return;
    }
    if (e.target.id === 'vehicleFinancialSearch') {
      _vehicleFinancialSearchQuery = e.target.value || '';
      _refreshVehicleFinancialTable();
    }
  });

}


window.addEventListener('owners:changed', () => {
  // Only refresh details if details page is currently visible
  const detailsPage = document.getElementById('ownerDetailsPage');
  if (detailsPage && !detailsPage.classList.contains('hidden') && _selectedClient?.type === 'owner') {
    showOwnerDetails(_selectedClient.id, 'owner', _selectedVehicle?.id);
  }
  loadOwners();
});

window.addEventListener('receipt-financial:changed', (event) => {
  const vehicleId = String(event.detail?.vehicle_id || '');
  const detailsPage = document.getElementById('ownerDetailsPage');
  if (vehicleId && detailsPage && !detailsPage.classList.contains('hidden')
    && String(_selectedVehicle?.id || '') === vehicleId && _selectedClient?.type === 'owner') {
    showOwnerDetails(_selectedClient.id, 'owner', vehicleId);
  }
  // The list projection always rebuilds balances from vehicle_ledger.
  loadOwners();
});

window.showOwnerDetails = showOwnerDetails;

export {
  VehiclesModule,
  resolveVehicle,
  OwnersModule,
  createOwner,
  getAllOwners,
  updateOwner,
  deleteOwner,
  getOwnerById,
  getClientByType,
  getOwnerVehicles,
  addAccount,
  loadOwners,
  attachOwnersPageListeners,
  showOwnerDetails,
};
