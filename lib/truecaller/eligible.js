/**
 * Join the cached Outlook account list with Truecaller sqlite.
 * Does not re-scan profile JSON (listAccounts already caches the 53k fleet).
 */
import { listAccounts as listOutlookAccounts } from '../accounts.js';
import { listAccounts as listTcAccounts, publicAccount, tcStatusOf } from './store.js';

export function tcMap() {
  const map = new Map();
  for (const row of listTcAccounts()) {
    map.set(String(row.email || '').toLowerCase(), row);
  }
  return map;
}

export function classifyRow(tcRow) {
  if (!tcRow) return 'not_signed_up';
  return tcStatusOf(tcRow);
}

function matchesFilters(acc, tcRow, { group = '', search = '', tcStatus = '' } = {}) {
  if (!acc?.sessionValid) return false;
  if (group && (acc.group || '') !== group) return false;
  const q = String(search || '').trim().toLowerCase();
  if (q && !String(acc.email || '').toLowerCase().includes(q)) return false;
  const status = classifyRow(tcRow);
  const wanted = String(tcStatus || '').trim();
  if (wanted && wanted !== 'all' && status !== wanted) return false;
  return true;
}

export function toEligibleRow(acc, tcRow) {
  return {
    email: acc.email,
    group: acc.group || null,
    outlookStatus: acc.status || null,
    outlookHealth: acc.health || null,
    lastLoginAt: acc.lastLoginAt || null,
    cookieCount: acc.cookieCount || 0,
    sessionValid: !!acc.sessionValid,
    tcStatus: classifyRow(tcRow),
    truecaller: publicAccount(tcRow),
  };
}

export async function collectEligible({ group = '', search = '', tcStatus = '' } = {}) {
  const outlook = await listOutlookAccounts();
  const map = tcMap();
  const rows = [];
  for (const acc of outlook) {
    const email = String(acc.email || '').toLowerCase();
    const tcRow = map.get(email) || null;
    if (!matchesFilters(acc, tcRow, { group, search, tcStatus })) continue;
    rows.push({ acc, tcRow, email: acc.email, tcStatus: classifyRow(tcRow) });
  }
  return rows;
}

export async function eligiblePage({
  page = 1,
  limit = 50,
  group = '',
  search = '',
  tcStatus = '',
} = {}) {
  const safeLimit = Math.min(200, Math.max(10, Number(limit) || 50));
  const all = await collectEligible({ group, search, tcStatus });
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / safeLimit) || 1);
  const safePage = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (safePage - 1) * safeLimit;
  return {
    accounts: all.slice(start, start + safeLimit).map((r) => toEligibleRow(r.acc, r.tcRow)),
    total,
    page: safePage,
    limit: safeLimit,
    pages,
    group: group || '',
    search: search || '',
    tcStatus: tcStatus || 'all',
  };
}

export async function eligibleStats({ group = '', search = '' } = {}) {
  const outlook = await listOutlookAccounts();
  const map = tcMap();
  const q = String(search || '').trim().toLowerCase();
  const stats = {
    outlookTotal: 0,
    noSession: 0,
    eligible: 0,
    not_signed_up: 0,
    signed_up: 0,
    expired: 0,
    failed: 0,
    signing_up: 0,
    other: 0,
  };
  const groups = new Set();
  for (const acc of outlook) {
    if (acc.group) groups.add(acc.group);
    if (group && (acc.group || '') !== group) continue;
    if (q && !String(acc.email || '').toLowerCase().includes(q)) continue;
    stats.outlookTotal += 1;
    if (!acc.sessionValid) {
      stats.noSession += 1;
      continue;
    }
    stats.eligible += 1;
    const status = classifyRow(map.get(String(acc.email || '').toLowerCase()) || null);
    if (status === 'not_signed_up') stats.not_signed_up += 1;
    else if (status === 'signed_up') stats.signed_up += 1;
    else if (status === 'expired') stats.expired += 1;
    else if (status === 'failed') stats.failed += 1;
    else if (status === 'signing_up') stats.signing_up += 1;
    else stats.other += 1;
  }
  return {
    ...stats,
    groups: [...groups].sort((a, b) => a.localeCompare(b)),
  };
}

export async function collectEmails({
  scope = 'selected',
  emails = [],
  group = '',
  search = '',
  limit = 0,
} = {}) {
  const cap = Math.max(0, Number(limit) || 0);
  const selected = [...new Set((emails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];

  if (scope === 'selected') {
    const out = selected;
    return cap ? out.slice(0, cap) : out;
  }

  const tcStatus =
    scope === 'not_signed_up' || scope === 'expired' || scope === 'failed' || scope === 'signed_up'
      ? scope
      : '';
  const rows = await collectEligible({ group, search, tcStatus });
  const out = rows.map((r) => String(r.email).toLowerCase());
  return cap ? out.slice(0, cap) : out;
}
