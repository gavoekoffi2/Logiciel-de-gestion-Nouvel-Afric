'use strict';

const { MOIS, parsePeriods } = require('./paymentPeriods');
const { lastDuePeriod } = require('./rentCycle');

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

// Location a terme echu : la « periode courante » d'un ecran de gestion locative
// n'est pas le mois civil en cours (dont le loyer n'est pas encore exigible)
// mais le dernier mois de loyer EXIGIBLE, c'est-a-dire le mois precedent.
function dueMonthValue(ref = new Date()) {
  return lastDuePeriod(ref).value;
}

function normalizeRange(query = {}, defaults = {}) {
  const ref = defaults.ref instanceof Date ? defaults.ref : new Date();
  const mode = String(query.mode || defaults.mode || 'current').trim();
  const due = lastDuePeriod(ref);
  let fromValue = String(query.from || query.debut || '').trim();
  let toValue = String(query.to || query.fin || '').trim();

  // « Mois courant » et « depuis janvier » sont des periodes CALCULEES : quand
  // le client les demande nommement, le serveur impose ses propres bornes. Un
  // navigateur laisse ouvert au changement de mois, un signet ou une version
  // ancienne du JS ne peuvent donc pas afficher une periode contraire a la
  // regle du terme echu (le mois en cours n'est jamais exigible).
  if (String(query.mode || '').trim() === 'current') {
    fromValue = due.value;
    toValue = due.value;
  } else if (String(query.mode || '').trim() === 'ytd') {
    fromValue = `${due.annee}-01`;
    toValue = due.value;
  }

  if (!fromValue && query.mois && query.annee) {
    const monthNumber = MOIS.indexOf(String(query.mois).trim()) + 1;
    if (monthNumber > 0) fromValue = `${toInt(query.annee)}-${String(monthNumber).padStart(2, '0')}`;
  }
  if (!toValue && fromValue && (mode === 'month' || mode === 'current')) toValue = fromValue;

  if (!fromValue || !toValue) {
    if (mode === 'all') {
      return { mode: 'all', from: null, to: null, fromValue: '', toValue: '', monthCount: null };
    }
    if (mode === 'ytd') {
      fromValue = `${due.annee}-01`;
      toValue = due.value;
    } else {
      // Par defaut : le dernier mois de loyer exigible, jamais le mois en cours.
      fromValue = due.value;
      toValue = due.value;
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

// Ventile un reglement mois par mois (montant a payer, montant paye, reste) et
// ne conserve que les mois retenus par `keep(period, index)`.
function paymentAmountsFor(payment, keep) {
  const periods = parsePeriods(payment && payment.mois_payes, payment && payment.mois_concerne, payment && payment.annee_concernee);
  const sourcePeriods = periods.length ? periods : [{ mois: payment && payment.mois_concerne, annee: toInt(payment && payment.annee_concernee) }];
  const allocations = {
    montant_a_payer: allocateInteger(payment && payment.montant_a_payer, sourcePeriods.length),
    montant_paye: allocateInteger(payment && payment.montant_paye, sourcePeriods.length),
  };
  const selectedIndexes = sourcePeriods.map((period, index) => keep(period, index) ? index : -1).filter((index) => index >= 0);
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

// Part d'un reglement imputee aux mois de loyer de la periode (quelle que soit
// sa date d'encaissement).
function paymentAmountsInRange(payment, range) {
  return paymentAmountsFor(payment, (period) => periodInRange(period, range));
}

// Periode de recouvrement a laquelle appartient un encaissement, d'apres sa
// DATE. A terme echu, l'argent recu en septembre sert au recouvrement du loyer
// d'aout : un encaissement date du mois M appartient a la periode M-1.
// null si la date est absente ou illisible (on ne devine jamais une date).
function collectionPeriodIndex(dateValue) {
  const match = String(dateValue || '').trim().match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  const year = toInt(match[1]);
  const monthNumber = toInt(match[2]);
  if (year < 1900 || monthNumber < 1 || monthNumber > 12) return null;
  return year * 12 + monthNumber - 1 - 1;
}

// ARRIERES ENCAISSES PENDANT LA PERIODE. Part d'un reglement qui solde des mois
// ANTERIEURS a la periode affichee, mais qui a ete encaissee pendant le
// recouvrement de cette periode (d'apres la date d'encaissement).
//
// Ces montants ne sont pas des loyers du mois — ils ne touchent ni au du, ni a
// l'ecart du mois — mais c'est bien de l'argent recolte pendant le mois :
// l'agence doit les retrouver dans le total encaisse du mois.
//
// Les mois deja compris dans la periode sont exclus : ils sont comptes comme
// loyers de la periode, les reprendre ici les compterait deux fois.
function arrearsCollectedInRange(payment, range) {
  const none = paymentAmountsFor(payment, () => false);
  if (!range || range.mode === 'all' || !range.from || !range.to) return none;
  const collected = collectionPeriodIndex(payment && payment.date);
  if (collected === null || collected < range.from.index || collected > range.to.index) return none;
  return paymentAmountsFor(payment, (period) => {
    const index = periodIndex(period);
    return index !== null && index < range.from.index;
  });
}

function rangeLabel(range) {
  if (!range || range.mode === 'all') return 'Toutes les périodes';
  if (range.from.index === range.to.index) return `${range.from.mois} ${range.from.annee}`;
  return `${range.from.mois} ${range.from.annee} → ${range.to.mois} ${range.to.annee}`;
}

module.exports = {
  parseMonthValue,
  monthValue,
  dueMonthValue,
  normalizeRange,
  periodIndex,
  periodInRange,
  paymentAmountsInRange,
  collectionPeriodIndex,
  arrearsCollectedInRange,
  rangeLabel,
};
