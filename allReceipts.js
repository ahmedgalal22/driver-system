import { ReceiptsModule } from './receipts.js';
import { Money } from './money.js';
import { FinancialService } from './financial.js';
import {
  loadReceiptForEdit,
  renderReceiptSnapshotTableHead,
  renderReceiptSnapshotRowsHtml,
  DATA_COL_COUNT,
} from './receipts.js';
import { printHTML, buildPrintDocument } from './printEngine.js';
import { ExcelService } from './excelService.js';
import { ReceiptRepository } from './services/receiptRepository.js';
import { ReceiptReadRepository } from './services/receiptReadRepository.js';
import { DateUtils } from './dateUtils.js';

const PAGE_ID = 'allReceiptsPage';
const DATE_FMT = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'full' });
const SHORT_DATE_FMT = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' });
const TIME_FMT = new Intl.DateTimeFormat('ar-EG', { timeStyle: 'short' });

const STATE = {
  ready: false,
  loading: false,
  receipts: [],
  filters: {
    receipts: createFilterState(),
  },
};

function createFilterState() {
  const range = getLast30DaysRange();
  return {
    global: '',
    owner: '',
    company: '',
    date: '',
    number: '',
    vehicle: '',
    karta: '',
    type: '',
    from: range.from,
    to: range.to,
  };
}

function getPage() {
  return document.getElementById(PAGE_ID);
}

function getSessionUsername() {
  return window.__APP_CONTEXT__?.username || '';
}

/* ─── GENERAL NOTE AUTO-SAVE ─────────────────────────────────────────────── */
const _noteSaveTimers = new Map();

function _debouncedNoteSave(receiptId, value, username) {
  if (!receiptId || !username) return;
  if (_noteSaveTimers.has(receiptId)) {
    clearTimeout(_noteSaveTimers.get(receiptId));
  }
  const timer = setTimeout(async () => {
    try {
      await ReceiptRepository.update(receiptId, { notes: value.trim() || null }, { username });
    } catch (err) {
      console.error('[allReceipts] note auto-save failed:', err);
    } finally {
      _noteSaveTimers.delete(receiptId);
    }
  }, 700);
  _noteSaveTimers.set(receiptId, timer);
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMoney(value) { // delegated to Money.fmt
  return Money.fmt(value);

}

function toNumber(value) {
  return Number(value) || 0;
}

function getLast30DaysRange() {
  const today = new Date();
  const to = DateUtils.toLocalDate(today);
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - 89);
  return { from: DateUtils.toLocalDate(fromDate), to };
}

function normalizeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return DateUtils.toLocalDate(date);
}

function inRange(dateValue, from, to) {
  const value = normalizeDate(dateValue);
  if (!value) return false;
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
}

function rowContains(value, query) {
  if (!query) return true;
  return String(value ?? '').toLowerCase().includes(query);
}

function receiptDisplayDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return SHORT_DATE_FMT.format(date);
}

function receiptFullDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return DATE_FMT.format(date);
}

function receiptDayName(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ar-EG', { weekday: 'long' }).format(date);
}

function receiptTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return TIME_FMT.format(date);
}

function normalizePersistedRow(row) {
  if (!row || typeof row !== 'object') return row;
  if (row._type === 'separator') return row;
  const hasSeparatorShape = row.vehicleName != null
    && row.subtotal != null
    && !row.kartano
    && !row.kartaNo
    && !row.karta;
  if (hasSeparatorShape) return { ...row, _type: 'separator' };
  return row;
}

// ── Read-side row projection (Step 6 — normalized Receipt/ReceiptRow) ──
// Persisted receipts and their rows live in SEPARATE stores (receipts /
// receipt_rows). This page renders synchronously from STATE, so rows are
// fetched once per data load through ReceiptReadRepository and projected
// here, keyed by receipt id. Rows are NEVER attached onto receipt header
// objects — there is no embedded receipt.rows anywhere in this module.
const _receiptRowsProjection = new Map();

/**
 * Bridge one persisted ReceiptRow (persisted contract, money in CENTS:
 * { row_id, receipt_id, driver_id, vehicle_id, vehicle_plate, driver_price,
 *   loading, destination, office, advance, net, sarf, kartano, date,
 *   driver_name, weight, weight2, deficit, weightTotal, type, officeAmount,
 *   discount, add, row_order })
 * into the read-side vocabulary this page renders/prints (money in DECIMALS).
 * Mirrors the receipts.js read boundary. Every user-entered column is
 * persisted (Phase 5 — Step 2) and restored here; rows saved before Step 2
 * carry null for these columns → they render blank (no fabrication).
 */
function _persistedRowToPageRow(row) {
  const destination = row.destination   || '';
  const plate       = row.vehicle_plate || '';
  const kartano     = row.kartano ?? '';
  const rowDate     = row.date    ?? '';
  const driverName  = row.driver_name || '';
  return {
    _type        : row.row_type === 'separator' ? 'separator' : 'data', // forward-compat
    row_id       : row.row_id     ?? null,
    receipt_id   : row.receipt_id ?? null,
    row_order    : row.row_order  ?? null,
    driver_id    : row.driver_id  ?? null,
    vehicle_id   : row.vehicle_id ?? null,
    vehicle_plate: plate,
    car          : plate,
    office       : row.office  || '',
    loading      : row.loading || '',
    taktik       : destination,
    direction    : destination,
    // ── restored user-entered columns (persisted — Phase 5 Step 2) ──
    kartano, kartaNo: kartano, karta: kartano,
    date: rowDate, rowdate: rowDate,
    data: driverName, driver: driverName,
    owner_name: '', notes: '',
    type: row.type ?? '',
    weight: row.weight ?? '', weight2: row.weight2 ?? '', deficit: row.deficit ?? '',
    weightTotal: row.weightTotal ?? '', weight_total: row.weightTotal ?? '',
    // ── money: cents → decimals ──
    discount: Money.toDecimal(row.discount ?? 0),
    officeAmount: Money.toDecimal(row.officeAmount ?? 0),
    add: Money.toDecimal(row.add ?? 0),
    noloon: Money.toDecimal(row.driver_price ?? 0), // driver_price → نولون
    ohda  : Money.toDecimal(row.advance ?? 0),      // advance     → عهدة
    sarf  : Money.toDecimal(row.sarf ?? 0),
    net   : Money.toDecimal(row.net  ?? 0),
  };
}

async function _loadReceiptRowsProjection(receipts) {
  _receiptRowsProjection.clear();
  await Promise.all((receipts || []).map(async (rec) => {
    const key = String(rec?.id ?? '');
    try {
      const rows = key
        ? await ReceiptReadRepository.getReceiptRowsByReceipt(rec.id)
        : [];
      // Render in the persisted row_order sequence (stable sort; pre-Step-2
      // rows carry null and keep repository order).
      const ordered = [...(rows || [])].sort((a, b) =>
        (a?.row_order ?? Number.MAX_SAFE_INTEGER) - (b?.row_order ?? Number.MAX_SAFE_INTEGER));
      _receiptRowsProjection.set(key, ordered.map(_persistedRowToPageRow));
    } catch (err) {
      console.warn('[allReceipts] row projection failed for receipt', key, err);
      _receiptRowsProjection.set(key, []);
    }
  }));
}

function getReceiptRows(record) {
  const rows = _receiptRowsProjection.get(String(record?.id ?? '')) || [];
  return rows.map(normalizePersistedRow);
}

function hasActiveRowFilters(filters) {
  return !!(
    String(filters.global || '').trim()
    || String(filters.owner || '').trim()
    || String(filters.company || '').trim()
    || String(filters.vehicle || '').trim()
    || String(filters.karta || '').trim()
    || String(filters.number || '').trim()
    || String(filters.type || '').trim()
  );
}

function rowMatchesReceiptFilters(row, record, filters) {
  const global = String(filters.global || '').trim().toLowerCase();
  const owner = String(filters.owner || '').trim().toLowerCase();
  const company = String(filters.company || '').trim().toLowerCase();
  const vehicle = String(filters.vehicle || '').trim().toLowerCase();
  const karta = String(filters.karta || '').trim().toLowerCase();
  const number = String(filters.number || '').trim().toLowerCase();
  const typeFilter = String(filters.type || '').trim().toLowerCase();

  // Record-level filters: if active and record doesn't match, hide all rows
  if (number && !rowContains(record.receipt_number, number)) return false;

  if (row._type === 'separator') {
    const hay = [row.vehicleName, row.notes, String(row.subtotal ?? '')].join(' ').toLowerCase();
    if (global && hay.includes(global)) return true;
    if (vehicle && rowContains(row.vehicleName, vehicle)) return true;
    // If only record-level filters are active (number), show separators
    if (!global && !owner && !company && !vehicle && !karta && !typeFilter) return true;
    return false;
  }

  const hay = [
    row.kartano, row.kartaNo, row.karta, row.date, row.rowdate,
    row.data, row.driver, row.owner_name, row.car, row.carNo,
    row.vehicle_plate, row.office, row.loading, row.direction, row.taktik,
    row.type, row.notes, row.noloon, row.ohda, row.net,
  ].join(' ').toLowerCase();

  if (global && !hay.includes(global)) return false;
  if (owner && !rowContains(row.owner_name, owner) && !rowContains(record.owner_name || record.client_name, owner)) return false;
  if (company && !rowContains(row.office, company) && !rowContains(record.company_name, company)) return false;
  if (vehicle && !rowContains(row.car || row.carNo || row.vehicle_plate, vehicle)) return false;
  if (karta && !rowContains(row.kartano || row.kartaNo || row.karta, karta)) return false;
  if (typeFilter && !rowContains(row.type, typeFilter)) return false;
  return true;
}

/** عرض بصري لصفوف محفوظة فقط — بدون إعادة حساب مالي */
function getDisplayRowsForReceipt(record, filters = STATE.filters.receipts) {
  const rows = getReceiptRows(record);
  if (!hasActiveRowFilters(filters)) return rows;
  return rows.filter((row) => rowMatchesReceiptFilters(row, record, filters));
}

function sumVisibleRowWeight(rows) {
  return rows
    .filter((row) => row._type !== 'separator')
    .reduce((sum, row) => {
      if (row.weightTotal != null && row.weightTotal !== '') {
        return sum + toNumber(row.weightTotal);
      }
      if (row.weight_total != null && row.weight_total !== '') {
        return sum + toNumber(row.weight_total);
      }
      return sum + toNumber(row.weight) + toNumber(row.weight2) - toNumber(row.deficit);
    }, 0);
}

function sumVisibleRowField(rows, field) {
  return rows
    .filter((row) => row._type !== 'separator')
    .reduce((sum, row) => sum + toNumber(row[field]), 0);
}

function getReceiptCardsFiltered() {
  const filters = STATE.filters.receipts;
  const global = String(filters.global || '').trim().toLowerCase();
  const owner = String(filters.owner || '').trim().toLowerCase();
  const company = String(filters.company || '').trim().toLowerCase();
  const number = String(filters.number || '').trim().toLowerCase();
  const vehicle = String(filters.vehicle || '').trim().toLowerCase();
  const karta = String(filters.karta || '').trim().toLowerCase();
  const typeFilter = String(filters.type || '').trim().toLowerCase();
  const from = filters.from || '';
  const to = filters.to || '';
  const date = String(filters.date || '').trim();

  return STATE.receipts
    .filter((record) => inRange(record.receipt_date, from, to))
    .filter((record) => !date || normalizeDate(record.receipt_date) === normalizeDate(date))
    .filter((record) => {
      const rows = getReceiptRows(record);
      const haystack = [
        record.client_name,
        record.owner_name,
        record.receipt_number,
        record.vehicle_id,
        record.receipt_date,
        record.company_name,
        record.notes,
        ...rows.map((row) => [
          row.kartano, row.kartaNo, row.karta, row.carNo, row.car, row.vehicle_plate,
          row.owner_name, row.office, row.loading, row.direction, row.taktik, row.notes,
          row.vehicleName, row.data, row.driver, row.date, row.rowdate, row.type,
          row.noloon, row.ohda, row.net, row.officeAmount, row.add,
        ].join(' ')),
      ].join(' ').toLowerCase();

      if (global && !haystack.includes(global)) return false;
      if (owner && !rowContains(record.owner_name || record.client_name, owner) && !rows.some((row) => rowContains(row.owner_name, owner))) return false;
      if (company && !rowContains(record.company_name, company) && !rows.some((row) => rowContains(row.office, company))) return false;
      if (number && !rowContains(record.receipt_number, number)) return false;
      if (vehicle && !rowContains(record.vehicle_id, vehicle) && !rows.some((row) => rowContains(row.carNo || row.car || row.vehicle_plate, vehicle))) return false;
      if (karta && !rows.some((row) => rowContains(row.kartaNo || row.kartano || row.karta, karta))) return false;
      if (typeFilter && !rows.some((row) => rowContains(row.type, typeFilter))) return false;
      if (hasActiveRowFilters(filters)) {
        const visible = getDisplayRowsForReceipt(record, filters);
        if (!visible.some((row) => row._type !== 'separator')) return false;
      }
      return true;
    });
}


function summarizeReceipts(records) {
  const filters = STATE.filters.receipts;
  const rowFilterActive = hasActiveRowFilters(filters);

  return records.reduce((acc, record) => {
    if (!rowFilterActive) {
      const rows = getReceiptRows(record);
      acc.count += rows.filter((row) => row._type !== 'separator').length;
      acc.weight += sumVisibleRowWeight(rows);
      acc.noloon += sumVisibleRowField(rows, 'noloon');
      acc.ohda += sumVisibleRowField(rows, 'ohda');
      return acc;
    }

    const visible = getDisplayRowsForReceipt(record, filters);
    const dataRows = visible.filter((row) => row._type !== 'separator');
    if (dataRows.length === 0) return acc;

    acc.count += dataRows.length;
    dataRows.forEach((row) => {
      acc.noloon += toNumber(row.noloon);
      acc.ohda += toNumber(row.ohda);
    });
    acc.weight += sumVisibleRowWeight(visible);
    return acc;
  }, { count: 0, weight: 0, noloon: 0, ohda: 0 });
}







function setFilterValue(tab, key, value) {
  STATE.filters[tab][key] = value;
}

function setLast30(tab) {
  const range = getLast30DaysRange();
  STATE.filters[tab].from = range.from;
  STATE.filters[tab].to = range.to;
  STATE.filters[tab].date = '';
}

function setQuickRange(tab, days) {
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - (days - 1));
  STATE.filters[tab].from = DateUtils.toLocalDate(fromDate);
  STATE.filters[tab].to = DateUtils.toLocalDate(toDate);
  STATE.filters[tab].date = '';
}

function renderShell() {
  const page = getPage();
  if (!page) return;

  page.classList.remove('card');
  page.classList.add('all-receipts-page');
  page.innerHTML = `
    <div class="all-receipts-bg">
      <div class="all-receipts-card">

        <div class="all-receipts-header">
          <h2 class="all-receipts-title">جميع نماذج الصرف</h2>
          <p class="all-receipts-subtitle">عرض مركزي للكارتات مع التصفية والطباعة والتعديل الآمن.</p>
        </div>

        <div class="all-receipts-panels">
          <section class="all-panel" data-panel="receipts">
            ${renderReceiptsControls()}
            <div id="receiptsSummaryContainer"></div>
            <div id="receiptsList" class="all-list"></div>
          </section>
        </div>

      </div>
    </div>
  `;
}


function renderReceiptsControls() {
  const f = STATE.filters.receipts;
  return `
    <div class="filter-grid receipt-filters no-print">
      <label>
        <input data-filter-tab="receipts" data-filter-key="global" type="text" value="${esc(f.global)}" placeholder="بحث في جميع الحقول" />
      </label>
      <label>
        <input data-filter-tab="receipts" data-filter-key="owner" type="text" value="${esc(f.owner)}" placeholder="صاحب المركبة" list="receiptOwnersDatalist" />
      </label>
      <label>
        <input data-filter-tab="receipts" data-filter-key="company" type="text" value="${esc(f.company)}" placeholder="اسم الشركة" list="receiptCompaniesDatalist" />
      </label>
      <label>
        <input data-filter-tab="receipts" data-filter-key="number" type="text" value="${esc(f.number)}" placeholder="  اذن الصرف" list="receiptNumbersDatalist" />
      </label>
      <label>
        <input data-filter-tab="receipts" data-filter-key="vehicle" type="text" value="${esc(f.vehicle)}" placeholder="رقم المركبة" list="receiptVehiclesDatalist" />
      </label>
      <label>
        <input data-filter-tab="receipts" data-filter-key="karta" type="text" value="${esc(f.karta)}" placeholder="رقم الكارتة" list="receiptKartasDatalist" />
      </label>
      <label>
        <input data-filter-tab="receipts" data-filter-key="type" type="text" value="${esc(f.type)}" placeholder="النوع" />
      </label>
    </div>
    <div class="range-toolbar no-print">
      <button type="button" data-range="receipts" data-days="1" class="range-btn">يوم</button>
      <button type="button" data-range="receipts" data-days="7" class="range-btn">أسبوع</button>
      <button type="button" data-range="receipts" data-days="30" class="range-btn">شهر</button>
      <label>
        <span>من</span>
        <input data-filter-tab="receipts" data-filter-key="from" type="date" value="${esc(f.from)}" />
      </label>
      <label>
        <span>إلى</span>
        <input data-filter-tab="receipts" data-filter-key="to" type="date" value="${esc(f.to)}" />
      </label>
      <button type="button" data-action="apply-filter" data-tab="receipts" class="apply-btn apply-btn--receipts">تطبيق</button>
      <button type="button" data-action="print-filtered" data-tab="receipts" class="pdf-btn">📄 تصدير PDF</button>
      <button type="button" data-action="export-excel-filtered" data-tab="receipts" class="excel-btn">📊 تصدير Excel</button>
    </div>
    <datalist id="receiptOwnersDatalist"></datalist>
    <datalist id="receiptCompaniesDatalist"></datalist>
    <datalist id="receiptNumbersDatalist"></datalist>
    <datalist id="receiptVehiclesDatalist"></datalist>
    <datalist id="receiptKartasDatalist"></datalist>
  `;
}


function renderSummaryCards(_tab, _preFiltered) {
  const filtered = _preFiltered || getReceiptCardsFiltered();
  const sums = summarizeReceipts(filtered);
  const html = `
      <div class="summary-grid summary-grid--receipts">
        ${summaryCard('🗂️ عدد الكارتات', String(sums.count), 'summary-card--blue')}
        ${summaryCard('⚖️ إجمالي الوزن', fmtMoney(sums.weight), 'summary-card--green')}
        ${summaryCard('🚛 إجمالي النولون', fmtMoney(sums.noloon), 'summary-card--cyan')}
        ${summaryCard('🏦 إجمالي العهدة', fmtMoney(sums.ohda), 'summary-card--emerald')}
      </div>
    `;
  const container = document.getElementById('receiptsSummaryContainer');
  if (container) container.innerHTML = html;
  return html;
}


function summaryCard(label, value, extraClass) {
  return `
    <div class="summary-card ${extraClass}">
      <div class="summary-card__label">${esc(label)}</div>
      <div class="summary-card__value">${esc(value)}</div>
    </div>
  `;
}



/**
 * Build the HTML for a single receipt card.
 * @param {object} record — receipt record (from DB, cents-based)
 * @param {object} [opts] — { readOnly: false }
 * @returns {string} HTML
 */
function buildReceiptCardHtml(record, opts = {}) {
  const readOnly = opts.readOnly === true;
  const title = `${receiptDisplayDate(record.receipt_date)} — ${receiptDayName(record.receipt_date)} — ${receiptTime(record.created_at || record.updated_at || record.receipt_date)}`;
  const displayRows = getDisplayRowsForReceipt(record);
  const persistedRows = getReceiptRows(record);
  const kartaCount = record.row_count != null
    ? record.row_count
    : persistedRows.filter((row) => row._type !== 'separator').length;

  const actionsHtml = readOnly
    ? `<div class="record-card__actions no-print">
         <button type="button" data-action="print-single-receipt" data-id="${esc(record.id)}">🖨️ طباعة</button>
       </div>`
    : `<div class="record-card__actions no-print">
         <button type="button" data-action="edit-receipt" data-id="${esc(record.id)}">✏️ تعديل</button>
         <button type="button" data-action="print-single-receipt" data-id="${esc(record.id)}">🖨️ طباعة</button>
         <button type="button" data-action="delete-receipt" data-id="${esc(record.id)}">🗑️ حذف</button>
       </div>`;

  const noteHtml = readOnly
    ? (record.notes ? `<div style="padding:14px 22px;background:#f8fafc;border-top:1px solid #e5e7eb;border-radius:0 0 20px 20px;font-size:0.8125rem;color:#475569;">📝 ${esc(record.notes)}</div>` : '')
    : `<div class="receipt-general-note no-print" style="padding: 14px 22px; background: #f8fafc; border-top: 1px solid #e5e7eb; border-radius: 0 0 20px 20px;">
         <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;">
           <div style="flex:1;">
             <label style="display: block; font-size: 12px; font-weight: 700; color: #475569; margin-bottom: 8px; font-family: inherit;">📝 ملاحظة عامة</label>
             <textarea data-receipt-note="${esc(record.id)}" class="input" style="min-height: 52px; resize: vertical; font-size: 13px; line-height: 1.6;" rows="2" placeholder="اكتب ملاحظة عامة لهذا النموذج...">${esc(record.notes || '')}</textarea>
           </div>
         </div>
       </div>`;

  return `
    <article class="record-card receipt-record" data-kind="receipt" data-id="${esc(record.id)}">
      <header class="record-card__header">
        <div class="record-card__heading">
          <h3>${esc(title)}</h3>
          <p style="font-size:1rem;font-weight:700;color:#1e3a8a;margin:0 0 4px;">
            <span>صاحب المركبة: ${esc(record.owner_name || record.client_name || '—')}</span>
            <span style="margin:0 8px;color:#cbd5e1;">|</span>
            <span>إذن الصرف: ${esc(record.receipt_number || '—')}</span>
          </p>
        </div>
        ${actionsHtml}
      </header>
      <div class="record-card__table-wrap">
        <table class="record-table receipt-snapshot-table">
          <thead class="bg-gradient-to-r from-blue-600 to-blue-700 text-white">
            <tr>${renderReceiptSnapshotTableHead()}</tr>
          </thead>
          <tbody>
            ${renderReceiptSnapshotRowsHtml(displayRows, { colSpan: DATA_COL_COUNT })}
          </tbody>
        </table>
      </div>
      <div class="record-card__footer">
        <div><span>عدد الكارتات</span><strong>${kartaCount}</strong></div>
        <div><span>الإجمالي</span><strong>${Money.fmtCents(record.total)}</strong></div>
        <div><span>رصيد العميل</span><strong>${Money.fmtCents(record.previous_balance)}</strong></div>
      </div>
      ${noteHtml}
    </article>
  `;
}

function renderReceiptList(_preFiltered) {
  const container = document.getElementById('receiptsList');
  if (!container) return;
  const filtered = _preFiltered || getReceiptCardsFiltered();

  // Preserve active note focus before rebuild
  const activeEl = document.activeElement;
  const activeNoteId = activeEl?.closest?.('[data-receipt-note]')?.dataset?.receiptNote;
  const activeNoteCursor = activeEl?.selectionStart;

  if (!filtered.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📄</div>
        <p class="empty-state__text">لا توجد نماذج في هذه الفترة</p>
        <p class="empty-state__sub">جرّب تغيير نطاق التاريخ أو شروط البحث</p>
      </div>
    `;
    return;
  }

  // ── Sort pipeline (data-driven, never mutates source) ──
  const sorted = [...filtered];
  sorted.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  container.innerHTML = sorted
    .map((record) => buildReceiptCardHtml(record))
    .join('');

  // Restore focus if user was typing in a note
  if (activeNoteId) {
    const restored = container.querySelector(`[data-receipt-note="${activeNoteId}"]`);
    if (restored) {
      restored.focus();
      if (typeof activeNoteCursor === 'number') {
        restored.setSelectionRange(activeNoteCursor, activeNoteCursor);
      }
    }
  }
}


function renderLists(_preFilteredReceipts) {
  renderReceiptList(_preFilteredReceipts);
}


function renderDatalists() {
  const receipts = STATE.receipts;
  setDatalist('receiptOwnersDatalist', receipts.map((r) => r.owner_name || r.client_name).filter(Boolean));
  setDatalist('receiptCompaniesDatalist', receipts.map((r) => r.company_name).filter(Boolean));
  setDatalist('receiptNumbersDatalist', receipts.map((r) => r.receipt_number).filter(Boolean));
  setDatalist('receiptVehiclesDatalist', receipts.flatMap((r) => getReceiptRows(r).map((row) => row.car || row.carNo || row.vehicle_plate)).filter(Boolean));
  setDatalist('receiptKartasDatalist', receipts.flatMap((r) => getReceiptRows(r).map((row) => row.kartaNo)).filter(Boolean));}

function setDatalist(id, values) {
  const list = document.getElementById(id);
  if (!list) return;
  const unique = [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 200);
  list.innerHTML = unique.map((value) => `<option value="${esc(value)}"></option>`).join('');
}



async function loadAllReceiptsData() {
  const username = getSessionUsername();
  if (!username) return;
  if (STATE.loading) return;
  STATE.loading = true;
  try {
    const receipts = await ReceiptsModule.getAll(username);
    STATE.receipts = receipts.slice();
    // Step 6: preload the normalized ReceiptRows through ReceiptReadRepository
    // (persisted receipts are headers only — rows live in receipt_rows).
    await _loadReceiptRowsProjection(STATE.receipts);
    renderSummaryCards('receipts');
    renderLists();
    try {
      renderDatalists();
    } catch (e) {
      console.warn('[allReceipts] renderDatalists error:', e);
    }
  } finally {
    STATE.loading = false;
  }
}


function serializeCurrentView(_tab) {
  const records = getReceiptCardsFiltered();
  const title = 'جميع الكارتات';
  const summaryHTML = _buildReceiptsBulkSummary(summarizeReceipts(records));
  const body = records.map((record) => buildReceiptPrintBlock(record)).join('');
  const content = body
    ? `${summaryHTML}${body}`
    : '<div class="print-empty">لا توجد بيانات للطباعة</div>';
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${printStyles()}</style></head><body><div class="print-page"><h1>${esc(title)}</h1>${content}</div></body></html>`;
}


/**
 * _buildReceiptsBulkSummary(sums)
 *
 * Renders a summary bar for the bulk PDF export (تصدير PDF) of receipt cards.
 * Mirrors the summary cards shown on screen above the list.
 *
 * Money units:
 *   weight, noloon, ohda   → DECIMAL (summed directly from row fields)
 *   count                  → integer
 */
function _buildReceiptsBulkSummary(sums) {
  const th = (label) => `<th style="background:#fff;color:#000;padding:4px 6px;border:1.5px solid #000;text-align:center;font-size:7pt;font-weight:700;">${esc(label)}</th>`;
  const td = (value) => `<td style="background:#fff;color:#000;padding:5px 6px;border:1.5px solid #000;text-align:center;font-size:11pt;font-weight:800;">${esc(value)}</td>`;

  return `
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;page-break-inside:avoid;">
      <thead>
        <tr>
          ${th('عدد الكارتات')}
          ${th('إجمالي الوزن')}
          ${th('إجمالي النولون')}
          ${th('إجمالي العهدة')}
        </tr>
      </thead>
      <tbody>
        <tr>
          ${td(String(sums.count))}
          ${td(fmtMoney(sums.weight))}
          ${td(fmtMoney(sums.noloon))}
          ${td(fmtMoney(sums.ohda))}
        </tr>
      </tbody>
    </table>`;
}

/**
 * _bulkReceiptBuildTableHead(activeCols)
 *
 * Builds a clean <thead> for the bulk PDF export of receipt cards.
 * Uses plain <th> tags with inline styles only — no Tailwind, no .no-print classes.
 * This is required because printStyles() has no Tailwind reset.
 */
function _bulkReceiptBuildTableHead(activeCols) {
  const cells = activeCols.map((col) =>
    `<th>${esc(col.label)}</th>`
  ).join('');
  return `<thead><tr>${cells}</tr></thead>`;
}

/**
 * _bulkReceiptBuildTableBody(rows, activeCols)
 *
 * Builds a clean <tbody> for the bulk PDF export.
 * Reads values directly from stored row objects — no DOM, no Tailwind classes.
 * Handles both data rows and separator rows.
 */
function _bulkReceiptBuildTableBody(rows, activeCols) {
  if (!rows.length) return '<tbody></tbody>';

  const colSpan = activeCols.length;

  const html = rows.map((row) => {
    // ── Separator row ─────────────────────────────────────────────────────
    if (row._type === 'separator') {
      const vehicleName = esc(row.vehicleName || '');
      const subtotal    = Money.fmt(Number(row.subtotal) || 0);
      const notes       = row.notes ? ` | ملاحظات: ${esc(row.notes)}` : '';
      return `<tr class="sep-row">
        <td colspan="${colSpan}" style="text-align:right;padding:4px 8px;background:#fff7ed;border-top:2px solid #fb923c;color:#9a3412;font-weight:700;">
          <strong>🔄 رقم المركبة: ${vehicleName}</strong>
          &nbsp;&nbsp; إجمالي ما سبق: <strong>${subtotal}</strong>${notes}
        </td>
      </tr>`;
    }

    // ── Data row ──────────────────────────────────────────────────────────
    const cells = activeCols.map((col) => {
      const raw       = _receiptPrintGetCellValue(row, col.key);
      const formatted = _receiptPrintFormatCell(raw, col.type);
      const align     = col.type === 'number' ? 'center' : 'right';
      return `<td style="text-align:${align};">${formatted}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  return `<tbody>${html}</tbody>`;
}

function buildReceiptPrintBlock(record) {
  const allRows  = getReceiptRows(record);
  const dataRows = allRows.filter((r) => r._type !== 'separator');

  const kartaCount = record.row_count != null
    ? record.row_count
    : dataRows.length;

  // Resolve columns using the same logic as printSingleReceipt —
  // strips printHide columns and empty conditional columns.
  const activeCols = _receiptPrintResolveColumns(dataRows);
  const thead      = _bulkReceiptBuildTableHead(activeCols);
  const tbody      = _bulkReceiptBuildTableBody(allRows, activeCols);

  return `
    <section class="print-card">
      <header>
        <strong>${esc(receiptDisplayDate(record.receipt_date))}</strong>
        - ${esc(receiptDayName(record.receipt_date))}
        - ${esc(record.receipt_number || '')}
      </header>
      <div class="print-meta">
        ${esc(record.owner_name || record.client_name || '')}
        ${record.company_name ? ' · ' + esc(record.company_name) : ''}
      </div>
      <table>
        ${thead}
        ${tbody}
      </table>
      ${record.notes ? `<div style="margin-top:8px;padding:6px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;font-size:9pt;"><strong style="color:#334155;">ملاحظة:</strong> <span style="color:#475569;">${esc(record.notes)}</span></div>` : ''}
      <div class="print-footer">
        <span>عدد الكارتات: <strong>${kartaCount}</strong></span>
        <span>الإجمالي: <strong>${Money.fmtCents(record.total)}</strong></span>
        <span>رصيد العميل: <strong>${Money.fmtCents(record.previous_balance)}</strong></span>
      </div>
    </section>
  `;
}


// ─────────────────────────────────────────────────────────────────────────────
// RECEIPT CARD PRINT SYSTEM
// Single-receipt print — allReceipts page, Kارتات tab.
//
// Design contract:
//   • Source of truth: the stored record object from STATE.receipts (never DOM).
//   • Top-level money fields (total,
//     previous_balance) are stored as CENTS  → Money.fmtCents().
//   • Row-level numeric fields (net, ohda, noloon, officeAmount, add, weight,
//     weight2, deficit, weightTotal) are stored as DECIMALS → Money.fmt().
//   • Separator rows (_type === 'separator') carry vehicleName, subtotal, notes.
//     subtotal is a DECIMAL (not cents) — matches how getSnapshotCellRawValue
//     handles separator rows.
//   • Conditional columns (weight, weight2, add) are included only when at
//     least one data row has a non-zero value for that field.
//   • Rendered via printEngine.js buildPrintDocument() — no raw HTML wrapper,
//     no window.open, no DOM cloning.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Column definitions for receipt print.
 * Mirrors the COL_DEFS shape from receipts.js but is scoped exclusively to
 * this print system — independent, no shared reference.
 *
 * printHide: true  → column is never rendered in print output.
 * conditional: true → column is rendered only when ≥1 data row has value > 0.
 */
const _RECEIPT_PRINT_COLS = Object.freeze([
  { key: 'kartano',      label: 'رقم الكارتة',  type: 'text',   printHide: false, conditional: false },
  { key: 'date',         label: 'التاريخ',       type: 'text',   printHide: false, conditional: false },
  { key: 'data',         label: 'اسم السائق',    type: 'text',   printHide: false, conditional: false },
  { key: 'car',          label: 'رقم المركبة',   type: 'text',   printHide: false, conditional: false },
  { key: 'weight',       label: 'وزن وش',        type: 'number', printHide: false, conditional: true  },
  { key: 'weight2',      label: 'وزن م',         type: 'number', printHide: false, conditional: true  },
  { key: 'deficit',      label: 'عجز',           type: 'number', printHide: false, conditional: false },
  { key: 'weightTotal',  label: 'الوزن',         type: 'number', printHide: false, conditional: false },
  { key: 'loading',      label: 'التحميل',       type: 'text',   printHide: false, conditional: false },
  { key: 'taktik',       label: 'الجهة',         type: 'text',   printHide: false, conditional: false },
  { key: 'type',         label: 'النوع',         type: 'text',   printHide: false, conditional: false },
  { key: 'noloon',       label: 'نولون',         type: 'number', printHide: false, conditional: false },
  { key: 'ohda',         label: 'عهدة',          type: 'number', printHide: false, conditional: false },
  { key: 'officeAmount', label: 'مكتب',          type: 'number', printHide: false, conditional: false },
  { key: 'add',          label: 'إضافة',         type: 'number', printHide: false, conditional: true  },
  { key: 'net',          label: 'الصافي',        type: 'number', printHide: false, conditional: false },
]);

/**
 * _receiptPrintGetCellValue(row, colKey)
 *
 * Reads a single cell value from a persisted data row.
 * Handles all field aliases used across different save-format versions.
 * Returns the raw value (string or number) — formatting is applied separately.
 *
 * Row field storage:
 *   - Text fields  → stored as strings.
 *   - Number fields → stored as DECIMALS (not cents).
 *   - weightTotal  → may be pre-calculated or absent (fallback: w+w2-deficit).
 */
function _receiptPrintGetCellValue(row, colKey) {
  switch (colKey) {
    case 'kartano':
      return row.kartano ?? row.kartaNo ?? row.karta ?? '';
    case 'date':
      return row.date ?? row.rowdate ?? '';
    case 'data':
      return row.data ?? row.driver ?? '';
    case 'car': {
      // Guard: skip UUID values that may have been stored in car/vehicle_plate
      // fields in legacy data (vehicle_id leak).
      const _carVal = row.car ?? row.vehicle_plate ?? row.carNo ?? row.vehicle_no ?? '';
      if (typeof _carVal === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(_carVal)) return '';
      return _carVal;
    }
    case 'weight':
      return row.weight ?? '';
    case 'weight2':
      return row.weight2 ?? '';
    case 'deficit':
      return row.deficit ?? '';
    case 'weightTotal': {
      // Pre-calculated field — fall back to arithmetic for legacy records.
      if (row.weightTotal != null && row.weightTotal !== '') return row.weightTotal;
      if (row.weight_total != null && row.weight_total !== '') return row.weight_total;
      const w1 = Number(row.weight)  || 0;
      const w2 = Number(row.weight2) || 0;
      const d  = Number(row.deficit) || 0;
      return (w1 > 0 || w2 > 0) ? (w1 + w2 - d) : '';
    }
    case 'loading':
      return row.loading ?? '';
    case 'taktik':
      return row.taktik ?? row.direction ?? '';
    case 'type':
      return row.type ?? '';
    case 'noloon':
      return row.noloon ?? '';
    case 'ohda':
      return row.ohda ?? '';
    case 'officeAmount':
      return row.officeAmount ?? '';
    case 'add':
      return row.add ?? '';
    case 'net':
      return row.net ?? '';
    default:
      return '';
  }
}

/**
 * _receiptPrintFormatCell(value, colType)
 *
 * Formats a raw cell value for print output.
 *   - Number columns: Money.fmt() (decimal formatting with 2dp).
 *   - Text columns:   HTML-escaped string.
 *   - Empty values:   '' (not '0.00' — keeps print clean).
 */
function _receiptPrintFormatCell(value, colType) {
  if (value === '' || value === null || value === undefined) return '';
  if (colType === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? Money.fmt(n) : esc(String(value));
  }
  return esc(String(value));
}

/**
 * _receiptPrintResolveColumns(dataRows)
 *
 * Determines the final set of columns to render in the print table.
 * Strips printHide columns always.
 * Strips conditional columns when no data row carries a non-zero value.
 *
 * @param {object[]} dataRows - Non-separator rows from the record.
 * @returns {object[]} Active column definitions.
 */
function _receiptPrintResolveColumns(dataRows) {
  // Find which conditional keys have at least one row with value > 0
  const conditionalKeys = new Set(
    _RECEIPT_PRINT_COLS
      .filter((col) => col.conditional)
      .map((col) => col.key)
  );

  const activeConditionals = new Set();
  for (const col of _RECEIPT_PRINT_COLS) {
    if (!col.conditional) continue;
    const hasData = dataRows.some((row) => {
      const val = Number(_receiptPrintGetCellValue(row, col.key));
      return Number.isFinite(val) && val !== 0;
    });
    if (hasData) activeConditionals.add(col.key);
  }

  return _RECEIPT_PRINT_COLS.filter((col) => {
    if (col.printHide) return false;
    if (conditionalKeys.has(col.key) && !activeConditionals.has(col.key)) return false;
    return true;
  });
}

/**
 * _receiptPrintBuildTableHead(activeCols)
 *
 * Renders the print table <thead> from the resolved active column list.
 * Uses blue header style matching the system's print standard.
 */
function _receiptPrintBuildTableHead(activeCols) {
  const cells = activeCols.map((col) =>
    `<th class="print-th">${esc(col.label)}</th>`
  ).join('');
  return `<thead><tr>${cells}</tr></thead>`;
}

/**
 * _receiptPrintBuildTableBody(rows, activeCols)
 *
 * Renders the print table <tbody> from stored rows.
 * Handles both data rows and separator rows correctly.
 * Never touches the DOM. All values come from the stored row objects.
 *
 * Separator row rendering:
 *   - subtotal is a DECIMAL value (not cents) — use Money.fmt().
 *   - vehicleName and notes are plain strings.
 */
function _receiptPrintBuildTableBody(rows, activeCols) {
  if (!rows.length) return '<tbody></tbody>';

  const colSpan = activeCols.length;

  const rowsHtml = rows.map((row) => {
    // ── Separator row ────────────────────────────────────────────────────────
    if (row._type === 'separator') {
      const vehicleName = esc(row.vehicleName || '');
      const subtotal    = Money.fmt(Number(row.subtotal) || 0);
      const notes       = row.notes ? ` &nbsp;|&nbsp; ملاحظات: ${esc(row.notes)}` : '';
      return `
        <tr class="print-separator">
          <td colspan="${colSpan}" style="text-align:right;padding:4px 8px;">
            <strong style="color:#c2410c;">🔄 رقم المركبة: ${vehicleName}</strong>
            &nbsp;&nbsp; إجمالي ما سبق: <strong>${subtotal}</strong>${notes}
          </td>
        </tr>`;
    }

    // ── Data row ─────────────────────────────────────────────────────────────
    const cells = activeCols.map((col) => {
      const raw       = _receiptPrintGetCellValue(row, col.key);
      const formatted = _receiptPrintFormatCell(raw, col.type);
      const align     = col.type === 'number' ? 'center' : 'right';
      return `<td style="text-align:${align};">${formatted}</td>`;
    }).join('');

    return `<tr>${cells}</tr>`;
  }).join('');

  return `<tbody>${rowsHtml}</tbody>`;
}

/**
 * _receiptPrintBuildTotalsRow(record, kartaCount)
 *
 * Renders the coloured totals strip at the bottom of the print page.
 * All top-level money values are CENTS in DB → Money.fmtCents().
 * kartaCount is derived from record.row_count or counted from rows.
 */
function _receiptPrintBuildTotalsRow(record, kartaCount) {
  const total           = Money.fmtCents(record.total           ?? 0);
  const previousBalance = Money.fmtCents(record.previous_balance ?? 0);

  const th = (label) => `<th style="background:#fff;color:#000;padding:4px 6px;border:1.5px solid #000;text-align:center;font-size:7pt;font-weight:700;">${label}</th>`;
  const td = (value) => `<td style="background:#fff;color:#000;padding:5px 6px;border:1.5px solid #000;text-align:center;font-size:11pt;font-weight:800;">${esc(value)}</td>`;

  return `
    <table style="width:100%;border-collapse:collapse;margin-top:8px;page-break-inside:avoid;">
      <thead>
        <tr>
          ${th('عدد الكارتات')}
          ${th('الإجمالي')}
          ${th('رصيد العميل')}
        </tr>
      </thead>
      <tbody>
        <tr>
          ${td(String(kartaCount))}
          ${td(total)}
          ${td(previousBalance)}
        </tr>
      </tbody>
    </table>`;
}

/**
 * _receiptPrintBuildHeader(record)
 *
 * Renders the document header block:
 *   - Header image (wasel.png) — absolute URL built from window.location, no DOM read.
 *   - Title, receipt number, date.
 *   - Owner name.
 *   - Optional shipping number and notes.
 */
function _receiptPrintBuildHeader(record) {
  const receiptNumber = esc(record.receipt_number || '—');
  const receiptDate   = esc(receiptDisplayDate(record.receipt_date));
  const dayName       = esc(receiptDayName(record.receipt_date));
  const ownerName     = esc(record.owner_name || record.client_name || '—');
  const companyName   = record.company_name ? esc(record.company_name) : '';

  // Build absolute URL for the header image (wasel.png sits next to the app files).
  // We use window.location.href so the iframe can load it without a relative-path issue.
  // No DOM read — purely derived from the current page origin + path.
  const _headerImgAbsUrl = (() => {
    try {
      return new URL('wasel.png', window.location.href).href;
    } catch (_) {
      return '';
    }
  })();

  const headerImgHTML = _headerImgAbsUrl
    ? `<div style="margin-bottom:10px;">
         <img src="${_headerImgAbsUrl}" alt="Header"
              style="width:100%;height:auto;max-height:80px;object-fit:cover;display:block;">
       </div>`
    : '';

  return `
    ${headerImgHTML}
    <div class="print-header">
      <h2>نموذج الصرف</h2>
      <div class="print-header-info">
        <span>إذن الصرف: <strong>${receiptNumber}</strong></span>
        <span>التاريخ: <strong>${receiptDate} — ${dayName}</strong></span>
      </div>
      <div class="print-header-info" style="margin-top:4px;">
        <span>صاحب المركبة: <strong>${ownerName}</strong></span>
        ${companyName ? `<span>الشركة: <strong>${companyName}</strong></span>` : ''}
      </div>
    </div>`;
}

/**
 * _receiptPrintBuildBody(record)
 *
 * Assembles the complete print body from the stored record.
 * Orchestrates: header → table → notes → totals.
 * Returns a self-contained HTML string (no external dependencies at runtime).
 *
 * @param {object} record - The raw record from STATE.receipts (cents for money fields).
 * @returns {string} HTML body string for buildPrintDocument().
 */
function _receiptPrintBuildBody(record) {
  const allRows  = getReceiptRows(record);  // normalizes separator shapes
  const dataRows = allRows.filter((r) => r._type !== 'separator');

  const kartaCount = record.row_count != null
    ? record.row_count
    : dataRows.length;

  const activeCols = _receiptPrintResolveColumns(dataRows);
  const thead      = _receiptPrintBuildTableHead(activeCols);
  const tbody      = _receiptPrintBuildTableBody(allRows, activeCols);
  const totals     = _receiptPrintBuildTotalsRow(record, kartaCount);
  const header     = _receiptPrintBuildHeader(record);

  const notesBlock = record.notes
    ? `<div class="print-note">
        <strong style="color:#334155;">📝 ملاحظة عامة:</strong>
        <span style="color:#475569;">${esc(record.notes)}</span>
       </div>`
    : '';

  return `
    ${header}
    <table>
      ${thead}
      ${tbody}
    </table>
    ${notesBlock}
    ${totals}`;
}

/**
 * printSingleReceipt(record)
 *
 * Entry point for single-receipt printing from the allReceipts page.
 * Called by the event handler when data-action="print-single-receipt" is clicked.
 *
 * Validation:
 *   - Record must exist and have rows.
 *   - At least one non-separator data row must be present.
 *   - Errors are logged to console — no crash, no alert.
 *
 * Print output:
 *   - A4 landscape via buildPrintDocument().
 *   - Isolated iframe via printHTML().
 *   - No DOM reads, no inputs, no cloning.
 *
 * @param {object} record - The raw record from STATE.receipts.
 */
function printSingleReceipt(record) {
  // ── Validation ─────────────────────────────────────────────────────────────
  if (!record || typeof record !== 'object') {
    console.error('[printSingleReceipt] record is missing or invalid.');
    return;
  }

  const rows = getReceiptRows(record);
  if (rows.length === 0) {
    console.error('[printSingleReceipt] record has no rows — cannot print.', { id: record.id });
    return;
  }

  const dataRows = rows.filter((r) => r && r._type !== 'separator');
  if (dataRows.length === 0) {
    console.error('[printSingleReceipt] record has no data rows (only separators) — cannot print.', { id: record.id });
    return;
  }

  // ── Build & print ──────────────────────────────────────────────────────────
  try {
    const receiptNumber = record.receipt_number ? ` — ${record.receipt_number}` : '';
    const title         = `نموذج الصرف${receiptNumber}`;
    const body          = _receiptPrintBuildBody(record);

    const html = buildPrintDocument({
      title,
      body,
      orientation: 'landscape',
      extraCSS: `
        .print-separator td {
          background: #fff7ed !important;
          border-top: 2px solid #fb923c !important;
          color: #9a3412;
          font-weight: 700;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
      `,
    });

    printHTML(html, { id: 'receipt-card-print-iframe' });

  } catch (err) {
    console.error('[printSingleReceipt] Failed to build print document:', err);
  }
}

// ─── END: RECEIPT CARD PRINT SYSTEM ──────────────────────────────────────────



function printStyles() {
  return `
    * { box-sizing: border-box; }
    body {
      direction: rtl;
      font-family: 'Cairo', Arial, sans-serif;
      margin: 0;
      padding: 16px;
      color: #111827;
      font-size: 11pt;
      background: #fff;
    }
    .print-page { display: flex; flex-direction: column; gap: 20px; }
    h1 { margin: 0 0 14px; font-size: 20pt; font-weight: 800; color: #111827; text-align: center; }
    .print-card {
      border: 1.5px solid #d1d5db;
      border-radius: 10px;
      padding: 12px 14px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .print-card--emerald { border-color: #0f766e; }
    .print-card header {
      font-size: 12pt;
      font-weight: 700;
      padding-bottom: 8px;
      margin-bottom: 6px;
      border-bottom: 2px solid #e5e7eb;
      color: #1e3a8a;
    }
    .print-card--emerald header { border-color: #0f766e; color: #0f766e; }
    .print-meta { margin: 6px 0 10px; color: #374151; font-size: 9pt; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: 7.5pt; margin-bottom: 8px; }
    th, td {
      border: 1px solid #d1d5db;
      padding: 4px 5px;
      text-align: center;
      vertical-align: middle;
      word-break: break-word;
    }
    th {
      background: #1e3a8a !important;
      color: #fff !important;
      font-weight: 700;
      font-size: 7pt;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    .print-card--emerald th {
      background: #0f766e !important;
    }
    .sep-row td,
    .vehicle-separator-row td,
    .separator-row td {
      background: #fff7ed !important;
      border-top: 2px solid #fb923c !important;
      color: #9a3412;
      font-weight: 700;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    .print-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 20px;
      padding: 8px 0 0;
      border-top: 1px solid #e5e7eb;
      font-size: 9pt;
      color: #374151;
    }
    .print-footer strong { color: #1e40af; font-weight: 800; }
    .print-empty { padding: 24px; text-align: center; color: #6b7280; font-size: 11pt; }
  `;
}


/**
 * Print a single receipt from saved data — same layout as receipt page printer.
 * Builds the print HTML from stored record data, no DOM/page switch needed.
 */
async function printCurrentView(tab = 'receipts') {
  const html = serializeCurrentView(tab);
  printHTML(html, { id: 'all-receipts-print-iframe' });
}

async function handleCardAction(action, id, tab) {
  const username = getSessionUsername();
  if (!username) return;

  if (tab === 'receipts' || tab === 'receipt') {
    const record = STATE.receipts.find((item) => String(item.id) === String(id));
    if (!record) return;
    if (action === 'edit-receipt') {
      if (typeof window.showPage === 'function') await window.showPage('receipt');
      await loadReceiptForEdit(record);
      return;
    }

    if (action === 'print-single-receipt') {
      printSingleReceipt(record);
      return;
    }

    if (action === 'delete-receipt') {
      if (!window.confirm('هل تريد حذف هذا النموذج؟')) return;
      await FinancialService.deleteReceipt(username, id);
      window.dispatchEvent(new CustomEvent('receipts:changed'));
      return;
    }
  }
}



/**
 * _exportReceiptsToExcel()
 *
 * Collects the receipts currently visible on screen (after all search,
 * filter, and date-range filters) and exports them to a single
 * flat Excel sheet via ExcelService.exportAllReceiptsRows().
 *
 * Data flow:
 *   1. getReceiptCardsFiltered() → filtered + sorted record list
 *      (same source used by renderReceiptList — guarantees we export
 *       exactly what the user sees)
 *   2. For each record, getDisplayRowsForReceipt(record) → visible rows
 *      (honours row-level text filters such as karta / vehicle search)
 *   3. Pairs { record, rows } are passed to ExcelService — no DOM reads,
 *      no DB access — pure data transform.
 *
 * Rules followed:
 *   - Only data rows exported (separator rows skipped by the service).
 *   - owner_name injected per row from the parent record.
 *   - Empty records (0 visible data rows) are silently skipped.
 *   - No financial recalculation — values read as stored.
 */
function _exportReceiptsToExcel() {
  try {
    // Step 1: get filtered records in display order
    // renderReceiptList() applies .sort((a,b) => (b.created_at||0)-(a.created_at||0))
    // We replicate that sort here to match what the user sees exactly.
    const filtered = getReceiptCardsFiltered()
      .slice()
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    if (filtered.length === 0) {
      alert('لا توجد نماذج معروضة للتصدير.');
      return;
    }

    // Step 2: pair each record with its visible rows
    // getDisplayRowsForReceipt respects active row-level filters
    const receiptsWithRows = filtered.map(record => ({
      record,
      rows: getDisplayRowsForReceipt(record),
    }));

    // Step 3: delegate to excelService — pure data export, no DOM
    ExcelService.exportAllReceiptsRows(receiptsWithRows);

  } catch (err) {
    console.error('[allReceipts] Excel export failed:', err);
    alert(err.message || '❌ فشل تصدير Excel');
  }
}

function bindPageEvents() {
  const page = getPage();
  if (!page || page.dataset.bound === '1') return;
  page.dataset.bound = '1';

  page.addEventListener('click', async (event) => {
    const rangeBtn = event.target.closest('[data-range]');
    if (rangeBtn) {
      const days = Number(rangeBtn.dataset.days) || 30;
      setQuickRange('receipts', days);
      renderShell();
      renderAll();
      return;
    }

    const actionBtn = event.target.closest('[data-action]');
    if (actionBtn) {
      const tab = actionBtn.dataset.tab || 'receipts';
      const action = actionBtn.dataset.action;
      if (action === 'apply-filter') {
        renderAll();
        return;
      }
      if (action === 'print-filtered') {
        await printCurrentView(tab);
        return;
      }
      if (action === 'export-excel-filtered' && tab === 'receipts') {
        _exportReceiptsToExcel();
        return;
      }
    }

    const recordAction = event.target.closest('[data-id][data-action]');
    if (recordAction) {
      await handleCardAction(recordAction.dataset.action, recordAction.dataset.id, recordAction.closest('[data-kind]')?.dataset.kind || 'receipts');
      return;
    }
  });

  page.addEventListener('input', (event) => {
    const field = event.target.closest('[data-filter-tab][data-filter-key]');
    if (field) {
      setFilterValue(field.dataset.filterTab, field.dataset.filterKey, field.value);
      renderAll();
      return;
    }

    const noteField = event.target.closest('[data-receipt-note]');
    if (noteField) {
      const receiptId = noteField.dataset.receiptNote;
      const value = noteField.value;
      const receipt = STATE.receipts.find((r) => String(r.id) === String(receiptId));
      if (receipt) receipt.notes = value;
      _debouncedNoteSave(receiptId, value, getSessionUsername());
    }
  });

}

function renderAll() {
  const _cachedReceiptsFiltered = getReceiptCardsFiltered();
  renderSummaryCards('receipts', _cachedReceiptsFiltered);
  renderLists(_cachedReceiptsFiltered);
  try {
    renderDatalists();
  } catch (e) {
    console.warn('[allReceipts] renderDatalists error:', e);
  }
}


async function refreshAllReceiptsPage(force = false) {
  const page = getPage();
  if (!page) return;
  if (force || !STATE.ready) {
    await loadAllReceiptsData();
    STATE.ready = true;
  } else {
    renderAll();
  }
}

/**
 * Phase 2 TASK F — coalesced refresh scheduler.
 *
 * Domain events may fire in bursts. Each listener previously called
 * refreshAllReceiptsPage(true) → loadAllReceiptsData() independently.
 *
 * This scheduler ensures that no matter how many *:changed events fire
 * in the same synchronous burst, exactly ONE loadAllReceiptsData() call
 * is scheduled for the next microtask.  Subsequent bursts during the
 * inflight load are deferred and run as a single re-fetch after the
 * current one settles.
 *
 * Behaviour preserved:
 *   - UI still updates after every save/delete (cache invalidation works).
 *   - First-page-load behavior unchanged (init triggers a direct refresh).
 *   - Filter clicks call refreshAllReceiptsPage(false) directly (no DB).
 */
let _refreshScheduled = false;
let _refreshInflight = false;
let _refreshAgainAfter = false;
function _scheduleAllReceiptsRefresh() {
  if (_refreshInflight) { _refreshAgainAfter = true; return; }
  if (_refreshScheduled) return;
  _refreshScheduled = true;
  queueMicrotask(async () => {
    _refreshScheduled = false;
    _refreshInflight = true;
    try {
      await refreshAllReceiptsPage(true);
    } finally {
      _refreshInflight = false;
      if (_refreshAgainAfter) {
        _refreshAgainAfter = false;
        _scheduleAllReceiptsRefresh();
      }
    }
  });
}

async function initAllReceiptsPage() {
  const page = getPage();
  if (!page) return;
  if (page.dataset.initialized === '1') return;
  page.dataset.initialized = '1';
  renderShell();
  bindPageEvents();
  window.applyAllReceiptsFilter = () => refreshAllReceiptsPage(false);
  window.refreshAllReceiptsPage = () => refreshAllReceiptsPage(true);

  // Phase 2 TASK F — coalesced single-refresh-per-burst listeners.
  // Replaces 4 independent listeners that each kicked an async refresh.
  window.addEventListener('receipts:changed',    _scheduleAllReceiptsRefresh);
  window.addEventListener('offices:changed',     _scheduleAllReceiptsRefresh);
  window.addEventListener('treasury:changed',    _scheduleAllReceiptsRefresh);

  await refreshAllReceiptsPage(true);
}

export { initAllReceiptsPage, refreshAllReceiptsPage, buildReceiptCardHtml, summarizeReceipts, printSingleReceipt };
