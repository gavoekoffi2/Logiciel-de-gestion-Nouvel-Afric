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
      const existing = entry.paid.get(k) || { ...per, amount: 0, numero_recu: null };
      existing.amount += share;
      // Numero de recu rattache a CE mois : un etat mensuel doit pouvoir citer
      // la piece justificative du mois affiche, pas le dernier recu du bail.
      if (p.numero_recu) existing.numero_recu = p.numero_recu;
      entry.paid.set(k, existing);
    }
    entry.total += toInt(p.montant_paye);
    if (p.numero_recu) entry.lastRecu = p.numero_recu;
  }
  return map;
}

// Bilan d'un echeancier : combien de mois sont soldes, combien restent dus, et
// quel montant a ete effectivement encaisse POUR ces mois-la.
//
// `expectedMonths` delimite strictement le perimetre du calcul : si l'appelant
// ne passe qu'un seul mois, les montants renvoyes ne concernent QUE ce mois. Un
// encaissement impute a un autre mois n'est jamais reverse dans le total — c'est
// ce qui permet au compteur de recouvrement de repartir de zero a chaque mois.
//
// `options.scheduleMonths` (facultatif) donne l'echeancier COMPLET du bail. Il
// sert uniquement a reconnaitre les avances : un mois paye hors echeancier est
// un credit, alors qu'un mois paye simplement en dehors de la fenetre analysee
// (un mois anterieur, par exemple) n'en est pas un.
function summarizeRecoveryMonths(expectedMonths, paidEntry, loyer, options = {}) {
  const paid = paidEntry && paidEntry.paid ? paidEntry.paid : new Map();
  const months = expectedMonths || [];
  const expectedKeys = new Set(months.map(periodKey));
  const scheduleKeys = options.scheduleMonths
    ? new Set(options.scheduleMonths.map(periodKey))
    : expectedKeys;
  const paidExpected = [];
  const due = [];
  let montantPaye = 0;
  let resteDu = 0;
  for (const m of months) {
    const entry = paid.get(periodKey(m));
    const amount = entry ? entry.amount : 0;
    montantPaye += amount;
    const manque = loyer - amount;
    if (manque > PAYMENT_TOLERANCE) {
      due.push(m);
      resteDu += manque;
    } else {
      paidExpected.push(m);
    }
  }
  const credit = [];
  for (const e of paid.values()) {
    if (!scheduleKeys.has(periodKey(e))) credit.push(e);
  }
  const montantDu = months.length * loyer;
  return {
    mois_payes: paidExpected.length,
    mois_payes_liste: paidExpected.map(periodLabel),
    mois_dus: due.length,
    mois_dus_liste: due.map(periodLabel),
    mois_credit: credit.length,
    mois_credit_liste: credit.map(periodLabel),
    montant_du: montantDu,
    // Encaisse pour les mois analyses uniquement (jamais le cumul du bail).
    montant_paye: Math.round(montantPaye),
    montant_paye_total: paidEntry ? paidEntry.total : 0,
    // Somme des manques mois par mois : un trop-percu sur un mois ne vient pas
    // masquer l'impaye d'un autre mois.
    ecart: Math.round(resteDu),
  };
}

module.exports = { MOIS, parsePeriods, normalizePaidMonths, buildPaidMonthMap, summarizeRecoveryMonths, periodLabel, periodKey };
