'use strict';

const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

function clean(v) { return String(v || '').trim(); }
function toInt(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; }
function periodKey(p) { return `${toInt(p.annee)}-${clean(p.mois)}`; }
function periodLabel(p) { return `${clean(p.mois)} ${toInt(p.annee)}`; }

function parsePeriods(value, fallbackMonth, fallbackYear) {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (_) { raw = raw ? [raw] : []; }
  }
  if (!Array.isArray(raw)) raw = [];
  const out = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const parts = item.trim().split(/\s+/);
      const year = toInt(parts[parts.length - 1]) || toInt(fallbackYear);
      const month = parts.length > 1 ? parts.slice(0, -1).join(' ') : item.trim();
      if (month && year) out.push({ mois: month, annee: year });
    } else if (item && typeof item === 'object') {
      const mois = clean(item.mois || item.month);
      const annee = toInt(item.annee || item.year || fallbackYear);
      if (mois && annee) out.push({ mois, annee });
    }
  }
  if (!out.length && fallbackMonth && fallbackYear) out.push({ mois: clean(fallbackMonth), annee: toInt(fallbackYear) });
  const seen = new Set();
  return out.filter((p) => {
    const k = periodKey(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const PAYMENT_TOLERANCE = 1;

function normalizePaidMonths(body) {
  const months = parsePeriods(body.mois_payes || body.mois_payes_liste, body.mois_concerne, body.annee_concernee);
  const count = months.length || toInt(body.nombre_mois_payes) || 1;
  const unitDue = toInt(body.loyer);
  const explicitDue = toInt(body.montant_a_payer);
  const amountDue = unitDue ? unitDue * count : explicitDue;
  const amountPaid = toInt(body.montant_paye);
  const diff = amountDue - amountPaid;
  const reste = diff > PAYMENT_TOLERANCE ? diff : 0;
  return {
    months,
    count,
    primary: months[0] || { mois: clean(body.mois_concerne), annee: toInt(body.annee_concernee) },
    amountDue,
    amountPaid,
    reste,
    status: reste <= 0 ? 'Soldé' : 'Non soldé',
  };
}

function buildPaidMonthMap(payments) {
  const map = new Map();
  for (const p of payments || []) {
    const id = p.subscription_id;
    if (!id) continue;
    let entry = map.get(id);
    if (!entry) { entry = { paid: new Map(), total: 0, lastRecu: null }; map.set(id, entry); }
    const periods = parsePeriods(p.mois_payes, p.mois_concerne, p.annee_concernee);
    const share = periods.length ? (toInt(p.montant_paye) / periods.length) : toInt(p.montant_paye);
    for (const per of periods) {
      const k = periodKey(per);
      const existing = entry.paid.get(k) || { ...per, amount: 0 };
      existing.amount += share;
      entry.paid.set(k, existing);
    }
    entry.total += toInt(p.montant_paye);
    if (p.numero_recu) entry.lastRecu = p.numero_recu;
  }
  return map;
}

function summarizeRecoveryMonths(expectedMonths, paidEntry, loyer) {
  const paid = paidEntry && paidEntry.paid ? paidEntry.paid : new Map();
  const expectedKeys = new Set((expectedMonths || []).map(periodKey));
  const paidExpected = [];
  const due = [];
  for (const m of expectedMonths || []) {
    const e = paid.get(periodKey(m));
    if (e && e.amount + PAYMENT_TOLERANCE >= loyer) paidExpected.push(m);
    else due.push(m);
  }
  const credit = [];
  for (const e of paid.values()) {
    if (!expectedKeys.has(periodKey(e))) credit.push(e);
  }
  const montantDu = (expectedMonths || []).length * loyer;
  const montantPayeApplicable = Math.min(montantDu, paidExpected.length * loyer + (expectedMonths || []).reduce((a, m) => {
    const e = paid.get(periodKey(m));
    return a + (e && e.amount < loyer ? e.amount : 0);
  }, 0));
  const totalPaid = paidEntry ? paidEntry.total : 0;
  return {
    mois_payes: paidExpected.length,
    mois_payes_liste: paidExpected.map(periodLabel),
    mois_dus: due.length,
    mois_dus_liste: due.map(periodLabel),
    mois_credit: credit.length,
    mois_credit_liste: credit.map(periodLabel),
    montant_du: montantDu,
    montant_paye: Math.min(totalPaid, montantDu),
    montant_paye_total: totalPaid,
    ecart: Math.max(0, montantDu - totalPaid) <= PAYMENT_TOLERANCE ? 0 : Math.max(0, montantDu - totalPaid),
  };
}

module.exports = { MOIS, parsePeriods, normalizePaidMonths, buildPaidMonthMap, summarizeRecoveryMonths, periodLabel, periodKey };
