/**
 * dashboard.js — لوحة التحكم / Dashboard العميل
 * Completely isolated from core financial operations, read-only to existing data.
 */

import { Money } from './money.js';
import { AuthModule } from './auth.js';
import { ReceiptRepository } from './services/receiptRepository.js';
import { ReceiptReadRepository } from './services/receiptReadRepository.js';
import { DateUtils } from './dateUtils.js';

// ── Domain constants (self-contained — no external import dependency) ──────
const DOMAIN_EVENT = Object.freeze({
  RECEIPTS_CHANGED : 'receipts:changed',
  OFFICES_CHANGED  : 'offices:changed',
});

// ─── CONFIGURATION ──────────────────────────────────────────────────────────

const STATE = {
  quickRange: '', // 'day', 'week', 'month', or ''
  from: '',
  to: '',
};

function _currentUsername() {
  const session = AuthModule.getSession();
  if (!session?.username) throw new Error('Username required');
  return session.username;
}

function _esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── DATE HELPERS ────────────────────────────────────────────────────────────

function _setQuickFilterRange(rangeType) {
  const to = new Date();
  const from = new Date();
  if (rangeType === 'day') {
    // Today
    STATE.from = DateUtils.toLocalDate(to);
    STATE.to = DateUtils.toLocalDate(to);
  } else if (rangeType === 'week') {
    // Last 7 days
    from.setDate(to.getDate() - 6);
    STATE.from = DateUtils.toLocalDate(from);
    STATE.to = DateUtils.toLocalDate(to);
  } else if (rangeType === 'month') {
    // Last 30 days
    from.setDate(to.getDate() - 29);
    STATE.from = DateUtils.toLocalDate(from);
    STATE.to = DateUtils.toLocalDate(to);
  } else {
    STATE.from = '';
    STATE.to = '';
  }
  STATE.quickRange = rangeType;
}

// ─── AGGREGATE CALCULATIONS (DETERMINISTIC & MEMORIZED) ──────────────────────

// ── Read-side ReceiptRow projection (normalized Receipt/ReceiptRow) ──
// Persisted receipt HEADERS (receipts store) no longer carry row entities;
// rows live in the separate receipt_rows store. They are fetched once per
// refresh through the frozen ReceiptReadRepository and projected in-memory,
// keyed by receipt id — mirroring the allReceipts.js projection pattern.
// Rows are NEVER attached onto receipt header objects — there is no embedded
// receipt.rows anywhere in this module.
async function _loadReceiptRowsProjection(receipts) {
  const projection = new Map();
  await Promise.all((receipts || []).map(async (rec) => {
    const key = String(rec?.id ?? '');
    if (!key) { projection.set(key, []); return; }
    try {
      const rows = await ReceiptReadRepository.getReceiptRowsByReceipt(rec.id);
      projection.set(key, rows || []);
    } catch (err) {
      console.warn('[dashboard] row projection failed for receipt', key, err);
      projection.set(key, []);
    }
  }));
  return projection;
}

// ─── STYLE INJECTION FOR COMPLETE CSS ISOLATION ──────────────────────────────

function _injectIsolatedStyles() {
  if (document.getElementById('dashboard-isolated-styles')) return;

  const style = document.createElement('style');
  style.id = 'dashboard-isolated-styles';
  style.textContent = `
    /* ==========================================
       DASHBOARD NAMESPACED ISOLATED STYLES
       ========================================== */

    /* Core container */
    .dashboard-page {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      direction: rtl !important;
      text-align: right !important;
      font-family: 'Cairo', Arial, sans-serif !important;
      color: #1f2937;
      background-color: #f9fafb;
    }

    /* Isolated Cards */
    .dashboard-card {
      background: #ffffff !important;
      border-radius: 1rem !important;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.08), 0 2px 4px -1px rgba(0,0,0,0.04) !important;
      padding: 1.5rem !important;
      border: 1px solid #e5e7eb !important;
      position: relative !important;
      transition: box-shadow 0.25s ease, transform 0.25s ease !important;
    }

    .dashboard-card-hover:hover {
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05) !important;
    }

    /* Header Inner Alignments */
    .dashboard-header-inner {
      display: flex;
      flex-direction: row;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1.5rem;
    }

    @media (max-width: 1024px) {
      .dashboard-header-inner {
        flex-direction: column;
        align-items: flex-start;
      }
    }

    /* Filters Layout */
    .dashboard-filters-area {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      width: auto;
    }

    @media (max-width: 1024px) {
      .dashboard-filters-area {
        width: 100%;
      }
    }

    /* Quick Period Selector */
    .dashboard-quick-filters {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    /* Quick Filter Action Button */
    .dashboard-filter-btn {
      background-color: #e5e7eb !important;
      color: #374151 !important;
      font-weight: 700 !important;
      padding: 0.45rem 1rem !important;
      border-radius: 0.5rem !important;
      border: none !important;
      cursor: pointer !important;
      transition: background-color 0.2s, color 0.2s !important;
      font-size: 0.75rem !important;
      font-family: inherit !important;
    }

    .dashboard-filter-btn:hover {
      background-color: #2563eb !important;
      color: #ffffff !important;
    }

    .dashboard-filter-btn.active {
      background-color: #2563eb !important;
      color: #ffffff !important;
      box-shadow: 0 2px 4px rgba(37, 99, 235, 0.2) !important;
    }

    /* Manual Period Form Container */
    .dashboard-manual-filter-bar {
      background-color: #f9fafb !important;
      border: 1px solid #e5e7eb !important;
      border-radius: 0.75rem !important;
      padding: 0.5rem 1rem !important;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .dashboard-manual-filter-bar label {
      font-size: 0.75rem !important;
      font-weight: 700 !important;
      color: #4b5563 !important;
      margin: 0 !important;
    }

    .dashboard-manual-filter-bar input[type="date"] {
      border: 1px solid #cbd5e1 !important;
      border-radius: 0.5rem !important;
      padding: 0.35rem 0.65rem !important;
      font-size: 0.8125rem !important;
      font-family: inherit !important;
      color: #1f2937 !important;
      background-color: #ffffff !important;
      outline: none !important;
      transition: border-color 0.15s, box-shadow 0.15s !important;
    }

    .dashboard-manual-filter-bar input[type="date"]:focus {
      border-color: #7c3aed !important;
      box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.15) !important;
    }

    .dashboard-apply-btn {
      background-color: #4f46e5 !important;
      color: #ffffff !important;
      font-weight: 700 !important;
      padding: 0.45rem 1.25rem !important;
      border-radius: 0.5rem !important;
      border: none !important;
      cursor: pointer !important;
      transition: background-color 0.15s, box-shadow 0.15s !important;
      font-size: 0.75rem !important;
      font-family: inherit !important;
    }

    .dashboard-apply-btn:hover {
      background-color: #3730a3 !important;
      box-shadow: 0 4px 6px rgba(79, 70, 229, 0.15) !important;
    }

    /* Statistics Responsive Grid */
    .dashboard-grid {
      display: grid !important;
      grid-template-columns: repeat(5, 1fr) !important;
      gap: 1rem !important;
      width: 100% !important;
    }

    @media (max-width: 1280px) {
      .dashboard-grid {
        grid-template-columns: repeat(3, 1fr) !important;
      }
    }

    @media (max-width: 768px) {
      .dashboard-grid {
        grid-template-columns: repeat(2, 1fr) !important;
      }
    }

    @media (max-width: 480px) {
      .dashboard-grid {
        grid-template-columns: 1fr !important;
      }
    }

    /* Single Statistics Card with animated hover */
    .dashboard-stat-card {
      position: relative !important;
      border-radius: 1rem !important;
      padding: 1.25rem !important;
      color: #ffffff !important;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1) !important;
      border: 1px solid rgba(255, 255, 255, 0.15) !important;
      transform: translateY(0) !important;
      transition: transform 0.25s ease, box-shadow 0.25s ease !important;
      display: flex !important;
      flex-direction: column !important;
      justify-content: space-between !important;
      min-height: 125px !important;
    }

    .dashboard-stat-card:hover {
      transform: translateY(-4px) !important;
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.15) !important;
    }

    .dashboard-stat-title {
      font-size: 0.75rem !important;
      font-weight: 700 !important;
      color: rgba(255, 255, 255, 0.88) !important;
      margin: 0 0 0.5rem 0 !important;
    }

    .dashboard-stat-value {
      font-size: 1.625rem !important;
      font-weight: 800 !important;
      color: #ffffff !important;
      margin: 0 !important;
      line-height: 1.25 !important;
      font-variant-numeric: tabular-nums !important;
      direction: ltr !important;
      unicode-bidi: embed !important;
      text-align: right !important;
    }

    .dashboard-stat-value span {
      font-size: 0.75rem !important;
      font-weight: 600 !important;
      margin-right: 3px !important;
    }

    .dashboard-stat-desc {
      font-size: 0.6875rem !important;
      color: rgba(255, 255, 255, 0.7) !important;
      margin: 0.5rem 0 0 0 !important;
    }

    /* Gradient colors for summary cards */
    .dashboard-stat-indigo  { background: linear-gradient(135deg, #4f46e5, #7c3aed) !important; }
    .dashboard-stat-teal    { background: linear-gradient(135deg, #0d9488, #115e59) !important; }
    .dashboard-stat-emerald { background: linear-gradient(135deg, #10b981, #047857) !important; }
  `;
  document.head.appendChild(style);
}

// ─── RENDERING ───────────────────────────────────────────────────────────────

function _renderShell() {
  const page = document.getElementById('dashboardPage');
  if (!page) return;

  // Render the main dashboard content container if it doesn't exist
  let mainContent = page.querySelector('.dashboard-page');
  if (!mainContent) {
    mainContent = document.createElement('div');
    mainContent.className = 'dashboard-page';
    page.appendChild(mainContent);
  }

  mainContent.innerHTML = `
      <!-- Section 1: Header + Filters -->
      <div class="dashboard-card dashboard-card-hover">
        <div class="dashboard-header-inner">
          <div>
            <h1 class="text-2xl font-bold text-gray-800" style="margin:0 0 4px 0;">Dashboard العميل</h1>
            <p class="text-muted text-xs" style="margin:0;">ملخص شامل للحركة المالية والربحية للمركبات والشركات</p>
          </div>
          
          <!-- Filters area -->
          <div class="dashboard-filters-area">
            <!-- Row 1: Quick Filters -->
            <div class="dashboard-quick-filters">
              <button id="btnRangeDay" type="button" class="dashboard-filter-btn">يوم</button>
              <button id="btnRangeWeek" type="button" class="dashboard-filter-btn">أسبوع</button>
              <button id="btnRangeMonth" type="button" class="dashboard-filter-btn">شهر</button>
              <button id="btnRangeAll" type="button" class="dashboard-filter-btn">الكل</button>
            </div>
            
            <!-- Row 2: Manual Date Filter -->
            <div class="dashboard-manual-filter-bar">
              <label>من</label>
              <input id="dashFromDate" type="date">
              <label>إلى</label>
              <input id="dashToDate" type="date">
              <button id="btnApplyManualDate" type="button" class="dashboard-apply-btn">تطبيق</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Section 2: Statistics Cards Grid -->
      <div id="dashboardStatsGrid" class="dashboard-grid">
        <!-- Dynamic Cards Inserted Here -->
      </div>

      <!-- Section 3: Spacing Area / Footer -->
      <div style="padding: 1rem 0; text-align: center; font-size: 0.75rem; color: var(--color-gray-400); font-weight: 700; border-top: 1px solid var(--color-gray-200);">
        نظام Karta المالي — لوحة التحكم الذكية &copy; 2026
      </div>
  `;
}

async function _refreshDashboard() {
  const username = _currentUsername();

  // 1. Read raw tables via repositories
  const allReceipts = await ReceiptRepository.getAll(username);

  // 2. Filter datasets based on selected dates with defense guards
  const activeReceipts = (allReceipts || []).filter(r => {
    if (!r || r.deleted_at !== null) return false;
    const d = String(r.receipt_date || '').split('T')[0];
    if (STATE.from && d < STATE.from) return false;
    if (STATE.to && d > STATE.to) return false;
    return true;
  });

  // ─── ROW PROJECTION (normalized ReceiptRow reads) ────────────────
  // receipt_rows are fetched once via the frozen ReceiptReadRepository and
  // projected by receipt id; header objects never carry embedded rows.
  const receiptRowsProjection = await _loadReceiptRowsProjection(activeReceipts);

  // ─── CALCULATE STATISTICS ──────────────────────────────────────────────────

  // "إجمالي المكتب" — Sum of officeAmount from active receipts within selected period
  let totalOfficeCents = 0;
  for (const r of activeReceipts) {
    if (r) {
      const rows = receiptRowsProjection.get(String(r.id)) || [];
      for (const row of rows) {
        if (!row) continue; // separators are UI-local — never persisted in receipt_rows
        // officeAmount is persisted in integer cents on each ReceiptRow.
        totalOfficeCents += Number(row.officeAmount) || 0;
      }
    }
  }
  const totalOfficeVal = Money.toDecimal(totalOfficeCents);

  // ─── RENDER STATISTICS CARDS ────────────────────────────────────────────────

  _renderSummaryCards(totalOfficeVal);
}

function _renderSummaryCards(office) {
  const container = document.getElementById('dashboardStatsGrid');
  if (!container) return;

  const fmt = (v) => Money.fmt(v);

  const cardHtml = (title, value, description, gradientClass) => `
    <div class="dashboard-stat-card ${gradientClass}">
      <div>
        <p class="dashboard-stat-title">${_esc(title)}</p>
        <p class="dashboard-stat-value">${fmt(value)} <span>ج.م</span></p>
      </div>
      <p class="dashboard-stat-desc">${_esc(description)}</p>
    </div>`;

  container.innerHTML = `
    ${cardHtml('إجمالي المكتب', office, 'نسبة عمولة المكتب المحصلة من الكارتات', 'dashboard-stat-teal')}
  `;
}

// ─── SYNC NAVIGATION ACTIVE TABS ─────────────────────────────────────────────

function _syncQuickRangeButtons() {
  const btnDay = document.getElementById('btnRangeDay');
  const btnWeek = document.getElementById('btnRangeWeek');
  const btnMonth = document.getElementById('btnRangeMonth');
  const btnAll = document.getElementById('btnRangeAll');

  const removeAllActive = () => {
    [btnDay, btnWeek, btnMonth, btnAll].forEach(btn => {
      if (btn) btn.classList.remove('active');
    });
  };

  removeAllActive();

  if (STATE.quickRange === 'day' && btnDay) btnDay.classList.add('active');
  else if (STATE.quickRange === 'week' && btnWeek) btnWeek.classList.add('active');
  else if (STATE.quickRange === 'month' && btnMonth) btnMonth.classList.add('active');
  else if (STATE.quickRange === '' && btnAll) btnAll.classList.add('active');

  const dashFrom = document.getElementById('dashFromDate');
  const dashTo = document.getElementById('dashToDate');
  if (dashFrom) dashFrom.value = STATE.from || '';
  if (dashTo) dashTo.value = STATE.to || '';
}

// ─── DOM EVENT BINDING ───────────────────────────────────────────────────────

let _bound = false;

function _attachListeners() {
  if (_bound) return;
  _bound = true;

  document.addEventListener('click', async (e) => {
    // Scope all delegated click listeners strictly inside #dashboardPage
    const insideDashboard = e.target.closest('#dashboardPage');
    if (!insideDashboard) return;

    const id = e.target.id;

    // Quick range filters
    if (id === 'btnRangeDay') {
      _setQuickFilterRange('day');
      _syncQuickRangeButtons();
      await _refreshDashboard();
      return;
    }
    if (id === 'btnRangeWeek') {
      _setQuickFilterRange('week');
      _syncQuickRangeButtons();
      await _refreshDashboard();
      return;
    }
    if (id === 'btnRangeMonth') {
      _setQuickFilterRange('month');
      _syncQuickRangeButtons();
      await _refreshDashboard();
      return;
    }
    if (id === 'btnRangeAll') {
      _setQuickFilterRange('');
      _syncQuickRangeButtons();
      await _refreshDashboard();
      return;
    }

    // Apply manual range filter
    if (id === 'btnApplyManualDate') {
      STATE.from = document.getElementById('dashFromDate')?.value || '';
      STATE.to = document.getElementById('dashToDate')?.value || '';
      STATE.quickRange = 'manual';
      _syncQuickRangeButtons();
      await _refreshDashboard();
      return;
    }
  });

  // External sync events - these are window events but guarded by visibility checks inside
  window.addEventListener(DOMAIN_EVENT.RECEIPTS_CHANGED, async () => {
    const page = document.getElementById('dashboardPage');
    if (page && !page.classList.contains('hidden')) {
      await _refreshDashboard();
    }
  });

  window.addEventListener(DOMAIN_EVENT.OFFICES_CHANGED, async () => {
    const page = document.getElementById('dashboardPage');
    if (page && !page.classList.contains('hidden')) {
      await _refreshDashboard();
    }
  });
}

// ─── INITIALIZATION ───────────────────────────────────────────────────────────

export async function initDashboardPage() {
  const session = AuthModule.getSession();
  if (session?.role !== 'admin') {
    console.warn('[Dashboard] Unauthorized access attempt blocked.');
    return;
  }

  _injectIsolatedStyles();
  _renderShell();
  _attachListeners();
  _syncQuickRangeButtons();
  await _refreshDashboard();
}
