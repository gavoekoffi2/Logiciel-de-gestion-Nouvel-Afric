'use strict';

const { MOIS, parsePeriods } = require('./paymentPeriods');

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function parseMonthValue(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const annee = toInt(match[1]);
  const monthNumber = toInt(match[2]);
  if (annee < 1900 || monthNumber < 1 || monthNumber > 12) return null;
  return { annee, mois: MOIS[monthNumber - 1], index: annee * 12 + monthNumber - 1 };
}

function monthValue(period) {
  const monthNumber = MOIS.indexOf(period && period.mois) + 1;
  const year = toInt(period && period.annee);
  if (!year || monthNumber < 1) return '';
  return `${year}-${String(monthNumber).padStart(2, '0')}`;
}

function currentMonthValue(ref = new Date()) {
  return `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, '0')}`;
}

function normalizeRange(query = {}, defaults = {}) {
  const ref = defaults.ref instanceof Date ? defaults.ref : new Date();
  const mode = String(query.mode || defaults.mode || 'current').trim();
  let fromValue = String(query.from || query.debut || '').trim();
  let toValue = String(query.to || query.fin || '').trim();

  if (!fromValue && query.mois && query.annee) {
    const monthNumber = MOIS.indexOf(String(query.mois).trim()) + 1;
    if (monthNumber > 0) fromValue = `${toInt(query.annee)}-${String(monthNumber).padStart(2, '0')}`;
  }
  if (!toValue && fromValue && (mode === 'month' || mode === 'current')) toValue = fromValue;

  if (!fromValue || !toValue) {
    const current = currentMonthValue(ref);
    if (mode === 'ytd') {
      fromValue = `${ref.getFullYear()}-01`;
      toValue = current;
    } else if (mode === 'all') {
      return { mode: 'all', from: null, to: null, fromValue: '', toValue: '', monthCount: null };
    } else {
      fromValue = current;
      toValue = current;
    }
  }

  let from = parseMonthValue(fromValue);
  let to = parseMonthValue(toValue);
  if (!from || !to) return normalizeRange({}, { ...defaults, mode: defaults.mode || 'current', ref });
  if (from.index > to.index) [from, to] = [to, from];
  return {
    mode: from.index === to.index ? 'month' : 'range',
    from,
    to,
    fromValue: monthValue(from),
    toValue: monthValue(to),
    monthCount: to.index - from.index + 1,
  };
}

function periodIndex(period) {
  const monthNumber = MOIS.indexOf(String(period && period.mois || '').trim()) + 1;
  const year = toInt(period && period.annee);
  return monthNumber > 0 && year ? year * 12 + monthNumber - 1 : null;
}

function periodInRange(period, range) {
  if (!range || range.mode === 'all' || !range.from || !range.to) return true;
  const index = periodIndex(period);
  return index !== null && index >= range.from.index && index <= range.to.index;
}

function allocateInteger(total, count) {
  const value = Math.round(Number(total) || 0);
  const size = Math.max(1, count);
  const base = Math.trunc(value / size);
  let remainder = value - base * size;
  return Array.from({ length: size }, () => {
    if (remainder === 0) return base;
    const extra = remainder > 0 ? 1 : -1;
    remainder -= extra;
    return base + extra;
  });
}

function paymentAmountsInRange(payment, range) {
  const periods = parsePeriods(payment && payment.mois_payes, payment && payment.mois_concerne, payment && payment.annee_concernee);
  const sourcePeriods = periods.length ? periods : [{ mois: payment && payment.mois_concerne, annee: toInt(payment && payment.annee_concernee) }];
  const allocations = {
    montant_a_payer: allocateInteger(payment && payment.montant_a_payer, sourcePeriods.length),
    montant_paye: allocateInteger(payment && payment.montant_paye, sourcePeriods.length),
  };
  const selectedIndexes = sourcePeriods.map((period, index) => periodInRange(period, range) ? index : -1).filter((index) => index >= 0);
  const selectedPeriods = selectedIndexes.map((index) => sourcePeriods[index]);
  if (!selectedPeriods.length) {
    return { matches: false, selectedPeriods: [], periodAmounts: [], montant_a_payer: 0, montant_paye: 0, reste_a_payer: 0 };
  }
  const periodAmounts = selectedIndexes.map((index) => {
    const montant_a_payer = allocations.montant_a_payer[index];
    const montant_paye = allocations.montant_paye[index];
    const reste_a_payer = Math.max(0, montant_a_payer - montant_paye);
    return {
      ...sourcePeriods[index],
      montant_a_payer,
      montant_paye,
      reste_a_payer,
      statut: reste_a_payer <= 1 ? 'Soldé' : 'Non soldé',
    };
  });
  const sum = (field) => periodAmounts.reduce((total, item) => total + item[field], 0);
  return {
    matches: true,
    selectedPeriods,
    periodAmounts,
    montant_a_payer: sum('montant_a_payer'),
    montant_paye: sum('montant_paye'),
    reste_a_payer: sum('reste_a_payer'),
    statut: sum('reste_a_payer') <= 1 ? 'Soldé' : 'Non soldé',
  };
}

function rangeLabel(range) {
  if (!range || range.mode === 'all') return 'Toutes les périodes';
  if (range.from.index === range.to.index) return `${range.from.mois} ${range.from.annee}`;
  return `${range.from.mois} ${range.from.annee} → ${range.to.mois} ${range.to.annee}`;
}

module.exports = {
  parseMonthValue,
  monthValue,
  currentMonthValue,
  normalizeRange,
  periodIndex,
  periodInRange,
  paymentAmountsInRange,
  rangeLabel,
};
