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
  const vehicle_name = _toText(payload?.vehicle_name ?? payload?.name).trim();
  const vehicle_number = _toText(payload?.vehicle_number).trim();
  const notes = _toText(payload?.notes).trim();

  if (!vehicle_name) {
    throw new Error('اسم المركبة مطلوب');
  }
  if (!vehicle_number) {
    throw new Error('رقم المركبة مطلوب');
  }

  const exists = await ClientRepository.findOwnersByName(vehicle_name);
  if (exists.length > 0) {
    throw new Error('اسم المركبة مستخدم بالفعل');
  }

  const record = await ClientRepository.saveOwner({
    id: _uuid(),
    username,
    vehicle_name,
    vehicle_number,
    name: vehicle_name,
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
  const vehicle_name = patch?.vehicle_name !== undefined
    ? _toText(patch.vehicle_name).trim()
    : (patch?.name === undefined ? undefined : _toText(patch.name).trim());
  const vehicle_number = patch?.vehicle_number === undefined
    ? undefined
    : _toText(patch.vehicle_number).trim();
  const notes = patch?.notes === undefined ? undefined : _toText(patch.notes).trim();

  if (vehicle_name !== undefined) {
    if (!vehicle_name) throw new Error('اسم المركبة مطلوب');
    const exists = (await ClientRepository.findOwnersByName(vehicle_name))
      .filter(o => o.id !== id);
    if (exists.length > 0) {
      throw new Error('اسم المركبة مستخدم بالفعل');
    }
  }
  if (vehicle_number !== undefined && !vehicle_number) {
    throw new Error('رقم المركبة مطلوب');
  }

  const updated = await ClientRepository.updateOwner(id, {
    ...(vehicle_name !== undefined ? { vehicle_name, name: vehicle_name } : {}),
    ...(vehicle_number !== undefined ? { vehicle_number } : {}),
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



async function getClientsByTab(tab) {
  const owners = await ClientRepository.getAllOwners();
  return owners
    .filter(o => o.deleted_at === null)
    .map(o => ({
      id: String(o.id),
      type: 'owner',
      name: o.vehicle_name || o.name || '',
      vehicle_name: o.vehicle_name || o.name || '',
      vehicle_number: o.vehicle_number || '',
    }))
    .filter(x => x.name);
}

async function getClientByType(type, id) {
  if (type && type !== 'owner') return null;
  const owner = await ClientRepository.getOwnerById(String(id));
  return owner ? {
    id: String(owner.id),
    type: 'owner',
    name: owner.vehicle_name || owner.name || '',
    vehicle_name: owner.vehicle_name || owner.name || '',
    vehicle_number: owner.vehicle_number || '',
  } : null;
}


async function getClientBalance(client_id) {
  return FinancialService.getClientBalance(client_id);
}

async function getClientLedger(client_id) {
  return FinancialService.getClientLedger(client_id);
}

async function createClientBalanceEntry(username, payload) {
  return FinancialService.createClientBalanceEntry(username, payload);
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
  const vehicle_name = _toText(payload?.vehicle_name ?? payload?.name).trim();
  const vehicle_number = _toText(payload?.vehicle_number).trim();
  const notes = _toText(payload?.notes).trim();
  if (!vehicle_name) throw new Error('❌ اسم المركبة مطلوب');
  if (!vehicle_number) throw new Error('❌ رقم المركبة مطلوب');
  await createOwner(username, { vehicle_name, vehicle_number, notes });
}



// ─── DEPRECATED PROXIES (delegate to FinancialService) ─────────────────────
// getOwnerBalance was removed — it ignored receipt_due entries and returned wrong results.
// These proxies maintain backward compatibility for any external callers.
const getOwnerBalance = (id) => FinancialService.getClientBalance(id).then(s => s.balance);
const getOwnerLedger = (id) => FinancialService.getClientLedger(id);

const OwnersModule = Object.freeze({
  createOwner,
  getAllOwners,
  updateOwner,
  deleteOwner,
  getOwnerById,
  getOwnerBalance,
  getOwnerLedger,
  getClientsByTab,
  getClientByType,
  getClientBalance,
  getClientLedger,
  createClientBalanceEntry,
  getOwnerVehicles,
  addAccount,
});

window.OwnersModule = OwnersModule;



// ========================================
// Owners Page — Rendering / Events
// ========================================

let _activeAccountTab = 'customers';
let _ownersActiveSubTab = 'vehicles';
let _selectedClient = null;
let _balanceActionType = 'deposit';
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
  if (type === 'receipt_due') return 'صافي مستحق';
  if (type === 'receipt_payment') return 'صرف نموذج';
  if (type === 'OFFICE_DEPOSIT') return 'إيداع شركة';
  if (type === 'OFFICE_WITHDRAW_AUTO') return 'سحب شركة';
  return type || '-';
}

function _ledgerNote(entry) {
  const receiptNum = entry.receipt_number || '';
  const refType = entry.reference_type || '';
  const type = entry.type || '';
  const note = entry.note || '';

  // Receipt due — نموذج صرف أُضيف
  if (type === 'receipt_due') {
    return receiptNum ? 'إيداع نموذج صرف — إذن: ' + receiptNum : 'إيداع نموذج صرف';
  }
  // Receipt payment — نموذج صرف تم صرفه
  if (type === 'receipt_payment') {
    return receiptNum ? 'سحب نموذج صرف — إذن: ' + receiptNum : 'سحب نموذج صرف';
  }
  // Client balance — manual deposit/withdraw
  if (refType === 'client_balance') {
    if (type === 'deposit') return note || 'إيداع رصيد يدوي';
    if (type === 'withdraw') return note || 'سحب رصيد يدوي';
  }
  // Salfa
  if (refType === 'salfa') {
    return note || 'سلفة';
  }
  // Office entries
  if (type === 'OFFICE_DEPOSIT') return note || 'إيداع شركة';
  if (type === 'OFFICE_WITHDRAW_AUTO') return note || 'سحب شركة';
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

function _kindLabel(type) {
  return 'مركبة';
}


async function _clientSnapshot(client) {
  const balance = await OwnersModule.getClientBalance(client.id);
  // last_activity = most recent of: entity update OR financial transaction
  const entityTime = Number(client.updated_at || client.created_at || 0);
  const txTime = balance.last_transaction_date
    ? new Date(balance.last_transaction_date).getTime() || 0
    : 0;
  const lastActivity = Math.max(entityTime, txTime);
  return {
    ...client,
    name: client.vehicle_name || client.name || '',
    vehicle_name: client.vehicle_name || client.name || '',
    vehicle_number: client.vehicle_number || '',
    balance: balance.balance,
    last_transaction_date: balance.last_transaction_date,
    updated_at: entityTime,
    last_activity: lastActivity,
  };
}

async function _loadTabClients() {
  return OwnersModule.getClientsByTab(_activeAccountTab);
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
          <input id="ownerSearchInput" type="text" class="ent-search-input" placeholder="${_ownersActiveSubTab === 'vehicles' ? '🔍 ابحث عن اسم أو رقم المركبة...' : '🔍 ابحث عن اسم أو رقم هاتف السائق...'}" style="flex:1;min-width:200px;">
          <div style="background:linear-gradient(135deg,#1e40af,#3b82f6);color:#fff;padding:8px 20px;border-radius:12px;font-weight:700;font-size:0.875rem;white-space:nowrap;">
            الرصيد الكلي: <span id="totalBalanceDisplay">0.00</span>
          </div>
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
                  <th style="color:#fff;">اسم المركبة</th>
                  <th style="color:#fff;">رقم المركبة</th>
                  <th style="color:#fff;">الرصيد</th>
                  <th style="color:#fff;">كارتات</th>
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
                  <th style="color:#fff;">الرصيد الحالي</th>
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

function _renderCustomersShell() {
  return '';
}



let _addModalKind = 'owner';
let _editingAccountId = null;
let _editingAccountKind = null;


function _openEditModal(id, kind, currentName, currentNumber) {
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
  if (tbody) tbody.innerHTML = `<tr><td><input type="text" class="input input-sm add-m-name" placeholder="اسم المركبة" value="${currentName || ''}"></td><td><input type="text" class="input input-sm add-m-vehicle-number" placeholder="رقم المركبة" value="${currentNumber || ''}"></td><td></td></tr>`;

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
              <table class="table"><thead><tr><th>اسم المركبة</th><th>رقم المركبة</th><th>حذف</th></tr></thead>
              <tbody id="addModalRows">
                <tr><td><input type="text" class="input input-sm add-m-name" placeholder="اسم المركبة"></td><td><input type="text" class="input input-sm add-m-vehicle-number" placeholder="رقم المركبة"></td><td><button type="button" data-action="add-modal-remove-row" class="btn-icon" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button></td></tr>
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
  if (tbody) tbody.innerHTML = '<tr><td><input type="text" class="input input-sm add-m-name" placeholder="اسم المركبة"></td><td><input type="text" class="input input-sm add-m-vehicle-number" placeholder="رقم المركبة"></td><td><button type="button" data-action="add-modal-remove-row" class="btn-icon" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button></td></tr>';

  const msg = document.getElementById('addModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal?.classList.remove('hidden');
}

async function _saveFromAddModal() {
  const msg = document.getElementById('addModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }

  if (_editingAccountId) {
    const nameVal = (document.querySelector('#addModalRows .add-m-name')?.value || '').trim();
    const numberVal = (document.querySelector('#addModalRows .add-m-vehicle-number')?.value || '').trim();
    if (!nameVal) { if (msg) { msg.textContent = '❌ اسم المركبة مطلوب'; msg.classList.add('is-visible'); } return; }
    if (!numberVal) { if (msg) { msg.textContent = '❌ رقم المركبة مطلوب'; msg.classList.add('is-visible'); } return; }
    try {
      await OwnersModule.updateOwner(_currentUsername(), _editingAccountId, {
        vehicle_name: nameVal,
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
  const entries = rows.map(tr => ({
    vehicle_name: (tr.querySelector('.add-m-name')?.value || '').trim(),
    vehicle_number: (tr.querySelector('.add-m-vehicle-number')?.value || '').trim(),
  })).filter(e => e.vehicle_name || e.vehicle_number);

  if (entries.length === 0) {
    if (msg) { msg.textContent = '❌ أدخل مركبة واحدة على الأقل'; msg.classList.add('is-visible'); }
    return;
  }

  const username = _currentUsername();
  for (const entry of entries) {
    try {
      await OwnersModule.addAccount(username, 'owner', {
        vehicle_name: entry.vehicle_name,
        vehicle_number: entry.vehicle_number,
      });
    } catch (err) {
      if (msg) { msg.textContent = err.message || '❌ حدث خطأ'; msg.classList.add('is-visible'); }
      return;
    }
  }

  document.getElementById('ownerAddModal')?.classList.add('hidden');
  await loadOwners();
}




function _updateTotalBalance() {
  let total = 0;
  const selector = _ownersActiveSubTab === 'vehicles' ? '#ownersTableBody tr' : '#driversTableBody tr';
  document.querySelectorAll(selector).forEach(tr => {
    if (tr.style.display === 'none') return;
    const cells = tr.querySelectorAll('td');
    if (cells.length >= 3) {
      const val = parseFloat(cells[2]?.textContent) || 0;
      total += val;
    }
  });
  const el = document.getElementById('totalBalanceDisplay');
  if (el) el.textContent = Money.fmt(total);
}


function _printEntities(mode) {
  let rows = [];
  const ownerRows = document.querySelectorAll('#ownersTableBody tr');
  ownerRows.forEach(tr => {
    if (tr.style.display === 'none') return;
    const cells = tr.querySelectorAll('td');
    if (cells.length < 3) return;
    const name = (cells[0]?.textContent || '').trim();
    const number = (cells[1]?.textContent || '').trim();
    const balance = (cells[2]?.textContent || '').trim();
    rows.push({ name, number, balance });
  });

  if (rows.length === 0) {
    alert('لا توجد بيانات للطباعة');
    return;
  }

  const tableRows = rows.map(r => `
    <tr>
      <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:right;">${r.name}</td>
      <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:center;">${r.number}</td>
      <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:center;font-weight:700;">${r.balance}</td>
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
        <th>اسم المركبة</th>
        <th>رقم المركبة</th>
        <th>الرصيد</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`;

  printHTML(html);
}


function _sortByPriority(list) {
  return list.slice().sort((a, b) => {
    // 1. Negative balance first
    const aNeg = (a.balance || 0) < 0 ? 1 : 0;
    const bNeg = (b.balance || 0) < 0 ? 1 : 0;
    if (aNeg !== bNeg) return bNeg - aNeg;
    // 2. Then by last activity (entity update OR financial transaction)
    const aTime = a.last_activity || a.updated_at || 0;
    const bTime = b.last_activity || b.updated_at || 0;
    return bTime - aTime;
  });
}

async function _getUnpaidKartaCount(clientId) {
  // Normalized read path (Step 6): persisted receipts never embed rows.
  // Headers come from the client-scoped read-repository query; rows are
  // loaded per receipt via ReceiptReadRepository. DB.findByFields excludes
  // soft-deleted records by default (deleted guard is therefore implicit).
  const clientReceipts = await ReceiptReadRepository.getReceiptsByClient(clientId);
  const unpaid = (clientReceipts || []).filter(
    r => String(r.payout_status || 'unpaid') === 'unpaid'
  );
  const rowLists = await Promise.all(
    unpaid.map(r => ReceiptReadRepository.getReceiptRowsByReceipt(r.id))
  );
  // NOTE: the frozen ReceiptRow contract persists data rows only (no
  // separators), so each persisted row counts as one karta; the row_type
  // guard is forward-compatible if separators ever become persisted.
  return rowLists.reduce(
    (sum, rows) => sum + (rows || []).filter(row => row && row.row_type !== 'separator').length,
    0
  );
}

function _buildClientRow(client, kartaCount, kind) {
  const vName = client.vehicle_name || client.name || '';
  const vNumber = client.vehicle_number || '';
  return `
    <tr data-client-name="${(vName || '').toLowerCase()}" data-client-number="${(vNumber || '').toLowerCase()}">
      <td data-action="view-client" data-id="${client.id}" data-type="owner" class="ent-name-cell ent-name-cell--blue">
        ${vName}
      </td>
      <td>${vNumber || '—'}</td>
      <td class="${_balanceClass(client.balance)}">${_fmt(client.balance)}</td>
      <td class="text-center">${kartaCount > 0 ? '<span class="ent-karta-badge">' + kartaCount + '</span>' : '—'}</td>
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
    searchInput.placeholder = isVehicles ? '🔍 ابحث عن اسم أو رقم المركبة...' : '🔍 ابحث عن اسم أو رقم هاتف السائق...';
  }

  const tbodyId = isVehicles ? 'ownersTableBody' : 'driversTableBody';
  const ownersTbody = document.getElementById(tbodyId);
  if (!ownersTbody) return;

  if (isVehicles) {
    const owners = await ClientRepository.getAllOwners();
    const ownerList = owners.filter(o => o.deleted_at === null && (o.vehicle_name || o.name)).map(o => ({
      id: String(o.id),
      type: 'owner',
      name: o.vehicle_name || o.name || '',
      vehicle_name: o.vehicle_name || o.name || '',
      vehicle_number: o.vehicle_number || '',
    }));
    const ownerSnaps = await Promise.all(ownerList.map(_clientSnapshot));
    const ownerKartas = await Promise.all(ownerList.map(o => _getUnpaidKartaCount(o.id)));
    const sortedOwners = _sortByPriority(ownerSnaps);

    if (sortedOwners.length === 0) {
      ownersTbody.innerHTML = '<tr><td colspan="5" class="text-muted text-center p-6">لا توجد بيانات</td></tr>';
    } else {
      ownersTbody.innerHTML = sortedOwners.map((client) => {
        const idx = ownerSnaps.indexOf(client);
        return _buildClientRow(client, ownerKartas[idx], 'owner');
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
          const name = tr.getAttribute('data-client-name') || '';
          const number = tr.getAttribute('data-client-number') || '';
          tr.style.display = (!q || name.includes(q) || number.includes(q)) ? '' : 'none';
        });
      } else {
        document.querySelectorAll('#driversTableBody tr').forEach(tr => {
          const name = tr.getAttribute('data-driver-name') || '';
          const phone = tr.getAttribute('data-driver-phone') || '';
          tr.style.display = (!q || name.includes(q) || phone.includes(q)) ? '' : 'none';
        });
      }
      _updateTotalBalance();
    });
  }

  _updateTotalBalance();
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
    const actionsStr = canEdit ? `
      <div class="flex gap-1 justify-center">
        <button type="button" data-action="edit-driver-tx" data-ref-id="${entry.reference_id}" class="btn-icon" title="تعديل" style="background:#dbeafe;color:#2563eb;width:24px;height:24px;border:none;border-radius:4px;cursor:pointer;">✏️</button>
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
      totalSalfaCents += Money.toCents(e.amount);
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

    // Summary cards
    summaryContainer.innerHTML = `
      <div class="card p-4"><div class="text-xs text-muted">إجمالي الكارتات</div><div class="text-2xl font-bold">${summary.total_kartas}</div></div>
      <div class="card p-4"><div class="text-xs text-muted">غير مدفوعة</div><div class="text-2xl font-bold text-red-600">${summary.unpaid_kartas}</div></div>
      <div class="card p-4"><div class="text-xs text-muted">مدفوعة جزئياً</div><div class="text-2xl font-bold text-yellow-600">${summary.partial_kartas}</div></div>
      <div class="card p-4"><div class="text-xs text-muted">مدفوعة بالكامل</div><div class="text-2xl font-bold text-green-600">${summary.paid_kartas}</div></div>
      <div class="card p-4"><div class="text-xs text-muted">إجمالي السعر</div><div class="text-xl font-bold">${_fmt(summary.total_driver_price)}</div></div>
      <div class="card p-4"><div class="text-xs text-muted">إجمالي المدفوع</div><div class="text-xl font-bold">${_fmt(summary.total_settled)}</div></div>
      <div class="card p-4"><div class="text-xs text-muted">المتبقي</div><div class="text-xl font-bold">${_fmt(summary.total_remaining)}</div></div>
    `;

    // Table rows
    _renderKartaTable(kartas, tbody);

    // Client-side search
    if (searchInput && !searchInput.dataset.bound) {
      searchInput.dataset.bound = '1';
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        const filtered = kartas.filter(k =>
          Object.values(k).some(v => String(v || '').toLowerCase().includes(q))
        );
        _renderKartaTable(filtered, tbody, driverId);
      });
    }
  } catch (err) {
    console.error('[entities] Failed to load kartas tab', err);
    tbody.innerHTML = `<tr><td colspan="10" class="text-red-600 text-center p-6">فشل تحميل الكارتات</td></tr>`;
  }
}

let _currentKartaRowId = null;

function _openKartaSettlementModal(rowId) {
  _currentKartaRowId = rowId;
  const modal = document.getElementById('kartaSettlementModal');
  const amountEl = document.getElementById('kartaSettlementAmount');
  const dateEl = document.getElementById('kartaSettlementDate');
  const noteEl = document.getElementById('kartaSettlementNote');
  const msgEl = document.getElementById('kartaSettlementMsg');

  if (msgEl) { msgEl.textContent = ''; msgEl.classList.remove('is-visible'); }
  if (amountEl) amountEl.value = '';
  if (dateEl) dateEl.value = DateUtils.todayLocal();
  if (noteEl) noteEl.value = '';

  modal?.classList.remove('hidden');
}

function _closeKartaSettlementModal() {
  document.getElementById('kartaSettlementModal')?.classList.add('hidden');
  _currentKartaRowId = null;
}

async function _saveKartaSettlement() {
  const msgEl = document.getElementById('kartaSettlementMsg');
  const amount = parseFloat(document.getElementById('kartaSettlementAmount')?.value) || 0;
  const date = document.getElementById('kartaSettlementDate')?.value;
  const note = document.getElementById('kartaSettlementNote')?.value || '';

  if (!_currentKartaRowId) return;
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
    await FinancialService.createKartaSettlement(username, {
      row_id: _currentKartaRowId,
      amount,
      date,
      note: note || undefined
    });

    _closeKartaSettlementModal();

    const driverId = _getCurrentDriverId();
    if (driverId) {
      await _loadDriverKartasTab(driverId);
    }
  } catch (err) {
    if (msgEl) { msgEl.textContent = err.message || '❌ فشل حفظ التسوية'; msgEl.classList.add('is-visible'); }
  }
}

function _renderKartaTable(kartas, tbody, driverId) {
  if (!Array.isArray(kartas) || kartas.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-muted text-center p-6">لا توجد كارتات</td></tr>`;
    return;
  }

  tbody.innerHTML = kartas.map(k => {
    const canSettle = k.status === 'unpaid' || k.status === 'partial';
    const settleBtn = canSettle
      ? `<button type="button" data-action="open-karta-settlement" data-row-id="${k.row_id}" class="btn btn-primary btn-sm">تسوية</button>`
      : '—';

    return `
      <tr data-row-id="${k.row_id}">
        <td>${_dateLabel(k.date)}</td>
        <td>${k.vehicle_plate || '—'}</td>
        <td>${k.company || '—'}</td>
        <td>${k.loading || '—'}</td>
        <td>${k.destination || '—'}</td>
        <td>${_fmt(k.advance)}</td>
        <td class="font-semibold">${_fmt(k.driver_price)}</td>
        <td>${_fmt(k.settled)}</td>
        <td>${_fmt(k.remaining)}</td>
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

async function _renderLedger(client) {
  const ledger = await OwnersModule.getClientLedger(client.id);
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
          <div>
            <label class="label mb-1" for="vehicleModalDriver">السائق</label>
            <select id="vehicleModalDriver" class="input input-sm"></select>
          </div>
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

async function _openVehicleModal(title, plate, driverId, ownerId, editId) {
  _ensureVehicleModal();
  _vehicleOwnerId = ownerId || null;
  _vehicleEditId = editId || null;
  const modal = document.getElementById('vehicleModal');
  const titleEl = document.getElementById('vehicleModalTitle');
  const plateEl = document.getElementById('vehicleModalPlate');
  const driverEl = document.getElementById('vehicleModalDriver');
  const msg = document.getElementById('vehicleModalMsg');
  if (titleEl) titleEl.textContent = title;
  if (plateEl) plateEl.value = plate || '';
  // Driver assignment is id-keyed (Phase 6 fix): the vehicle stores driver_id
  // pointing at a registered driver record (driver_name stays a display denorm).
  if (driverEl) {
    const username = _currentUsername();
    const drivers = (await ClientRepository.getDriversForUser(username))
      .filter(d => d && d.deleted_at == null);
    driverEl.innerHTML = '<option value="">— بدون سائق —</option>'
      + drivers.map(d => `<option value="${d.id}">${String(d.name || '').replace(/</g, '&lt;')}</option>`).join('');
    driverEl.value = driverId ? String(driverId) : '';
  }
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal?.classList.remove('hidden');
}

async function _renderOwnerVehicles(client) {
  const owned = await OwnersModule.getOwnerVehicles(client.id);

  return `
    <section>
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold mb-0">المركبات والسائقين</h3>
        <div class="flex gap-2">
          <button type="button" data-action="add-vehicle-manual" data-owner-id="${client.id}" style="background:#16a34a;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">➕ إضافة مركبة</button>
        </div>
      </div>
      <div class="table-wrapper mb-10">
        <table class="table">
          <thead>
            <tr>
              <th>رقم المركبة</th>
              <th>اسم السائق</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${owned.length ? owned.map(v => `
              <tr>
                <td>${v.plate || '-'}</td>
                <td>${v.driver_name || '—'}</td>
                <td>
                  <button type="button" data-action="edit-vehicle" data-vehicle-id="${v.id}" data-plate="${v.plate || ''}" data-driver-id="${v.driver_id || ''}" class="btn-icon" title="تعديل" style="background:#dbeafe;color:#2563eb;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">✏️</button>
                  <button type="button" data-action="delete-vehicle" data-vehicle-id="${v.id}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
                </td>
              </tr>
            `).join('') : `
              <tr>
                <td colspan="3" class="text-muted text-center">لا توجد مركبات</td>
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

  const balance = await OwnersModule.getClientBalance(client.id);
  const ledgerHtml = await _renderLedger(client);
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
          <div class="text-3xl font-bold ${_balanceClass(balance.balance)} mb-6">${_fmt(balance.balance)}</div>
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

      ${ledgerHtml}
      ${relatedHtml}

      <div id="balanceEntryModal" class="modal-overlay hidden">
        <div class="modal">
          <div class="modal-body">
            <div class="flex items-center justify-between mb-6">
              <button type="button" data-action="close-balance-entry" class="btn btn-secondary btn-sm">إغلاق</button>
              <h3 id="balanceEntryTitle" class="text-lg font-bold mb-0">إيداع رصيد</h3>
            </div>

            <div class="grid gap-4">
              <div class="form-group mb-0">
                <label class="label mb-2" for="balanceEntryDate">التاريخ</label>
                <input id="balanceEntryDate" type="date" class="input input-sm">
              </div>
              <div class="form-group mb-0">
                <label class="label mb-2" for="balanceEntryAmount">المبلغ</label>
                <input id="balanceEntryAmount" type="number" min="0" step="0.01" class="input input-sm" placeholder="0.00">
              </div>
              <div class="form-group mb-0">
                <label class="label mb-2" for="balanceEntryNote">ملاحظة</label>
                <input id="balanceEntryNote" type="text" class="input input-sm" placeholder="اختياري">
              </div>
              <button type="button" data-action="save-balance-entry" class="btn btn-primary btn-full mt-4">
                حفظ الحركة
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  if (typeof window.showPage === 'function') {
    await window.showPage('ownerDetailsPage');
  }
}

function _openBalanceEntryModal(type) {
  if (!_selectedClient) return;
  _balanceActionType = type === 'withdraw' ? 'withdraw' : 'deposit';

  const modal = document.getElementById('balanceEntryModal');
  const title = document.getElementById('balanceEntryTitle');
  const dateEl = document.getElementById('balanceEntryDate');
  const amountEl = document.getElementById('balanceEntryAmount');
  const noteEl = document.getElementById('balanceEntryNote');

  if (title) title.textContent = _balanceActionType === 'deposit' ? 'إيداع رصيد' : 'سحب رصيد';
  if (dateEl) dateEl.value = DateUtils.todayLocal();
  if (amountEl) amountEl.value = '';
  if (noteEl) noteEl.value = '';
  modal?.classList.remove('hidden');
}

function _closeBalanceEntryModal() {
  document.getElementById('balanceEntryModal')?.classList.add('hidden');
}

async function _saveBalanceEntry() {
  if (!_selectedClient) return;

  const date = document.getElementById('balanceEntryDate')?.value;
  const amount = parseFloat(document.getElementById('balanceEntryAmount')?.value) || 0;
  const note = document.getElementById('balanceEntryNote')?.value || '';

  if (!date) {
    alert('التاريخ مطلوب');
    return;
  }
  if (amount <= 0) {
    alert('المبلغ يجب أن يكون أكبر من صفر');
    return;
  }

  await OwnersModule.createClientBalanceEntry(_currentUsername(), {
    client_id: _selectedClient.id,
    client_type: _selectedClient.type,
    client_name: _selectedClient.name,
    type: _balanceActionType,
    amount,
    date,
    note,
  });

  _closeBalanceEntryModal();
  await showOwnerDetails(_selectedClient.id, _selectedClient.type);
  await loadOwners();
}

// ─── EXCEL HANDLERS ───────────────────────────────────────────────────────────

/**
 * Reads all active vehicle owners and exports them to Excel
 * file with vehicle_name and vehicle_number columns.
 * Export mirrors what the user sees on the page.
 */
async function _handleExportOwnersExcel() {
  try {
    const ownersRaw = await ClientRepository.getAllOwners();
    const owners = ownersRaw
      .filter(o => o.deleted_at === null && (o.vehicle_name || o.name))
      .map(o => ({
        vehicle_name: o.vehicle_name || o.name || '',
        vehicle_number: o.vehicle_number || '',
        name: o.vehicle_name || o.name || '',
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
          const vehicle_name = String(row.vehicle_name || row.name || '').trim();
          const vehicle_number = String(row.vehicle_number || '').trim();
          if (!vehicle_name || !vehicle_number) { ownersSkipped++; continue; }
          const existing = await ClientRepository.findOwnersByName(vehicle_name);
          const dup = (existing || []).some(o => o.deleted_at === null);
          if (dup) { ownersSkipped++; continue; }
          await createOwner(username, { vehicle_name, vehicle_number, notes: null });
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
    // Open driver deposit modal
    if (e.target.closest('[data-action="open-driver-deposit"]')) {
      await _openDriverDepositModal(null);
      return;
    }
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

    // Delete driver transaction
    const delTxBtn = e.target.closest('[data-action="delete-driver-tx"]');
    if (delTxBtn) {
      const refId = delTxBtn.dataset.refId;
      if (!confirm('هل تريد حذف هذه الحركة؟')) return;
      try {
        const username = _currentUsername();
        if (txEntry && txEntry.reference_type === "salfa") {
          await FinancialService.deleteDriverSalfa(username, refId);
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
      let currentName = '';
      let currentNumber = '';
      try {
        const owner = await ClientRepository.getOwnerById(String(id));
        currentName = owner?.vehicle_name || owner?.name || '';
        currentNumber = owner?.vehicle_number || '';
      } catch (_) {}
      _openEditModal(id, 'owner', currentName, currentNumber);
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
        <td><input type="text" class="input input-sm add-m-name" placeholder="اسم المركبة"></td>
        <td><input type="text" class="input input-sm add-m-vehicle-number" placeholder="رقم المركبة"></td>
        <td><button type="button" data-action="add-modal-remove-row" class="btn btn-secondary btn-sm">حذف</button></td>`;
      tbody.appendChild(tr);
      return;
    }
    if (e.target.closest('[data-action="add-modal-remove-row"]')) {
      e.target.closest('tr')?.remove();
      return;
    }

    // Balance entry modal
    const openBal = e.target.closest('[data-action="open-balance-entry"]');
    if (openBal) {
      _openBalanceEntryModal(openBal.dataset.entryType || 'deposit');
      return;
    }
    if (e.target.closest('[data-action="close-balance-entry"]')) {
      _closeBalanceEntryModal();
      return;
    }
    if (e.target.closest('[data-action="save-balance-entry"]')) {
      await _saveBalanceEntry();
      return;
    }

    // Client ledger date filter
    if (e.target.closest('[data-action="client-apply-filter"]') && _selectedClient) {
      await showOwnerDetails(_selectedClient.id, 'owner');
      return;
    }
    if (e.target.closest('[data-action="client-clear-filter"]') && _selectedClient) {
      await showOwnerDetails(_selectedClient.id, 'owner');
      return;
    }

    // Vehicles
    if (e.target.closest('[data-action="add-vehicle-manual"]')) {
      if (!_selectedClient) return;
      await _openVehicleModal('إضافة مركبة', '', '', _selectedClient.id, null);
      return;
    }
    const editVeh = e.target.closest('[data-action="edit-vehicle"]');
    if (editVeh) {
      await _openVehicleModal('تعديل مركبة', editVeh.dataset.plate || '', editVeh.dataset.driverId || '', editVeh.dataset.ownerId || _selectedClient?.id, editVeh.dataset.id);
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
      const driverId = document.getElementById('vehicleModalDriver')?.value || '';
      const ownerId = modal.dataset.ownerId || _selectedClient?.id;
      const editId = modal.dataset.editId || null;
      if (!plate || !ownerId) {
        alert('❌ رقم المركبة مطلوب');
        return;
      }
      try {
        const username = _currentUsername();
        // Id-keyed driver link (Phase 6 fix): persist driver_id; driver_name is
        // kept only as a display denorm taken from the selected driver record.
        let driverName = null;
        if (driverId) {
          const d = await ClientRepository.getDriverById(String(driverId));
          driverName = d?.name || null;
        }
        const vehiclePayload = { plate, driver_id: driverId || null, driver_name: driverName, owner_id: String(ownerId) };
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
  getOwnerBalance,
  getOwnerLedger,
  getClientsByTab,
  getClientByType,
  getClientBalance,
  getClientLedger,
  createClientBalanceEntry,
  getOwnerVehicles,
  addAccount,
  loadOwners,
  attachOwnersPageListeners,
  showOwnerDetails,
};
