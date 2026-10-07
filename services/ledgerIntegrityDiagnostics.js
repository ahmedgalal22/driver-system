/**
 * ledgerIntegrityDiagnostics.js — pure ledger-record classifiers
 *
 * No database, browser, repository, or FinancialService dependencies. These
 * functions classify caller-supplied plain ledger records only; callers own all
 * reading, snapshotting, and presentation behavior.
 */

function ledgerEntryState(entry) {
  return {
    active: entry.is_reversed === false && entry.deleted_at === null,
    reversed: entry.is_reversed === true,
    deleted: entry.deleted_at !== null,
  };
}

function classifyBusinessDate(value, today) {
  if (value === null || value === undefined || value === '') return { category: 'missing_date', future: false };
  if (typeof value !== 'string') return { category: 'invalid_type', future: false };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { category: 'invalid_format', future: false };

  const [year, month, day] = value.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  const real = candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
  if (!real) return { category: 'invalid_calendar_date', future: false };
  return { category: 'valid_date', future: value > today };
}

function vehicleLedgerDateDetail(entry, dateResult) {
  const state = ledgerEntryState(entry);
  return {
    id: entry.id,
    vehicle_id: entry.vehicle_id || null,
    type: entry.type || null,
    amount: entry.amount,
    date: Object.hasOwn(entry, 'date') ? entry.date : undefined,
    effect: entry.effect || null,
    reference_type: entry.reference_type || null,
    reference_id: entry.reference_id || null,
    active: state.active,
    reversed: state.reversed,
    deleted: state.deleted,
    category: dateResult.category,
    future: dateResult.future,
  };
}

/**
 * Read-only active vehicle-ledger business-date classifier. Active
 * vehicle-linked custom types are surfaced separately and do not enter the
 * deposit/withdraw report population.
 */
function diagnoseVehicleLedgerDates(records, today) {
  const activeRows = records.filter(entry => ledgerEntryState(entry).active);
  const activeVehicleLinked = activeRows.filter(entry => String(entry.vehicle_id || '').trim());
  const relevant = activeVehicleLinked.filter(entry => entry.type === 'deposit' || entry.type === 'withdraw');
  const excludedCustomTypes = activeVehicleLinked.filter(entry => entry.type !== 'deposit' && entry.type !== 'withdraw');

  const details = relevant.map(entry => vehicleLedgerDateDetail(entry, classifyBusinessDate(entry.date, today)));
  const count = category => details.filter(detail => detail.category === category).length;
  const rowsByType = Object.fromEntries(['deposit', 'withdraw'].map(type => [
    type,
    details.filter(detail => detail.type === type).length,
  ]));
  const rowsByEffect = Object.fromEntries([...new Set(details.map(detail => detail.effect || 'none'))]
    .sort()
    .map(effect => [effect, details.filter(detail => (detail.effect || 'none') === effect).length]));
  const rowsByReferenceType = Object.fromEntries([...new Set(details.map(detail => detail.reference_type || 'none'))]
    .sort()
    .map(referenceType => [referenceType, details.filter(detail => (detail.reference_type || 'none') === referenceType).length]));

  return {
    total_active_vehicle_ledger_rows: details.length,
    valid_dates: count('valid_date'),
    missing_dates: count('missing_date'),
    invalid_formats: count('invalid_format'),
    invalid_calendar_dates: count('invalid_calendar_date'),
    invalid_date_types: count('invalid_type'),
    future_dated_rows: details.filter(detail => detail.future).length,
    rows_by_type: rowsByType,
    rows_by_effect: rowsByEffect,
    rows_by_reference_type: rowsByReferenceType,
    problematic_active_rows: details.filter(detail => detail.category !== 'valid_date'),
    future_rows: details.filter(detail => detail.future),
    excluded_active_vehicle_custom_type_rows: excludedCustomTypes.map(entry => vehicleLedgerDateDetail(entry, classifyBusinessDate(entry.date, today))),
  };
}

const LedgerIntegrityDiagnostics = Object.freeze({
  classifyBusinessDate,
  diagnoseVehicleLedgerDates,
});

export {
  classifyBusinessDate,
  diagnoseVehicleLedgerDates,
  LedgerIntegrityDiagnostics,
};
