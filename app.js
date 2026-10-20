/**
 * app.js — bootstrap, routing, initialization
 */

import { DB }          from './database.js';
import { AuthModule }  from './auth.js';
import { initReceiptPage } from './receipts.js';
import { initAllReceiptsPage } from './allReceipts.js';
import { attachOwnersPageListeners, loadOwners } from './entities.js';
import { OfficesModule, attachOfficesPageListeners, initOfficesPage, loadOffices } from './offices.js';
import { initHomePage } from './home.js';
import { initSidebarLayout } from './sidebarLayout.js';
import { initDashboardPage } from './dashboard.js';
import { initLoadPricesPage, loadLoadPrices } from './loadPrices.js';
import './entities.js';
import { DateUtils } from './dateUtils.js';
import {
  createBackupSnapshot,
  createExclusiveOperationGuard,
  parseBackupJson,
  serializeBackupSnapshot,
  validateBackupSnapshot,
  restoreAndVerifyBackup,
  BackupRestoreError,
} from './services/backupService.js';

const LAST_PAGE_KEY = 'financial_last_page';
const LAST_PAGE_CTX_KEY = 'financial_last_page_ctx';
const PAGE_MAP = {
  homePage: 'homePage',
  dashboardPage: 'dashboardPage',
  receipt: 'receiptPage',
  allReceipts: 'allReceiptsPage',
  ownersPage: 'ownersPage',
  ownerDetailsPage: 'ownerDetailsPage',
  driverDetailsPage: 'driverDetailsPage',
  officesPage: 'officesPage',
  officeDetailsPage: 'officeDetailsPage',
  loadPrices: 'loadPricesPage',
};
const PAGE_KEY_NORMALIZE = {
  homePage: 'homePage',
  dashboardPage: 'dashboardPage',
  receipt: 'receipt',
  receiptPage: 'receipt',
  allReceipts: 'allReceipts',
  allReceiptsPage: 'allReceipts',
  ownersPage: 'ownersPage',
  ownerDetailsPage: 'ownerDetailsPage',
  driverDetailsPage: 'driverDetailsPage',
  officesPage: 'officesPage',
  officeDetailsPage: 'officeDetailsPage',
  loadPrices: 'loadPrices',
};

function _readLastPage() {
  return sessionStorage.getItem(LAST_PAGE_KEY);
}

function _writeLastPage(pageId) {
  if (!pageId) return;
  sessionStorage.setItem(LAST_PAGE_KEY, pageId);
}

function _readLastPageContext() {
  const raw = sessionStorage.getItem(LAST_PAGE_CTX_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _resolvePageElement(pageName) {
  // allow passing direct section id (e.g. "ownersPage")
  const direct = document.getElementById(pageName);
  if (direct) return direct;
  return document.getElementById(PAGE_MAP[pageName]);
}

function _resolvePageKey(pageName, targetId) {
  if (PAGE_KEY_NORMALIZE[pageName]) return PAGE_KEY_NORMALIZE[pageName];
  if (PAGE_KEY_NORMALIZE[targetId]) return PAGE_KEY_NORMALIZE[targetId];
  if (PAGE_MAP[pageName]) return pageName;
  if (PAGE_MAP[targetId]) return targetId;
  return pageName || targetId || '';
}

async function showPage(pageName) {
  const session = AuthModule.getSession();
  const role = session?.role || 'user';

  // Secure Navigation Layer
  if (role !== 'admin') {
    const targetEl = _resolvePageElement(pageName);
    const targetId = targetEl?.id || '';
    const pageKey = _resolvePageKey(pageName, targetId);
    if (pageKey === 'dashboardPage' || targetId === 'dashboardPage') {
      pageName = 'homePage';
    }
  }

  const pages = document.querySelectorAll('.page');
  pages.forEach(p => p.classList.add('hidden'));

  const target = _resolvePageElement(pageName);
  if (target) {
    target.classList.remove('hidden');
  }

  const targetId = target?.id || '';
  const pageKey = _resolvePageKey(pageName, targetId);
  _writeLastPage(pageKey);

  // ── Sidebar active state ──
  document.querySelectorAll('#sidebar .sidebar-link').forEach(link => {
    const lp = link.dataset.page;
    link.classList.toggle('active', lp === pageKey || lp === targetId);
  });

  if (pageName === 'ownersPage' || targetId === 'ownersPage') {
    await loadOwners();
  }
  if (pageName === 'officesPage' || targetId === 'officesPage') {
    await loadOffices();
  }
  if (pageName === 'allReceipts' || targetId === 'allReceiptsPage') {
    await initAllReceiptsPage();
  }
  if (pageName === 'loadPrices' || targetId === 'loadPricesPage') {
    await loadLoadPrices();
  }
  if (pageName === 'dashboardPage' || targetId === 'dashboardPage') {
    if (role === 'admin') {
      await initDashboardPage();
    } else {
      await showPage('homePage');
    }
  }
  if (pageName === 'homePage' || targetId === 'homePage') {
    initHomePage();
  }
}

window.showPage = showPage;

function _bindLogout() {
  const btn = document.getElementById('logoutBtn');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    AuthModule.logout();
    window.location.href = 'login.html';
  });
}

async function boot() {
  try {
    const session = AuthModule.getSession();
    if (!session) {
      window.location.href = 'login.html';
      return;
    }

    const username = session.username;
    if (!username) {
      throw new Error('Session username is required');
    }

    window.__APP_CONTEXT__ = Object.freeze({
      username,
      role: session.role,
    });

    await DB.init();

    // Secure Sidebar Visibility for non-admins
    if (session.role !== 'admin') {
      const dbLink = document.querySelector('[data-page="dashboardPage"]');
      if (dbLink) {
        dbLink.remove();
      }
    }

    initSidebarLayout();
    _bindLogout();
    initReceiptPage();
    await initAllReceiptsPage();
    initLoadPricesPage();
    initOfficesPage();
    attachOwnersPageListeners();
    attachOfficesPageListeners();
    const lastPage = _readLastPage();
    const ctx = _readLastPageContext();
    let restored = false;

    if (lastPage === 'officeDetailsPage' && ctx?.officeId && typeof window.showOfficeDetails === 'function') {
      // Session state can outlive an office deleted in another session, a clean
      // database reset, or a backup import. Validate the saved id before
      // invoking the strict Office Details entry point, which must still throw
      // for an explicit invalid navigation.
      const office = await OfficesModule.getOfficeDetails(ctx.officeId);
      if (office) {
        await window.showOfficeDetails(ctx.officeId);
        restored = true;
      } else {
        sessionStorage.removeItem(LAST_PAGE_CTX_KEY);
      }
    } else if (lastPage === 'ownerDetailsPage' && ctx?.ownerId && typeof window.showOwnerDetails === 'function') {
      await window.showOwnerDetails(ctx.ownerId, ctx.ownerType || 'owner');
      restored = true;
    } else if (lastPage === 'driverDetailsPage' && ctx?.driverId && typeof showDriverDetails === 'function') {
      await showDriverDetails(ctx.driverId);
      restored = true;
    }

    if (!restored) {
      let fallbackPage = lastPage;
      if (lastPage === 'officeDetailsPage') fallbackPage = 'officesPage';
      if (lastPage === 'ownerDetailsPage') fallbackPage = 'ownersPage';
      if (lastPage === 'driverDetailsPage') fallbackPage = 'ownersPage';
      // Unknown / removed pages fall through to home when element is missing
      if (!fallbackPage || !_resolvePageElement(fallbackPage)) fallbackPage = 'homePage';
      await showPage(fallbackPage);
    }

    // sidebar [data-page] navigation (unified — no more onclick)
    document.getElementById('sidebar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-page]');
      if (!btn) return;
      const pageId = btn.dataset.page;
      if (pageId) showPage(pageId);
    });

  } catch (err) {
    console.error('[app] Boot failed:', err);
    const app = document.getElementById('app');
    if (app) {
      app.innerHTML = `
        <div class="login-page">
          <div class="login-card shadow-lg">
            <div class="alert alert-error flex-col gap-4 text-center">
              <span class="text-2xl mb-2" aria-hidden="true">⚠️</span>
              <p class="font-bold text-lg mb-2">فشل تحميل التطبيق</p>
              <p class="text-muted text-sm mb-0">${err.message || 'خطأ غير معروف'}</p>
            </div>
          </div>
        </div>`;
    }
  }
}

boot();


// ─────────────────────────────────────────────────────────────────────────────
// BACKUP SYSTEM — Full IndexedDB export/import + auto-reminder
// Added for production safety. Does NOT modify DB schema or financial logic.
// ─────────────────────────────────────────────────────────────────────────────

const BACKUP_DATE_KEY = 'karta_last_backup_date';
const BACKUP_REMINDER_DISMISSED_KEY = 'karta_backup_reminder_dismissed';
const BACKUP_REMINDER_DAYS = 7;
const _backupOperationGuard = createExclusiveOperationGuard();

function _getDbInstance() {
  return DB._db || (function() { throw new Error('DB not initialized'); })();
}

function _setBackupControlsDisabled(disabled) {
  const exportBtn = document.getElementById('exportBackupBtn');
  const importBtn = document.getElementById('importBackupBtn');
  if (exportBtn) exportBtn.disabled = disabled;
  if (importBtn) importBtn.disabled = disabled;
}

function _beginBackupOperation() {
  if (!_backupOperationGuard.tryAcquire()) return false;
  _setBackupControlsDisabled(true);
  return true;
}

function _endBackupOperation() {
  _backupOperationGuard.release();
  _setBackupControlsDisabled(false);
}

function _backupCanonicalStoreNames() {
  return Object.keys(DB.STORES).sort();
}

function _downloadBackup(json) {
  const blob = new Blob([json], { type: 'application/json' });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const filename = `karta-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}.json`;
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => { URL.revokeObjectURL(anchor.href); anchor.remove(); }, 1000);
  return filename;
}

/**
 * Export a complete format-v2 snapshot of every active native object store.
 * The browser download remains external to IndexedDB; this only confirms the
 * file was prepared and download was requested.
 */
async function _exportFullBackup() {
  if (!_beginBackupOperation()) return;
  try {
    const db = _getDbInstance();
    const snapshot = await createBackupSnapshot(db, {
      canonicalStoreNames: _backupCanonicalStoreNames(),
      exportedAt: DateUtils.nowLocal(),
      exportedBy: window.__APP_CONTEXT__?.username || 'unknown',
    });
    // Validate the exact JSON representation that will be downloaded. This
    // rejects values that JSON would omit or transform before any download is requested.
    const { json } = serializeBackupSnapshot(db, snapshot, {
      canonicalStoreNames: _backupCanonicalStoreNames(),
    });
    const filename = _downloadBackup(json);

    localStorage.setItem(BACKUP_DATE_KEY, DateUtils.toLocalDateTime(new Date()));
    localStorage.removeItem(BACKUP_REMINDER_DISMISSED_KEY);
    _hideBackupReminder();
    alert(`✅ تم تجهيز النسخة الاحتياطية للتنزيل\n${filename}\n\nتأكد من اكتمال تنزيل المتصفح قبل المتابعة.`);
  } catch (err) {
    console.error('[Backup] Export failed:', err);
    alert(`❌ فشل تصدير النسخة الاحتياطية\n${err.message || 'خطأ غير معروف'}`);
  } finally {
    _endBackupOperation();
  }
}

function _restoreSummary(backup) {
  const totalRecords = Object.values(backup._meta.recordCounts)
    .reduce((sum, count) => sum + count, 0);
  return {
    storeCount: backup._meta.storeNames.length,
    totalRecords,
    exportDate: backup._meta.exportedAt
      ? new Date(backup._meta.exportedAt).toLocaleString('ar-EG')
      : 'غير معروف',
  };
}

/**
 * Parse and validate a full format-v2 backup before asking for confirmation or
 * opening a destructive transaction. A rejected file never clears current data.
 */
function _showRestoreFailure(err) {
  console.error('[Backup] Restore failed:', err);
  if (err instanceof BackupRestoreError && err.phase === 'verification') {
    alert('⚠️ اكتملت معاملة الاستعادة لكن فشل التحقق اللاحق.\n\nتوقف عن استخدام التطبيق، أعد تحميل الصفحة، واحفظ الحالة الحالية للتحقيق. لم يتم عرض نجاح للاستعادة.');
    return;
  }
  alert(`❌ فشلت أو أُلغيت معاملة الاستعادة\n${err?.message || 'خطأ غير معروف'}\n\nلم يتم عرض نجاح للاستعادة. يجب أن تعيد IndexedDB البيانات السابقة عند إلغاء المعاملة.`);
}

/**
 * Parse and validate a full format-v2 backup before asking for confirmation or
 * opening a destructive transaction. The exclusive guard starts before the
 * picker so competing imports cannot both reach a restore transaction.
 */
async function _importFullBackup() {
  if (!_beginBackupOperation()) return;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.style.display = 'none';
  document.body.appendChild(input);

  let changeStarted = false;
  const releaseCancelledPicker = () => {
    setTimeout(() => {
      if (changeStarted) return;
      input.remove();
      _endBackupOperation();
    }, 250);
  };
  window.addEventListener('focus', releaseCancelledPicker, { once: true });

  input.addEventListener('change', async () => {
    changeStarted = true;
    const file = input.files?.[0];
    input.remove();
    if (!file) {
      _endBackupOperation();
      return;
    }

    let backup;
    let validated;
    let summary;
    try {
      const text = await file.text();
      backup = parseBackupJson(text);
      const db = _getDbInstance();
      validated = validateBackupSnapshot(db, backup, {
        canonicalStoreNames: _backupCanonicalStoreNames(),
      });
      summary = _restoreSummary(backup);
    } catch (err) {
      console.error('[Backup] Validation failed:', err);
      alert(`❌ لم يتم استيراد النسخة الاحتياطية\n${err.message || 'ملف النسخة غير صالح'}\nلم يتم تغيير أي بيانات.`);
      _endBackupOperation();
      return;
    }

    const message = `⚠️ النسخة الاحتياطية اجتازت التحقق الأولي\n\n`
      + `📅 تاريخ النسخة: ${summary.exportDate}\n`
      + `📦 عدد الجداول: ${summary.storeCount}\n`
      + `📊 عدد السجلات: ${summary.totalRecords}\n\n`
      + `⚠️ سيتم استبدال جميع الجداول النشطة في عملية واحدة.\n`
      + `⚠️ أغلق أي تبويبات أخرى لنظام Karta قبل المتابعة.\n\n`
      + `هل تريد المتابعة؟`;
    if (!confirm(message)) {
      _endBackupOperation();
      return;
    }
    if (!confirm('⚠️ تأكيد نهائي: سيتم استبدال جميع البيانات الحالية بالنسخة التي تم التحقق منها. هل أنت متأكد؟')) {
      _endBackupOperation();
      return;
    }

    try {
      await restoreAndVerifyBackup(_getDbInstance(), validated);
    } catch (err) {
      _showRestoreFailure(err);
      _endBackupOperation();
      return;
    }

    alert('✅ تم استيراد النسخة الاحتياطية والتحقق منها بنجاح!\nسيتم إعادة تحميل الصفحة...');
    _endBackupOperation();
    window.location.reload();
  });

  try {
    input.click();
  } catch (err) {
    input.remove();
    _endBackupOperation();
    throw err;
  }
}

/**
 * Backup reminder — checks localStorage for last backup date,
 * shows a dismissible banner if >7 days old.
 */
function _checkBackupReminder() {
  const banner = document.getElementById('backupReminderBanner');
  if (!banner) return;

  const lastBackup = localStorage.getItem(BACKUP_DATE_KEY);
  const dismissed = localStorage.getItem(BACKUP_REMINDER_DISMISSED_KEY);

  // If dismissed today, don't show
  if (dismissed) {
    const dismissedDate = new Date(dismissed);
    const now = new Date();
    if (now.toDateString() === dismissedDate.toDateString()) return;
  }

  let shouldShow = false;
  const dateDisplay = document.getElementById('lastBackupDateDisplay');

  if (!lastBackup) {
    shouldShow = true;
    if (dateDisplay) dateDisplay.textContent = 'لم يتم إنشاء نسخة بعد';
  } else {
    const lastDate = new Date(lastBackup);
    const daysSince = Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince >= BACKUP_REMINDER_DAYS) {
      shouldShow = true;
    }
    if (dateDisplay) {
      dateDisplay.textContent = lastDate.toLocaleDateString('ar-EG', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
    }
  }

  if (shouldShow) {
    banner.classList.remove('hidden');
    banner.style.display = 'flex';
  }
}

function _hideBackupReminder() {
  const banner = document.getElementById('backupReminderBanner');
  if (banner) {
    banner.classList.add('hidden');
    banner.style.display = 'none';
  }
}

// ── Bind backup buttons after DOM is ready ──
function _initBackupSystem() {
  const exportBtn = document.getElementById('exportBackupBtn');
  const importBtn = document.getElementById('importBackupBtn');
  const dismissBtn = document.getElementById('dismissBackupReminder');

  if (exportBtn && !exportBtn.dataset.bound) {
    exportBtn.dataset.bound = '1';
    exportBtn.addEventListener('click', _exportFullBackup);
  }
  if (importBtn && !importBtn.dataset.bound) {
    importBtn.dataset.bound = '1';
    importBtn.addEventListener('click', _importFullBackup);
  }
  if (dismissBtn && !dismissBtn.dataset.bound) {
    dismissBtn.dataset.bound = '1';
    dismissBtn.addEventListener('click', () => {
      localStorage.setItem(BACKUP_REMINDER_DISMISSED_KEY, DateUtils.nowLocal());
      _hideBackupReminder();
    });
  }

  // Check reminder after short delay to not block boot
  setTimeout(_checkBackupReminder, 2000);
}

// Hook into boot completion
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(_initBackupSystem, 500));
} else {
  setTimeout(_initBackupSystem, 500);
}
