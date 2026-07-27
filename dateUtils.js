/**
 * dateUtils.js — Egypt Local Date/Time Utilities
 * ─────────────────────────────────────────────────────────────────────────────
 * Single Source of Truth for ALL date/time creation in Karta ERP.
 *
 * RULE: No file in the system may create business dates using:
 *   - new Date().toISOString()
 *   - .toISOString().split('T')[0]
 *   These produce UTC dates which are WRONG for Egypt (UTC+2/UTC+3).
 *
 * ALL business dates must go through this module:
 *   DateUtils.todayLocal()     → "2026-06-09"           (YYYY-MM-DD)
 *   DateUtils.nowLocal()       → "2026-06-09T01:30:00"  (YYYY-MM-DDTHH:mm:ss)
 *   DateUtils.toLocalDate(d)   → "2026-06-09"           (from any Date object)
 *   DateUtils.toLocalDateTime(d) → "2026-06-09T01:30:00"
 *
 * TIMEZONE: Africa/Cairo (Egypt Standard Time / Egypt Daylight Time)
 *   - UTC+2 in winter (EET)
 *   - UTC+3 in summer (EEST) when DST is active
 *
 * The implementation uses Intl.DateTimeFormat with timeZone: 'Africa/Cairo'
 * which automatically handles DST transitions. Fallback to local getters
 * if Intl is unavailable (same-timezone only).
 *
 * MySQL COMPATIBILITY:
 *   - Date fields: 'YYYY-MM-DD' → MySQL DATE
 *   - DateTime fields: 'YYYY-MM-DDTHH:mm:ss' → MySQL DATETIME
 *   - No timezone suffix (Z or +02:00) — values represent Egypt local time
 * ─────────────────────────────────────────────────────────────────────────────
 */

const TIMEZONE = 'Africa/Cairo';

// ─── Intl-based extraction (handles DST automatically) ─────────────────────

let _intlSupported = null;

function _isIntlSupported() {
  if (_intlSupported !== null) return _intlSupported;
  try {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const test = f.format(new Date(2026, 0, 1));
    _intlSupported = /^\d{4}/.test(test);
  } catch {
    _intlSupported = false;
  }
  return _intlSupported;
}

/**
 * Extract date/time parts for a specific timezone using Intl.
 * Returns { year, month, day, hour, minute, second }.
 */
function _intlParts(date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const { type, value } of f.formatToParts(date)) {
    if (type === 'year')   parts.year   = value;
    if (type === 'month')  parts.month  = value;
    if (type === 'day')    parts.day    = value;
    if (type === 'hour')   parts.hour   = value === '24' ? '00' : value;
    if (type === 'minute') parts.minute = value;
    if (type === 'second') parts.second = value;
  }
  return parts;
}

/**
 * Fallback: use local Date getters (works if browser timezone = Egypt).
 */
function _localParts(date) {
  return {
    year:   String(date.getFullYear()),
    month:  String(date.getMonth() + 1).padStart(2, '0'),
    day:    String(date.getDate()).padStart(2, '0'),
    hour:   String(date.getHours()).padStart(2, '0'),
    minute: String(date.getMinutes()).padStart(2, '0'),
    second: String(date.getSeconds()).padStart(2, '0'),
  };
}

function _getParts(date) {
  return _isIntlSupported() ? _intlParts(date) : _localParts(date);
}

// ─── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Today's date in Egypt local time.
 * @returns {string} "YYYY-MM-DD"
 */
function todayLocal() {
  const p = _getParts(new Date());
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Current date+time in Egypt local time.
 * @returns {string} "YYYY-MM-DDTHH:mm:ss"
 */
function nowLocal() {
  const p = _getParts(new Date());
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Convert any Date object to Egypt local date string.
 * @param {Date} date
 * @returns {string} "YYYY-MM-DD"
 */
function toLocalDate(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return todayLocal();
  }
  const p = _getParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Convert any Date object to Egypt local datetime string.
 * @param {Date} date
 * @returns {string} "YYYY-MM-DDTHH:mm:ss"
 */
function toLocalDateTime(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return nowLocal();
  }
  const p = _getParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

// ─── EXPORT ────────────────────────────────────────────────────────────────────

const DateUtils = Object.freeze({
  todayLocal,
  nowLocal,
  toLocalDate,
  toLocalDateTime,
  TIMEZONE,
});

export { DateUtils };
export default DateUtils;
