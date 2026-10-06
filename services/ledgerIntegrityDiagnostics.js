/**
 * ledgerIntegrityDiagnostics.js — pure ledger-record classifiers
 *
 * No database, browser, repository, or FinancialService dependencies. These
 * functions classify caller-supplied plain ledger records only; callers own all
 * reading, snapshotting, and presentation behavior.
 */

const LEGACY_DRIVER_DEPOSIT_REFERENCE_TYPE = 'driver_deposit';

function ledgerEntryState(entry) {
  return {
    active: entry.is_reversed === false && entry.deleted_at === null,
    reversed: entry.is_reversed === true,
    deleted: entry.deleted_at !== null,
  };
}

function isLegacyDriverDepositCandidate(entry) {
  return entry?.reference_type === LEGACY_DRIVER_DEPOSIT_REFERENCE_TYPE
    || entry?.type === LEGACY_DRIVER_DEPOSIT_REFERENCE_TYPE;
}

function isLegacyDriverDepositDriverLeg(entry) {
  return isLegacyDriverDepositCandidate(entry)
    && (entry.client_type === 'driver' || entry.type === LEGACY_DRIVER_DEPOSIT_REFERENCE_TYPE)
    && entry.type !== 'withdraw';
}

function isLegacyDriverDepositVehicleLeg(entry) {
  return isLegacyDriverDepositCandidate(entry) && entry.type === 'withdraw';
}

function driverDepositDetail(entry) {
  if (!entry) return null;
  const state = ledgerEntryState(entry);
  return {
    id: entry.id,
    driver_id: entry.client_type === 'driver' ? entry.owner_id || null : null,
    vehicle_id: entry.vehicle_id || null,
    amount: entry.amount,
    date: entry.date || null,
    active: state.active,
    reversed: state.reversed,
    deleted: state.deleted,
    type: entry.type || null,
    client_type: entry.client_type || null,
  };
}

/**
 * Read-only historical Driver Deposit integrity classifier. It recognizes both
 * the observed type=deposit driver leg and the older type=driver_deposit marker
 * form, but never treats an unmarked withdrawal as a legacy candidate.
 */
function diagnoseHistoricalDriverDeposits(records) {
  const candidates = records.filter(isLegacyDriverDepositCandidate);
  const groups = new Map();
  let invalidOrdinal = 0;

  for (const entry of candidates) {
    const rawReference = typeof entry.reference_id === 'string' ? entry.reference_id.trim() : '';
    const key = rawReference || `__invalid__${entry.id ?? ++invalidOrdinal}`;
    if (!groups.has(key)) groups.set(key, { reference_id: rawReference || null, entries: [] });
    groups.get(key).entries.push(entry);
  }

  const reports = [...groups.values()].map(group => {
    const driverLegs = group.entries.filter(isLegacyDriverDepositDriverLeg);
    const vehicleLegs = group.entries.filter(isLegacyDriverDepositVehicleLeg);
    const allActive = group.entries.every(entry => ledgerEntryState(entry).active);
    const hasInactive = group.entries.some(entry => !ledgerEntryState(entry).active);
    const hasActive = group.entries.some(entry => ledgerEntryState(entry).active);
    const flags = [];

    if (!group.reference_id) {
      flags.push('invalid_reference');
    } else {
      if (driverLegs.length === 0 && vehicleLegs.length > 0) flags.push('vehicle_only');
      if (vehicleLegs.length === 0 && driverLegs.length > 0) flags.push('driver_only');
      if (driverLegs.length > 1) flags.push('duplicate_driver');
      if (vehicleLegs.length > 1) flags.push('duplicate_vehicle');
    }

    const oneDriver = driverLegs.length === 1 ? driverLegs[0] : null;
    const oneVehicle = vehicleLegs.length === 1 ? vehicleLegs[0] : null;
    if (group.reference_id && oneDriver && oneVehicle) {
      const driverAmount = Number(oneDriver.amount);
      const vehicleAmount = Number(oneVehicle.amount);
      const malformed = oneDriver.client_type !== 'driver'
        || !String(oneDriver.owner_id || '').trim()
        || !String(oneDriver.vehicle_id || '').trim()
        || !String(oneVehicle.vehicle_id || '').trim()
        || !String(oneVehicle.owner_id || '').trim()
        || String(oneDriver.vehicle_id) !== String(oneVehicle.vehicle_id)
        || !Number.isFinite(driverAmount)
        || !Number.isFinite(vehicleAmount)
        || driverAmount <= 0
        || vehicleAmount <= 0
        || driverAmount !== vehicleAmount;
      if (malformed) flags.push('driver_vehicle_mismatch');
    }

    if (hasInactive) flags.push('reversed_or_deleted_history');

    const activeStructuralFlags = flags.filter(flag => flag !== 'reversed_or_deleted_history');
    const completeActive = allActive && activeStructuralFlags.length === 0
      && driverLegs.length === 1 && vehicleLegs.length === 1;
    const primary = completeActive
      ? 'complete'
      : !group.reference_id
        ? 'invalid_reference'
        : hasInactive
          ? 'reversed_or_deleted_history'
          : flags[0] || 'driver_vehicle_mismatch';

    return {
      reference_id: group.reference_id,
      primary,
      flags,
      active_problematic: hasActive && !completeActive,
      driver_legs: driverLegs.map(driverDepositDetail),
      vehicle_legs: vehicleLegs.map(driverDepositDetail),
    };
  }).sort((a, b) => String(a.reference_id || '').localeCompare(String(b.reference_id || '')));

  const count = predicate => reports.filter(predicate).length;
  return {
    total_candidate_reference_ids: reports.length,
    complete_pairs: count(report => report.primary === 'complete'),
    driver_only_pairs: count(report => report.flags.includes('driver_only')),
    vehicle_only_pairs: count(report => report.flags.includes('vehicle_only')),
    duplicate_driver_cases: count(report => report.flags.includes('duplicate_driver')),
    duplicate_vehicle_cases: count(report => report.flags.includes('duplicate_vehicle')),
    driver_vehicle_mismatch_cases: count(report => report.flags.includes('driver_vehicle_mismatch')),
    invalid_reference_cases: count(report => report.flags.includes('invalid_reference')),
    reversed_or_deleted_history_cases: count(report => report.flags.includes('reversed_or_deleted_history')),
    active_problematic_cases: count(report => report.active_problematic),
    reports,
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
  LEGACY_DRIVER_DEPOSIT_REFERENCE_TYPE,
  classifyBusinessDate,
  diagnoseVehicleLedgerDates,
  diagnoseHistoricalDriverDeposits,
});

export {
  LEGACY_DRIVER_DEPOSIT_REFERENCE_TYPE,
  classifyBusinessDate,
  diagnoseVehicleLedgerDates,
  diagnoseHistoricalDriverDeposits,
  LedgerIntegrityDiagnostics,
};
