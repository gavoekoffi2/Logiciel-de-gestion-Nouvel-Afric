'use strict';

/**
 * CYCLE DU LOYER — LOCATION A TERME ECHU (source de verite unique).
 *
 * Regle metier : le locataire paie un mois de loyer APRES l'avoir consomme.
 * Le loyer de juillet se recouvre donc en aout, celui d'aout en septembre, etc.
 *
 * Consequences appliquees partout dans le logiciel :
 *   - le dernier mois EXIGIBLE est toujours le mois civil PRECEDENT ;
 *   - le mois en cours est « a echoir » : jamais reclame, jamais compte en
 *     retard, jamais propose par defaut a l'encaissement ;
 *   - le mois propose par defaut lors d'un encaissement est le mois precedant
 *     la date d'encaissement (encaissement du 05/08 => loyer de juillet).
 *
 * Tout module qui a besoin de savoir « quel mois de loyer est du aujourd'hui »
 * doit passer par ce fichier, jamais par un calcul local.
 */

const { MOIS } = require('./paymentPeriods');

// Nombre de mois d'avance tolere lors d'une saisie manuelle. Au-dela, il s'agit
// presque toujours d'une faute de frappe sur l'annee (ex. 2062 au lieu de 2026)
// qui creerait un faux credit invisible pendant des annees.
const MAX_ADVANCE_MONTHS = 12;

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// Accepte 'YYYY-MM', 'YYYY-MM-DD', un Date, ou rien (= maintenant).
function referenceDate(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year >= 1900 && month >= 1 && month <= 12) return new Date(year, month - 1, 1);
  }
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

// Represente un mois de loyer sous toutes les formes utilisees dans le code :
// libelle francais, annee, numero de mois (1..12), valeur 'YYYY-MM' et index
// absolu (pour comparer deux periodes sans se soucier du changement d'annee).
function buildPeriod(year, monthNumber) {
  return {
    mois: MOIS[monthNumber - 1],
    annee: year,
    monthNumber,
    value: `${year}-${String(monthNumber).padStart(2, '0')}`,
    label: `${MOIS[monthNumber - 1]} ${year}`,
    index: year * 12 + monthNumber - 1,
  };
}

// Index absolu d'une periode { mois: 'Juillet' | 7, annee: 2026 } ; null si la
// periode est inexploitable.
function periodIndexOf(period) {
  if (!period) return null;
  const year = toInt(period.annee !== undefined ? period.annee : period.year);
  const raw = period.mois !== undefined ? period.mois : period.month;
  const monthNumber = typeof raw === 'number' ? raw : MOIS.indexOf(String(raw || '').trim()) + 1;
  if (!year || monthNumber < 1 || monthNumber > 12) return null;
  return year * 12 + monthNumber - 1;
}

// Dernier mois de loyer EXIGIBLE a la date de reference = le mois precedent.
function lastDuePeriod(ref = new Date()) {
  const date = referenceDate(ref);
  const previous = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return buildPeriod(previous.getFullYear(), previous.getMonth() + 1);
}

// Mois de loyer propose par defaut pour un encaissement effectue a cette date.
// Identique a `lastDuePeriod` : on encaisse le mois deja consomme.
function previousRentPeriod(paymentDate = new Date()) {
  const { mois, annee, value } = lastDuePeriod(paymentDate);
  return { mois, annee, value };
}

// Le loyer de cette periode est-il deja exigible (mois entierement consomme) ?
function isPeriodDue(period, ref = new Date()) {
  const index = periodIndexOf(period);
  return index !== null && index <= lastDuePeriod(ref).index;
}

// Ramene une periode au dernier mois exigible si elle le depasse. Utilise par
// les etats de recouvrement : on ne reclame jamais un mois en cours.
function clampToDuePeriod(period, ref = new Date()) {
  const due = lastDuePeriod(ref);
  const index = periodIndexOf(period);
  if (index === null || index > due.index) return due;
  return buildPeriod(Math.floor(index / 12), (index % 12) + 1);
}

// Garde-fou de saisie : une periode trop lointaine revele une faute de frappe.
function isPeriodTooFarAhead(period, ref = new Date()) {
  const index = periodIndexOf(period);
  return index !== null && index > lastDuePeriod(ref).index + MAX_ADVANCE_MONTHS;
}

module.exports = {
  MOIS,
  MAX_ADVANCE_MONTHS,
  buildPeriod,
  periodIndexOf,
  lastDuePeriod,
  previousRentPeriod,
  isPeriodDue,
  clampToDuePeriod,
  isPeriodTooFarAhead,
};
