/**
 * financialCalculator.js — Shared Financial Calculation Layer
 * Ensures absolute consistency of money math between UI, local IndexedDB, and future MySQL databases.
 */

import { Money } from '../money.js';

// Explicit row markers take precedence over the editable cargo `type` field.
// An unmarked `type: separator` remains supported for separator-only payloads.
export function isSeparatorRow(row) {
  if (!row) return false;
  if (row._type === 'separator' || row.row_type === 'separator') return true;
  if (row._type === 'data' || row.row_type === 'data') return false;
  return row.type === 'separator';
}

/**
 * Calculates the net value of a single data row.
 * Formula: (weight - deficit / 1000) * noloon - (ohda + officeAmount + discount) + add - sarf
 */
export function calculateRowNet(row) {
  if (!row) return 0;
  if (isSeparatorRow(row)) return 0;

  const noloon       = Money.round(row.noloon);
  const ohda         = Money.round(row.ohda);
  const officeAmount = Money.round(row.officeAmount);
  const discount     = Money.round(row.discount);
  const add          = Money.round(row.add);
  const sarf         = Money.round(row.sarf);

  const base = calculateWeightTotal(row) * noloon
             - (ohda + officeAmount + discount);
  // Equal adjustments cancel exactly; avoid floating-point cancellation
  // changing the cent subsequently chosen by the existing rounding policy.
  const net = add === sarf ? base : base + add - sarf;

  return Money.round(net);
}

/**
 * Calculates the weight total of a single data row.
 * Formula: weight - deficit / 1000
 */
export function calculateWeightTotal(row) {
  if (!row) return 0;
  if (isSeparatorRow(row)) return 0;
  const weight  = Number(row.weight)  || 0;
  const deficit = Number(row.deficit) || 0;
  return weight - deficit / 1000;
}

/**
 * Calculates totals for a full receipt based on its rows.
 * Returns: { total }
 */
export function calculateReceiptTotals(rows) {
  const dataRows = (rows || []).filter(r => r && !isSeparatorRow(r));
  
  let totalCents = 0;
  for (const r of dataRows) {
    totalCents += Money.toCents(calculateRowNet(r));
  }
  const total = Money.toDecimal(totalCents);

  return {
    total
  };
}
