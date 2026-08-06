/**
 * treasury.js — صفحة الخزنة
 * Internal structure: Constants → Services → Rendering → Events → Public API
 *
 * Treasury entries (effect column — MySQL ENUM):
 *   capital_deposit   ← إيداع رأس مال
 *   salfa             ← سلفة لعميل/شخص آخر
 *   expense           ← مصروف
 *   salary            ← مرتب
 *
 */

import { Money } from './money.js';
import { AuthModule } from './auth.js';
import { printHTML, buildPrintDocument } from './printEngine.js';
import { DBProvider } from './services/dbProvider.js';
import { TreasuryRepository } from './services/treasuryRepository.js';
import { ClientRepository } from './services/clientRepository.js';
import { DateUtils } from './dateUtils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Domain Constants — Self-Contained (no external import dependency)
// ═══════════════════════════════════════════════════════════════════════════════
// Self-contained — no external constant imports to guarantee module loading.

const TREASURY_ENTRY_TYPE = Object.freeze({
  DEPOSIT  : 'deposit',
  WITHDRAW : 'withdraw',
});

const TREASURY_EFFECT = Object.freeze({
  CAPITAL_DEPOSIT  : 'capital_deposit',
  SALFA            : 'salfa',
  EXPENSE          : 'expense',
  SALARY           : 'salary',


});

const TREASURY_EDITABLE_EFFECTS = Object.freeze([
  TREASURY_EFFECT.CAPITAL_DEPOSIT,
  TREASURY_EFFECT.SALFA,
  TREASURY_EFFECT.EXPENSE,
  TREASURY_EFFECT.SALARY,
]);

const TREASURY_EXPENSE_EFFECTS = Object.freeze([
  TREASURY_EFFECT.EXPENSE,
  TREASURY_EFFECT.SALARY,
]);

const TREASURY_TAB = Object.freeze({
  ALL      : 'all',
  EXPENSES : 'expenses',
});

const ACCOUNT_TYPE = Object.freeze({
  CASH     : 'cash',
  BANK     : 'bank',
  VODAFONE : 'vodafone',
  NONE     : 'none',
});

const REFERENCE_TYPE = Object.freeze({
  RECEIPT : 'receipt',
  SALFA   : 'salfa',
  CAPITAL : 'capital',
  EXPENSE : 'expense',
  SALARY  : 'salary',
});

const CLIENT_TYPE = Object.freeze({
  OWNER  : 'owner',
  OFFICE : 'office',
});

const DOMAIN_EVENT = Object.freeze({
  TREASURY_CHANGED : 'treasury:changed',
  RECEIPTS_CHANGED : 'receipts:changed',
});

// ═══════════════════════════════════════════════════════════════════════════════
// Store Names & Aliases
// ═══════════════════════════════════════════════════════════════════════════════

const STORE = Object.freeze({
  TREASURY: 'treasury',
});

// Short alias for readability
const EFFECTS = TREASURY_EFFECT;

function _uuid() {
  return crypto.randomUUID();
}

/**
 * Normalize a treasury entry ID to the correct IndexedDB key type.
 *
 * The treasury store uses autoIncrement: true, which means
 * IndexedDB generates INTEGER keys (1, 2, 3...).  IDBObjectStore.get()
 * uses strict type matching — get("3") !== get(3).
 *
 * HTML data-attributes (dataset.id) always return STRINGS.
 * This function converts "3" → 3 for integer-keyed stores,
 * while preserving UUID strings as-is for string-keyed stores.
 */
function _toEntryId(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  // If it's a valid finite number (e.g. "3" → 3), return the number.
  // If it's a UUID or non-numeric string, return as-is.
  return Number.isFinite(n) && String(n) === String(raw).trim() ? n : raw;
}

function _currentUsername() {
  const session = AuthModule.getSession();
  if (!session?.username) throw new Error('Username required');
  return session.username;
}

function _todayISO() {
  return DateUtils.todayLocal();
}

function _nowISO() {
  return DateUtils.nowLocal();
}

function _effectLabel(effect) {
  switch (effect) {
    case EFFECTS.CAPITAL_DEPOSIT:  return 'إيداع رأس مال';
    case EFFECTS.SALFA:            return 'سلفة';
    case EFFECTS.EXPENSE:          return 'مصروف';
    case EFFECTS.SALARY:           return 'مرتب';


    default: return effect || '—';
  }
}

function _typeIcon(type) {
  return type === TREASURY_ENTRY_TYPE.DEPOSIT ? '⬇️' : '⬆️';
}

function _directionClass(type) {
  return type === TREASURY_ENTRY_TYPE.DEPOSIT ? 'treasury-in' : 'treasury-out';
}

function _esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _dateDisplay(v) {
  if (!v) return '—';
  return String(v).split('T')[0];
}

function _timeDisplay(v) {
  if (!v) return '';
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TreasuryService — Financial Operations
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Deposit capital into the treasury (إيداع رأس مال)
 */
async function depositCapital(username, { amount, date, note }) {
  if (!username) throw new Error('[Treasury] username required');
  const cents = Money.toCents(amount);
  if (cents <= 0) throw new Error('❌ المبلغ يجب أن يكون أكبر من صفر');
  const isoDate = date || _todayISO();

  const [entry] = await DBProvider.transaction([{
    op: 'add',
    store: STORE.TREASURY,
    payload: {
      username,
      type: TREASURY_ENTRY_TYPE.DEPOSIT,
      effect: EFFECTS.CAPITAL_DEPOSIT,
      amount: cents,
      account_type: ACCOUNT_TYPE.CASH,
      reference_type: REFERENCE_TYPE.CAPITAL,
      reference_id: _uuid(),
      client_id: null,
      client_type: null,
      client_name: null,
      date: isoDate,
      applied_at: _nowISO(),
      is_reversed: false,
      note: String(note || '').trim() || 'إيداع رأس مال',
    },
  }], { username });

  window.dispatchEvent(new CustomEvent(DOMAIN_EVENT.TREASURY_CHANGED));
  return Money.decimalizeRecord(entry);
}

/**
 * Create a salfa (سلفة) — partial advance payment to a client
 */
async function createSalfa(username, { client_id, client_type, client_name, amount, date, note }) {
  if (!username) throw new Error('[Treasury] username required');
  const cents = Money.toCents(amount);
  if (cents <= 0) throw new Error('❌ المبلغ يجب أن يكون أكبر من صفر');
  const isoDate = date || _todayISO();
  const refId = _uuid();
  const now = _nowISO();
  const noteText = String(note || '').trim() || 'سلفة';

  const ops = [
    // Treasury: cash out
    {
      op: 'add',
      store: STORE.TREASURY,
      payload: {
        username,
        type: TREASURY_ENTRY_TYPE.WITHDRAW,
        effect: EFFECTS.SALFA,
        amount: cents,
        account_type: ACCOUNT_TYPE.CASH,
        reference_type: REFERENCE_TYPE.SALFA,
        reference_id: refId,
        client_id: client_id || null,
        client_type: client_type || null,
        client_name: client_name || null,
        date: isoDate,
        applied_at: now,
        is_reversed: false,
        note: noteText,
      },
    },
  ];

  const results = await DBProvider.transaction(ops, { username });

  window.dispatchEvent(new CustomEvent(DOMAIN_EVENT.TREASURY_CHANGED));
  return Money.decimalizeRecord(results[0]);
}

/**
 * Create an expense or salary (مصروف أو مرتب)
 */
async function createExpense(username, { subtype, description, employee_name, amount, date, note }) {
  if (!username) throw new Error('[Treasury] username required');
  const cents = Money.toCents(amount);
  if (cents <= 0) throw new Error('❌ المبلغ يجب أن يكون أكبر من صفر');
  const isoDate = date || _todayISO();
  const isSalary = subtype === EFFECTS.SALARY;
  const effect = isSalary ? EFFECTS.SALARY : EFFECTS.EXPENSE;
  const desc = isSalary
    ? `مرتب: ${String(employee_name || '').trim()}`
    : String(description || '').trim() || 'مصروف';

  const [entry] = await DBProvider.transaction([{
    op: 'add',
    store: STORE.TREASURY,
    payload: {
      username,
      type: TREASURY_ENTRY_TYPE.WITHDRAW,
      effect,
      amount: cents,
      account_type: ACCOUNT_TYPE.CASH,
      reference_type: effect,
      reference_id: _uuid(),
      client_id: null,
      client_type: null,
      client_name: isSalary ? String(employee_name || '').trim() : null,
      employee_name: isSalary ? String(employee_name || '').trim() : null,
      description: desc,
      date: isoDate,
      applied_at: _nowISO(),
      is_reversed: false,
      note: String(note || '').trim() || desc,
    },
  }], { username });

  window.dispatchEvent(new CustomEvent(DOMAIN_EVENT.TREASURY_CHANGED));
  return Money.decimalizeRecord(entry);
}

/**
 * Edit a treasury entry (تعديل حركة)
 */
async function editEntry(username, entryId, patch) {
  if (!username) throw new Error('[Treasury] username required');
  if (!entryId) throw new Error('[Treasury] entryId required');
  entryId = _toEntryId(entryId);

  const existing = await TreasuryRepository.getById(entryId);
  if (!existing) throw new Error('❌ الحركة غير موجودة');
  if (existing.username !== username) throw new Error('❌ غير مسموح');

  // Only allow editing manual entries — not auto entries
  const editableEffects = TREASURY_EDITABLE_EFFECTS;
  if (!editableEffects.includes(existing.effect)) {
    throw new Error('❌ لا يمكن تعديل هذه الحركة — هي حركة تلقائية');
  }

  const updates = {};
  if (patch.amount !== undefined) updates.amount = Money.toCents(patch.amount);
  if (patch.date !== undefined) updates.date = patch.date;
  if (patch.note !== undefined) updates.note = String(patch.note || '').trim() || null;
  if (patch.description !== undefined) updates.description = String(patch.description || '').trim() || null;
  if (patch.client_name !== undefined) updates.client_name = String(patch.client_name || '').trim() || null;
  if (patch.employee_name !== undefined) updates.employee_name = String(patch.employee_name || '').trim() || null;

  const ops = [
    { op: 'update', store: STORE.TREASURY, id: entryId, patch: updates },
  ];

  await DBProvider.transaction(ops, { username });
  const updated = await TreasuryRepository.getById(entryId);

  window.dispatchEvent(new CustomEvent(DOMAIN_EVENT.TREASURY_CHANGED));
  return Money.decimalizeRecord(updated);
}

/**
 * Delete (reverse) a treasury entry (حذف / عكس حركة)
 */
async function deleteEntry(username, entryId) {
  if (!username) throw new Error('[Treasury] username required');
  if (!entryId) throw new Error('[Treasury] entryId required');
  entryId = _toEntryId(entryId);

  const existing = await TreasuryRepository.getById(entryId);
  if (!existing) throw new Error('❌ الحركة غير موجودة');
  if (existing.username !== username) throw new Error('❌ غير مسموح');

  const editableEffects = TREASURY_EDITABLE_EFFECTS;
  if (!editableEffects.includes(existing.effect)) {
    throw new Error('❌ لا يمكن حذف هذه الحركة — هي حركة تلقائية');
  }

  const now = _nowISO();
  const ops = [
    {
      op: 'update',
      store: STORE.TREASURY,
      id: entryId,
      patch: { is_reversed: true, reversed_at: now, reversed_by: username },
    },
  ];

  await DBProvider.transaction(ops, { username });

  window.dispatchEvent(new CustomEvent(DOMAIN_EVENT.TREASURY_CHANGED));
}

/**
 * Get filtered entries for display
 */
async function getEntries(username, filters = null) {
  if (!username) throw new Error('[Treasury] username required');

  const all = await TreasuryRepository.getAll(username);
  let entries = all.filter(e => e.is_reversed === false);

  if (filters?.from || filters?.to) {
    entries = entries.filter(e => {
      const d = String(e.date || '').split('T')[0];
      if (filters.from && d < filters.from) return false;
      if (filters.to && d > filters.to) return false;
      return true;
    });
  }

  if (filters?.tab === TREASURY_TAB.EXPENSES) {
    entries = entries.filter(e => TREASURY_EXPENSE_EFFECTS.includes(e.effect));
  }

  return entries
    .sort((a, b) => {
      const da = new Date(b.applied_at || b.date || 0).getTime();
      const db = new Date(a.applied_at || a.date || 0).getTime();
      return da - db;
    })
    .map(Money.decimalizeRecord);
}

const TreasuryService = Object.freeze({
  depositCapital,
  createSalfa,
  createExpense,
  editEntry,
  deleteEntry,
  getEntries,
});

// ═══════════════════════════════════════════════════════════════════════════════
// UI State
// ═══════════════════════════════════════════════════════════════════════════════

const STATE = {
  tab: TREASURY_TAB.ALL,
  from: '',
  to: '',
  editingId: null,
  search: { all: '', expenses: '' },
  _salfaClients: [],       // client list stored in state, not on DOM node
  _shellRendered: false,   // idempotent shell rendering
};

// ── Render-cache for data-driven print ──
let _lastRenderedEntries = [];
let _lastRenderedSummary = { balance: 0, total_in: 0, total_salfa: 0, total_expense: 0 };

// ── Async generation counter ──
let _refreshGen = 0;

// ── Suppress event-driven refresh when a UI handler will refresh explicitly ──
// Set to true before calling a TreasuryService method that dispatches
// DOMAIN_EVENT.TREASURY_CHANGED. The event listener skips its _refreshPage() call.
// The UI handler then calls _refreshPage() itself — single execution path.
let _suppressEventRefresh = false;

function _setQuickRange(days) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));
  STATE.from = DateUtils.toLocalDate(from);
  STATE.to = DateUtils.toLocalDate(to);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Renders the treasury page shell.
 *
 * Idempotent: it only runs if the shell has not
 * been rendered yet (or if the page element is empty, indicating a page
 * lifecycle reset from app.js).  This prevents destroying delegated listeners
 * or losing input state on re-entry.
 */
function _renderShell() {
  const page = document.getElementById('treasuryPage');
  if (!page) return;

  // Idempotent guard: skip if shell is already present
  if (STATE._shellRendered && page.querySelector('#treasuryTableBody')) return;

  page.innerHTML = `
    <div class="p-6 card">
      <div class="card-header mb-4">
        <h2 class="card-title mb-0">الخزنة</h2>
      </div>

      <!-- Summary Cards -->
      <div id="treasurySummaryCards" class="flex flex-nowrap gap-2 pb-2 mb-6 overflow-x-auto"></div>

      <!-- Action Buttons -->
      <div class="flex flex-wrap gap-2 mb-6">
        <button type="button" data-action="treasury-deposit" class="btn btn-success btn-sm">➕ إيداع رأس مال</button>
        <button type="button" data-action="treasury-salfa" class="btn btn-primary btn-sm">💰 سلفة</button>
        <button type="button" data-action="treasury-expense" class="btn btn-secondary btn-sm">📦 مصروف / مرتب</button>
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap gap-3 items-end mb-4">
        <button type="button" data-action="treasury-range" data-days="1" class="btn btn-secondary btn-sm">اليوم</button>
        <button type="button" data-action="treasury-range" data-days="7" class="btn btn-secondary btn-sm">أسبوع</button>
        <button type="button" data-action="treasury-range" data-days="30" class="btn btn-secondary btn-sm">شهر</button>
        <div class="form-group mb-0">
          <label class="label mb-1 text-xs" for="treasuryFrom">من</label>
          <input id="treasuryFrom" type="date" class="input input-sm">
        </div>
        <div class="form-group mb-0">
          <label class="label mb-1 text-xs" for="treasuryTo">إلى</label>
          <input id="treasuryTo" type="date" class="input input-sm">
        </div>
        <button type="button" data-action="treasury-apply-filter" class="btn btn-primary btn-sm">تطبيق</button>
        <button type="button" data-action="treasury-clear-filter" class="btn btn-secondary btn-sm">مسح</button>
      </div>

      <!-- Tabs -->
      <div class="tabs mb-4" role="tablist">
        <button type="button" data-action="treasury-tab" data-tab="all" class="tab-btn active-purple">📊 الكل</button>
        <button type="button" data-action="treasury-tab" data-tab="expenses" class="tab-btn">📦 مصروفات ومرتبات</button>
      </div>

      <!-- Search + Print -->
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;">
        <input id="treasurySearch" type="text" class="ent-search-input" style="flex:1;padding:10px 16px;border:1.5px solid #d1d5db;border-radius:12px;font-family:inherit;font-size:0.875rem;outline:none;"
          placeholder="🔍 ابحث داخل جميع الحركات..."
          value="">
        <button type="button" data-action="treasury-print-tab" style="background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;border:none;border-radius:12px;padding:8px 18px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;white-space:nowrap;box-shadow:0 2px 8px rgba(124,58,237,0.3);">🖨️ طباعة</button>
      </div>

      <!-- Entries Table -->
      <div class="table-wrapper overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>الوقت</th>
              <th>النوع</th>
              <th>الوصف</th>
              <th>الشخص</th>
              <th>المبلغ</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody id="treasuryTableBody"></tbody>
        </table>
      </div>
    </div>
  `;

  STATE._shellRendered = true;
}

function _renderSummary(summary) {
  const container = document.getElementById('treasurySummaryCards');
  if (!container) return;

  const card = (label, value, bg) => `
    <div class="flex-1 min-w-[120px] p-3 rounded-lg text-white" style="background:${bg}">
      <p class="text-xs opacity-90 mb-1" style="color:#fff">${_esc(label)}</p>
      <p class="text-xl font-bold" style="color:#fff">${Money.fmt(value)}</p>
    </div>`;

  container.innerHTML = `
    ${card('رصيد الخزنة', summary.balance, 'linear-gradient(135deg,#1e40af,#3b82f6)')}
    ${card('إجمالي الداخل', summary.total_in, 'linear-gradient(135deg,#059669,#10b981)')}
    ${card('السلفيات', summary.total_salfa, 'linear-gradient(135deg,#0891b2,#06b6d4)')}
    ${card('المصروفات والمرتبات', summary.total_expense, 'linear-gradient(135deg,#dc2626,#ef4444)')}
  `;
}

function _renderEntries(entries) {
  const tbody = document.getElementById('treasuryTableBody');
  if (!tbody) return;

  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted p-6">لا توجد حركات في هذه الفترة</td></tr>`;
    return;
  }

  const editableEffects = TREASURY_EDITABLE_EFFECTS;

  tbody.innerHTML = entries.map(e => {
    const isEditable = editableEffects.includes(e.effect);
    const dirClass = _directionClass(e.type);
    return `
      <tr data-entry-id="${_esc(e.id)}">
        <td>${_dateDisplay(e.date)}</td>
        <td>${_timeDisplay(e.applied_at)}</td>
        <td>
          <span class="${dirClass}">${_typeIcon(e.type)} ${_effectLabel(e.effect)}</span>
        </td>
        <td>${_esc(e.description || e.note || '—')}</td>
        <td>${_esc(e.client_name || e.employee_name || '—')}</td>
        <td class="font-semibold ${dirClass}">${e.type === TREASURY_ENTRY_TYPE.DEPOSIT ? '+' : '-'}${Money.fmt(e.amount)}</td>
        <td>
          ${isEditable ? `
            <button type="button" data-action="treasury-edit" data-id="${e.id}" class="btn btn-secondary btn-sm">✏️</button>
            <button type="button" data-action="treasury-delete" data-id="${e.id}" class="btn btn-secondary btn-sm">🗑️</button>
          ` : `<span class="text-muted text-xs">تلقائي</span>`}
        </td>
      </tr>
    `;
  }).join('');
}

function _renderTabs() {
  const page = document.getElementById('treasuryPage');
  if (!page) return;
  page.querySelectorAll('[data-action="treasury-tab"]').forEach(btn => {
    btn.classList.toggle('active-purple', btn.dataset.tab === STATE.tab);
  });
}

/**
 * Update the search input placeholder to match the current tab.
 * Called from _refreshPage() so it stays in sync after tab switches
 * without re-rendering the shell.
 */
function _syncSearchPlaceholder() {
  const searchEl = document.getElementById('treasurySearch');
  if (!searchEl) return;
  if (STATE.tab === TREASURY_TAB.EXPENSES) {
    searchEl.placeholder = '🔍 ابحث داخل المصروفات والمرتبات...';
  } else {
    searchEl.placeholder = '🔍 ابحث داخل جميع الحركات...';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Modals
// ═══════════════════════════════════════════════════════════════════════════════

function _ensureModals() {
  if (document.getElementById('treasuryModal')) return;

  const div = document.createElement('div');
  div.innerHTML = `
    <div id="treasuryModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md">
        <div class="flex items-center justify-between mb-4">
          <h3 id="treasuryModalTitle" class="text-lg font-bold">عملية</h3>
          <button type="button" data-action="treasury-modal-close" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>
        <div id="treasuryModalBody" class="grid gap-3"></div>
        <div id="treasuryModalMsg" class="field-msg-inline field-msg-inline--error mt-3" role="alert"></div>
      </div>
    </div>
  `;
  document.body.appendChild(div.firstElementChild);
}

function _openModal(title, bodyHTML) {
  _ensureModals();
  const modal = document.getElementById('treasuryModal');
  const titleEl = document.getElementById('treasuryModalTitle');
  const body = document.getElementById('treasuryModalBody');
  const msg = document.getElementById('treasuryModalMsg');
  if (titleEl) titleEl.textContent = title;
  if (body) body.innerHTML = bodyHTML;
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal?.classList.remove('hidden');
}

function _closeModal() {
  document.getElementById('treasuryModal')?.classList.add('hidden');
  STATE.editingId = null;
}

function _showModalError(text) {
  const msg = document.getElementById('treasuryModalMsg');
  if (msg) { msg.textContent = text; msg.classList.add('is-visible'); }
}

function _modalVal(id) {
  return document.getElementById(id)?.value?.trim() || '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Modal Forms
// ═══════════════════════════════════════════════════════════════════════════════

function _openDepositModal() {
  _openModal('إيداع رأس مال', `
    <div class="form-group mb-0">
      <label class="label mb-1" for="tDepositAmount">المبلغ</label>
      <input id="tDepositAmount" type="number" min="0" step="0.01" class="input input-sm" placeholder="0.00">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tDepositDate">التاريخ</label>
      <input id="tDepositDate" type="date" class="input input-sm" value="${_todayISO()}">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tDepositNote">ملاحظة</label>
      <input id="tDepositNote" type="text" class="input input-sm" placeholder="اختياري">
    </div>
    <button type="button" data-action="treasury-save-deposit" class="btn btn-primary btn-full mt-2">حفظ</button>
  `);
}

async function _openSalfaModal() {
  const username = _currentUsername();
  // Load clients list via repositories
  const owners = await ClientRepository.getAllOwners();
  const clients = [
    ...owners.filter(o => o.deleted_at === null).map(o => ({ id: o.id, type: CLIENT_TYPE.OWNER, name: o.name || '' })),
  ].filter(c => c.name);

  // Store client list in STATE, not on a DOM node
  STATE._salfaClients = clients;

  const options = clients.map(c => `<option value="${_esc(c.name)}" data-id="${c.id}" data-type="${c.type}"></option>`).join('');

  _openModal('سلفة', `
    <div class="form-group mb-0">
      <label class="label mb-1" for="tSalfaPerson">الشخص</label>
      <input id="tSalfaPerson" type="text" list="tSalfaClientsList" class="input input-sm" placeholder="اختر من القائمة أو اكتب اسم">
      <datalist id="tSalfaClientsList">${options}</datalist>
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tSalfaAmount">المبلغ</label>
      <input id="tSalfaAmount" type="number" min="0" step="0.01" class="input input-sm" placeholder="0.00">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tSalfaDate">التاريخ</label>
      <input id="tSalfaDate" type="date" class="input input-sm" value="${_todayISO()}">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tSalfaNote">ملاحظة</label>
      <input id="tSalfaNote" type="text" class="input input-sm" placeholder="اختياري">
    </div>
    <button type="button" data-action="treasury-save-salfa" class="btn btn-primary btn-full mt-2">حفظ</button>
  `);
}

function _openExpenseModal() {
  _openModal('مصروف / مرتب', `
    <div class="form-group mb-0">
      <label class="label mb-1">النوع</label>
      <div class="flex gap-3">
        <label class="flex items-center gap-1">
          <input type="radio" name="tExpenseType" value="expense" checked> مصروف
        </label>
        <label class="flex items-center gap-1">
          <input type="radio" name="tExpenseType" value="salary"> مرتب
        </label>
      </div>
    </div>
    <div id="tExpenseDescWrap" class="form-group mb-0">
      <label class="label mb-1" for="tExpenseDesc">الوصف</label>
      <input id="tExpenseDesc" type="text" class="input input-sm" placeholder="إيجار / بنزين / صيانة...">
    </div>
    <div id="tExpenseEmpWrap" class="form-group mb-0 hidden">
      <label class="label mb-1" for="tExpenseEmp">اسم الموظف</label>
      <input id="tExpenseEmp" type="text" class="input input-sm" placeholder="اسم الموظف">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tExpenseAmount">المبلغ</label>
      <input id="tExpenseAmount" type="number" min="0" step="0.01" class="input input-sm" placeholder="0.00">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tExpenseDate">التاريخ</label>
      <input id="tExpenseDate" type="date" class="input input-sm" value="${_todayISO()}">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tExpenseNote">ملاحظة</label>
      <input id="tExpenseNote" type="text" class="input input-sm" placeholder="اختياري">
    </div>
    <button type="button" data-action="treasury-save-expense" class="btn btn-primary btn-full mt-2">حفظ</button>
  `);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Save Handlers
// ═══════════════════════════════════════════════════════════════════════════════

let _isSavingTreasury = false;

async function _saveDeposit() {
  if (_isSavingTreasury) return;
  _isSavingTreasury = true;
  const btn = document.querySelector('[data-action="treasury-save-deposit"]');
  if (btn) btn.disabled = true;
  try {
    const amount = parseFloat(_modalVal('tDepositAmount')) || 0;
    const date = _modalVal('tDepositDate');
    const note = _modalVal('tDepositNote');
    if (amount <= 0) { _showModalError('❌ المبلغ مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }
    if (!date) { _showModalError('❌ التاريخ مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }
    _suppressEventRefresh = true;
    await TreasuryService.depositCapital(_currentUsername(), { amount, date, note });
    _suppressEventRefresh = false;
    _closeModal();
    await _refreshPage();
  } catch (err) {
    _showModalError(err.message || '❌ حدث خطأ');
  } finally {
    _suppressEventRefresh = false;
    _isSavingTreasury = false;
    if (btn) btn.disabled = false;
  }
}

async function _saveSalfa() {
  if (_isSavingTreasury) return;
  _isSavingTreasury = true;
  const btn = document.querySelector('[data-action="treasury-save-salfa"]');
  if (btn) btn.disabled = true;
  try {
    const personName = _modalVal('tSalfaPerson');
    const amount = parseFloat(_modalVal('tSalfaAmount')) || 0;
    const date = _modalVal('tSalfaDate');
    const note = _modalVal('tSalfaNote');
    if (amount <= 0) { _showModalError('❌ المبلغ مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }
    if (!date) { _showModalError('❌ التاريخ مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }

    // Read client list from STATE, not from DOM node property
    let client_id = null, client_type = null, client_name = personName || null;
    const clients = STATE._salfaClients || [];
    const match = clients.find(c => c.name === personName);
    if (match) {
      client_id = String(match.id);
      client_type = match.type;
      client_name = match.name;
    }

    _suppressEventRefresh = true;
    await TreasuryService.createSalfa(_currentUsername(), {
      client_id, client_type, client_name, amount, date, note,
    });
    _suppressEventRefresh = false;
    _closeModal();
    await _refreshPage();
  } catch (err) {
    _showModalError(err.message || '❌ حدث خطأ');
  } finally {
    _suppressEventRefresh = false;
    _isSavingTreasury = false;
    if (btn) btn.disabled = false;
  }
}

async function _saveExpense() {
  if (_isSavingTreasury) return;
  _isSavingTreasury = true;
  const btn = document.querySelector('[data-action="treasury-save-expense"]');
  if (btn) btn.disabled = true;
  try {
    const subtype = document.querySelector('input[name="tExpenseType"]:checked')?.value || EFFECTS.EXPENSE;
    const description = _modalVal('tExpenseDesc');
    const employee_name = _modalVal('tExpenseEmp');
    const amount = parseFloat(_modalVal('tExpenseAmount')) || 0;
    const date = _modalVal('tExpenseDate');
    const note = _modalVal('tExpenseNote');
    if (amount <= 0) { _showModalError('❌ المبلغ مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }
    if (!date) { _showModalError('❌ التاريخ مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }
    if (subtype === EFFECTS.SALARY && !employee_name) { _showModalError('❌ اسم الموظف مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }
    if (subtype === EFFECTS.EXPENSE && !description) { _showModalError('❌ وصف المصروف مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }

    _suppressEventRefresh = true;
    await TreasuryService.createExpense(_currentUsername(), {
      subtype, description, employee_name, amount, date, note,
    });
    _suppressEventRefresh = false;
    _closeModal();
    await _refreshPage();
  } catch (err) {
    _showModalError(err.message || '❌ حدث خطأ');
  } finally {
    _suppressEventRefresh = false;
    _isSavingTreasury = false;
    if (btn) btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Print — data-driven
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Print the current treasury tab.
 *
 * Data-driven: reads from a cached render of entries/summary, never scraped DOM text.
 * Now reads exclusively from _lastRenderedEntries and _lastRenderedSummary
 * (raw data cached on each _refreshPage()).
 *
 * Zero DOM-driven financial values.
 */
function _printTreasuryTab() {
  const tabLabels = { all: 'جميع الحركات', expenses: 'مصروفات ومرتبات' };
  const tabTitle = tabLabels[STATE.tab] || 'الخزنة';

  const entries = _lastRenderedEntries;
  if (!entries.length) { alert('لا توجد حركات للطباعة'); return; }

  const summary = _lastRenderedSummary;

  let tableRows = '';
  for (const e of entries) {
    const dirSign = e.type === TREASURY_ENTRY_TYPE.DEPOSIT ? '+' : '-';
    const amountDisplay = `${dirSign}${Money.fmt(e.amount)}`;
    tableRows += `<tr>
      <td style="padding:6px 8px;border:1px solid #d1d5db;text-align:center;">${_esc(_dateDisplay(e.date))}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;text-align:center;">${_esc(_timeDisplay(e.applied_at))}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;text-align:right;">${_esc(_typeIcon(e.type))} ${_esc(_effectLabel(e.effect))}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;text-align:right;">${_esc(e.description || e.note || '—')}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;text-align:right;">${_esc(e.client_name || e.employee_name || '—')}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;text-align:center;font-weight:700;">${amountDisplay}</td>
    </tr>`;
  }

  // Build summary cards from raw data
  const summaryItems = [
    { label: 'رصيد الخزنة', value: Money.fmt(summary.balance) },
    { label: 'إجمالي الداخل', value: Money.fmt(summary.total_in) },
    { label: 'السلفيات', value: Money.fmt(summary.total_salfa) },
    { label: 'المصروفات والمرتبات', value: Money.fmt(summary.total_expense) },
  ];

  const summaryHTML = '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">'
    + summaryItems.map(item =>
      `<div style="flex:1;min-width:100px;border:1px solid #cbd5e1;border-radius:6px;padding:8px 12px;text-align:center;"><div style="font-size:8pt;color:#6b7280;">${_esc(item.label)}</div><div style="font-size:14pt;font-weight:800;color:#1e3a8a;">${item.value}</div></div>`
    ).join('')
    + '</div>';

  const now = new Date();
  const dateStr = now.toLocaleDateString('ar-EG', { dateStyle: 'full' });
  const timeStr = now.toLocaleTimeString('ar-EG', { timeStyle: 'short' });

  const body = `
    <div style="text-align:center;margin-bottom:16px;border-bottom:2px solid #1e3a8a;padding-bottom:10px;">
      <h2 style="margin:0;color:#1e3a8a;font-size:16pt;">الخزنة — ${_esc(tabTitle)}</h2>
      <p style="margin:4px 0 0;color:#6b7280;font-size:9pt;">${dateStr} — ${timeStr}</p>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #1e3a8a;font-size:9pt;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;">التاريخ</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #1e3a8a;font-size:9pt;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;">الوقت</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #1e3a8a;font-size:9pt;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;">النوع</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #1e3a8a;font-size:9pt;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;">الوصف</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #1e3a8a;font-size:9pt;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;">الشخص</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #1e3a8a;font-size:9pt;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;">المبلغ</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
    ${summaryHTML}`;

  printHTML(buildPrintDocument({
    title: 'طباعة الخزنة — ' + tabTitle,
    body,
    orientation: 'landscape',
  }), { id: 'treasury-print-iframe' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Refresh
// ═══════════════════════════════════════════════════════════════════════════════

function _computeFilteredSummary(entries) {
  let total_in = 0;
  let total_salfa = 0;
  let total_expense = 0;
  let balance_in = 0;
  let balance_out = 0;

  for (const e of entries) {
    const amt = Money.toCents(e.amount);
    if (e.type === TREASURY_ENTRY_TYPE.DEPOSIT) { total_in += amt; balance_in += amt; }
    if (e.type === TREASURY_ENTRY_TYPE.WITHDRAW) balance_out += amt;
    if (e.effect === EFFECTS.SALFA) total_salfa += amt;
    if (e.effect === EFFECTS.EXPENSE || e.effect === EFFECTS.SALARY) total_expense += amt;
  }

  return {
    balance: Money.toDecimal(balance_in - balance_out),
    total_in: Money.toDecimal(total_in),
    total_salfa: Money.toDecimal(total_salfa),
    total_expense: Money.toDecimal(total_expense),
  };
}

/**
 * _refreshPage — master refresh function.
 *
 * Uses a generation counter to discard stale async results.
 * If a newer _refreshPage() call starts before this one finishes fetching,
 * this call's render is silently discarded — preventing stale data display.
 *
 * This also updates the search placeholder so tab switches
 * update it without re-rendering the shell.
 */
async function _refreshPage() {
  const gen = ++_refreshGen;
  const username = _currentUsername();
  const filters = { from: STATE.from, to: STATE.to, tab: STATE.tab };

  const allEntries = await TreasuryService.getEntries(username, filters);

  // Stale check: if another refresh started while we were fetching, abort
  if (gen !== _refreshGen) return;

  // Apply search filter
  const query = (STATE.search[STATE.tab] || '').trim().toLowerCase();
  const filteredEntries = query
    ? allEntries.filter(e => {
        const hay = [
          e.note, e.description, e.client_name, e.employee_name,
          _effectLabel(e.effect),
          String(e.amount), e.date, e.reference_id,
        ].join(' ').toLowerCase();
        return hay.includes(query);
      })
    : allEntries;

  // Cache for data-driven print
  _lastRenderedEntries = filteredEntries;

  // Compute summary from filtered entries only
  const filteredSummary = _computeFilteredSummary(filteredEntries);

  // Cache summary for print
  _lastRenderedSummary = filteredSummary;

  _renderSummary(filteredSummary);
  _renderEntries(filteredEntries);
  _renderTabs();

  // Sync inputs
  const fromEl = document.getElementById('treasuryFrom');
  const toEl = document.getElementById('treasuryTo');
  if (fromEl) fromEl.value = STATE.from || '';
  if (toEl) toEl.value = STATE.to || '';

  // Sync search input value + placeholder
  const searchEl = document.getElementById('treasurySearch');
  if (searchEl) searchEl.value = STATE.search[STATE.tab] || '';
  _syncSearchPlaceholder();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Events
// ═══════════════════════════════════════════════════════════════════════════════

function _injectStyles() {
  if (document.getElementById('treasury-module-styles')) return;
  const style = document.createElement('style');
  style.id = 'treasury-module-styles';
  style.textContent = `
    .treasury-in { color: #059669; }
    .treasury-out { color: #dc2626; }
  `;
  document.head.appendChild(style);
}

let _bound = false;

function attachTreasuryListeners() {
  if (_bound) return;
  _bound = true;
  console.log('[Treasury] ✅ attachTreasuryListeners executed — click handler registered on document');

  document.addEventListener('click', async (e) => {
    // Scope all delegated click listeners strictly inside #treasuryPage or treasuryModal
    const treasuryRoot = e.target.closest('#treasuryPage') || e.target.closest('#treasuryModal');
    if (!treasuryRoot) return;

    // ── Runtime diagnostic (safe to keep in production — fires only inside treasury) ──
    const actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      console.log('[Treasury] Click:', actionEl.dataset.action, 'id=' + (actionEl.dataset.id || '—'));
    }

    // Deposit
    if (e.target.closest('[data-action="treasury-deposit"]')) {
      _openDepositModal();
      return;
    }
    if (e.target.closest('[data-action="treasury-save-deposit"]')) {
      await _saveDeposit();
      return;
    }

    // Salfa
    if (e.target.closest('[data-action="treasury-salfa"]')) {
      await _openSalfaModal();
      return;
    }
    if (e.target.closest('[data-action="treasury-save-salfa"]')) {
      await _saveSalfa();
      return;
    }

    // Expense
    if (e.target.closest('[data-action="treasury-expense"]')) {
      _openExpenseModal();
      return;
    }
    if (e.target.closest('[data-action="treasury-save-expense"]')) {
      await _saveExpense();
      return;
    }

    // Modal close
    if (e.target.closest('[data-action="treasury-modal-close"]')) {
      _closeModal();
      return;
    }

    // Tabs
    const tabBtn = e.target.closest('[data-action="treasury-tab"]');
    if (tabBtn) {
      STATE.tab = tabBtn.dataset.tab || TREASURY_TAB.ALL;
      await _refreshPage();
      return;
    }

    // Date range
    const rangeBtn = e.target.closest('[data-action="treasury-range"]');
    if (rangeBtn) {
      _setQuickRange(Number(rangeBtn.dataset.days) || 30);
      await _refreshPage();
      return;
    }

    // Apply filter
    if (e.target.closest('[data-action="treasury-apply-filter"]')) {
      STATE.from = document.getElementById('treasuryFrom')?.value || '';
      STATE.to = document.getElementById('treasuryTo')?.value || '';
      await _refreshPage();
      return;
    }

    // Clear filter
    if (e.target.closest('[data-action="treasury-clear-filter"]')) {
      STATE.from = '';
      STATE.to = '';
      await _refreshPage();
      return;
    }

    // Delete entry
    const delBtn = e.target.closest('[data-action="treasury-delete"]');
    if (delBtn) {
      if (!confirm('هل تريد حذف هذه الحركة؟')) return;
      try {
        _suppressEventRefresh = true;
        await TreasuryService.deleteEntry(_currentUsername(), _toEntryId(delBtn.dataset.id));
        _suppressEventRefresh = false;
        await _refreshPage();
      } catch (err) {
        alert(err.message || '❌ حدث خطأ');
      } finally {
        _suppressEventRefresh = false;
      }
      return;
    }

    // Edit entry
    const editBtn = e.target.closest('[data-action="treasury-edit"]');
    if (editBtn) {
      const entryId = _toEntryId(editBtn.dataset.id);
      console.log('[Treasury] Edit lookup: raw=' + editBtn.dataset.id, 'normalized=' + entryId, 'type=' + typeof entryId);
      const entry = await TreasuryRepository.getById(entryId);
      if (!entry) {
        console.error('[Treasury] ❌ Entry not found for id:', entryId, '(type:', typeof entryId + ')');
        return;
      }
      const dec = Money.decimalizeRecord(entry);

      STATE.editingId = entryId;
      _openModal('تعديل الحركة', `
        <div class="form-group mb-0">
          <label class="label mb-1">النوع</label>
          <input type="text" class="input input-sm" value="${_esc(_effectLabel(entry.effect))}" disabled>
        </div>
        <div class="form-group mb-0">
          <label class="label mb-1" for="tEditAmount">المبلغ</label>
          <input id="tEditAmount" type="number" min="0" step="0.01" class="input input-sm" value="${dec.amount}">
        </div>
        <div class="form-group mb-0">
          <label class="label mb-1" for="tEditDate">التاريخ</label>
          <input id="tEditDate" type="date" class="input input-sm" value="${_dateDisplay(entry.date)}">
        </div>
        <div class="form-group mb-0">
          <label class="label mb-1" for="tEditNote">ملاحظة</label>
          <input id="tEditNote" type="text" class="input input-sm" value="${_esc(entry.note || '')}">
        </div>
        <button type="button" data-action="treasury-save-edit" class="btn btn-primary btn-full mt-2">حفظ التعديل</button>
      `);
      return;
    }

    // Save edit
    if (e.target.closest('[data-action="treasury-save-edit"]')) {
      if (!STATE.editingId) return;
      if (_isSavingTreasury) return;
      _isSavingTreasury = true;
      const editSaveBtn = e.target.closest('[data-action="treasury-save-edit"]');
      if (editSaveBtn) editSaveBtn.disabled = true;
      try {
        const amount = parseFloat(_modalVal('tEditAmount')) || 0;
        const date = _modalVal('tEditDate');
        const note = _modalVal('tEditNote');
        if (amount <= 0) { _showModalError('❌ المبلغ مطلوب'); _isSavingTreasury = false; if (editSaveBtn) editSaveBtn.disabled = false; return; }
        _suppressEventRefresh = true;
        await TreasuryService.editEntry(_currentUsername(), STATE.editingId, { amount, date, note });
        _suppressEventRefresh = false;
        _closeModal();
        await _refreshPage();
      } catch (err) {
        _showModalError(err.message || '❌ حدث خطأ');
      } finally {
        _suppressEventRefresh = false;
        _isSavingTreasury = false;
        if (editSaveBtn) editSaveBtn.disabled = false;
      }
      return;
    }

    // Print tab
    if (e.target.closest('[data-action="treasury-print-tab"]')) {
      _printTreasuryTab();
      return;
    }
  });

  // Expense type radio toggle
  document.addEventListener('change', (e) => {
    // Only process if change is inside treasuryPage or treasuryModal
    const treasuryRoot = e.target.closest('#treasuryPage') || e.target.closest('#treasuryModal');
    if (!treasuryRoot) return;

    if (e.target.name === 'tExpenseType') {
      const isSalary = e.target.value === EFFECTS.SALARY;
      document.getElementById('tExpenseDescWrap')?.classList.toggle('hidden', isSalary);
      document.getElementById('tExpenseEmpWrap')?.classList.toggle('hidden', !isSalary);
    }
  });

  // Search input - scoped strictly to treasury page
  document.addEventListener('input', (e) => {
    const treasuryRoot = e.target.closest('#treasuryPage') || e.target.closest('#treasuryModal');
    if (!treasuryRoot) return;

    if (e.target.id === 'treasurySearch') {
      STATE.search[STATE.tab] = e.target.value;
      _refreshPage();
    }
  });

  // Listen for external changes
  // External change listener — skipped when a UI handler will refresh explicitly.
  // This prevents double DB queries when the treasury page itself triggers the event.
  window.addEventListener(DOMAIN_EVENT.TREASURY_CHANGED, () => {
    if (_suppressEventRefresh) return;
    const page = document.getElementById('treasuryPage');
    if (page && !page.classList.contains('hidden')) {
      _refreshPage();
    }
  });
  window.addEventListener(DOMAIN_EVENT.RECEIPTS_CHANGED, () => {
    const page = document.getElementById('treasuryPage');
    if (page && !page.classList.contains('hidden')) {
      _refreshPage();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════════════════

function initTreasuryPage() {
  console.log('[Treasury] initTreasuryPage() called');
  _injectStyles();
  _renderShell();
  attachTreasuryListeners();
  _refreshPage();
  console.log('[Treasury] initTreasuryPage() complete — module fully loaded');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════════════════════════

export { TreasuryService, initTreasuryPage, attachTreasuryListeners };
