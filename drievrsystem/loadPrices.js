import { AuthModule } from './auth.js';
import { Money } from './money.js';
import { LoadPriceRepository } from './services/loadPriceRepository.js';

const PAGE_ID = 'loadPricesPage';
let _editingId = null;
let _bound = false;

function _username() {
  const session = AuthModule.getSession();
  if (!session?.username) throw new Error('Username required');
  return session.username;
}

function _esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _page() {
  return document.getElementById(PAGE_ID);
}

function _renderShell() {
  const page = _page();
  if (!page) return;

  page.innerHTML = `
    <div class="p-6 card">
      <div class="flex items-center justify-between flex-wrap gap-3 mb-6">
        <div>
          <h2 class="text-2xl font-bold text-gray-800 mb-1">أسعار الحمولة</h2>
          <p class="text-muted text-sm mb-0">مرجع المسارات المكتشفة من نماذج الصرف والأسعار التي يديرها المستخدم.</p>
        </div>
      </div>
      <div class="table-wrapper overflow-x-auto">
        <table class="table">
          <thead style="background:linear-gradient(135deg,#0f766e,#115e59);">
            <tr>
              <th style="color:#fff;">التحميل</th>
              <th style="color:#fff;">الجهة</th>
              <th style="color:#fff;">السعر</th>
              <th style="color:#fff;">الإجراءات</th>
            </tr>
          </thead>
          <tbody id="loadPricesTableBody"></tbody>
        </table>
      </div>
      <div id="loadPricesMsg" class="field-msg-inline field-msg-inline--error" role="alert"></div>
    </div>
  `;
}

function _renderRows(routes) {
  const tbody = document.getElementById('loadPricesTableBody');
  if (!tbody) return;

  if (!routes.length) {
    tbody.innerHTML = `
      <tr><td colspan="4" class="text-center text-muted p-6">
        لا توجد مسارات حتى الآن. ستظهر المسارات تلقائياً عند حفظ نموذج صرف يحتوي على التحميل والجهة.
      </td></tr>`;
    return;
  }

  tbody.innerHTML = routes.map((route) => {
    const editing = String(_editingId || '') === String(route.id);
    return `
      <tr data-id="${_esc(route.id)}">
        <td>${_esc(route.loading)}</td>
        <td>${_esc(route.destination)}</td>
        <td>${editing
          ? `<input type="number" min="0" step="0.01" class="input input-sm load-price-edit" value="${_esc(Money.toDecimal(route.price))}">`
          : `<strong>${_esc(Money.fmtCents(route.price))}</strong>`}</td>
        <td>
          ${editing
            ? `<button type="button" data-action="save-load-price" class="btn btn-primary btn-sm">حفظ</button>
               <button type="button" data-action="cancel-load-price" class="btn btn-secondary btn-sm">إلغاء</button>`
            : `<button type="button" data-action="edit-load-price" class="btn btn-secondary btn-sm">تعديل</button>
               <button type="button" data-action="delete-load-price" class="btn btn-danger btn-sm">حذف</button>`}
        </td>
      </tr>`;
  }).join('');
}

export async function loadLoadPrices() {
  _renderShell();
  const routes = await LoadPriceRepository.getAll();
  const sorted = [...routes].sort((a, b) =>
    String(a.loading || '').localeCompare(String(b.loading || ''), 'ar')
    || String(a.destination || '').localeCompare(String(b.destination || ''), 'ar')
  );
  _renderRows(sorted);
}

function _bind() {
  if (_bound) return;
  _bound = true;

  document.addEventListener('click', async (event) => {
    const page = _page();
    if (!page || !page.contains(event.target)) return;
    const row = event.target.closest('tr[data-id]');
    const id = row?.dataset.id;

    if (event.target.closest('[data-action="edit-load-price"]')) {
      _editingId = id;
      await loadLoadPrices();
      return;
    }
    if (event.target.closest('[data-action="cancel-load-price"]')) {
      _editingId = null;
      await loadLoadPrices();
      return;
    }
    if (event.target.closest('[data-action="save-load-price"]')) {
      const price = Money.toCents(row?.querySelector('.load-price-edit')?.value);
      if (price < 0) {
        const msg = document.getElementById('loadPricesMsg');
        if (msg) { msg.textContent = '❌ السعر لا يمكن أن يكون سالباً'; msg.classList.add('is-visible'); }
        return;
      }
      await LoadPriceRepository.updatePrice(id, price, { username: _username() });
      _editingId = null;
      await loadLoadPrices();
      return;
    }
    if (event.target.closest('[data-action="delete-load-price"]')) {
      if (!confirm('هل تريد حذف هذا المسار؟')) return;
      await LoadPriceRepository.delete(id, { username: _username() });
      _editingId = null;
      await loadLoadPrices();
    }
  });

  window.addEventListener('receipts:changed', () => {
    const page = _page();
    if (page && !page.classList.contains('hidden')) loadLoadPrices();
  });
}

export function initLoadPricesPage() {
  _renderShell();
  _bind();
}
