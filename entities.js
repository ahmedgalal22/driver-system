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
let _editingDriverId = null;
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

  // Salfa
  if (refType === 'salfa') {
    return note || 'سلفة';
  }
  if (refType === 'salfa_recovery') {
    return note || 'استرداد سلفة';
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

async function _getVehicleOwnerListBalance(owner) {
  const plate = String(owner?.vehicle_number || '').trim();
  if (!plate) return 0;
  const candidates = await ClientRepository.getVehiclesByPlate(plate);
  const vehicle = (candidates || []).find(v => String(v.owner_id || '') === String(owner.id)) || null;
  if (!vehicle) return 0;
  return (await FinancialService.rebuildVehicleBalance(vehicle.id)).balance;
}

function _buildClientRow(client, kartaCount, balance, kind) {
  const vNumber = client.vehicle_number || '';
  return `
    <tr data-client-number="${(vNumber || '').toLowerCase()}">
      <td data-action="view-client" data-id="${client.id}" data-type="owner" class="ent-name-cell ent-name-cell--blue">
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
      balance: await _getVehicleOwnerListBalance(owner),
    })));
    const sortedOwners = [...ownerList].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

    if (sortedOwners.length === 0) {
      ownersTbody.innerHTML = '<tr><td colspan="4" class="text-muted text-center p-6">لا توجد بيانات</td></tr>';
    } else {
      ownersTbody.innerHTML = sortedOwners.map((client) => {
        const idx = ownerList.indexOf(client);
        const stats = ownerStats[idx];
        return _buildClientRow(client, stats.kartaCount, stats.balance, 'owner');
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

let _editingDriverRefId = null;

async function _openDriverDepositModal(txEntry = null) {
  _editingDriverRefId = txEntry ? txEntry.reference_id : null;
  const modal = document.getElementById('driverDepositModal');
  const vehicleSelect = document.getElementById('driverDepositVehicle');
  const amountEl = document.getElementById('driverDepositAmount');
  const dateEl = document.getElementById('driverDepositDate');
  const noteEl = document.getElementById('driverDepositNote');
  const msgEl = document.getElementById('driverDepositMsg');

  if (msgEl) { msgEl.textContent = ''; msgEl.classList.remove('is-visible'); }
  if (dateEl) dateEl.value = txEntry?.date || DateUtils.todayLocal();
  if (amountEl) amountEl.value = txEntry ? Money.toDecimal(Math.abs(Number(txEntry.amount) || 0)) : '';
  if (noteEl) noteEl.value = txEntry?.note || '';

  const vehicles = await ClientRepository.getAllVehicles();
  if (vehicleSelect) {
    vehicleSelect.innerHTML = '<option value="">اختر المركبة المصدر...</option>' + vehicles.filter(v => v.deleted_at === null).map(v => `
      <option value="${v.id}" ${txEntry && String(txEntry.vehicle_id) === String(v.id) ? 'selected' : ''}>${v.plate} ${v.owner_name ? '(' + v.owner_name + ')' : ''}</option>
    `).join('');
  }

  modal?.classList.remove('hidden');
}

function _closeDriverDepositModal() {
  document.getElementById('driverDepositModal')?.classList.add('hidden');
  _editingDriverRefId = null;
}

async function _saveDriverDeposit() {
  const msgEl = document.getElementById('driverDepositMsg');
  const vehicleId = document.getElementById('driverDepositVehicle')?.value;
  const amount = parseFloat(document.getElementById('driverDepositAmount')?.value) || 0;
  const date = document.getElementById('driverDepositDate')?.value;
  const note = document.getElementById('driverDepositNote')?.value || '';

  if (!vehicleId) {
    if (msgEl) { msgEl.textContent = '❌ المركبة المصدر مطلوبة'; msgEl.classList.add('is-visible'); }
    return;
  }
  if (amount <= 0) {
    if (msgEl) { msgEl.textContent = '❌ المبلغ يجب أن يكون أكبر من صفر'; msgEl.classList.add('is-visible'); }
    return;
  }
  if (!date) {
    if (msgEl) { msgEl.textContent = '❌ التاريخ مطلوب'; msgEl.classList.add('is-visible'); }
    return;
  }

  const username = _currentUsername();
  try {
    if (_editingDriverRefId) {
      await FinancialService.updateDriverDeposit(username, _editingDriverRefId, {
        driver_id: _getCurrentDriverId(),
        vehicle_id: vehicleId,
        amount,
        date,
        note,
      });
    } else {
      await FinancialService.createDriverDeposit(username, {
        driver_id: _getCurrentDriverId(),
        vehicle_id: vehicleId,
        amount,
        date,
        note,
      });
    }

    _closeDriverDepositModal();
    const did = _getCurrentDriverId();
    if (did) await showDriverDetails(did);
  } catch (err) {
    if (msgEl) { msgEl.textContent = err.message || '❌ فشل حفظ الإيداع'; msgEl.classList.add('is-visible'); }
  }
}

async function _openDriverSalfaModal(txEntry = null) {
  _editingDriverRefId = txEntry ? txEntry.reference_id : null;
  const modal = document.getElementById('driverSalfaModal');
  const amountEl = document.getElementById('driverSalfaAmount');
  const dateEl = document.getElementById('driverSalfaDate');
  const noteEl = document.getElementById('driverSalfaNote');
  const msgEl = document.getElementById('driverSalfaMsg');

  if (msgEl) { msgEl.textContent = ''; msgEl.classList.remove('is-visible'); }
  if (dateEl) dateEl.value = txEntry?.date || DateUtils.todayLocal();
  if (amountEl) amountEl.value = txEntry ? Money.toDecimal(Math.abs(Number(txEntry.amount) || 0)) : '';
  if (noteEl) noteEl.value = txEntry?.note || '';

  modal?.classList.remove('hidden');
}

function _closeDriverSalfaModal() {
  document.getElementById('driverSalfaModal')?.classList.add('hidden');
  _editingDriverRefId = null;
}

async function _saveDriverSalfa() {
  const msgEl = document.getElementById('driverSalfaMsg');
  const amount = parseFloat(document.getElementById('driverSalfaAmount')?.value) || 0;
  const date = document.getElementById('driverSalfaDate')?.value;
  const note = document.getElementById('driverSalfaNote')?.value || '';

  if (amount <= 0) {
    if (msgEl) { msgEl.textContent = '❌ المبلغ يجب أن يكون أكبر من صفر'; msgEl.classList.add('is-visible'); }
    return;
  }
  if (!date) {
    if (msgEl) { msgEl.textContent = '❌ التاريخ مطلوب'; msgEl.classList.add('is-visible'); }
    return;
  }

  const username = _currentUsername();
  try {
    if (_editingDriverRefId) {
      await FinancialService.updateDriverSalfa(username, _editingDriverRefId, {
        driver_id: _getCurrentDriverId(),
        amount,
        date,
        note,
      });
    } else {
      await FinancialService.createDriverSalfa(username, {
        driver_id: _getCurrentDriverId(),
        amount,
        date,
        note,
      });
    }

    _closeDriverSalfaModal();
    const did = _getCurrentDriverId();
    if (did) await showDriverDetails(did);
  } catch (err) {
    if (msgEl) { msgEl.textContent = err.message || '❌ فشل حفظ السلفة'; msgEl.classList.add('is-visible'); }
  }
}

function _openDriverSalfaRecoveryModal() {
  const modal = document.getElementById('driverSalfaRecoveryModal');
  const amountEl = document.getElementById('driverSalfaRecoveryAmount');
  const dateEl = document.getElementById('driverSalfaRecoveryDate');
  const noteEl = document.getElementById('driverSalfaRecoveryNote');
  const msgEl = document.getElementById('driverSalfaRecoveryMsg');

  if (msgEl) { msgEl.textContent = ''; msgEl.classList.remove('is-visible'); }
  if (amountEl) amountEl.value = '';
  if (dateEl) dateEl.value = DateUtils.todayLocal();
  if (noteEl) noteEl.value = 'استرداد سلفة';
  modal?.classList.remove('hidden');
}

function _closeDriverSalfaRecoveryModal() {
  document.getElementById('driverSalfaRecoveryModal')?.classList.add('hidden');
}

async function _saveDriverSalfaRecovery() {
  const msgEl = document.getElementById('driverSalfaRecoveryMsg');
  const amount = parseFloat(document.getElementById('driverSalfaRecoveryAmount')?.value) || 0;
  const date = document.getElementById('driverSalfaRecoveryDate')?.value || '';
  const note = document.getElementById('driverSalfaRecoveryNote')?.value?.trim() || 'استرداد سلفة';

  if (amount <= 0 || !date) {
    if (msgEl) {
      msgEl.textContent = amount <= 0 ? '❌ المبلغ يجب أن يكون أكبر من صفر'
        : '❌ التاريخ مطلوب';
      msgEl.classList.add('is-visible');
    }
    return;
  }

  try {
    await FinancialService.createDriverSalfaRecovery(_currentUsername(), {
      driver_id: _getCurrentDriverId(),
      amount,
      date,
      note,
    });
    _closeDriverSalfaRecoveryModal();
    const did = _getCurrentDriverId();
    if (did) await showDriverDetails(did);
  } catch (err) {
    if (msgEl) { msgEl.textContent = err.message || '❌ فشل حفظ استرداد السلفة'; msgEl.classList.add('is-visible'); }
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
    const typeStr = _ledgerType(entry.type);
    const refStr = entry.vehicle_plate || entry.reference_number || entry.reference_id || '—';
    const amtStr = _fmt(entry.amount);
    const balStr = _fmt(entry.running_balance);
    const descStr = _ledgerNote(entry);

    const canEdit = entry.reference_id && (entry.reference_type === 'driver_deposit' || entry.reference_type === 'salfa');
    const canDelete = canEdit || (entry.reference_id && entry.reference_type === 'salfa_recovery');
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

  let totalSalfaCents = 0;
  for (const e of _driverLedgerCache) {
    if (e.reference_type === 'salfa' || e.type === 'salfa' || e.effect === 'salfa') {
      totalSalfaCents += Math.abs(Money.toCents(e.amount));
    }
    if (e.reference_type === 'salfa_recovery' || e.effect === 'salfa_recovery') {
      totalSalfaCents -= Math.abs(Money.toCents(e.amount));
    }
  }

  const nameEl = document.getElementById('driverDetailsName');
  const balanceEl = document.getElementById('driverDetailsBalance');
  const phoneEl = document.getElementById('driverDetailsPhone');
  const salfaEl = document.getElementById('driverDetailsSalfa');

  if (nameEl) nameEl.textContent = driver.name || '—';
  if (balanceEl) {
    balanceEl.textContent = _fmt(balanceData.balance);
    balanceEl.className = 'text-3xl font-bold mb-2 ' + _balanceClass(balanceData.balance);
  }
  if (phoneEl) phoneEl.textContent = driver.phone || '—';
  if (salfaEl) salfaEl.textContent = Money.fmt(Money.toDecimal(totalSalfaCents));

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
  // post-mutation refreshes (deposit/salfa/karta settlement/tx delete).
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
      FinancialService.getDriverKartasSummary(driverId)
    ]);
    _currentKartas = kartas; // stashed for the settlement modal (row vehicle preselect)

    // Summary cards
    summaryContainer.innerHTML = `
      <div class="card p-4"><div class="text-xs text-muted">إجمالي الكارتات</div><div class="text-2xl font-bold">${summary.total_kartas}</div></div>
      <div class="card p-4"><div class="text-xs text-muted">غير مدفوعة</div><div class="text-2xl font-bold text-red-600">${summary.unpaid_kartas}</div></div>
      <div class="card p-4"><div class="text-xs text-muted">مدفوعة بالكامل</div><div class="text-2xl font-bold text-green-600">${summary.paid_kartas}</div></div>
      <div class="card p-4"><div class="text-xs text-muted">إجمالي السعر</div><div id="kartaFilteredTotalPrice" class="text-xl font-bold">${_fmt(summary.total_price)}</div></div>
    `;

    // Table rows — rendered through the Phase 8 in-memory status+search filter
    // so the user's current filter selection and search text stay applied on
    // every refresh (settlement create/edit, re-entry).
    _applyKartaFilters(tbody, driverId);

    // Client-side search (composes with the status filter; in-memory only)
    if (searchInput && !searchInput.dataset.bound) {
      searchInput.dataset.bound = '1';
      searchInput.addEventListener('input', () => _applyKartaFilters(tbody, driverId));
    }
  } catch (err) {
    console.error('[entities] Failed to load kartas tab', err);
    tbody.innerHTML = `<tr><td colspan="8" class="text-red-600 text-center p-6">فشل تحميل الكارتات</td></tr>`;
  }
}

let _currentKartaRowId = null;
let _kartaSettlementMode = 'create'; // 'create' (تسوية) | 'edit' (تعديل التسوية)
let _currentKartas = []; // last kartas dataset loaded for the open Driver Details page
let _kartaStatusFilter = 'all'; // Phase 8: 'all' (paid+partial+unpaid) | 'settled' (status !== 'unpaid') | 'unsettled' (status === 'unpaid') — preserved across tab refreshes and settlement create/edit

/** Sync the status-filter buttons' active styling to the current filter state. */
function _syncKartaFilterButtons() {
  document.querySelectorAll('[data-action="karta-status-filter"]').forEach(btn => {
    const active = btn.dataset.filter === _kartaStatusFilter;
    btn.classList.toggle('active-purple', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function _sumKartaPrices(kartas) {
  const cents = (kartas || []).reduce(
    (sum, karta) => sum + Money.toCents(karta?.price ?? 0),
    0
  );
  return Money.toDecimal(cents);
}

function _renderFilteredKartaPriceTotal(kartas) {
  const totalEl = document.getElementById('kartaFilteredTotalPrice');
  if (totalEl) totalEl.textContent = _fmt(_sumKartaPrices(kartas));
}

/**
 * Phase 8 — status filter + search text, composed ENTIRELY in memory over
 * _currentKartas (no FinancialService call, no IndexedDB query, no writes).
 * Reading the search input live keeps both status AND search text applied
 * automatically after every tab refresh (create/edit settlement, re-entry).
 */
function _applyKartaFilters(tbody, driverId) {
  const target = tbody || document.getElementById('kartaTableBody');
  if (!target) return;
  const q = (document.getElementById('kartaSearchInput')?.value || '').trim().toLowerCase();
  const filtered = _currentKartas.filter(k => {
    if (_kartaStatusFilter === 'settled' && k.status === 'unpaid') return false; // settled = status !== 'unpaid' (future-proof: partial or any new settled-ish status appears automatically)
    if (_kartaStatusFilter === 'unsettled' && k.status !== 'unpaid') return false; // unsettled = status === 'unpaid' only
    if (q && !Object.values(k).some(v => String(v || '').toLowerCase().includes(q))) return false;
    return true;
  });
  _renderKartaTable(filtered, target, driverId);
  _renderFilteredKartaPriceTotal(filtered);
  _syncKartaFilterButtons();
}

async function _openKartaSettlementModal(rowId, mode = 'create') {
  _currentKartaRowId = rowId;
  _kartaSettlementMode = mode === 'edit' ? 'edit' : 'create';
  const modal = document.getElementById('kartaSettlementModal');
  const amountEl = document.getElementById('kartaSettlementAmount');
  const vehicleEl = document.getElementById('kartaSettlementVehicle');
  const dateEl = document.getElementById('kartaSettlementDate');
  const noteEl = document.getElementById('kartaSettlementNote');
  const msgEl = document.getElementById('kartaSettlementMsg');
  const titleEl = document.getElementById('kartaSettlementTitle');
  const saveBtnEl = document.getElementById('kartaSettlementSaveBtn');

  // Same dialog, two modes: create (تسوية) vs edit (تعديل التسوية).
  if (titleEl) titleEl.textContent = _kartaSettlementMode === 'edit' ? 'تعديل التسوية' : 'تسوية كارتة';
  if (saveBtnEl) saveBtnEl.textContent = _kartaSettlementMode === 'edit' ? '💾 حفظ التعديل' : '💾 حفظ التسوية';

  // The user selects the vehicle to charge (workflow step 3). Options = EVERY
  // active registered vehicle (business rule: no username scoping — vehicles
  // created through the receipt flow carry no username key); preselect the
  // karta row's own vehicle.
  if (vehicleEl) {
    const vehicles = (await ClientRepository.getAllVehicles())
      .filter(v => v && v.deleted_at == null);
    vehicleEl.innerHTML = '<option value="">— اختر المركبة —</option>'
      + vehicles.map(v => `<option value="${v.id}">${String(v.plate || '').replace(/</g, '&lt;')}</option>`).join('');
    const k = _currentKartas.find(k => String(k.row_id) === String(rowId));
    if (k?.vehicle_id && [...vehicleEl.options].some(o => o.value === String(k.vehicle_id))) {
      vehicleEl.value = String(k.vehicle_id);
    }
  }

  if (msgEl) { msgEl.textContent = ''; msgEl.classList.remove('is-visible'); }
  if (amountEl) amountEl.value = '';
  if (dateEl) dateEl.value = DateUtils.todayLocal();
  if (noteEl) noteEl.value = '';

  if (_kartaSettlementMode === 'edit') {
    // Prefill from the CURRENT active settlement (the same logical settlement
    // being edited) — price, charged vehicle, date, note.
    const history = await FinancialService.getKartaSettlementHistory(rowId);
    const active = (history || []).filter(e => e.is_reversed === false);
    const cur = active[active.length - 1];
    if (!cur) {
      if (msgEl) { msgEl.textContent = '❌ لا توجد تسوية نشطة لهذه الكارتة'; msgEl.classList.add('is-visible'); }
      modal?.classList.remove('hidden');
      return;
    }
    if (amountEl) amountEl.value = typeof cur.price === 'number' ? cur.price : Math.abs(Number(cur.amount) || 0);
    if (vehicleEl && cur.vehicle_id && [...vehicleEl.options].some(o => o.value === String(cur.vehicle_id))) {
      vehicleEl.value = String(cur.vehicle_id);
    }
    if (dateEl && cur.date) dateEl.value = cur.date;
    if (noteEl) noteEl.value = cur.note || '';
  }

  modal?.classList.remove('hidden');
}

function _closeKartaSettlementModal() {
  document.getElementById('kartaSettlementModal')?.classList.add('hidden');
  _currentKartaRowId = null;
  _kartaSettlementMode = 'create';
}

async function _saveKartaSettlement() {
  const msgEl = document.getElementById('kartaSettlementMsg');
  const amount = parseFloat(document.getElementById('kartaSettlementAmount')?.value) || 0;
  const chargeVehicleId = document.getElementById('kartaSettlementVehicle')?.value || '';
  const date = document.getElementById('kartaSettlementDate')?.value;
  const note = document.getElementById('kartaSettlementNote')?.value || '';

  if (!_currentKartaRowId) return;
  if (amount <= 0) {
    if (msgEl) { msgEl.textContent = '❌ السعر يجب أن يكون أكبر من صفر'; msgEl.classList.add('is-visible'); }
    return;
  }
  if (!chargeVehicleId) {
    if (msgEl) { msgEl.textContent = '❌ يجب اختيار المركبة المحمَّل عليها'; msgEl.classList.add('is-visible'); }
    return;
  }
  if (!date) {
    if (msgEl) { msgEl.textContent = '❌ التاريخ مطلوب'; msgEl.classList.add('is-visible'); }
    return;
  }

  const username = _currentUsername();
  const mode = _kartaSettlementMode;
  try {
    const payload = {
      row_id: _currentKartaRowId,
      amount, // enters the settlement AND becomes the karta's settlement price (السعر)
      vehicle_id: chargeVehicleId,
      date,
      note: note || undefined
    };
    if (mode === 'edit') {
      // Updates the EXISTING settlement (same logical settlement, one active) —
      // never creates a second one.
      await FinancialService.updateKartaSettlement(username, payload);
    } else {
      await FinancialService.createKartaSettlement(username, payload);
    }

    _closeKartaSettlementModal();

    const driverId = _getCurrentDriverId();
    if (driverId) {
      if (mode === 'edit') {
        // Full refresh, no manual reload: driver balance, driver ledger,
        // settlement history, kartas table + summary cards (active tab kept);
        // then emit owners:changed so any open vehicle/owner balance view
        // re-derives from the updated ledger.
        await showDriverDetails(driverId);
        window.dispatchEvent(new CustomEvent('owners:changed'));
      } else {
        await _loadDriverKartasTab(driverId);
      }
    }
  } catch (err) {
    if (msgEl) { msgEl.textContent = err.message || '❌ فشل حفظ التسوية'; msgEl.classList.add('is-visible'); }
  }
}

function _renderKartaTable(kartas, tbody, driverId) {
  if (!Array.isArray(kartas) || kartas.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-muted text-center p-6">لا توجد كارتات</td></tr>`;
    return;
  }

  tbody.innerHTML = kartas.map(k => {
    // Unpaid → create (تسوية). Paid/Partial → edit the existing settlement
    // (تعديل التسوية) — the settlement stays one logical settlement.
    const settleBtn = k.status === 'unpaid'
      ? `<button type="button" data-action="open-karta-settlement" data-row-id="${k.row_id}" class="btn btn-primary btn-sm">تسوية</button>`
      : `<button type="button" data-action="edit-karta-settlement" data-row-id="${k.row_id}" class="btn btn-primary btn-sm">تعديل التسوية</button>`;

    return `
      <tr data-row-id="${k.row_id}">
        <td>${_dateLabel(k.date)}</td>
        <td>${k.vehicle_plate || '—'}</td>
        <td>${k.company || '—'}</td>
        <td>${k.loading || '—'}</td>
        <td>${k.destination || '—'}</td>
        <td>${_fmt(k.advance)}</td>
        <td class="font-semibold">${k.price == null ? '—' : _fmt(k.price)}</td>
        <td>
          <span class="px-2 py-0.5 rounded text-xs font-medium ${k.status === 'paid' ? 'bg-green-100 text-green-700' : k.status === 'partial' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}">${k.status}</span>
          ${settleBtn}
        </td>
      </tr>
    `;
  }).join('');
}

function _openDriverModal(driver = null) {
  _editingDriverId = driver ? driver.id : null;
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
    if (_editingDriverId) {
      await ClientRepository.updateDriver(_editingDriverId, {
        name,
        phone: phone || null,
      }, { username });
    } else {
      await ClientRepository.saveDriver({
        username,
        name,
        phone: phone || null,
      }, { username });
    }

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
 * Owner Details is the current vehicle/customer details surface. A vehicle
 * owner may have more than one linked vehicle, so aggregate the authoritative
 * per-vehicle rebuild result and the matching read-only movements. No balance
 * is persisted or posted here.
 */
async function _getOwnerVehicleFinancials(ownerId) {
  const vehicles = await OwnersModule.getOwnerVehicles(ownerId);
  const projections = await Promise.all(vehicles.map(async (vehicle) => {
    const [balance, ledger] = await Promise.all([
      FinancialService.rebuildVehicleBalance(vehicle.id),
      FinancialService.getVehicleLedger(vehicle.id),
    ]);
    return { balance, ledger };
  }));

  const balanceCents = projections.reduce(
    (sum, projection) => sum + Money.toCents(projection.balance.balance),
    0
  );
  const ledger = projections
    .flatMap(projection => projection.ledger)
    .sort((a, b) => {
      const db = new Date(b.date || b.applied_at || b.created_at || 0).getTime();
      const da = new Date(a.date || a.applied_at || a.created_at || 0).getTime();
      return db - da;
    });

  return {
    balance: Money.toDecimal(balanceCents),
    ledger,
  };
}

// ── Vehicle Details tabs + structured manual maintenance metadata ────────────
// Maintenance remains a normal `manual_vehicle_balance` withdrawal. These
// fields only classify the existing active vehicle-ledger movement for UI.
const MAINTENANCE_TYPE_SUGGESTIONS = Object.freeze([
  'جاز', 'فلاتر', 'زيت', 'كاوتش', 'ميكانيكي', 'اكسسوارت',
]);
let _vehicleDetailsTab = 'financial';
let _maintenanceVehicleFilter = '';
let _maintenanceEntriesCache = [];
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
  _vehicleDetailsTab = tab === 'maintenance' ? 'maintenance' : 'financial';
  const financialPanel = document.getElementById('vehicleDetailsTabFinancial');
  const maintenancePanel = document.getElementById('vehicleDetailsTabMaintenance');
  const financialButton = document.getElementById('vehicleDetailsTabBtnFinancial');
  const maintenanceButton = document.getElementById('vehicleDetailsTabBtnMaintenance');
  const isFinancial = _vehicleDetailsTab === 'financial';

  if (financialPanel) financialPanel.classList.toggle('hidden', !isFinancial);
  if (maintenancePanel) maintenancePanel.classList.toggle('hidden', isFinancial);
  if (financialButton) {
    financialButton.classList.toggle('active-purple', isFinancial);
    financialButton.setAttribute('aria-selected', String(isFinancial));
  }
  if (maintenanceButton) {
    maintenanceButton.classList.toggle('active-purple', !isFinancial);
    maintenanceButton.setAttribute('aria-selected', String(!isFinancial));
  }
}

async function _renderMaintenanceTab(client, ledger = []) {
  const vehicles = await OwnersModule.getOwnerVehicles(client.id);
  const activeMaintenance = (ledger || []).filter(_isActiveMaintenanceEntry);
  _maintenanceEntriesCache = activeMaintenance;

  const validFilter = vehicles.some(vehicle => String(vehicle.id) === String(_maintenanceVehicleFilter));
  if (!validFilter) {
    _maintenanceVehicleFilter = vehicles.length === 1 ? String(vehicles[0].id) : '';
  }

  const selectedVehicleId = _maintenanceVehicleFilter;
  const entries = selectedVehicleId
    ? activeMaintenance.filter(entry => String(entry.vehicle_id) === selectedVehicleId)
    : [];
  const selectedVehicle = vehicles.find(vehicle => String(vehicle.id) === selectedVehicleId) || null;
  const selectorOptions = vehicles.map(vehicle => `
    <option value="${_escapeMaintenanceText(vehicle.id)}"${String(vehicle.id) === selectedVehicleId ? ' selected' : ''}>
      ${_escapeMaintenanceText(vehicle.plate || vehicle.id)}
    </option>`).join('');

  const tableRows = selectedVehicleId
    ? entries.length
      ? entries.map(entry => `
          <tr>
            <td>${_escapeMaintenanceText(_dateLabel(entry.date || entry.applied_at))}</td>
            <td>${_escapeMaintenanceText(entry.maintenance_type)}</td>
            <td>${_escapeMaintenanceText(entry.maintenance_quantity)}</td>
            <td class="font-semibold">${_fmt(entry.amount)}</td>
            <td>${_escapeMaintenanceText(entry.note || '—')}</td>
            <td class="text-center">
              <div class="flex gap-1 justify-center">
                <button type="button" data-action="edit-vehicle-maintenance" data-ref-id="${_escapeMaintenanceText(entry.reference_id)}" class="btn-icon" title="تعديل" style="background:#dbeafe;color:#2563eb;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">✏️</button>
                <button type="button" data-action="delete-vehicle-maintenance" data-ref-id="${_escapeMaintenanceText(entry.reference_id)}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
              </div>
            </td>
          </tr>
        `).join('')
      : `<tr><td colspan="6" class="text-muted text-center p-6">لا توجد حركات صيانة للمركبة المحددة</td></tr>`
    : `<tr><td colspan="6" class="text-muted text-center p-6">اختر مركبة لعرض حركات الصيانة</td></tr>`;

  return `
    <section class="mb-8" role="tabpanel" id="vehicleDetailsTabMaintenance">
      <div class="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div class="form-group mb-0" style="min-width:220px;">
          <label class="label mb-1 text-muted text-xs" for="maintenanceVehicleFilter">المركبة</label>
          <select id="maintenanceVehicleFilter" class="input input-sm" data-action="maintenance-vehicle-filter">
            <option value="">— اختر المركبة —</option>
            ${selectorOptions}
          </select>
        </div>
        <button type="button" data-action="open-vehicle-maintenance" class="btn btn-primary btn-sm"${vehicles.length ? '' : ' disabled'}>
          صيانة${selectedVehicle ? ` — ${_escapeMaintenanceText(selectedVehicle.plate || selectedVehicle.id)}` : ''}
        </button>
      </div>
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>نوع الصيانة</th>
              <th>العدد</th>
              <th>المبلغ</th>
              <th>ملاحظة</th>
              <th>الإجراءات</th>
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
    ? matches.map(type => `<button type="button" data-action="select-maintenance-type" data-value="${type}" style="display:block;width:100%;border:0;background:#fff;padding:8px 10px;text-align:right;cursor:pointer;font:inherit;">${type}</button>`).join('')
    : '<div class="text-muted text-xs" style="padding:8px 10px;">يمكنك إدخال نوع مخصص</div>';
  box.classList.remove('hidden');
}

function _ensureVehicleMaintenanceModal() {
  if (document.getElementById('vehicleMaintenanceModal')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div id="vehicleMaintenanceModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold" id="vehicleMaintenanceTitle">صيانة مركبة</h3>
          <button type="button" data-action="close-vehicle-maintenance" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>
        <div class="grid gap-3 mb-4">
          <div>
            <label class="label mb-1" for="vehicleMaintenanceVehicle">المركبة <span class="text-red-500">*</span></label>
            <select id="vehicleMaintenanceVehicle" class="input input-sm"></select>
          </div>
          <div>
            <label class="label mb-1" for="vehicleMaintenanceDate">التاريخ <span class="text-red-500">*</span></label>
            <input id="vehicleMaintenanceDate" type="date" class="input input-sm">
          </div>
          <div style="position:relative;">
            <label class="label mb-1" for="vehicleMaintenanceType">نوع الصيانة <span class="text-red-500">*</span></label>
            <input id="vehicleMaintenanceType" type="text" autocomplete="off" class="input input-sm" placeholder="اختر أو اكتب نوع الصيانة">
            <div id="vehicleMaintenanceTypeSuggestions" class="hidden" style="position:absolute;z-index:60;top:100%;right:0;left:0;background:#fff;border:1px solid #d1d5db;border-radius:8px;box-shadow:0 8px 18px rgba(0,0,0,.12);max-height:180px;overflow:auto;"></div>
          </div>
          <div>
            <label class="label mb-1" for="vehicleMaintenanceQuantity">العدد <span class="text-red-500">*</span></label>
            <input id="vehicleMaintenanceQuantity" type="number" min="0" step="any" class="input input-sm" placeholder="0">
          </div>
          <div>
            <label class="label mb-1" for="vehicleMaintenanceAmount">المبلغ <span class="text-red-500">*</span></label>
            <input id="vehicleMaintenanceAmount" type="number" min="0" step="0.01" class="input input-sm" placeholder="0.00">
          </div>
          <div>
            <label class="label mb-1" for="vehicleMaintenanceNote">ملاحظة</label>
            <input id="vehicleMaintenanceNote" type="text" class="input input-sm" placeholder="ملاحظة اختيارية">
          </div>
        </div>
        <div class="flex gap-2 justify-end">
          <button type="button" data-action="close-vehicle-maintenance" class="btn btn-secondary btn-sm">إلغاء</button>
          <button type="button" data-action="save-vehicle-maintenance" class="btn btn-primary btn-sm">💾 حفظ</button>
        </div>
        <div id="vehicleMaintenanceMsg" class="field-msg-inline field-msg-inline--error mt-3" role="alert"></div>
      </div>
    </div>
  `;
  document.body.appendChild(div.firstElementChild);
}

async function _openVehicleMaintenanceModal(entry = null) {
  if (!_selectedClient?.id) return;
  _ensureVehicleMaintenanceModal();
  const vehicles = await OwnersModule.getOwnerVehicles(_selectedClient.id);
  const modal = document.getElementById('vehicleMaintenanceModal');
  const title = document.getElementById('vehicleMaintenanceTitle');
  const vehicleSelect = document.getElementById('vehicleMaintenanceVehicle');
  const date = document.getElementById('vehicleMaintenanceDate');
  const type = document.getElementById('vehicleMaintenanceType');
  const quantity = document.getElementById('vehicleMaintenanceQuantity');
  const amount = document.getElementById('vehicleMaintenanceAmount');
  const note = document.getElementById('vehicleMaintenanceNote');
  const msg = document.getElementById('vehicleMaintenanceMsg');

  _editingMaintenanceReferenceId = entry?.reference_id || null;
  if (title) title.textContent = entry ? 'تعديل صيانة مركبة' : 'صيانة مركبة';
  if (vehicleSelect) {
    vehicleSelect.innerHTML = '<option value="">— اختر المركبة —</option>'
      + vehicles.map(vehicle => `<option value="${vehicle.id}">${vehicle.plate || vehicle.id}</option>`).join('');
    const preferredVehicleId = entry?.vehicle_id || _maintenanceVehicleFilter || (vehicles.length === 1 ? vehicles[0].id : '');
    vehicleSelect.value = String(preferredVehicleId || '');
  }
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
  const vehicle_id = document.getElementById('vehicleMaintenanceVehicle')?.value || '';
  const date = document.getElementById('vehicleMaintenanceDate')?.value || '';
  const maintenance_type = document.getElementById('vehicleMaintenanceType')?.value?.trim() || '';
  const maintenance_quantity = Number(document.getElementById('vehicleMaintenanceQuantity')?.value);
  const amount = parseFloat(document.getElementById('vehicleMaintenanceAmount')?.value) || 0;
  const note = document.getElementById('vehicleMaintenanceNote')?.value?.trim() || '';
  const msg = document.getElementById('vehicleMaintenanceMsg');

  if (!vehicle_id || !date || !maintenance_type || !Number.isFinite(maintenance_quantity) || maintenance_quantity <= 0 || amount <= 0) {
    if (msg) {
      msg.textContent = !vehicle_id ? '❌ يجب اختيار المركبة'
        : !date ? '❌ التاريخ مطلوب'
        : !maintenance_type ? '❌ نوع الصيانة مطلوب'
        : !Number.isFinite(maintenance_quantity) || maintenance_quantity <= 0 ? '❌ العدد يجب أن يكون أكبر من صفر'
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
    _maintenanceVehicleFilter = String(vehicle_id);
    _vehicleDetailsTab = 'maintenance';
    _closeVehicleMaintenanceModal();
    if (_selectedClient?.id) await showOwnerDetails(_selectedClient.id, 'owner');
  } catch (err) {
    if (msg) {
      msg.textContent = err.message || '❌ فشل حفظ حركة الصيانة';
      msg.classList.add('is-visible');
    }
  }
}

// ── رصيد العميل — existing vehicle_ledger read projection ─────────────────
// The existing layout remains intact. Entries are read-only movements from the
// same vehicle_ledger records used by rebuildVehicleBalance; the date controls
// remain visual-only because no client-ledger filtering workflow exists.
function _renderLedger(client, ledger = []) {
  return `
    <section class="mb-8">
      <h3 class="text-lg font-bold mb-4">الحركات</h3>
      <div class="filter-row mb-6 flex-wrap">
        <div class="form-group mb-0">
          <label class="label mb-2 text-muted text-xs" for="clientFromDate">من</label>
          <input id="clientFromDate" type="date" class="input input-sm">
        </div>
        <div class="form-group mb-0">
          <label class="label mb-2 text-muted text-xs" for="clientToDate">إلى</label>
          <input id="clientToDate" type="date" class="input input-sm">
        </div>
        <button type="button" data-action="client-apply-filter" data-id="${client.id}" data-type="${client.type}"
          class="btn btn-primary btn-sm mb-4">
          تطبيق
        </button>
        <button type="button" data-action="client-clear-filter" data-id="${client.id}" data-type="${client.type}"
          class="btn btn-secondary btn-sm mb-4">
          مسح التحديد
        </button>
      </div>
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>المبلغ</th>
              <th>المركبة</th>
              <th>ملاحظة</th>
            </tr>
          </thead>
          <tbody id="clientLedgerBody">
            ${ledger.length ? ledger.map(e => `
              <tr>
                <td>${_dateLabel(e.date || e.applied_at)}</td>
                <td class="font-semibold">${_fmt(e.amount)}</td>
                <td>${e.vehicle_plate || '-'}</td>
                <td>${_ledgerNote(e)}</td>
              </tr>
            `).join('') : `
              <tr>
                <td colspan="4" class="text-muted text-center">لا توجد حركات</td>
              </tr>
            `}
          </tbody>
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
    <div id="vehicleBalanceEntryModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold" id="vehicleBalanceEntryTitle">حركة رصيد للمركبة</h3>
          <button type="button" data-action="close-vehicle-balance-entry" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>
        <div class="grid gap-3 mb-4">
          <div>
            <label class="label mb-1" for="vehicleBalanceEntryVehicle">المركبة <span class="text-red-500">*</span></label>
            <select id="vehicleBalanceEntryVehicle" class="input input-sm"></select>
          </div>
          <div>
            <label class="label mb-1" for="vehicleBalanceEntryAmount">المبلغ <span class="text-red-500">*</span></label>
            <input id="vehicleBalanceEntryAmount" type="number" step="0.01" min="0" class="input input-sm" placeholder="0.00">
          </div>
          <div>
            <label class="label mb-1" for="vehicleBalanceEntryDate">التاريخ <span class="text-red-500">*</span></label>
            <input id="vehicleBalanceEntryDate" type="date" class="input input-sm">
          </div>
          <div>
            <label class="label mb-1" for="vehicleBalanceEntryNote">السبب / ملاحظة <span class="text-red-500">*</span></label>
            <input id="vehicleBalanceEntryNote" type="text" class="input input-sm" placeholder="اكتب سبب الحركة">
          </div>
        </div>
        <div class="flex gap-2 justify-end">
          <button type="button" data-action="close-vehicle-balance-entry" class="btn btn-secondary btn-sm">إلغاء</button>
          <button type="button" data-action="save-vehicle-balance-entry" class="btn btn-primary btn-sm">💾 حفظ</button>
        </div>
        <div id="vehicleBalanceEntryMsg" class="field-msg-inline field-msg-inline--error mt-3" role="alert"></div>
      </div>
    </div>
  `;
  document.body.appendChild(div.firstElementChild);
}

async function _openVehicleBalanceEntryModal(entryType) {
  if (!_selectedClient?.id) return;
  _ensureVehicleBalanceEntryModal();
  _vehicleBalanceEntryType = entryType === 'withdraw' ? 'withdraw' : 'deposit';

  const vehicles = await OwnersModule.getOwnerVehicles(_selectedClient.id);
  const modal = document.getElementById('vehicleBalanceEntryModal');
  const title = document.getElementById('vehicleBalanceEntryTitle');
  const vehicleSelect = document.getElementById('vehicleBalanceEntryVehicle');
  const amount = document.getElementById('vehicleBalanceEntryAmount');
  const date = document.getElementById('vehicleBalanceEntryDate');
  const note = document.getElementById('vehicleBalanceEntryNote');
  const msg = document.getElementById('vehicleBalanceEntryMsg');

  if (title) title.textContent = _vehicleBalanceEntryType === 'deposit' ? 'إيداع رصيد للمركبة' : 'سحب رصيد من المركبة';
  if (vehicleSelect) {
    vehicleSelect.innerHTML = '<option value="">— اختر المركبة —</option>'
      + vehicles.map(vehicle => `<option value="${vehicle.id}">${vehicle.plate || vehicle.id}</option>`).join('');
    if (vehicles.length === 1) vehicleSelect.value = String(vehicles[0].id);
  }
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
  const vehicleId = document.getElementById('vehicleBalanceEntryVehicle')?.value || '';
  const amount = parseFloat(document.getElementById('vehicleBalanceEntryAmount')?.value) || 0;
  const date = document.getElementById('vehicleBalanceEntryDate')?.value || '';
  const note = document.getElementById('vehicleBalanceEntryNote')?.value?.trim() || '';
  const msg = document.getElementById('vehicleBalanceEntryMsg');

  if (!vehicleId || amount <= 0 || !date || !note) {
    if (msg) {
      msg.textContent = !vehicleId ? '❌ يجب اختيار المركبة'
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
    if (_selectedClient?.id) await showOwnerDetails(_selectedClient.id, 'owner');
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

async function showOwnerDetails(id, type = 'owner') {
  const client = await _getClient('owner', id);
  if (!client) return;
  _selectedClient = client;

  sessionStorage.setItem(LAST_PAGE_CTX_KEY, JSON.stringify({
    page: 'ownerDetailsPage',
    ownerId: String(id),
    ownerType: type,
  }));

  const financials = await _getOwnerVehicleFinancials(client.id);
  const ledgerHtml = _renderLedger(client, financials.ledger);
  const maintenanceHtml = await _renderMaintenanceTab(client, financials.ledger);
  const relatedHtml = await _renderOwnerVehicles(client);

  const page = document.getElementById('ownerDetailsPage');
  if (!page) return;

  page.innerHTML = `
    <div class="ent-details-page">
      <div class="ent-details-header">
        <button type="button" data-action="back-to-customers" class="ent-btn-back">← رجوع</button>
        <h2 class="ent-details-name">${client.name}</h2>
        <span class="ent-details-type">مركبة</span>
      </div>

      <div class="stat-grid mb-8">
        <div class="card">
          <p class="text-muted text-xs mb-2">الرصيد الحالي</p>
          <div class="text-3xl font-bold ${_balanceClass(financials.balance)} mb-6">${_fmt(financials.balance)}</div>
          <div class="flex gap-2 flex-wrap justify-end">
            <button type="button" data-action="open-balance-entry" data-entry-type="deposit"
              class="btn btn-success btn-sm">
              إيداع رصيد
            </button>
            <button type="button" data-action="open-balance-entry" data-entry-type="withdraw"
              class="btn btn-danger btn-sm">
              سحب رصيد
            </button>
          </div>
        </div>
      </div>

      <div class="tabs mb-6" role="tablist" aria-label="تفاصيل المركبة">
        <button type="button" role="tab" id="vehicleDetailsTabBtnFinancial" data-action="vehicle-details-tab" data-tab="financial" class="tab-btn active-purple" aria-selected="true">الحركات المالية</button>
        <button type="button" role="tab" id="vehicleDetailsTabBtnMaintenance" data-action="vehicle-details-tab" data-tab="maintenance" class="tab-btn" aria-selected="false">الصيانة</button>
      </div>

      <section id="vehicleDetailsTabFinancial" role="tabpanel">
        ${ledgerHtml}
      </section>
      ${maintenanceHtml}
      ${relatedHtml}
    </div>
  `;

  if (typeof window.showPage === 'function') {
    await window.showPage('ownerDetailsPage');
  }
  _setVehicleDetailsTab(_vehicleDetailsTab);
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
    const vehicleDetailsTab = e.target.closest('[data-action="vehicle-details-tab"]');
    if (vehicleDetailsTab) {
      _setVehicleDetailsTab(vehicleDetailsTab.dataset.tab);
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
      typeInput?.focus();
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
        if (_selectedClient?.id) await showOwnerDetails(_selectedClient.id, 'owner');
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

    // Karta settlement modal (تسوية) — enter السعر, pick the vehicle to charge
    const openKartaStl = e.target.closest('[data-action="open-karta-settlement"]');
    if (openKartaStl) {
      await _openKartaSettlementModal(openKartaStl.dataset.rowId, 'create');
      return;
    }
    // Edit an existing settlement (تعديل التسوية) — same modal, prefill mode
    const editKartaStl = e.target.closest('[data-action="edit-karta-settlement"]');
    if (editKartaStl) {
      await _openKartaSettlementModal(editKartaStl.dataset.rowId, 'edit');
      return;
    }
    if (e.target.closest('[data-action="close-karta-settlement"]')) {
      _closeKartaSettlementModal();
      return;
    }
    if (e.target.closest('[data-action="save-karta-settlement"]')) {
      await _saveKartaSettlement();
      return;
    }

    // Driver deposit modal remains reachable only when editing an existing
    // driver-deposit transaction; the Driver Details create action is removed.
    if (e.target.closest('[data-action="close-driver-deposit"]')) {
      _closeDriverDepositModal();
      return;
    }
    if (e.target.closest('[data-action="save-driver-deposit"]')) {
      await _saveDriverDeposit();
      return;
    }

    // Open driver salfa modal
    if (e.target.closest('[data-action="open-driver-salfa"]')) {
      await _openDriverSalfaModal(null);
      return;
    }
    if (e.target.closest('[data-action="close-driver-salfa"]')) {
      _closeDriverSalfaModal();
      return;
    }
    if (e.target.closest('[data-action="save-driver-salfa"]')) {
      await _saveDriverSalfa();
      return;
    }

    // Recover driver salfa (repayment) — separate ledger namespace.
    if (e.target.closest('[data-action="open-driver-salfa-recovery"]')) {
      _openDriverSalfaRecoveryModal();
      return;
    }
    if (e.target.closest('[data-action="close-driver-salfa-recovery"]')) {
      _closeDriverSalfaRecoveryModal();
      return;
    }
    if (e.target.closest('[data-action="save-driver-salfa-recovery"]')) {
      await _saveDriverSalfaRecovery();
      return;
    }

    // Edit driver transaction
    const editTxBtn = e.target.closest('[data-action="edit-driver-tx"]');
    if (editTxBtn) {
      const refId = editTxBtn.dataset.refId;
      const txEntry = _driverLedgerCache.find(entry => entry.reference_id === refId);
      if (txEntry) {
        if (txEntry.reference_type === 'driver_deposit') {
          await _openDriverDepositModal(txEntry);
        } else if (txEntry.reference_type === 'salfa') {
          await _openDriverSalfaModal(txEntry);
        }
      }
      return;
    }

    // Delete driver transaction (audit-preserving reversal, never hard delete).
    const delTxBtn = e.target.closest('[data-action="delete-driver-tx"]');
    if (delTxBtn) {
      const refId = delTxBtn.dataset.refId;
      const txEntry = _driverLedgerCache.find(entry => entry.reference_id === refId);
      if (!txEntry || !confirm('هل تريد حذف هذه الحركة؟')) return;
      try {
        const username = _currentUsername();
        if (txEntry.reference_type === 'salfa') {
          await FinancialService.deleteDriverSalfa(username, refId);
        } else if (txEntry.reference_type === 'salfa_recovery') {
          await FinancialService.deleteDriverSalfaRecovery(username, refId);
        } else {
          await FinancialService.deleteDriverDeposit(username, refId);
        }
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
      await showOwnerDetails(viewBtn.dataset.id, 'owner');
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
        if (_selectedClient) await showOwnerDetails(_selectedClient.id, 'owner');
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
        if (_selectedClient) await showOwnerDetails(_selectedClient.id, 'owner');
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

  document.addEventListener('input', (e) => {
    if (e.target.id === 'vehicleMaintenanceType') {
      _renderMaintenanceTypeSuggestions(e.target.value);
    }
  });

  document.addEventListener('change', async (e) => {
    if (e.target.id === 'maintenanceVehicleFilter') {
      _maintenanceVehicleFilter = e.target.value || '';
      _vehicleDetailsTab = 'maintenance';
      if (_selectedClient?.id) await showOwnerDetails(_selectedClient.id, 'owner');
    }
  });
}


window.addEventListener('owners:changed', () => {
  // Only refresh details if details page is currently visible
  const detailsPage = document.getElementById('ownerDetailsPage');
  if (detailsPage && !detailsPage.classList.contains('hidden') && _selectedClient?.type === 'owner') {
    showOwnerDetails(_selectedClient.id, 'owner');
  }
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
