/**
 * payoutStatus.js — Enterprise-grade Payout State Machine
 * Single Source of Truth for Payout States, Transitions, and Metadata
 */

import { DateUtils } from '../dateUtils.js';

export const RECEIPT_PAYOUT_STATUS = Object.freeze({
  PAID: 'paid',
  UNPAID: 'unpaid',
  PARTIAL: 'partial',
  CANCELLED: 'cancelled'
});

const VALID_STATUSES = new Set(Object.values(RECEIPT_PAYOUT_STATUS));

// Static Frozen Metadata Registry (Pre-calculated & cached to avoid allocations)
const STATUS_META_REGISTRY = Object.freeze({
  [RECEIPT_PAYOUT_STATUS.PAID]: Object.freeze({
    id: RECEIPT_PAYOUT_STATUS.PAID,
    label: 'تم صرفه',
    printLabel: '✅ تم صرفه',
    color: '#059669',
    badgeClass: 'badge-green',
    icon: '✅'
  }),
  [RECEIPT_PAYOUT_STATUS.PARTIAL]: Object.freeze({
    id: RECEIPT_PAYOUT_STATUS.PARTIAL,
    label: 'صرف جزئي',
    printLabel: '⚠️ صرف جزئي',
    color: '#fb923c',
    badgeClass: 'badge-orange',
    icon: '⚠️'
  }),
  [RECEIPT_PAYOUT_STATUS.CANCELLED]: Object.freeze({
    id: RECEIPT_PAYOUT_STATUS.CANCELLED,
    label: 'ملغي',
    printLabel: '🚫 ملغي',
    color: '#9ca3af',
    badgeClass: 'badge-gray',
    icon: '🚫'
  }),
  [RECEIPT_PAYOUT_STATUS.UNPAID]: Object.freeze({
    id: RECEIPT_PAYOUT_STATUS.UNPAID,
    label: 'لم يتم الصرف',
    printLabel: '⏳ لم يتم الصرف',
    color: '#dc2626',
    badgeClass: 'badge-red',
    icon: '⏳'
  })
});

/**
 * Asserts whether a given status is valid. Throws error on failure.
 * @param {string} status 
 * @throws {Error}
 */
export function assertValidPayoutStatus(status) {
  if (typeof status !== 'string') {
    throw new Error(`[PayoutState] Invalid status type: expected string, got ${typeof status}`);
  }
  const clean = status.trim().toLowerCase();
  if (!VALID_STATUSES.has(clean)) {
    throw new Error(`[PayoutState] Unsupported payout status: "${status}"`);
  }
}

/**
 * Validates whether a given status string is a known domain status.
 * @param {string} status 
 * @returns {boolean}
 */
export function isValidPayoutStatus(status) {
  try {
    assertValidPayoutStatus(status);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Performs defensive normalization of status values.
 * Returns PAID or UNPAID as a fallback for any corrupted/unknown values.
 * @param {string} status 
 * @returns {string}
 */
export function normalizePayoutStatus(status) {
  if (!status) return RECEIPT_PAYOUT_STATUS.UNPAID;
  const clean = String(status).trim().toLowerCase();
  if (VALID_STATUSES.has(clean)) {
    return clean;
  }
  return RECEIPT_PAYOUT_STATUS.UNPAID;
}

/**
 * Returns metadata (labels, colors, badges, icons) for any payout status.
 * Reads from the cached, frozen static registry.
 * @param {string} status 
 * @returns {{ id: string, label: string, printLabel: string, color: string, badgeClass: string, icon: string }}
 */
export function getPayoutStatusMeta(status) {
  const clean = normalizePayoutStatus(status);
  return STATUS_META_REGISTRY[clean] || STATUS_META_REGISTRY[RECEIPT_PAYOUT_STATUS.UNPAID];
}

// State Machine transition rules
const TRANSITION_RULES = Object.freeze({
  [RECEIPT_PAYOUT_STATUS.UNPAID]: new Set([RECEIPT_PAYOUT_STATUS.PAID, RECEIPT_PAYOUT_STATUS.PARTIAL, RECEIPT_PAYOUT_STATUS.CANCELLED]),
  [RECEIPT_PAYOUT_STATUS.PAID]: new Set([RECEIPT_PAYOUT_STATUS.UNPAID, RECEIPT_PAYOUT_STATUS.PARTIAL, RECEIPT_PAYOUT_STATUS.CANCELLED]),
  [RECEIPT_PAYOUT_STATUS.PARTIAL]: new Set([RECEIPT_PAYOUT_STATUS.PAID, RECEIPT_PAYOUT_STATUS.UNPAID, RECEIPT_PAYOUT_STATUS.CANCELLED]),
  [RECEIPT_PAYOUT_STATUS.CANCELLED]: new Set([RECEIPT_PAYOUT_STATUS.UNPAID])
});

/**
 * Checks if a transition from one state to another is allowed.
 * @param {string} from 
 * @param {string} to 
 * @returns {boolean}
 */
export function canTransition(from, to) {
  const cleanFrom = normalizePayoutStatus(from);
  const cleanTo = normalizePayoutStatus(to);
  if (cleanFrom === cleanTo) return true;
  return TRANSITION_RULES[cleanFrom]?.has(cleanTo) || false;
}

/**
 * Transition engine for changing payout status.
 * Ensures the transition is valid, returns a new mutated copy of the receipt.
 * @param {object} receipt 
 * @param {string} nextStatus 
 * @returns {object}
 */
export function transitionReceiptState(receipt, nextStatus) {
  if (!receipt) throw new Error('[PayoutState] Receipt object is required');
  assertValidPayoutStatus(nextStatus);

  const currentStatus = normalizePayoutStatus(receipt.payout_status);
  const targetStatus = normalizePayoutStatus(nextStatus);

  if (!canTransition(currentStatus, targetStatus)) {
    throw new Error(`[PayoutState] Transition not allowed from "${currentStatus}" to "${targetStatus}"`);
  }

  const localISO = DateUtils.nowLocal();

  return Object.freeze({
    ...receipt,
    payout_status: targetStatus,
    paid_at: targetStatus === RECEIPT_PAYOUT_STATUS.PAID ? localISO : null
  });
}
