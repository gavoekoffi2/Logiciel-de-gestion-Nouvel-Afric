'use strict';

/**
 * API REST de gestion locative — TOUTES les donnees sont isolees par entreprise
 * (company_id provenant de la session, jamais du client).
 *
 * Trois routeurs sont exportes :
 *   - router            : metier (proprietaires, locataires, biens, baux,
 *                         reglements, tableau de bord, parametres, utilisateurs).
 *                         Exige un abonnement actif.
 *   - settingsRouter    : profil/branding de l'entreprise (consultable meme si
 *                         l'abonnement est expire).
 *   - subscriptionRouter: etat de l'abonnement + demande d'activation.
 */

const express = require('express');
const { db, hashPassword, computeSubscription, migrateInactiveSubscriptionDates } = require('./db');
const { requireRole, publicUser, companyState } = require('./auth');
const { isNoSubscriptionCompanyName } = require('./companyPolicy');
const { normalizePaidMonths, parsePeriods, buildPaidMonthMap, summarizeRecoveryMonths } = require('./paymentPeriods');
const { normalizeRange, periodInRange, periodIndex, paymentAmountsInRange, rangeLabel } = require('./periodRange');
const {
  previousRentPeriod, lastDuePeriod, clampToDuePeriod, isPeriodDue, isPeriodTooFarAhead,
  periodIndexOf, MAX_ADVANCE_MONTHS,
} = require('./rentCycle');

const router = express.Router();
const settingsRouter = express.Router();
const subscriptionRouter = express.Router();
const dataRouter = express.Router();

const MOIS = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

// Un écart d'arrondi de 1 FCFA ne doit jamais bloquer un paiement ni afficher
// un reliquat artificiel dans l'échéancier du bien.
const PAYMENT_TOLERANCE = 1;

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};
const toNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

const rand = () => Math.floor(Math.random() * (5484444 - 1000 + 1)) + 1000;

function dateCode(dateStr) {
  if (typeof dateStr === 'string') {
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}${m[2]}${m[1]}`;
  }
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}${mm}${d.getFullYear()}`;
}

// Abrege le type de bien pour l'inserer dans le code (ex. 'RDC' -> 'RDC', 'R+1' -> 'R1').
function typeCode(type) {
  return (clean(type) || 'BIEN').replace(/[^A-Za-z0-9]+/g, '').toUpperCase() || 'BIEN';
}

// Les codes restent uniques au niveau global (le suffixe aleatoire l'assure).
async function codeExists(table, code) {
  return !!(await db.prepare(`SELECT 1 FROM ${table} WHERE code = ?`).get(code));
}

async function genPropertyCode(type, dateStr) {
  const base = `${typeCode(type)}_M${dateCode(dateStr)}`;
  let code;
  do { code = `${base}A${rand()}`; } while (await codeExists('properties', code));
  return code;
}

async function genCode(table, prefix, dateStr) {
  let code;
  do { code = `${prefix}${dateCode(dateStr)}A${rand()}`; } while (await codeExists(table, code));
  return code;
}

// Garantit un code unique au niveau global (utilise a l'import : on conserve le
// code d'origine s'il est libre, sinon on le rend unique en y ajoutant un suffixe).
async function uniqueCode(table, prefix, desired) {
  let code = clean(desired) || `${prefix}${dateCode()}A${rand()}`;
  while (await codeExists(table, code)) code = `${clean(desired) || prefix}-${rand()}`;
  return code;
}

// Petit utilitaire pour rattraper les erreurs d'une route sans repeter try/catch.
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
};

// Liste des mois du 1er mois de paiement jusqu'a la periode (annee/mois) demandee
// incluse — sert a construire l'echeancier d'un bail et a reperer les retards.
function monthsUntil(startYMD, ey, em) {
  const m = String(startYMD || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return [];
  let y = Number(m[1]);
  let mo = Number(m[2]); // 1..12
  const out = [];
  let guard = 0;
  while ((y < ey || (y === ey && mo <= em)) && guard++ < 600) {
    out.push({ annee: y, mois: MOIS[mo - 1] });
    mo += 1;
    if (mo > 12) { mo = 1; y += 1; }
  }
  return out;
}
// Location A TERME ECHU : le loyer d'un mois n'est exigible qu'une fois le mois
// entierement consomme. Le dernier mois exigible est donc le mois civil PRECEDENT
// (ex. en aout, on encaisse le loyer de juillet). La regle est portee par
// src/rentCycle.js ; on n'expose ici que la forme { annee, mois } (mois en
// base 1) attendue par les calculs d'echeancier.
function lastDueYearMonth(ref) {
  const due = lastDuePeriod(ref || new Date());
  return { annee: due.annee, mois: due.monthNumber };
}

function lastDueAtDeparture(dateValue) {
  const match = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  let annee = Number(match[1]);
  let mois = Number(match[2]);
  const day = Number(match[3]);
  const lastDay = new Date(annee, mois, 0).getDate();
  if (day < lastDay) {
    mois -= 1;
    if (mois < 1) { mois = 12; annee -= 1; }
  }
  return { annee, mois };
}

function latestPaymentPeriod(payments) {
  let latest = null;
  for (const payment of payments || []) {
    for (const period of parsePeriods(payment.mois_payes, payment.mois_concerne, payment.annee_concernee)) {
      const month = MOIS.indexOf(period.mois) + 1;
      const index = period.annee * 12 + month;
      if (month > 0 && (!latest || index > latest.index)) latest = { annee: period.annee, mois: month, index };
    }
  }
  return latest && { annee: latest.annee, mois: latest.mois };
}

function subscriptionEndPeriod(subscription, payments, { includeCurrent = false, ref = new Date() } = {}) {
  if (subscription.statut === 'Active') {
    return includeCurrent
      ? { annee: ref.getFullYear(), mois: ref.getMonth() + 1 }
      : lastDueYearMonth(ref);
  }
  const end = lastDueAtDeparture(subscription.date_fin) || latestPaymentPeriod(payments);
  if (!end) return null;
  const due = lastDueYearMonth(ref);
  return end.annee * 12 + end.mois > due.annee * 12 + due.mois ? due : end;
}

// Roles possibles AU SEIN d'une entreprise (le super-admin est hors entreprise).
const COMPANY_ROLES = ['admin', 'secretaire', 'assistant'];
const normRole = (r) => (COMPANY_ROLES.includes(clean(r)) ? clean(r) : 'secretaire');

// Journal d'activite : enregistre QUI fait QUOI. Ne doit JAMAIS faire echouer
// l'action metier (toute erreur d'ecriture du journal est avalee).
async function logAction(req, action, entity, label) {
  try {
    await db.prepare(
      'INSERT INTO audit_log (company_id, user_id, user_nom, action, entity, label) VALUES (?,?,?,?,?,?)'
    ).run(req.companyId || null, req.userId || null, req.userNom || null, action, entity, clean(label) || null);
  } catch (e) { console.error('audit_log:', e.message); }
}

// ===========================================================================
// PROPRIETAIRES
// ===========================================================================
router.get('/owners', wrap(async (req, res) => {
  const cid = req.companyId;
  const q = clean(req.query.q);
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = await db.prepare(
      `SELECT * FROM owners
       WHERE company_id = ? AND (nom_prenoms LIKE ? OR contact LIKE ? OR email LIKE ? OR adresse LIKE ?)
       ORDER BY nom_prenoms COLLATE NOCASE`
    ).all(cid, like, like, like, like);
  } else {
    rows = await db.prepare('SELECT * FROM owners WHERE company_id = ? ORDER BY nom_prenoms COLLATE NOCASE').all(cid);
  }
  res.json(rows);
}));

function personPayload(body) {
  return {
    nom_prenoms: clean(body.nom_prenoms),
    contact: clean(body.contact),
    email: clean(body.email),
    adresse: clean(body.adresse),
  };
}

async function validatePerson(p, table, companyId, excludeId, label) {
  if (!p.nom_prenoms) return 'Veuillez saisir le nom et prénoms.';
  if (!p.contact) return 'Veuillez saisir le contact.';
  const dup = await db
    .prepare(`SELECT id FROM ${table} WHERE company_id = ? AND lower(nom_prenoms) = lower(?) AND id <> ?`)
    .get(companyId, p.nom_prenoms, excludeId || 0);
  if (dup) return `Ce nom de ${label} existe déjà. Ajoutez un élément distinctif s’il s’agit de deux personnes différentes.`;
  return null;
}

router.post('/owners', wrap(async (req, res) => {
  const cid = req.companyId;
  const p = personPayload(req.body);
  const err = await validatePerson(p, 'owners', cid, 0, 'propriétaire');
  if (err) return res.status(400).json({ error: err });
  const info = await db.prepare(
    'INSERT INTO owners (company_id, nom_prenoms, contact, email, adresse, type_logement, pieces_logement) VALUES (?,?,?,?,?,?,?)'
  ).run(cid, p.nom_prenoms, p.contact, p.email, p.adresse, clean(req.body.type_logement), clean(req.body.pieces_logement));
  await logAction(req, 'Création', 'Propriétaire', p.nom_prenoms);
  res.json(await db.prepare('SELECT * FROM owners WHERE id = ?').get(info.lastInsertRowid));
}));

router.put('/owners/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const p = personPayload(req.body);
  const err = await validatePerson(p, 'owners', cid, id, 'propriétaire');
  if (err) return res.status(400).json({ error: err });
  await db.prepare(
    'UPDATE owners SET nom_prenoms=?, contact=?, email=?, adresse=?, type_logement=?, pieces_logement=? WHERE id=? AND company_id=?'
  ).run(p.nom_prenoms, p.contact, p.email, p.adresse, clean(req.body.type_logement), clean(req.body.pieces_logement), id, cid);
  await logAction(req, 'Modification', 'Propriétaire', p.nom_prenoms);
  res.json(await db.prepare('SELECT * FROM owners WHERE id = ? AND company_id = ?').get(id, cid));
}));

router.delete('/owners/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const row = await db.prepare('SELECT nom_prenoms FROM owners WHERE id = ? AND company_id = ?').get(id, req.companyId);
  await db.prepare('DELETE FROM owners WHERE id = ? AND company_id = ?').run(id, req.companyId);
  if (row) await logAction(req, 'Suppression', 'Propriétaire', row.nom_prenoms);
  res.json({ ok: true });
}));

// ===========================================================================
// LOCATAIRES
// ===========================================================================
router.get('/tenants', wrap(async (req, res) => {
  const cid = req.companyId;
  const q = clean(req.query.q);
  const base = `SELECT t.*,
      s.id AS active_subscription_id, s.code AS active_subscription_code,
      p.id AS active_property_id, p.code AS active_property_code,
      p.designation AS active_property_designation, p.type_construction AS active_property_type,
      s.montant_loyer AS active_property_loyer
    FROM tenants t
    LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.company_id = t.company_id AND s.statut = 'Active'
    LEFT JOIN properties p ON p.id = s.property_id AND p.company_id = t.company_id`;
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = await db.prepare(
      `${base}
       WHERE t.company_id = ? AND (t.nom_prenoms LIKE ? OR t.contact LIKE ? OR t.email LIKE ? OR t.adresse LIKE ? OR p.code LIKE ?)
       ORDER BY t.nom_prenoms COLLATE NOCASE`
    ).all(cid, like, like, like, like, like);
  } else {
    rows = await db.prepare(`${base} WHERE t.company_id = ? ORDER BY t.nom_prenoms COLLATE NOCASE`).all(cid);
  }
  res.json(rows);
}));

router.get('/tenants/:id/defaults', wrap(async (req, res) => {
  const row = await db.prepare(
    'SELECT id, caution, autre_frais, montant_autre_frais FROM tenants WHERE id = ? AND company_id = ?'
  ).get(toInt(req.params.id), req.companyId);
  if (!row) return res.status(404).json({ error: 'Locataire introuvable.' });
  res.json(row);
}));

router.post('/tenants', wrap(async (req, res) => {
  const cid = req.companyId;
  const p = personPayload(req.body);
  const err = await validatePerson(p, 'tenants', cid, 0, 'locataire');
  if (err) return res.status(400).json({ error: err });

  // Si un bien est choisi au moment d'enregistrer le locataire, on valide le
  // bien et le loyer avant de créer la fiche, afin d'éviter un locataire orphelin.
  const propertyId = toInt(req.body.property_id);
  let prop = null;
  if (propertyId) {
    prop = await db.prepare('SELECT * FROM properties WHERE id = ? AND company_id = ?').get(propertyId, cid);
    if (!prop) return res.status(400).json({ error: 'Bien introuvable.' });
    if (!toInt(req.body.montant_loyer)) return res.status(400).json({ error: 'Le montant du loyer est requis.' });
  }

  let subscription = null;
  let subscriptionCode = null;
  if (propertyId) {
    const montantLoyer = toInt(req.body.montant_loyer);
    const nbCaution = toInt(req.body.nombre_mois_caution);
    const nbAvance = toInt(req.body.nombre_mois_avance);
    const nbGarantie = toInt(req.body.nombre_mois_garantie);
    const today = new Date().toISOString().slice(0, 10);
    subscription = subscriptionPayload({
      ...req.body,
      property_id: propertyId,
      tenant_id: null,
      montant_loyer: montantLoyer,
      montant_caution: req.body.montant_caution !== undefined ? req.body.montant_caution : nbCaution * montantLoyer,
      montant_avance: req.body.montant_avance !== undefined ? req.body.montant_avance : nbAvance * montantLoyer,
      montant_garantie: req.body.montant_garantie !== undefined ? req.body.montant_garantie : nbGarantie * montantLoyer,
      date_souscription: clean(req.body.date_souscription) || today,
      date_entree: clean(req.body.date_entree) || today,
      date_debut_paiement: clean(req.body.date_debut_paiement) || clean(req.body.date_entree) || today,
      statut: clean(req.body.statut) || 'Active',
    });
    applySubscriptionEndDate(subscription, req.body);
    const subErr = await validateSubscription(subscription, cid, 0, { plannedTenant: true });
    if (subErr) return res.status(400).json({ error: subErr });
    subscriptionCode = await genCode('subscriptions', 'S', subscription.date_souscription);
  }

  const statements = [{
    sql: 'INSERT INTO tenants (company_id, nom_prenoms, contact, email, adresse, caution, autre_frais, montant_autre_frais) VALUES (?,?,?,?,?,?,?,?)',
    args: [cid, p.nom_prenoms, p.contact, p.email, p.adresse, toInt(req.body.caution), clean(req.body.autre_frais), toInt(req.body.montant_autre_frais)],
  }];
  if (subscription) {
    const { tenant_id: _plannedTenantId, ...subscriptionArgs } = subscription;
    statements.push({
      sql: `INSERT INTO subscriptions
        (company_id, code, property_id, tenant_id, date_souscription, montant_loyer, nombre_mois_caution,
         montant_caution, nombre_mois_avance, montant_avance, nombre_mois_garantie, montant_garantie,
         autre_frais, montant_autre_frais, date_entree, date_debut_paiement, date_fin, statut)
        VALUES (@company_id,@code,@property_id,last_insert_rowid(),@date_souscription,@montant_loyer,@nombre_mois_caution,
         @montant_caution,@nombre_mois_avance,@montant_avance,@nombre_mois_garantie,@montant_garantie,
         @autre_frais,@montant_autre_frais,@date_entree,@date_debut_paiement,@date_fin,@statut)`,
      args: { company_id: cid, code: subscriptionCode, ...subscriptionArgs },
    });
  }
  const results = await db.batch(statements);
  const tenantId = Number(results[0].lastInsertRowid);
  await logAction(req, 'Création', 'Locataire', p.nom_prenoms);
  if (subscription) await logAction(req, 'Création', 'Souscription', `${subscriptionCode} — ${p.nom_prenoms}`);
  res.json(await db.prepare('SELECT * FROM tenants WHERE id = ? AND company_id = ?').get(tenantId, cid));
}));

router.get('/tenants/:id/details', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const tenant = await db.prepare('SELECT * FROM tenants WHERE id = ? AND company_id = ?').get(id, cid);
  if (!tenant) return res.status(404).json({ error: 'Locataire introuvable.' });
  const subscriptions = await db.prepare(`${SUB_SELECT} WHERE s.tenant_id = ? AND s.company_id = ? ORDER BY s.statut, s.id DESC`).all(id, cid);
  const payments = await db.prepare(
    `SELECT r.*, p.code AS property_code, p.designation, p.type_construction
     FROM payments r
     LEFT JOIN properties p ON p.id = r.property_id AND p.company_id = r.company_id
     WHERE r.tenant_id = ? AND r.company_id = ?
     ORDER BY r.annee_concernee DESC, r.id DESC`
  ).all(id, cid);
  const totals = {
    loyers_payes: payments.reduce((a, x) => a + (x.montant_paye || 0), 0),
    reste_a_payer: payments.reduce((a, x) => a + (x.reste_a_payer || 0), 0),
    cautions: subscriptions.reduce((a, s) => a + (s.montant_caution || 0), 0),
    avances: subscriptions.reduce((a, s) => a + (s.montant_avance || 0), 0),
    garanties: subscriptions.reduce((a, s) => a + (s.montant_garantie || 0), 0),
    autres_frais: subscriptions.reduce((a, s) => a + (s.montant_autre_frais || 0), 0),
  };
  res.json({ tenant, subscriptions, payments, totals });
}));

router.put('/tenants/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const p = personPayload(req.body);
  const err = await validatePerson(p, 'tenants', cid, id, 'locataire');
  if (err) return res.status(400).json({ error: err });
  await db.prepare(
    'UPDATE tenants SET nom_prenoms=?, contact=?, email=?, adresse=?, caution=?, autre_frais=?, montant_autre_frais=? WHERE id=? AND company_id=?'
  ).run(p.nom_prenoms, p.contact, p.email, p.adresse, toInt(req.body.caution), clean(req.body.autre_frais), toInt(req.body.montant_autre_frais), id, cid);
  await logAction(req, 'Modification', 'Locataire', p.nom_prenoms);
  res.json(await db.prepare('SELECT * FROM tenants WHERE id = ? AND company_id = ?').get(id, cid));
}));

router.delete('/tenants/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const row = await db.prepare('SELECT nom_prenoms FROM tenants WHERE id = ? AND company_id = ?').get(id, cid);
  if (!row) return res.status(404).json({ error: 'Locataire introuvable.' });

  // Les deux suppressions et le contrôle d'historique sont exécutés dans une
  // transaction unique. Une création de paiement concurrente ne peut donc pas
  // produire un enregistrement orphelin entre le contrôle et la suppression.
  await db.batch([
    {
      sql: `DELETE FROM subscriptions
            WHERE tenant_id = ? AND company_id = ?
              AND NOT EXISTS (SELECT 1 FROM payments WHERE tenant_id = ? AND company_id = ?)`,
      args: [id, cid, id, cid],
    },
    {
      sql: `DELETE FROM tenants
            WHERE id = ? AND company_id = ?
              AND NOT EXISTS (SELECT 1 FROM payments WHERE tenant_id = ? AND company_id = ?)`,
      args: [id, cid, id, cid],
    },
  ]);
  const remaining = await db.prepare('SELECT 1 FROM tenants WHERE id = ? AND company_id = ?').get(id, cid);
  if (remaining) {
    return res.status(400).json({
      error: 'Ce locataire possède déjà des paiements. Modifiez sa fiche ou clôturez son bail afin de conserver l’historique comptable.',
    });
  }
  await logAction(req, 'Suppression', 'Locataire', row.nom_prenoms);
  res.json({ ok: true });
}));

// ===========================================================================
// MAISONS / BIENS
// ===========================================================================
const PROPERTY_SELECT = `
  SELECT p.*, o.nom_prenoms AS owner_nom, o.contact AS owner_contact,
         o.email AS owner_email, o.adresse AS owner_adresse,
         CASE WHEN EXISTS (
           SELECT 1 FROM subscriptions s
           WHERE s.property_id = p.id AND s.company_id = p.company_id AND s.statut = 'Active'
         ) THEN 'Occupé' ELSE 'Disponible' END AS statut
  FROM properties p
  LEFT JOIN owners o ON o.id = p.owner_id AND o.company_id = p.company_id
`;

router.get('/properties', wrap(async (req, res) => {
  const q = clean(req.query.q);
  const statut = clean(req.query.statut);
  let rows = await db.prepare(`${PROPERTY_SELECT} WHERE p.company_id = ? ORDER BY p.id DESC`).all(req.companyId);
  if (q) {
    const s = q.toLowerCase();
    rows = rows.filter((r) =>
      [r.code, r.owner_nom, r.type_construction, r.ville, r.commune, r.quartier]
        .some((v) => (v || '').toLowerCase().includes(s)));
  }
  if (statut) rows = rows.filter((r) => r.statut === statut);
  res.json(rows);
}));

// Maisons sélectionnables pour une souscription.
// Une maison peut maintenant accueillir plusieurs locataires actifs ; elle reste
// donc disponible même si un premier bail existe déjà.
router.get('/properties/available', wrap(async (req, res) => {
  res.json(await db.prepare(`${PROPERTY_SELECT} WHERE p.company_id = ? ORDER BY p.id DESC`).all(req.companyId));
}));

function propertyPayload(body) {
  return {
    owner_id: toInt(body.owner_id) || null,
    type_construction: clean(body.type_construction),
    nombre_piece: toInt(body.nombre_piece),
    designation: clean(body.designation),
    cout_loyer: toInt(body.cout_loyer),
    ville: clean(body.ville),
    commune: clean(body.commune),
    quartier: clean(body.quartier),
    observation: clean(body.observation),
    part_commission: toNum(body.part_commission),
    nombre_porte: toInt(body.nombre_porte),
  };
}

async function validateProperty(p, companyId) {
  if (!p.owner_id) return 'Veuillez sélectionner le propriétaire.';
  // Le proprietaire doit appartenir a la meme entreprise.
  const own = await db.prepare('SELECT 1 FROM owners WHERE id = ? AND company_id = ?').get(p.owner_id, companyId);
  if (!own) return 'Propriétaire introuvable.';
  if (!p.type_construction) return 'Veuillez sélectionner le type de bien.';
  if (!p.designation) return 'Veuillez saisir la désignation du bien.';
  if (p.part_commission > 100) return 'La part de commission doit être inférieure ou égale à 100.';
  return null;
}

router.post('/properties', wrap(async (req, res) => {
  const cid = req.companyId;
  const p = propertyPayload(req.body);
  const err = await validateProperty(p, cid);
  if (err) return res.status(400).json({ error: err });
  const code = await genPropertyCode(p.type_construction, req.body.date);
  const info = await db.prepare(
    `INSERT INTO properties
     (company_id, code, owner_id, type_construction, nombre_piece, designation, cout_loyer, ville, commune, quartier, observation, part_commission, nombre_porte)
     VALUES (@company_id,@code,@owner_id,@type_construction,@nombre_piece,@designation,@cout_loyer,@ville,@commune,@quartier,@observation,@part_commission,@nombre_porte)`
  ).run({ company_id: cid, code, ...p });
  await logAction(req, 'Création', 'Bien', code);
  res.json(await db.prepare(`${PROPERTY_SELECT} WHERE p.id = ?`).get(info.lastInsertRowid));
}));

router.put('/properties/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const p = propertyPayload(req.body);
  const err = await validateProperty(p, cid);
  if (err) return res.status(400).json({ error: err });
  await db.prepare(
    `UPDATE properties SET
       owner_id=@owner_id, type_construction=@type_construction, nombre_piece=@nombre_piece,
       designation=@designation, cout_loyer=@cout_loyer, ville=@ville, commune=@commune, quartier=@quartier,
       observation=@observation, part_commission=@part_commission, nombre_porte=@nombre_porte
     WHERE id=@id AND company_id=@company_id`
  ).run({ id, company_id: cid, ...p });
  const updated = await db.prepare(`${PROPERTY_SELECT} WHERE p.id = ? AND p.company_id = ?`).get(id, cid);
  await logAction(req, 'Modification', 'Bien', updated && updated.code);
  res.json(updated);
}));

router.delete('/properties/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const row = await db.prepare('SELECT code FROM properties WHERE id = ? AND company_id = ?').get(id, cid);
  if (!row) return res.status(404).json({ error: 'Bien introuvable.' });

  // Le client veut pouvoir supprimer un bien même si un bail est encore actif.
  // On conserve les historiques, mais on détache proprement les lignes liées :
  // - les baux du bien sont désactivés et ne ressortent plus comme actifs ;
  // - les règlements/reversements restent consultables dans l'historique global ;
  // - les réparations du bien sont supprimées par la clé étrangère/cascade.
  const deletionDate = new Date().toISOString().slice(0, 10);
  await db.batch([
    {
      sql: "UPDATE subscriptions SET statut = 'Desactive', date_fin = COALESCE(NULLIF(date_fin, ''), ?) WHERE property_id = ? AND company_id = ?",
      args: [deletionDate, id, cid],
    },
    {
      sql: 'UPDATE payments SET property_id = NULL WHERE property_id = ? AND company_id = ?',
      args: [id, cid],
    },
    {
      sql: "UPDATE subscriptions SET property_id = NULL WHERE property_id = ? AND company_id = ?",
      args: [id, cid],
    },
    {
      sql: 'DELETE FROM properties WHERE id = ? AND company_id = ?',
      args: [id, cid],
    },
  ]);
  if (row) await logAction(req, 'Suppression', 'Bien', row.code);
  res.json({ ok: true });
}));

// ===========================================================================
// SOUSCRIPTIONS / BAUX
// ===========================================================================
const SUB_SELECT = `
  SELECT s.*, p.code AS property_code, p.type_construction, p.nombre_piece, p.designation,
         o.nom_prenoms AS owner_nom, o.contact AS owner_contact,
         t.nom_prenoms AS tenant_nom, t.contact AS tenant_contact,
         t.email AS tenant_email, t.adresse AS tenant_adresse
  FROM subscriptions s
  LEFT JOIN properties p ON p.id = s.property_id AND p.company_id = s.company_id
  LEFT JOIN owners o ON o.id = p.owner_id AND o.company_id = s.company_id
  LEFT JOIN tenants t ON t.id = s.tenant_id AND t.company_id = s.company_id
`;

router.get('/subscriptions', wrap(async (req, res) => {
  const q = clean(req.query.q);
  let rows = await db.prepare(`${SUB_SELECT} WHERE s.company_id = ? ORDER BY s.id DESC`).all(req.companyId);
  if (q) {
    const s = q.toLowerCase();
    rows = rows.filter((r) =>
      [r.code, r.property_code, r.tenant_nom, r.statut].some((v) => (v || '').toLowerCase().includes(s)));
  }
  res.json(rows);
}));

router.get('/subscriptions/active', wrap(async (req, res) => {
  res.json(await db.prepare(`${SUB_SELECT} WHERE s.company_id = ? AND s.statut='Active' ORDER BY t.nom_prenoms COLLATE NOCASE`).all(req.companyId));
}));

router.get('/subscriptions/:id', wrap(async (req, res) => {
  const row = await db.prepare(`${SUB_SELECT} WHERE s.id = ? AND s.company_id = ?`).get(toInt(req.params.id), req.companyId);
  if (!row) return res.status(404).json({ error: 'Souscription introuvable' });
  res.json(row);
}));

function subscriptionPayload(body) {
  const montant_loyer = toInt(body.montant_loyer);
  const nbCaution = toInt(body.nombre_mois_caution);
  const nbAvance = toInt(body.nombre_mois_avance);
  const nbGarantie = toInt(body.nombre_mois_garantie);
  return {
    property_id: toInt(body.property_id) || null,
    tenant_id: toInt(body.tenant_id) || null,
    date_souscription: clean(body.date_souscription),
    montant_loyer,
    nombre_mois_caution: nbCaution,
    montant_caution: body.montant_caution !== undefined ? toInt(body.montant_caution) : nbCaution * montant_loyer,
    nombre_mois_avance: nbAvance,
    montant_avance: body.montant_avance !== undefined ? toInt(body.montant_avance) : nbAvance * montant_loyer,
    nombre_mois_garantie: nbGarantie,
    montant_garantie: body.montant_garantie !== undefined ? toInt(body.montant_garantie) : nbGarantie * montant_loyer,
    autre_frais: clean(body.autre_frais),
    montant_autre_frais: toInt(body.montant_autre_frais),
    date_entree: clean(body.date_entree),
    date_debut_paiement: clean(body.date_debut_paiement),
    date_fin: clean(body.date_fin) || null,
    statut: clean(body.statut) || 'Active',
  };
}

function isValidYMD(value) {
  const text = clean(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function applySubscriptionEndDate(subscription, body, current = null) {
  if (subscription.statut === 'Active') {
    subscription.date_fin = null;
    return subscription;
  }
  const supplied = Object.prototype.hasOwnProperty.call(body || {}, 'date_fin') ? clean(body.date_fin) : '';
  subscription.date_fin = supplied || (current && current.date_fin) || new Date().toISOString().slice(0, 10);
  return subscription;
}

async function validateSubscription(s, companyId, excludeId = 0, { plannedTenant = false } = {}) {
  if (!s.property_id) return 'Veuillez sélectionner le bien (maison).';
  if (!plannedTenant && !s.tenant_id) return 'Veuillez sélectionner le locataire.';
  const prop = await db.prepare('SELECT 1 FROM properties WHERE id = ? AND company_id = ?').get(s.property_id, companyId);
  if (!prop) return 'Bien introuvable.';
  if (!plannedTenant) {
    const ten = await db.prepare('SELECT 1 FROM tenants WHERE id = ? AND company_id = ?').get(s.tenant_id, companyId);
    if (!ten) return 'Locataire introuvable.';
  }
  if (!s.montant_loyer) return 'Le montant du loyer est requis.';
  if (!['Active', 'Desactive'].includes(s.statut)) return 'Statut de bail invalide.';
  if (s.date_souscription && !isValidYMD(s.date_souscription)) return 'Date de souscription invalide.';
  if (!s.date_entree) return 'Veuillez saisir la date d’entrée.';
  if (!isValidYMD(s.date_entree)) return 'Date d’entrée invalide.';
  if (!s.date_debut_paiement) return 'Veuillez saisir la date de début de paiement.';
  if (!isValidYMD(s.date_debut_paiement)) return 'Date de début de paiement invalide.';
  if (s.date_debut_paiement < s.date_entree) return 'La date de début de paiement ne peut pas précéder la date d’entrée.';
  if (s.statut === 'Desactive') {
    if (!s.date_fin || !isValidYMD(s.date_fin)) return 'Date de fin invalide.';
    if (s.date_fin < s.date_entree || s.date_fin < s.date_debut_paiement) return 'La date de fin ne peut pas précéder le début du bail.';
  }
  if (s.statut === 'Active' && !plannedTenant) {
    const dup = await db.prepare(
      `SELECT 1 FROM subscriptions
       WHERE company_id = ? AND tenant_id = ? AND statut = 'Active' AND id <> ?`
    ).get(companyId, s.tenant_id, excludeId || 0);
    if (dup) return 'Ce locataire est déjà actif dans un bien. Désactivez d’abord son ancien bail avant de l’ajouter ailleurs.';
  }
  return null;
}

async function insertSubscription(companyId, payload, dateForCode) {
  const code = await genCode('subscriptions', 'S', payload.date_souscription || dateForCode);
  const info = await db.prepare(
    `INSERT INTO subscriptions
     (company_id, code, property_id, tenant_id, date_souscription, montant_loyer, nombre_mois_caution,
      montant_caution, nombre_mois_avance, montant_avance, nombre_mois_garantie, montant_garantie,
      autre_frais, montant_autre_frais, date_entree, date_debut_paiement, date_fin, statut)
     VALUES (@company_id,@code,@property_id,@tenant_id,@date_souscription,@montant_loyer,@nombre_mois_caution,
      @montant_caution,@nombre_mois_avance,@montant_avance,@nombre_mois_garantie,@montant_garantie,
      @autre_frais,@montant_autre_frais,@date_entree,@date_debut_paiement,@date_fin,@statut)`
  ).run({ company_id: companyId, code, ...payload });
  return db.prepare(`${SUB_SELECT} WHERE s.id = ? AND s.company_id = ?`).get(info.lastInsertRowid, companyId);
}

router.post('/subscriptions', wrap(async (req, res) => {
  const cid = req.companyId;
  const s = subscriptionPayload(req.body);
  applySubscriptionEndDate(s, req.body);
  const err = await validateSubscription(s, cid);
  if (err) return res.status(400).json({ error: err });
  const saved = await insertSubscription(cid, s, s.date_souscription);
  await logAction(req, 'Création', 'Souscription', saved && saved.code);
  res.json(saved);
}));

router.put('/subscriptions/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const current = await db.prepare('SELECT * FROM subscriptions WHERE id = ? AND company_id = ?').get(id, cid);
  if (!current) return res.status(404).json({ error: 'Souscription introuvable.' });
  const s = subscriptionPayload(req.body);
  applySubscriptionEndDate(s, req.body, current);
  const err = await validateSubscription(s, cid, id);
  if (err) return res.status(400).json({ error: err });
  await db.prepare(
    `UPDATE subscriptions SET
       property_id=@property_id, tenant_id=@tenant_id, date_souscription=@date_souscription,
       montant_loyer=@montant_loyer, nombre_mois_caution=@nombre_mois_caution, montant_caution=@montant_caution,
       nombre_mois_avance=@nombre_mois_avance, montant_avance=@montant_avance,
       nombre_mois_garantie=@nombre_mois_garantie, montant_garantie=@montant_garantie, autre_frais=@autre_frais,
       montant_autre_frais=@montant_autre_frais, date_entree=@date_entree,
       date_debut_paiement=@date_debut_paiement, date_fin=@date_fin, statut=@statut
     WHERE id=@id AND company_id=@company_id`
  ).run({ id, company_id: cid, ...s });
  const updated = await db.prepare(`${SUB_SELECT} WHERE s.id = ? AND s.company_id = ?`).get(id, cid);
  await logAction(req, 'Modification', 'Souscription', updated && updated.code);
  res.json(updated);
}));

router.put('/subscriptions/:id/tenant', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const current = await db.prepare(`${SUB_SELECT} WHERE s.id = ? AND s.company_id = ?`).get(id, cid);
  if (!current || !current.tenant_id) return res.status(404).json({ error: 'Locataire ou bail introuvable.' });

  const person = personPayload(req.body);
  // Les réponses de l'API masquent les coordonnées personnelles. Si le formulaire
  // renvoie une valeur masquée inchangée, préserver la valeur réelle en base ;
  // une nouvelle valeur complète saisie par l'utilisateur reste modifiable.
  if (person.contact.includes('*')) person.contact = clean(current.tenant_contact);
  if (person.email.includes('*')) person.email = clean(current.tenant_email);
  const personError = await validatePerson(person, 'tenants', cid, current.tenant_id, 'locataire');
  if (personError) return res.status(400).json({ error: personError });
  const subscription = subscriptionPayload({
    ...req.body,
    property_id: current.property_id,
    tenant_id: current.tenant_id,
  });
  applySubscriptionEndDate(subscription, req.body, current);
  const subscriptionError = await validateSubscription(subscription, cid, id);
  if (subscriptionError) return res.status(400).json({ error: subscriptionError });

  await db.batch([
    {
      sql: `UPDATE tenants SET nom_prenoms=@nom_prenoms, contact=@contact, email=@email, adresse=@adresse,
            caution=@caution, autre_frais=@autre_frais, montant_autre_frais=@montant_autre_frais
            WHERE id=@tenant_id AND company_id=@company_id`,
      args: {
        ...person,
        caution: toInt(req.body.caution),
        autre_frais: clean(req.body.autre_frais),
        montant_autre_frais: toInt(req.body.montant_autre_frais),
        tenant_id: current.tenant_id,
        company_id: cid,
      },
    },
    {
      sql: `UPDATE subscriptions SET
              property_id=@property_id, tenant_id=@tenant_id, date_souscription=@date_souscription,
              montant_loyer=@montant_loyer, nombre_mois_caution=@nombre_mois_caution, montant_caution=@montant_caution,
              nombre_mois_avance=@nombre_mois_avance, montant_avance=@montant_avance,
              nombre_mois_garantie=@nombre_mois_garantie, montant_garantie=@montant_garantie,
              autre_frais=@autre_frais, montant_autre_frais=@montant_autre_frais,
              date_entree=@date_entree, date_debut_paiement=@date_debut_paiement,
              date_fin=@date_fin, statut=@statut
            WHERE id=@id AND company_id=@company_id`,
      args: { id, company_id: cid, ...subscription },
    },
  ]);
  const updated = await db.prepare(`${SUB_SELECT} WHERE s.id = ? AND s.company_id = ?`).get(id, cid);
  await logAction(req, 'Modification', 'Locataire et bail', `${person.nom_prenoms} — ${updated.code}`);
  res.json(updated);
}));

router.delete('/subscriptions/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const row = await db.prepare('SELECT code FROM subscriptions WHERE id = ? AND company_id = ?').get(id, cid);
  if (!row) return res.status(404).json({ error: 'Souscription introuvable.' });

  // Un bail qui porte des encaissements ne peut pas etre supprime : les loyers
  // deja encaisses perdraient leur rattachement et disparaitraient de l'etat de
  // recouvrement tout en restant a reverser. La suppression definitive ne sert
  // qu'a effacer une erreur de saisie ; un vrai depart passe par /depart.
  // Le controle et la suppression sont dans la meme transaction : un
  // encaissement concurrent ne peut pas se glisser entre les deux.
  await db.batch([{
    sql: `DELETE FROM subscriptions
          WHERE id = ? AND company_id = ?
            AND NOT EXISTS (SELECT 1 FROM payments WHERE subscription_id = ? AND company_id = ?)`,
    args: [id, cid, id, cid],
  }]);
  const remaining = await db.prepare('SELECT 1 FROM subscriptions WHERE id = ? AND company_id = ?').get(id, cid);
  if (remaining) {
    return res.status(400).json({
      error: 'Ce bail possède des loyers encaissés : il ne peut pas être supprimé. '
        + 'Utilisez « Le locataire a quitté » pour le clôturer en conservant l’historique comptable.',
    });
  }
  await logAction(req, 'Suppression', 'Souscription', row.code);
  res.json({ ok: true });
}));

// Depart d'un locataire : le locataire a quitte le bien. On CLOT le bail
// (statut « Desactive ») sans rien supprimer : l'historique des paiements et des
// reversements reste consultable, et le logement redevient disponible s'il n'a
// plus aucun locataire actif.
router.post('/subscriptions/:id/depart', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const row = await db.prepare(`${SUB_SELECT} WHERE s.id = ? AND s.company_id = ?`).get(id, cid);
  if (!row) return res.status(404).json({ error: 'Souscription introuvable.' });
  const dateFin = clean(req.body && req.body.date_fin) || new Date().toISOString().slice(0, 10);
  if (!isValidYMD(dateFin)) return res.status(400).json({ error: 'Date de fin invalide.' });
  if (dateFin < row.date_entree || dateFin < row.date_debut_paiement) {
    return res.status(400).json({ error: 'La date de fin ne peut pas précéder le début du bail.' });
  }
  await db.prepare("UPDATE subscriptions SET statut = 'Desactive', date_fin = ? WHERE id = ? AND company_id = ?").run(dateFin, id, cid);
  await logAction(req, 'Modification', 'Souscription', `Départ du locataire — ${row.tenant_nom || ''} (${row.code})`);
  res.json({ ok: true });
}));

// Ajout en lot de plusieurs locataires dans une maison. Chaque ligne crée un
// bail actif avec son propre loyer mensuel, car deux locataires d'une même
// maison peuvent payer des montants différents.
router.post('/properties/:id/tenants', wrap(async (req, res) => {
  const cid = req.companyId;
  const propertyId = toInt(req.params.id);
  const prop = await db.prepare('SELECT * FROM properties WHERE id = ? AND company_id = ?').get(propertyId, cid);
  if (!prop) return res.status(404).json({ error: 'Bien introuvable.' });

  const lines = Array.isArray(req.body && req.body.tenants) ? req.body.tenants : [];
  if (!lines.length) return res.status(400).json({ error: 'Veuillez sélectionner au moins un locataire.' });

  const today = new Date().toISOString().slice(0, 10);
  const base = {
    property_id: propertyId,
    date_souscription: clean(req.body.date_souscription) || today,
    date_entree: clean(req.body.date_entree) || today,
    date_debut_paiement: clean(req.body.date_debut_paiement) || clean(req.body.date_entree) || today,
    nombre_mois_caution: toInt(req.body.nombre_mois_caution),
    nombre_mois_avance: toInt(req.body.nombre_mois_avance),
    nombre_mois_garantie: toInt(req.body.nombre_mois_garantie),
    autre_frais: clean(req.body.autre_frais),
    montant_autre_frais: toInt(req.body.montant_autre_frais),
    statut: 'Active',
  };

  const seen = new Set();
  const payloads = [];
  for (const line of lines) {
    const tenantId = toInt(line && line.tenant_id);
    if (!tenantId) return res.status(400).json({ error: 'Un locataire sélectionné est invalide.' });
    if (seen.has(tenantId)) return res.status(400).json({ error: 'Un même locataire ne peut pas être ajouté deux fois dans la même opération.' });
    seen.add(tenantId);
    const montantLoyer = toInt(line && line.montant_loyer);
    const payload = subscriptionPayload({
      ...base,
      tenant_id: tenantId,
      montant_loyer: montantLoyer,
      montant_caution: line && line.montant_caution !== undefined ? line.montant_caution : base.nombre_mois_caution * montantLoyer,
      montant_avance: line && line.montant_avance !== undefined ? line.montant_avance : base.nombre_mois_avance * montantLoyer,
      montant_garantie: line && line.montant_garantie !== undefined ? line.montant_garantie : base.nombre_mois_garantie * montantLoyer,
    });
    const err = await validateSubscription(payload, cid);
    if (err) {
      const tenant = await db.prepare('SELECT nom_prenoms FROM tenants WHERE id = ? AND company_id = ?').get(tenantId, cid);
      return res.status(400).json({ error: `${tenant ? tenant.nom_prenoms + ' : ' : ''}${err}` });
    }
    payloads.push(payload);
  }

  const saved = [];
  for (const payload of payloads) {
    const row = await insertSubscription(cid, payload, base.date_souscription);
    saved.push(row);
  }
  await logAction(req, 'Création', 'Souscriptions', `${prop.code} — ${saved.length} locataire(s)`);
  res.json({ ok: true, count: saved.length, subscriptions: saved });
}));

// ===========================================================================
// DETAIL D'UNE MAISON : « entrer » dans un bien pour suivre, locataire par
// locataire, les loyers payes, les impayes et les retards de paiement.
// ===========================================================================
router.get('/properties/:id/details', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  // Compteur mensuel : par defaut la fiche presente le mois en cours de
  // recouvrement, pas tout l'historique du bail. Les mois precedents ne sont
  // pas perdus — ils sont chiffres a part dans « arrieres » — et le filtre de
  // periode permet toujours de revenir sur un mois passe ou sur le cumul.
  const range = normalizeRange(req.query, { mode: 'current' });
  const property = await db.prepare(`${PROPERTY_SELECT} WHERE p.id = ? AND p.company_id = ?`).get(id, cid);
  if (!property) return res.status(404).json({ error: 'Bien introuvable.' });

  const [subs, allRepairs, paymentRows, payoutRows] = await Promise.all([
    db.prepare(`${SUB_SELECT} WHERE s.property_id = ? AND s.company_id = ? ORDER BY s.statut, s.id DESC`).all(id, cid),
    db.prepare('SELECT * FROM repairs WHERE property_id = ? AND company_id = ? ORDER BY annee DESC, id DESC').all(id, cid),
    db.prepare(
      `SELECT r.id, r.code, r.date, r.mois_concerne, r.annee_concernee,
              r.montant_a_payer, r.montant_paye, r.reste_a_payer, r.statut, r.numero_recu, r.mois_payes,
              r.payout_id, s.code AS subscription_code, t.nom_prenoms AS tenant_nom,
              t.contact AS tenant_contact
       FROM payments r
       LEFT JOIN subscriptions s ON s.id = r.subscription_id AND s.company_id = r.company_id
       LEFT JOIN tenants t ON t.id = r.tenant_id AND t.company_id = r.company_id
       WHERE r.property_id = ? AND r.company_id = ?
       ORDER BY r.annee_concernee DESC, r.id DESC`
    ).all(id, cid),
    db.prepare(
      `SELECT DISTINCT v.*
       FROM payouts v
       JOIN payments r ON r.payout_id = v.id
       WHERE r.property_id = ? AND r.company_id = ? AND v.company_id = ?
       ORDER BY v.id DESC`
    ).all(id, cid, cid),
  ]);

  const repairs = allRepairs.filter((r) => periodInRange({ mois: r.mois, annee: r.annee }, range));
  const allPayments = paymentRows.map((p) => {
    const selected = paymentAmountsInRange(p, range);
    return selected.matches ? {
      ...p,
      montant_a_payer: selected.montant_a_payer,
      montant_paye: selected.montant_paye,
      reste_a_payer: selected.reste_a_payer,
      statut: selected.statut,
      periodes_filtrees: selected.selectedPeriods,
    } : null;
  }).filter(Boolean);

  for (const s of subs) {
    const pays = await db.prepare(
      `SELECT id, code, date, mois_concerne, annee_concernee, mois_payes, montant_a_payer, montant_paye, reste_a_payer, statut
       FROM payments WHERE subscription_id = ? AND company_id = ? ORDER BY annee_concernee, id`
    ).all(s.id, cid);

    let total_paye = 0;
    const filteredPays = [];
    for (const p of pays) {
      const selected = paymentAmountsInRange(p, range);
      if (!selected.matches) continue;
      total_paye += selected.montant_paye;
      filteredPays.push({
        ...p,
        montant_a_payer: selected.montant_a_payer,
        montant_paye: selected.montant_paye,
        reste_a_payer: selected.reste_a_payer,
        statut: selected.statut,
        periodes_filtrees: selected.selectedPeriods,
      });
    }

    const loyer = s.montant_loyer || 0;
    // Montant encaisse POUR chaque mois de loyer, toutes periodes confondues.
    // Independant du filtre : c'est ce qui permet de chiffrer les arrieres des
    // mois anterieurs sans les faire entrer dans les totaux du mois affiche.
    const paidByAll = {};
    for (const p of pays) {
      for (const period of paymentAmountsInRange(p, { mode: 'all' }).periodAmounts) {
        const k = `${period.annee}-${period.mois}`;
        paidByAll[k] = (paidByAll[k] || 0) + period.montant_paye;
      }
    }

    // Les baux actifs affichent aussi le mois courant (« À échoir ») : le
    // locataire le consomme encore, son loyer ne sera exigible que le mois
    // suivant. Les baux clôturés conservent leur échéancier historique jusqu'au
    // dernier mois dû.
    let echeancier = [];
    const arrieres_echeancier = [];
    let arrieres = 0;
    let arrieres_mois = 0;
    if (s.date_debut_paiement) {
      const now = new Date();
      const end = subscriptionEndPeriod(s, pays, { includeCurrent: true, ref: now });
      const calendrier = end ? monthsUntil(s.date_debut_paiement, end.annee, end.mois) : [];
      const ligne = (mm) => {
        const echu = isPeriodDue(mm, now);
        const paye = paidByAll[`${mm.annee}-${mm.mois}`] || 0;
        const diff = loyer - paye;
        const resteReel = diff > PAYMENT_TOLERANCE ? diff : 0;
        const reste = echu ? resteReel : 0;
        let statut;
        if (loyer > 0 && resteReel === 0) statut = 'Payé';
        else if (!echu) statut = paye > 0 ? 'Partiel' : 'À échoir';
        else statut = paye > 0 ? 'Partiel' : 'Impayé';
        return { annee: mm.annee, mois: mm.mois, attendu: loyer, paye, reste, echu, statut };
      };
      echeancier = calendrier.filter((mm) => periodInRange(mm, range)).map(ligne);
      // Retards des mois situes AVANT la periode affichee. Ils sont renvoyes
      // dans une LISTE SEPAREE, pas dans l'echeancier : l'agence doit pouvoir
      // les voir et les encaisser meme quand l'ecran est cale sur le mois en
      // cours, mais leurs montants ne doivent jamais entrer dans les compteurs
      // du mois (c'est tout l'objet du compteur remis a zero).
      for (const mm of calendrier) {
        if (periodInRange(mm, range)) continue;
        if (range.from && periodIndex(mm) >= range.from.index) continue;
        const l = ligne(mm);
        if (l.echu && l.reste > 0) {
          arrieres += l.reste;
          arrieres_mois += 1;
          arrieres_echeancier.push(l);
        }
      }
    }
    const total_attendu = echeancier.reduce((a, m) => a + (m.echu ? m.attendu : 0), 0);
    const reste = echeancier.reduce((a, m) => a + m.reste, 0);
    const mois_retard = echeancier.filter((m) => m.echu && m.reste > 0).length;

    s.paiements = filteredPays;
    s.echeancier = echeancier;
    // Les mois de retard restent encaissables depuis la fiche, dans leur propre
    // tableau, avec le mois d'arriere reellement concerne (jamais le mois en
    // cours de recouvrement).
    s.arrieres_echeancier = arrieres_echeancier;
    s.resume = { nb_paiements: filteredPays.length, total_attendu, total_paye, reste, mois_retard, arrieres, arrieres_mois };
  }

  const payoutLineRows = await db.prepare(
    `SELECT r.payout_id, r.id, r.code, r.date, r.mois_concerne, r.annee_concernee, r.mois_payes, r.montant_paye,
            r.montant_a_payer, r.reste_a_payer, p.part_commission, t.nom_prenoms AS tenant_nom
     FROM payments r
     LEFT JOIN properties p ON p.id = r.property_id AND p.company_id = r.company_id
     LEFT JOIN tenants t ON t.id = r.tenant_id AND t.company_id = r.company_id
     WHERE r.property_id = ? AND r.company_id = ? AND r.payout_id IS NOT NULL
     ORDER BY r.annee_concernee, r.id`
  ).all(id, cid);
  const linesByPayout = payoutLineRows.reduce((acc, l) => {
    const selected = paymentAmountsInRange(l, range);
    if (!selected.matches) return acc;
    l.montant_paye = selected.montant_paye;
    l.periodes_filtrees = selected.selectedPeriods;
    l.commission = Math.round((l.montant_paye * (l.part_commission || 0)) / 100);
    l.net = l.montant_paye - l.commission;
    (acc[l.payout_id] ||= []).push(l);
    return acc;
  }, {});
  const payouts = payoutRows.map((v) => ({ ...v, lignes_bien: linesByPayout[v.id] || [] }))
    .filter((v) => v.lignes_bien.length > 0);

  const totals = {
    total_paye: allPayments.reduce((a, p) => a + (p.montant_paye || 0), 0),
    total_reste: allPayments.reduce((a, p) => a + (p.reste_a_payer || 0), 0),
    total_reparations: repairs.reduce((a, r) => a + (r.montant || 0), 0),
    total_reversements_net: payouts.reduce((a, v) => a + (v.lignes_bien || []).reduce((b, l) => b + (l.net || 0), 0), 0),
    total_arrieres: subs.reduce((a, s) => a + ((s.resume && s.resume.arrieres) || 0), 0),
    nombre_locataires: subs.length,
    nombre_locataires_actifs: subs.filter((s) => s.statut === 'Active').length,
  };

  res.json({
    property, subscriptions: subs, repairs, payments: allPayments, payouts, totals,
    periode: { from: range.fromValue, to: range.toValue, label: rangeLabel(range), monthCount: range.monthCount },
  });
}));

// ===========================================================================
// REPARATIONS (travaux deduits du solde reverse au proprietaire)
// ===========================================================================
router.get('/repairs', wrap(async (req, res) => {
  const cid = req.companyId;
  const propertyId = toInt(req.query.property_id);
  const rows = propertyId
    ? await db.prepare('SELECT * FROM repairs WHERE company_id = ? AND property_id = ? ORDER BY id DESC').all(cid, propertyId)
    : await db.prepare('SELECT * FROM repairs WHERE company_id = ? ORDER BY id DESC').all(cid);
  res.json(rows);
}));

router.post('/repairs', wrap(async (req, res) => {
  const cid = req.companyId;
  const propertyId = toInt(req.body.property_id);
  const prop = await db.prepare('SELECT code FROM properties WHERE id = ? AND company_id = ?').get(propertyId, cid);
  if (!prop) return res.status(400).json({ error: 'Veuillez sélectionner un bien valide.' });
  const montant = toInt(req.body.montant);
  if (montant <= 0) return res.status(400).json({ error: 'Veuillez saisir le montant de la réparation.' });
  const info = await db.prepare(
    'INSERT INTO repairs (company_id, property_id, mois, annee, montant, description) VALUES (?,?,?,?,?,?)'
  ).run(cid, propertyId, clean(req.body.mois) || null, toInt(req.body.annee) || null, montant, clean(req.body.description) || null);
  await logAction(req, 'Création', 'Réparation', `${prop.code} — ${montant}`);
  res.json(await db.prepare('SELECT * FROM repairs WHERE id = ?').get(info.lastInsertRowid));
}));

router.delete('/repairs/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  await db.prepare('DELETE FROM repairs WHERE id = ? AND company_id = ?').run(id, cid);
  await logAction(req, 'Suppression', 'Réparation', '#' + id);
  res.json({ ok: true });
}));

// ===========================================================================
// RECOUVREMENT : rapport MENSUEL par ZONE (quartier) -> MAISON -> LOCATAIRE.
//
// COMPTEUR REMIS A ZERO CHAQUE MOIS. C'est la regle fondamentale de cet etat :
// le rapport de septembre ne doit contenir QUE ce qui concerne le mois de
// septembre. Les loyers encaisses les mois precedents ne doivent jamais
// s'ajouter au total du mois affiche, sinon l'agence est incapable de savoir
// combien elle a reellement recolte dans le mois.
//
// Pour le mois affiche uniquement :
//   - montant du   = loyer du mois (0 si le bail ne couvre pas ce mois)
//   - montant paye = somme encaissee POUR ce mois (quelle que soit la date
//                    d'encaissement : un loyer d'aout paye en octobre reste un
//                    loyer d'aout)
//   - ecart        = du - paye du mois (impaye du mois)
//   - commission partielle = taux du bien x paye du mois
//   - commission generale  = taux du bien x du du mois
//   - solde (a reverser)   = paye du mois - reparations du mois - commission generale
//
// Les retards des mois anterieurs ne sont pas perdus pour autant : ils sont
// calcules a part, dans la colonne « arrieres », et ne polluent aucun total du
// mois.
// ===========================================================================
router.get('/recouvrement', wrap(async (req, res) => {
  const cid = req.companyId;
  // Par defaut, on presente le dernier mois EXIGIBLE (mois precedent), puisque
  // les loyers se paient a terme echu.
  const due = lastDuePeriod();
  const moisDemande = clean(req.query.mois) || due.mois;
  const anneeDemandee = toInt(req.query.annee) || due.annee;
  if (MOIS.indexOf(moisDemande) < 0) return res.status(400).json({ error: 'Mois invalide.' });

  // Un etat de recouvrement arrete sur un mois encore en cours reclamerait un
  // loyer que le locataire n'a pas fini de consommer : on ramene toujours la
  // periode au dernier mois exigible et on le signale a l'ecran.
  const periode = clampToDuePeriod({ mois: moisDemande, annee: anneeDemandee });
  const periodeAjustee = periodIndexOf({ mois: moisDemande, annee: anneeDemandee }) !== periode.index;
  const moisSel = periode.mois;
  const anneeSel = periode.annee;
  const emIndex = periode.monthNumber;

  const [subs, pays, reps] = await Promise.all([
    db.prepare(
      `SELECT s.id, s.montant_loyer, s.date_debut_paiement, s.date_fin, s.statut, s.montant_avance,
              p.id AS property_id, p.code AS property_code, p.designation, p.type_construction,
              p.ville, p.commune, p.quartier, p.part_commission,
              o.id AS owner_id, o.nom_prenoms AS owner_nom, o.contact AS owner_contact,
              t.nom_prenoms AS tenant_nom
       FROM subscriptions s
       JOIN properties p ON p.id = s.property_id AND p.company_id = s.company_id
       LEFT JOIN owners o ON o.id = p.owner_id AND o.company_id = s.company_id
       LEFT JOIN tenants t ON t.id = s.tenant_id AND t.company_id = s.company_id
       WHERE s.company_id = ?`
    ).all(cid),
    db.prepare('SELECT subscription_id, mois_concerne, annee_concernee, mois_payes, nombre_mois_payes, montant_paye, numero_recu FROM payments WHERE company_id = ?').all(cid),
    db.prepare('SELECT property_id, montant FROM repairs WHERE company_id = ? AND mois = ? AND annee = ?').all(cid, moisSel, anneeSel),
  ]);

  const reportIndex = anneeSel * 12 + emIndex;
  // La carte des encaissements couvre TOUT le bail (aucun filtrage de periode) :
  // chaque paiement reste impute au mois de loyer qu'il regle. C'est ce qui
  // permet ensuite d'extraire le mois affiche seul, les arrieres anterieurs, et
  // les avances, sans jamais melanger les trois.
  const payBySub = buildPaidMonthMap(pays);
  const repByProp = new Map();
  for (const r of reps) repByProp.set(r.property_id, (repByProp.get(r.property_id) || 0) + (r.montant || 0));

  const monthIndexOf = (period) => period.annee * 12 + MOIS.indexOf(period.mois) + 1;

  const maisons = new Map();
  for (const s of subs) {
    const loyer = s.montant_loyer || 0;
    let end = { annee: anneeSel, mois: emIndex };
    if (s.statut !== 'Active') {
      const historicalEnd = lastDueAtDeparture(s.date_fin)
        || latestPaymentPeriod(pays.filter((payment) => payment.subscription_id === s.id));
      if (!historicalEnd) continue;
      if (historicalEnd.annee * 12 + historicalEnd.mois < reportIndex) end = historicalEnd;
    }
    const pe = payBySub.get(s.id) || { paid: new Map(), total: 0, lastRecu: null };

    // Echeancier complet du bail jusqu'au mois affiche : sert de reference pour
    // distinguer un mois du d'une avance, et pour chiffrer les arrieres.
    const scheduleMonths = monthsUntil(s.date_debut_paiement, end.annee, end.mois);
    // LE MOIS AFFICHE, ET LUI SEUL.
    const moisDuRapport = scheduleMonths.filter((m) => monthIndexOf(m) === reportIndex);
    // Les mois anterieurs, chiffres a part (colonne « arrieres »).
    const moisAnterieurs = scheduleMonths.filter((m) => monthIndexOf(m) < reportIndex);

    const summary = summarizeRecoveryMonths(moisDuRapport, pe, loyer, { scheduleMonths });
    const arrieres = summarizeRecoveryMonths(moisAnterieurs, pe, loyer, { scheduleMonths });
    const montantDu = summary.montant_du;
    const montantPaye = summary.montant_paye;

    // Un bail actif reste toujours affiche, meme sans rien a encaisser ce
    // mois-ci : le faire disparaitre laisserait croire a un oubli de saisie.
    // Un bail clos, lui, ne figure au rapport que s'il a encore quelque chose a
    // y dire (mois du, encaissement du mois, ou arriere).
    const concerneLeRapport = moisDuRapport.length > 0 || montantPaye > 0 || arrieres.ecart > 0;
    if (s.statut !== 'Active' && !concerneLeRapport) continue;

    const recuDuMois = moisDuRapport.reduce((found, m) => {
      const entry = pe.paid.get(`${m.annee}-${m.mois}`);
      return (entry && entry.numero_recu) || found;
    }, null);

    let M = maisons.get(s.property_id);
    if (!M) {
      M = {
        property_id: s.property_id, code: s.property_code, designation: s.designation, type: s.type_construction,
        zone: s.quartier || s.commune || s.ville || 'Sans zone',
        owner_id: s.owner_id, owner_nom: s.owner_nom, owner_contact: s.owner_contact,
        part_commission: s.part_commission || 0, locataires: [], total_du: 0, total_paye: 0, total_arrieres: 0,
      };
      maisons.set(s.property_id, M);
    }
    let statutMois;
    if (!moisDuRapport.length) statutMois = 'Hors bail';
    else if (summary.ecart <= 0) statutMois = 'Payé';
    else if (montantPaye > 0) statutMois = 'Partiel';
    else statutMois = 'Impayé';

    M.locataires.push({
      tenant_nom: s.tenant_nom, designation: s.designation, loyer,
      statut_mois: statutMois,
      mois_payes: summary.mois_payes, mois_payes_liste: summary.mois_payes_liste,
      mois_dus: summary.mois_dus, mois_dus_liste: summary.mois_dus_liste,
      mois_credit: summary.mois_credit, mois_credit_liste: summary.mois_credit_liste,
      montant_du: montantDu, montant_paye: montantPaye, ecart: summary.ecart,
      // Retards des mois PRECEDENTS : montre a part, jamais additionne au mois.
      arrieres: arrieres.ecart,
      arrieres_mois: arrieres.mois_dus,
      arrieres_liste: arrieres.mois_dus_liste,
      avance: s.montant_avance || 0, numero_recu: recuDuMois,
    });
    M.total_du += montantDu;
    M.total_paye += montantPaye;
    M.total_arrieres += arrieres.ecart;
  }

  const FIELDS = ['total_du', 'total_paye', 'ecart', 'total_arrieres', 'reparations', 'commission_partielle', 'commission_generale', 'solde'];
  const zones = new Map();
  const recap = Object.fromEntries(FIELDS.map((k) => [k, 0]));
  for (const M of maisons.values()) {
    const taux = M.part_commission || 0;
    M.reparations = repByProp.get(M.property_id) || 0;
    // Ecart du MOIS : somme des manques locataire par locataire, pour qu'un
    // trop-percu chez l'un ne vienne pas effacer l'impaye d'un autre.
    M.ecart = M.locataires.reduce((total, l) => total + l.ecart, 0);
    M.commission_partielle = Math.round(M.total_paye * taux / 100);
    M.commission_generale = Math.round(M.total_du * taux / 100);
    M.solde = M.total_paye - M.reparations - M.commission_generale;
    let Z = zones.get(M.zone);
    if (!Z) { Z = { zone: M.zone, maisons: [], ...Object.fromEntries(FIELDS.map((k) => [k, 0])) }; zones.set(M.zone, Z); }
    Z.maisons.push(M);
    for (const k of FIELDS) { Z[k] += M[k]; recap[k] += M[k]; }
  }
  const zonesArr = [...zones.values()].sort((a, b) => a.zone.localeCompare(b.zone));
  zonesArr.forEach((z) => z.maisons.sort((a, b) => (a.code || '').localeCompare(b.code || '')));

  res.json({
    mois: moisSel,
    annee: anneeSel,
    mois_demande: moisDemande,
    annee_demandee: anneeDemandee,
    periode_ajustee: periodeAjustee,
    mois_exigible: due.mois,
    annee_exigible: due.annee,
    // Rappel explicite au client : les totaux ci-dessous portent sur CE MOIS
    // uniquement. Un ancien front (page gardee ouverte, cache navigateur) ne
    // peut donc pas presenter ces chiffres comme un cumul.
    portee: 'mois',
    zones: zonesArr,
    recap,
  });
}));

// ===========================================================================
// REGLEMENTS / PAIEMENTS
// ===========================================================================
const PAY_SELECT = `
  SELECT r.*, p.code AS property_code, p.type_construction, p.nombre_piece, p.designation, p.cout_loyer,
         t.nom_prenoms AS tenant_nom, t.contact AS tenant_contact,
         s.code AS subscription_code, s.montant_loyer AS subscription_loyer
  FROM payments r
  LEFT JOIN properties p ON p.id = r.property_id AND p.company_id = r.company_id
  LEFT JOIN tenants t ON t.id = r.tenant_id AND t.company_id = r.company_id
  LEFT JOIN subscriptions s ON s.id = r.subscription_id AND s.company_id = r.company_id
`;

router.get('/payments', wrap(async (req, res) => {
  const q = clean(req.query.q);
  const mois = clean(req.query.mois);
  const annee = clean(req.query.annee);
  const statut = clean(req.query.statut);
  let rows = await db.prepare(`${PAY_SELECT} WHERE r.company_id = ? ORDER BY r.id DESC`).all(req.companyId);
  if (req.query.from || req.query.to || req.query.mode) {
    const range = normalizeRange(req.query, { mode: 'current' });
    rows = rows.map((r) => {
      const selected = paymentAmountsInRange(r, range);
      return selected.matches ? {
        ...r,
        montant_a_payer: selected.montant_a_payer,
        montant_paye: selected.montant_paye,
        reste_a_payer: selected.reste_a_payer,
        statut: selected.statut,
        periodes_filtrees: selected.selectedPeriods,
      } : null;
    }).filter(Boolean);
  }
  if (mois) rows = rows.filter((r) => r.mois_concerne === mois);
  if (annee) rows = rows.filter((r) => String(r.annee_concernee) === annee);
  if (statut) rows = rows.filter((r) => r.statut === statut);
  if (q) {
    const s = q.toLowerCase();
    rows = rows.filter((r) =>
      [r.code, r.property_code, r.tenant_nom, r.mois_concerne].some((v) => (v || '').toLowerCase().includes(s)));
  }
  res.json(rows);
}));

router.get('/payments/:id', wrap(async (req, res) => {
  const row = await db.prepare(`${PAY_SELECT} WHERE r.id = ? AND r.company_id = ?`).get(toInt(req.params.id), req.companyId);
  if (!row) return res.status(404).json({ error: 'Règlement introuvable' });
  res.json(row);
}));

async function paymentPayload(body, companyId) {
  let subscription_id = toInt(body.subscription_id) || null;
  let property_id = toInt(body.property_id) || null;
  let tenant_id = toInt(body.tenant_id) || null;
  let montant_a_payer = toInt(body.montant_a_payer);
  let montant_loyer_unitaire = 0;

  // On complete automatiquement le bien, le locataire et le loyer du a partir
  // de la souscription choisie (en restant dans la meme entreprise).
  if (subscription_id) {
    const sub = await db.prepare('SELECT * FROM subscriptions WHERE id = ? AND company_id = ?').get(subscription_id, companyId);
    if (sub) {
      montant_loyer_unitaire = toInt(sub.montant_loyer);
      // Une souscription valide est la source d'autorité : le client ne peut pas
      // substituer un bien ou un locataire d'une autre entreprise.
      property_id = sub.property_id;
      tenant_id = sub.tenant_id;
      if (!montant_a_payer) montant_a_payer = sub.montant_loyer;
    } else {
      subscription_id = null;
    }
  }

  if (property_id) {
    const property = await db.prepare('SELECT 1 FROM properties WHERE id = ? AND company_id = ?').get(property_id, companyId);
    if (!property) property_id = null;
  }
  if (tenant_id) {
    const tenant = await db.prepare('SELECT 1 FROM tenants WHERE id = ? AND company_id = ?').get(tenant_id, companyId);
    if (!tenant) tenant_id = null;
  }

  const montant_paye = toInt(body.montant_paye);
  const paymentDate = clean(body.date) || new Date().toISOString().slice(0, 10);
  const defaultPeriod = previousRentPeriod(paymentDate);
  const normalized = normalizePaidMonths({
    ...body,
    mois_concerne: clean(body.mois_concerne) || defaultPeriod.mois,
    annee_concernee: toInt(body.annee_concernee) || defaultPeriod.annee,
    montant_a_payer,
    montant_paye,
    loyer: montant_loyer_unitaire || undefined,
  });
  const duePeriods = parsePeriods(body.mois_dus, null, body.annee_concernee);
  const reste = normalized.reste;
  return {
    subscription_id,
    property_id,
    tenant_id,
    date: paymentDate,
    montant_a_payer: normalized.amountDue,
    montant_paye,
    reste_a_payer: reste,
    mois_concerne: normalized.primary.mois,
    annee_concernee: normalized.primary.annee,
    nombre_mois_payes: normalized.count,
    mois_payes: JSON.stringify(normalized.months),
    nombre_mois_dus: duePeriods.length || toInt(body.nombre_mois_dus),
    mois_dus: duePeriods.length ? JSON.stringify(duePeriods) : clean(body.mois_dus),
    statut: normalized.status,
    numero_recu: clean(body.numero_recu),
  };
}

function validatePayment(r) {
  if (!r.property_id) return 'Veuillez sélectionner la souscription / le bien concerné.';
  if (!r.tenant_id) return 'Le locataire est requis.';
  if (!r.mois_concerne) return 'Veuillez sélectionner au moins un mois payé.';
  if (!r.annee_concernee) return 'Veuillez saisir l’année concernée.';
  if (!r.montant_paye) return 'Veuillez saisir le montant payé.';
  // Un locataire peut payer d'avance, mais une periode situee des annees plus
  // loin traduit toujours une faute de frappe sur l'annee. Non detectee, elle
  // cree un credit fantome qui fausse le recouvrement pendant des annees.
  const periods = parsePeriods(r.mois_payes, r.mois_concerne, r.annee_concernee);
  const tooFar = periods.find((period) => isPeriodTooFarAhead(period));
  if (tooFar) {
    const due = lastDuePeriod();
    return `Période de loyer improbable : ${tooFar.mois} ${tooFar.annee}. `
      + `Les loyers se recouvrent à terme échu (dernier mois exigible : ${due.mois} ${due.annee}) `
      + `et l’avance acceptée est limitée à ${MAX_ADVANCE_MONTHS} mois. Vérifiez l’année saisie.`;
  }
  return null;
}

router.post('/payments', wrap(async (req, res) => {
  const cid = req.companyId;
  const r = await paymentPayload(req.body, cid);
  const err = validatePayment(r);
  if (err) return res.status(400).json({ error: err });
  const code = await genCode('payments', 'R', r.date);
  const info = await db.prepare(
    `INSERT INTO payments
     (company_id, code, subscription_id, property_id, tenant_id, date, montant_a_payer, montant_paye,
      reste_a_payer, mois_concerne, annee_concernee, nombre_mois_payes, mois_payes, nombre_mois_dus, mois_dus, statut, numero_recu)
     VALUES (@company_id,@code,@subscription_id,@property_id,@tenant_id,@date,@montant_a_payer,@montant_paye,
      @reste_a_payer,@mois_concerne,@annee_concernee,@nombre_mois_payes,@mois_payes,@nombre_mois_dus,@mois_dus,@statut,@numero_recu)`
  ).run({ company_id: cid, code, ...r });
  await logAction(req, 'Création', 'Règlement', `${code} (${r.mois_concerne || ''} ${r.annee_concernee || ''})`.trim());
  res.json(await db.prepare(`${PAY_SELECT} WHERE r.id = ?`).get(info.lastInsertRowid));
}));

router.put('/payments/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const existing = await db.prepare('SELECT payout_id FROM payments WHERE id = ? AND company_id = ?').get(id, cid);
  if (!existing) return res.status(404).json({ error: 'Règlement introuvable.' });
  // Modifier un loyer deja reverse fausserait le releve remis au proprietaire
  // (montants et periodes figes dans le reversement).
  if (existing.payout_id) {
    return res.status(400).json({
      error: 'Ce loyer a déjà été reversé au propriétaire. Annulez d’abord le reversement pour pouvoir le corriger.',
    });
  }
  const r = await paymentPayload(req.body, cid);
  const err = validatePayment(r);
  if (err) return res.status(400).json({ error: err });
  await db.prepare(
    `UPDATE payments SET
       subscription_id=@subscription_id, property_id=@property_id, tenant_id=@tenant_id, date=@date,
       montant_a_payer=@montant_a_payer, montant_paye=@montant_paye, reste_a_payer=@reste_a_payer,
       mois_concerne=@mois_concerne, annee_concernee=@annee_concernee,
       nombre_mois_payes=@nombre_mois_payes, mois_payes=@mois_payes, nombre_mois_dus=@nombre_mois_dus, mois_dus=@mois_dus,
       statut=@statut, numero_recu=@numero_recu
     WHERE id=@id AND company_id=@company_id`
  ).run({ id, company_id: cid, ...r });
  const updated = await db.prepare(`${PAY_SELECT} WHERE r.id = ? AND r.company_id = ?`).get(id, cid);
  await logAction(req, 'Modification', 'Règlement', updated && updated.code);
  res.json(updated);
}));

router.delete('/payments/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const row = await db.prepare('SELECT code, payout_id FROM payments WHERE id = ? AND company_id = ?').get(id, req.companyId);
  if (!row) return res.status(404).json({ error: 'Règlement introuvable.' });
  // Un loyer deja reverse au proprietaire ne peut pas etre efface : le
  // reversement resterait a un montant qui ne correspond plus a aucun loyer.
  if (row.payout_id) {
    return res.status(400).json({
      error: 'Ce loyer a déjà été reversé au propriétaire. Annulez d’abord le reversement correspondant.',
    });
  }
  await db.prepare('DELETE FROM payments WHERE id = ? AND company_id = ?').run(id, req.companyId);
  await logAction(req, 'Suppression', 'Règlement', row.code);
  res.json({ ok: true });
}));

// Encaissement multiple : enregistre le loyer d'UN mois deja echu pour
// plusieurs souscriptions a la fois (campagne de recouvrement mensuelle).
router.post('/payments/bulk', wrap(async (req, res) => {
  const cid = req.companyId;
  const date = clean(req.body.date) || new Date().toISOString().slice(0, 10);
  const defaultPeriod = previousRentPeriod(date);
  const mois = clean(req.body.mois) || defaultPeriod.mois;
  const annee = toInt(req.body.annee) || defaultPeriod.annee;
  const ids = Array.isArray(req.body.subscription_ids) ? req.body.subscription_ids.map(toInt) : [];

  if (ids.length === 0) return res.status(400).json({ error: 'Veuillez sélectionner au moins une souscription.' });
  if (MOIS.indexOf(mois) < 0 || !annee) return res.status(400).json({ error: 'Période de loyer invalide.' });
  // Terme echu : une campagne d'encaissement ne peut porter que sur un mois
  // deja consomme. Reclamer le mois en cours a tous les locataires est
  // precisement l'erreur que cette regle empeche.
  if (!isPeriodDue({ mois, annee })) {
    const due = lastDuePeriod();
    return res.status(400).json({
      error: `Le loyer de ${mois} ${annee} n’est pas encore exigible : il ne se recouvre qu’une fois le mois terminé. `
        + `Dernier mois encaissable : ${due.mois} ${due.annee}.`,
    });
  }

  let crees = 0;
  let ignores = 0;
  for (const sid of ids) {
    const sub = await db.prepare("SELECT * FROM subscriptions WHERE id = ? AND company_id = ? AND statut='Active'").get(sid, cid);
    if (!sub) { ignores++; continue; }
    // Un reglement couvrant plusieurs mois n'est pas detectable via le seul
    // `mois_concerne` (premier mois paye) : on relit la liste complete des mois
    // payes, sinon un locataire deja a jour serait encaisse deux fois.
    const existing = await db.prepare(
      'SELECT mois_concerne, annee_concernee, mois_payes FROM payments WHERE subscription_id=? AND company_id=?'
    ).all(sid, cid);
    const exist = existing.some((p) => parsePeriods(p.mois_payes, p.mois_concerne, p.annee_concernee)
      .some((period) => clean(period.mois) === mois && toInt(period.annee) === annee));
    if (exist) { ignores++; continue; }
    const code = await genCode('payments', 'R', date);
    await db.prepare(
      `INSERT INTO payments
       (company_id, code, subscription_id, property_id, tenant_id, date, montant_a_payer, montant_paye,
        reste_a_payer, mois_concerne, annee_concernee, nombre_mois_payes, mois_payes, nombre_mois_dus, mois_dus, statut)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(cid, code, sub.id, sub.property_id, sub.tenant_id, date || null,
      sub.montant_loyer, sub.montant_loyer, 0, mois, annee, 1, JSON.stringify([{ mois, annee }]), 0, '', 'Soldé');
    crees++;
  }
  if (crees > 0) await logAction(req, 'Création', 'Règlement', `Encaissement du mois : ${crees} loyer(s) — ${mois} ${annee}`);
  res.json({ ok: true, crees, ignores });
}));

// ===========================================================================
// REVERSEMENTS AUX PROPRIETAIRES
//
// Principe : l'agence encaisse les loyers (table payments), preleve sa commission
// (part_commission, definie par BIEN) et reverse le net au proprietaire. La
// commission est calculee paiement par paiement (chaque bien peut avoir un taux
// different). Un loyer deja reverse (payout_id non nul) n'est jamais represente.
// ===========================================================================
const PAYOUT_SELECT = `
  SELECT v.*, o.nom_prenoms AS owner_nom, o.contact AS owner_contact,
         o.email AS owner_email, o.adresse AS owner_adresse
  FROM payouts v
  LEFT JOIN owners o ON o.id = v.owner_id AND o.company_id = v.company_id
`;

// Detail (par paiement) des loyers encaisses NON encore reverses pour un
// proprietaire ; renvoie aussi les totaux (loyers, commission, net).
async function dueForOwner(companyId, ownerId) {
  const lignes = await db.prepare(
    `SELECT r.id, r.code, r.date, r.mois_concerne, r.annee_concernee, r.montant_paye,
            p.code AS property_code, p.part_commission, t.nom_prenoms AS tenant_nom
     FROM payments r
     JOIN properties p ON p.id = r.property_id AND p.company_id = r.company_id
     LEFT JOIN tenants t ON t.id = r.tenant_id AND t.company_id = r.company_id
     WHERE r.company_id = ? AND p.owner_id = ? AND r.payout_id IS NULL AND r.montant_paye > 0
     ORDER BY r.annee_concernee, r.id`
  ).all(companyId, ownerId);
  const detail = lignes.map((l) => {
    const commission = Math.round((l.montant_paye * (l.part_commission || 0)) / 100);
    return { ...l, commission, net: l.montant_paye - commission };
  });
  const totals = detail.reduce(
    (a, l) => ({ loyers: a.loyers + l.montant_paye, commission: a.commission + l.commission, net: a.net + l.net }),
    { loyers: 0, commission: 0, net: 0 }
  );
  return { lignes: detail, totals };
}

// Liste des proprietaires ayant des loyers encaisses a reverser (vue principale).
router.get('/payouts/due', wrap(async (req, res) => {
  const rows = await db.prepare(
    `SELECT o.id AS owner_id, o.nom_prenoms AS owner_nom, o.contact AS owner_contact,
            COUNT(r.id) AS nombre_paiements,
            COALESCE(SUM(r.montant_paye), 0) AS loyers,
            COALESCE(SUM(ROUND(r.montant_paye * COALESCE(p.part_commission, 0) / 100.0)), 0) AS commission
     FROM payments r
     JOIN properties p ON p.id = r.property_id AND p.company_id = r.company_id
     JOIN owners o ON o.id = p.owner_id AND o.company_id = r.company_id
     WHERE r.company_id = ? AND r.payout_id IS NULL AND r.montant_paye > 0
     GROUP BY o.id, o.nom_prenoms, o.contact
     HAVING loyers > 0
     ORDER BY o.nom_prenoms COLLATE NOCASE`
  ).all(req.companyId);
  rows.forEach((x) => { x.net = x.loyers - x.commission; });
  res.json(rows);
}));

// Detail du du pour un proprietaire (avant de valider le reversement).
router.get('/payouts/due/:ownerId', wrap(async (req, res) => {
  const cid = req.companyId;
  const owner = await db.prepare('SELECT * FROM owners WHERE id = ? AND company_id = ?').get(toInt(req.params.ownerId), cid);
  if (!owner) return res.status(404).json({ error: 'Propriétaire introuvable.' });
  const { lignes, totals } = await dueForOwner(cid, owner.id);
  res.json({
    owner: { id: owner.id, nom_prenoms: owner.nom_prenoms, contact: owner.contact, email: owner.email, adresse: owner.adresse },
    lignes, totals, nombre_paiements: lignes.length,
  });
}));

// Historique des reversements effectues.
router.get('/payouts', wrap(async (req, res) => {
  const q = clean(req.query.q);
  let rows = await db.prepare(`${PAYOUT_SELECT} WHERE v.company_id = ? ORDER BY v.id DESC`).all(req.companyId);
  if (q) {
    const s = q.toLowerCase();
    rows = rows.filter((r) => [r.code, r.owner_nom].some((v) => (v || '').toLowerCase().includes(s)));
  }
  res.json(rows);
}));

// Detail d'un reversement (avec les loyers couverts) — pour l'impression du releve.
router.get('/payouts/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const payout = await db.prepare(`${PAYOUT_SELECT} WHERE v.id = ? AND v.company_id = ?`).get(id, cid);
  if (!payout) return res.status(404).json({ error: 'Reversement introuvable.' });
  const lignes = await db.prepare(
    `SELECT r.id, r.code, r.date, r.mois_concerne, r.annee_concernee, r.montant_paye,
            p.code AS property_code, p.part_commission, t.nom_prenoms AS tenant_nom
     FROM payments r
     LEFT JOIN properties p ON p.id = r.property_id AND p.company_id = r.company_id
     LEFT JOIN tenants t ON t.id = r.tenant_id AND t.company_id = r.company_id
     WHERE r.payout_id = ? AND r.company_id = ?
     ORDER BY r.annee_concernee, r.id`
  ).all(id, cid);
  lignes.forEach((l) => {
    l.commission = Math.round((l.montant_paye * (l.part_commission || 0)) / 100);
    l.net = l.montant_paye - l.commission;
  });
  payout.lignes = lignes;
  res.json(payout);
}));

// Cree un reversement pour un proprietaire (couvre par defaut TOUS ses loyers
// encaisses non encore reverses ; un sous-ensemble payment_ids est accepte).
router.post('/payouts', wrap(async (req, res) => {
  const cid = req.companyId;
  const ownerId = toInt(req.body.owner_id);
  const owner = await db.prepare('SELECT * FROM owners WHERE id = ? AND company_id = ?').get(ownerId, cid);
  if (!owner) return res.status(400).json({ error: 'Veuillez sélectionner un propriétaire valide.' });

  const { lignes } = await dueForOwner(cid, ownerId);
  let selected = lignes;
  if (Array.isArray(req.body.payment_ids) && req.body.payment_ids.length) {
    const set = new Set(req.body.payment_ids.map(toInt));
    selected = lignes.filter((l) => set.has(l.id));
  }
  if (selected.length === 0) {
    return res.status(400).json({ error: 'Aucun loyer encaissé à reverser pour ce propriétaire.' });
  }

  const date = clean(req.body.date) || new Date().toISOString().slice(0, 10);
  const code = await genCode('payouts', 'V', date);
  const payoutId = (await db.prepare(
    `INSERT INTO payouts
       (company_id, code, owner_id, date, periode_debut, periode_fin,
        nombre_paiements, montant_loyers, montant_commission, montant_net, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(cid, code, ownerId, date, null, null, 0, 0, 0, 0, clean(req.body.note) || null)).lastInsertRowid;

  // Chaque loyer n'est rattache que s'il est ENCORE libre (payout_id IS NULL).
  // Sans cette condition, deux reversements valides en meme temps pour le meme
  // proprietaire se volent les memes loyers : le second ecrase le rattachement
  // du premier, et l'argent est reverse deux fois.
  const claimed = [];
  for (const l of selected) {
    const info = await db.prepare(
      'UPDATE payments SET payout_id = ? WHERE id = ? AND company_id = ? AND payout_id IS NULL'
    ).run(payoutId, l.id, cid);
    if (info.changes > 0) claimed.push(l);
  }

  if (claimed.length === 0) {
    await db.prepare('DELETE FROM payouts WHERE id = ? AND company_id = ?').run(payoutId, cid);
    return res.status(409).json({ error: 'Ces loyers viennent d’être reversés par un autre utilisateur. Actualisez la page.' });
  }

  const loyers = claimed.reduce((a, l) => a + l.montant_paye, 0);
  const commission = claimed.reduce((a, l) => a + l.commission, 0);
  const net = loyers - commission;
  const dates = claimed.map((l) => l.date).filter(Boolean).sort();
  await db.prepare(
    `UPDATE payouts SET periode_debut = ?, periode_fin = ?, nombre_paiements = ?,
       montant_loyers = ?, montant_commission = ?, montant_net = ?
     WHERE id = ? AND company_id = ?`
  ).run(dates[0] || null, dates[dates.length - 1] || null, claimed.length, loyers, commission, net, payoutId, cid);

  await logAction(req, 'Création', 'Reversement', `${owner.nom_prenoms} — net ${net}`);
  res.json(await db.prepare(`${PAYOUT_SELECT} WHERE v.id = ?`).get(payoutId));
}));

// Annule un reversement : les loyers redeviennent « a reverser ».
router.delete('/payouts/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const row = await db.prepare(`${PAYOUT_SELECT} WHERE v.id = ? AND v.company_id = ?`).get(id, cid);
  await db.prepare('UPDATE payments SET payout_id = NULL WHERE payout_id = ? AND company_id = ?').run(id, cid);
  await db.prepare('DELETE FROM payouts WHERE id = ? AND company_id = ?').run(id, cid);
  if (row) await logAction(req, 'Suppression', 'Reversement', `${row.owner_nom || ''} — ${row.code}`);
  res.json({ ok: true });
}));

// ===========================================================================
// TABLEAU DE BORD
// ===========================================================================
router.get('/dashboard', wrap(async (req, res) => {
  const cid = req.companyId;
  const now = new Date();
  const moisCourant = MOIS[now.getMonth()];
  const anneeCourante = now.getFullYear();
  // Compteur mensuel : le tableau de bord s'ouvre sur le mois en cours de
  // recouvrement, pas sur le cumul depuis janvier. Le filtre de periode reste
  // disponible pour « Depuis janvier » ou « Toutes les periodes ».
  const range = normalizeRange(req.query, { mode: 'current', ref: now });
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const [proprietaires, locataires, maisons, occupees, subscriptions, paymentRows, allProps] = await Promise.all([
    one('SELECT COUNT(*) n FROM owners WHERE company_id = ?', cid),
    one('SELECT COUNT(*) n FROM tenants WHERE company_id = ?', cid),
    one('SELECT COUNT(*) n FROM properties WHERE company_id = ?', cid),
    one("SELECT COUNT(DISTINCT property_id) n FROM subscriptions WHERE company_id = ? AND statut='Active' AND property_id IS NOT NULL", cid),
    db.prepare('SELECT * FROM subscriptions WHERE company_id = ?').all(cid),
    db.prepare(
      `SELECT r.*, p.code AS property_code, p.part_commission,
              t.nom_prenoms AS tenant_nom, t.contact AS tenant_contact,
         t.email AS tenant_email, t.adresse AS tenant_adresse
       FROM payments r
       LEFT JOIN properties p ON p.id = r.property_id AND p.company_id = r.company_id
       LEFT JOIN tenants t ON t.id = r.tenant_id AND t.company_id = r.company_id
       WHERE r.company_id = ? ORDER BY r.id DESC`
    ).all(cid),
    db.prepare(`${PROPERTY_SELECT} WHERE p.company_id = ?`).all(cid),
  ]);

  // Un reglement dont le BIEN a ete supprime n'est plus rattachable a un
  // proprietaire : l'ecran Reversements l'ignore deja (jointure stricte sur
  // properties). Le tableau de bord doit l'ignorer aussi, sinon il annonce des
  // montants introuvables ailleurs dans le logiciel — c'est ce qui gonflait
  // « loyers encaisses » et « a reverser » apres des suppressions de biens.
  const livePaymentRows = paymentRows.filter((p) => p.property_id && p.property_code);
  // Idem pour les baux : un bail rattache a un bien supprime ne represente plus
  // ni une caution detenue ni un loyer reclamable.
  const liveSubscriptions = subscriptions.filter((s) => s.property_id);

  const selectedPayments = livePaymentRows.map((p) => {
    const selected = paymentAmountsInRange(p, range);
    return selected.matches ? {
      ...p,
      montant_a_payer: selected.montant_a_payer,
      montant_paye: selected.montant_paye,
      reste_a_payer: selected.reste_a_payer,
      statut: selected.statut,
      periodes_filtrees: selected.selectedPeriods,
    } : null;
  }).filter(Boolean);

  const paymentsBySubscription = livePaymentRows.reduce((grouped, payment) => {
    if (payment.subscription_id) (grouped[payment.subscription_id] ||= []).push(payment);
    return grouped;
  }, {});
  const paidMonthMap = buildPaidMonthMap(livePaymentRows);
  let expected = 0;
  let unpaidCount = 0;
  let unpaidAmount = 0;
  for (const subscription of liveSubscriptions.filter((s) => s.date_debut_paiement)) {
    const end = subscriptionEndPeriod(subscription, paymentsBySubscription[subscription.id] || []);
    if (!end) continue;
    const periods = monthsUntil(subscription.date_debut_paiement, end.annee, end.mois)
      .filter((period) => periodInRange(period, range));
    const rent = subscription.montant_loyer || 0;
    expected += periods.length * rent;
    const paid = (paidMonthMap.get(subscription.id) || {}).paid || new Map();
    for (const period of periods) {
      const entry = paid.get(`${period.annee}-${period.mois}`);
      const remaining = Math.max(0, rent - (entry ? entry.amount : 0));
      if (remaining > PAYMENT_TOLERANCE) {
        unpaidCount += 1;
        unpaidAmount += remaining;
      }
    }
  }

  const totalPaid = selectedPayments.reduce((sum, p) => sum + (p.montant_paye || 0), 0);
  // Le « reste a reverser » est une DETTE qui s'accumule jusqu'au reversement,
  // pas un flux du mois : on la calcule sur tous les loyers encaisses non encore
  // reverses, quelle que soit leur periode. Sinon le tableau de bord annoncerait
  // un montant plus faible que l'ecran Reversements, qui lui fait foi.
  const aReverser = livePaymentRows.filter((p) => !p.payout_id && p.montant_paye > 0)
    .reduce((sum, p) => sum + p.montant_paye - Math.round(p.montant_paye * (p.part_commission || 0) / 100), 0);
  // Cautions et avances sont de l'argent DETENU par l'agence jusqu'au depart du
  // locataire, pas un flux du mois. Les filtrer sur la date de signature du bail
  // n'avait aucun sens : apres une ressaisie du parc, tous les baux portaient la
  // date du jour et la tuile affichait d'un coup la totalite des cautions.
  // On compte donc ce qui est reellement detenu : les baux ACTIFS d'un bien
  // existant.
  const heldSubscriptions = liveSubscriptions.filter((s) => s.statut === 'Active');
  const nb_maisons = maisons.n;
  const nb_occupees = occupees.n;
  const label = rangeLabel(range);

  const data = {
    moisCourant,
    anneeCourante,
    moisRecouvrement: label,
    anneeRecouvrement: '',
    periode: { mode: range.mode, from: range.fromValue, to: range.toValue, label, monthCount: range.monthCount },
    nb_proprietaires: proprietaires.n,
    nb_locataires: locataires.n,
    nb_maisons,
    nb_occupees,
    nb_disponibles: nb_maisons - nb_occupees,
    total_caution: heldSubscriptions.reduce((sum, s) => sum + (s.montant_caution || 0), 0),
    total_avance: heldSubscriptions.reduce((sum, s) => sum + (s.montant_avance || 0), 0),
    total_loyer: totalPaid,
    loyer_attendu: expected,
    loyer_encaisse_mois: totalPaid,
    impayes_nombre: unpaidCount,
    impayes_montant: unpaidAmount,
    reste_a_reverser: aReverser,
  };
  data.reste_attendu_mois = Math.max(0, data.loyer_attendu - data.loyer_encaisse_mois);
  data.derniers_paiements = selectedPayments.slice(0, 6);
  data.maisons_disponibles = allProps.filter((r) => r.statut === 'Disponible').slice(0, 6);

  res.json(data);
}));

// ===========================================================================
// UTILISATEURS de l'entreprise (administrateur uniquement)
// ===========================================================================
router.get('/users', requireRole('admin'), wrap(async (req, res) => {
  res.json(await db.prepare(
    'SELECT id, email, nom, role, actif, created_at FROM users WHERE company_id = ? ORDER BY id'
  ).all(req.companyId));
}));

router.post('/users', requireRole('admin'), wrap(async (req, res) => {
  const cid = req.companyId;
  const email = clean(req.body.email).toLowerCase();
  const password = clean(req.body.password);
  const nom = clean(req.body.nom);
  const role = normRole(req.body.role);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail invalide.' });
  if (!password) return res.status(400).json({ error: 'Mot de passe requis.' });
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(400).json({ error: 'Cette adresse e-mail est déjà utilisée.' });
  }
  const info = await db.prepare(
    'INSERT INTO users (username, email, password, nom, role, company_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(email, email, hashPassword(password), nom, role, cid);
  await logAction(req, 'Création', 'Utilisateur', nom || email);
  res.json(publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
}));

router.put('/users/:id', requireRole('admin'), wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const user = await db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(id, cid);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const nom = clean(req.body.nom) || user.nom;
  const role = normRole(req.body.role);
  const actif = req.body.actif === undefined ? user.actif : (req.body.actif ? 1 : 0);
  const password = clean(req.body.password);
  if (password) {
    await db.prepare('UPDATE users SET nom=?, role=?, actif=?, password=? WHERE id=? AND company_id=?')
      .run(nom, role, actif, hashPassword(password), id, cid);
  } else {
    await db.prepare('UPDATE users SET nom=?, role=?, actif=? WHERE id=? AND company_id=?').run(nom, role, actif, id, cid);
  }
  await logAction(req, 'Modification', 'Utilisateur', nom || user.email);
  res.json(publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
}));

router.delete('/users/:id', requireRole('admin'), wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  if (id === req.userId) return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
  const row = await db.prepare('SELECT nom, email FROM users WHERE id = ? AND company_id = ?').get(id, cid);
  await db.prepare('DELETE FROM users WHERE id = ? AND company_id = ?').run(id, cid);
  if (row) await logAction(req, 'Suppression', 'Utilisateur', row.nom || row.email);
  res.json({ ok: true });
}));

// ===========================================================================
// JOURNAL D'ACTIVITE (qui a fait quoi) — administrateur uniquement
// ===========================================================================
router.get('/audit', requireRole('admin'), wrap(async (req, res) => {
  const q = clean(req.query.q);
  let rows = await db.prepare(
    `SELECT a.id, a.user_id, a.user_nom, a.action, a.entity, a.label, a.created_at,
            u.nom AS current_nom, u.email AS current_email
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id AND u.company_id = a.company_id
     WHERE a.company_id = ? ORDER BY a.id DESC LIMIT 1000`
  ).all(req.companyId);
  if (q) {
    const s = q.toLowerCase();
    rows = rows.filter((r) => [r.user_nom, r.current_nom, r.action, r.entity, r.label]
      .some((v) => (v || '').toLowerCase().includes(s)));
  }
  res.json(rows);
}));

// ===========================================================================
// PARAMETRES de l'entreprise (profil + branding) — sur settingsRouter
// (consultable meme si l'abonnement est expire ; modification : admin).
// ===========================================================================
function companyToSettings(c) {
  return {
    entreprise: c.nom, telephone: c.telephone || '', email: c.email || '',
    adresse: c.adresse || '', devise: c.devise || 'FCFA', logo: c.logo || null,
  };
}

settingsRouter.get('/', wrap(async (req, res) => {
  const c = await db.prepare('SELECT * FROM companies WHERE id = ?').get(req.companyId);
  if (!c) return res.status(404).json({ error: 'Entreprise introuvable.' });
  res.json(companyToSettings(c));
}));

settingsRouter.put('/', requireRole('admin'), wrap(async (req, res) => {
  const cid = req.companyId;
  const b = req.body || {};

  let logo;
  if (b.logo === undefined) {
    const cur = await db.prepare('SELECT logo FROM companies WHERE id = ?').get(cid);
    logo = (cur && cur.logo) || null;
  } else if (b.logo === null || b.logo === '') {
    logo = null;
  } else {
    logo = String(b.logo);
    if (!/^data:image\/(png|jpeg|jpg|webp|svg\+xml);/i.test(logo)) {
      return res.status(400).json({ error: 'Logo invalide : veuillez choisir une image (PNG, JPG ou SVG).' });
    }
    if (logo.length > 700000) {
      return res.status(400).json({ error: 'Logo trop volumineux (max ~500 Ko). Choisissez une image plus légère.' });
    }
  }

  const nextName = clean(b.entreprise) || 'Mon entreprise';
  const forceNoSubscription = isNoSubscriptionCompanyName(nextName);
  const sql = forceNoSubscription
    ? 'UPDATE companies SET nom=?, telephone=?, email=?, adresse=?, devise=?, logo=?, illimite=1, statut=\'actif\', demande_le=NULL WHERE id=?'
    : 'UPDATE companies SET nom=?, telephone=?, email=?, adresse=?, devise=?, logo=? WHERE id=?';
  await db.prepare(sql).run(
    nextName,
    clean(b.telephone),
    clean(b.email),
    clean(b.adresse),
    clean(b.devise) || 'FCFA',
    logo,
    cid
  );
  const c = await db.prepare('SELECT * FROM companies WHERE id = ?').get(cid);
  res.json(companyToSettings(c));
}));

// ===========================================================================
// ABONNEMENT (cote entreprise) — sur subscriptionRouter
// Consultable meme si expire ; permet de demander l'activation.
// ===========================================================================
subscriptionRouter.get('/', wrap(async (req, res) => {
  const [company, platform] = await Promise.all([
    companyState(req.companyId),
    db.prepare('SELECT * FROM platform WHERE id = 1').get(),
  ]);
  res.json({ company, platform: platform || null });
}));

subscriptionRouter.post('/request', wrap(async (req, res) => {
  const c = await db.prepare('SELECT * FROM companies WHERE id = ?').get(req.companyId);
  if (!c) return res.status(404).json({ error: 'Entreprise introuvable.' });
  const today = new Date().toISOString().slice(0, 10);
  await db.prepare('UPDATE companies SET demande_le = ? WHERE id = ?').run(today, req.companyId);
  res.json({ ok: true, message: "Votre demande a bien été enregistrée. Nous vous contacterons après vérification du paiement." });
}));

// ===========================================================================
// SAUVEGARDE / RESTAURATION des donnees de l'entreprise — sur dataRouter
//
// But : permettre a une entreprise d'exporter TOUTES ses donnees metier dans un
// seul fichier JSON (sauvegarde / transfert vers l'hebergement en ligne) puis de
// les re-importer. Reserve a l'administrateur de l'entreprise. L'isolation par
// company_id est conservee : on n'exporte/importe QUE les donnees de la session.
// ===========================================================================

// Tables metier exportees, dans l'ordre des dependances (parent -> enfant).
// payouts est place avant payments car payments.payout_id y fait reference.
// audit_log est exporte/restaure en dernier : c'est l'historique propre a
// l'entreprise, mais il ne doit jamais bloquer la restauration des donnees.
const DATA_TABLES = ['owners', 'tenants', 'properties', 'subscriptions', 'payouts', 'payments', 'repairs', 'audit_log'];

dataRouter.get('/export', requireRole('admin'), wrap(async (req, res) => {
  const cid = req.companyId;
  const [company, owners, tenants, properties, subscriptions, payouts, payments, repairs, audit_log] = await Promise.all([
    db.prepare('SELECT nom, telephone, email, adresse, devise FROM companies WHERE id = ?').get(cid),
    db.prepare('SELECT * FROM owners WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM tenants WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM properties WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM subscriptions WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM payouts WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM payments WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM repairs WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM audit_log WHERE company_id = ? ORDER BY id').all(cid),
  ]);

  const data = {
    format: 'nouvelafric.sauvegarde',
    version: 1,
    exporte_le: new Date().toISOString(),
    entreprise: company || null,
    donnees: { owners, tenants, properties, subscriptions, payouts, payments, repairs, audit_log },
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const slug = ((company && company.nom) || 'entreprise')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'entreprise';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sauvegarde-${slug}-${stamp}.json"`);
  res.send(JSON.stringify(data, null, 2));
}));

dataRouter.post('/import', requireRole('admin'), wrap(async (req, res) => {
  const cid = req.companyId;
  const body = req.body || {};
  // On accepte soit l'enveloppe complete { donnees: {...} }, soit directement les
  // listes { owners, tenants, ... }.
  const d = (body && body.donnees) || body;
  const list = (k) => (Array.isArray(d[k]) ? d[k] : []);
  const owners = list('owners');
  const tenants = list('tenants');
  const properties = list('properties');
  const subscriptions = list('subscriptions');
  const payouts = list('payouts');
  const payments = list('payments');
  const repairs = list('repairs');
  const audit_log = list('audit_log');

  if (![owners, tenants, properties, subscriptions, payouts, payments, repairs, audit_log].some((a) => a.length)) {
    return res.status(400).json({ error: 'Fichier de sauvegarde vide ou invalide.' });
  }

  // Le profil de l'entreprise est sauvegarde avec les donnees. A la restauration,
  // on le remet a jour par defaut pour que l'entreprise retrouve sa devise et ses
  // coordonnees apres migration. Le compte de connexion reste celui de la session.
  if (body.entreprise && body.restaurerProfil !== false) {
    await db.prepare('UPDATE companies SET nom=?, telephone=?, email=?, adresse=?, devise=? WHERE id=?').run(
      clean(body.entreprise.nom) || 'Mon entreprise',
      clean(body.entreprise.telephone),
      clean(body.entreprise.email),
      clean(body.entreprise.adresse),
      clean(body.entreprise.devise) || 'FCFA',
      cid
    );
  }

  // 'remplacer' : efface d'abord les donnees actuelles de CETTE entreprise.
  // 'fusionner' (defaut) : ajoute aux donnees existantes.
  const mode = clean(body.mode) === 'remplacer' ? 'remplacer' : 'fusionner';
  if (mode === 'remplacer') {
    for (const t of [...DATA_TABLES].reverse()) {
      await db.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(cid);
    }
  }

  // Les identifiants auto-incrementes different d'une base a l'autre : on remappe
  // les anciens id vers les nouveaux pour preserver les liens entre les tables.
  const ownerMap = new Map();
  const tenantMap = new Map();
  const propertyMap = new Map();
  const subscriptionMap = new Map();
  const payoutMap = new Map();
  const counts = { owners: 0, tenants: 0, properties: 0, subscriptions: 0, payouts: 0, payments: 0, repairs: 0, audit_log: 0 };

  for (const o of owners) {
    const id = (await db.prepare(
      'INSERT INTO owners (company_id, nom_prenoms, contact, email, adresse, type_logement, pieces_logement) VALUES (?,?,?,?,?,?,?)'
    ).run(cid, clean(o.nom_prenoms) || 'Sans nom', clean(o.contact), clean(o.email), clean(o.adresse),
      clean(o.type_logement) || null, clean(o.pieces_logement) || null)).lastInsertRowid;
    if (o.id != null) ownerMap.set(o.id, id);
    counts.owners++;
  }

  for (const t of tenants) {
    const id = (await db.prepare(
      'INSERT INTO tenants (company_id, nom_prenoms, contact, email, adresse, caution, autre_frais, montant_autre_frais) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      cid, clean(t.nom_prenoms) || 'Sans nom', clean(t.contact), clean(t.email), clean(t.adresse),
      toInt(t.caution), clean(t.autre_frais), toInt(t.montant_autre_frais)
    )).lastInsertRowid;
    if (t.id != null) tenantMap.set(t.id, id);
    counts.tenants++;
  }

  for (const p of properties) {
    const code = await uniqueCode('properties', 'MX', p.code);
    const id = (await db.prepare(
      `INSERT INTO properties
       (company_id, code, owner_id, type_construction, nombre_piece, designation, cout_loyer, ville, commune, quartier, observation, part_commission, nombre_porte)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      cid, code, ownerMap.get(p.owner_id) || null,
      clean(p.type_construction), p.nombre_piece != null ? toInt(p.nombre_piece) : null, clean(p.designation) || null,
      toInt(p.cout_loyer), clean(p.ville), clean(p.commune), clean(p.quartier),
      clean(p.observation), toNum(p.part_commission), p.nombre_porte != null ? toInt(p.nombre_porte) : null
    )).lastInsertRowid;
    if (p.id != null) propertyMap.set(p.id, id);
    counts.properties++;
  }

  for (const s of subscriptions) {
    const code = await uniqueCode('subscriptions', 'S', s.code);
    const importedStatus = ['Active', 'Desactive'].includes(clean(s.statut)) ? clean(s.statut) : 'Active';
    const importedEndDate = importedStatus === 'Desactive' && isValidYMD(s.date_fin) ? clean(s.date_fin) : null;
    const id = (await db.prepare(
      `INSERT INTO subscriptions
       (company_id, code, property_id, tenant_id, date_souscription, montant_loyer,
        nombre_mois_caution, montant_caution, nombre_mois_avance, montant_avance,
        nombre_mois_garantie, montant_garantie, autre_frais, montant_autre_frais,
        date_entree, date_debut_paiement, date_fin, statut)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      cid, code, propertyMap.get(s.property_id) || null, tenantMap.get(s.tenant_id) || null,
      clean(s.date_souscription) || null, toInt(s.montant_loyer),
      toInt(s.nombre_mois_caution), toInt(s.montant_caution),
      toInt(s.nombre_mois_avance), toInt(s.montant_avance),
      toInt(s.nombre_mois_garantie), toInt(s.montant_garantie),
      clean(s.autre_frais), toInt(s.montant_autre_frais),
      clean(s.date_entree) || null, clean(s.date_debut_paiement) || null,
      importedEndDate,
      importedStatus
    )).lastInsertRowid;
    if (s.id != null) subscriptionMap.set(s.id, id);
    counts.subscriptions++;
  }

  for (const v of payouts) {
    const code = await uniqueCode('payouts', 'V', v.code);
    const id = (await db.prepare(
      `INSERT INTO payouts
       (company_id, code, owner_id, date, periode_debut, periode_fin,
        nombre_paiements, montant_loyers, montant_commission, montant_net, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      cid, code, ownerMap.get(v.owner_id) || null,
      clean(v.date) || null, clean(v.periode_debut) || null, clean(v.periode_fin) || null,
      toInt(v.nombre_paiements), toInt(v.montant_loyers), toInt(v.montant_commission), toInt(v.montant_net),
      clean(v.note) || null
    )).lastInsertRowid;
    if (v.id != null) payoutMap.set(v.id, id);
    counts.payouts++;
  }

  for (const p of payments) {
    const code = await uniqueCode('payments', 'R', p.code);
    await db.prepare(
      `INSERT INTO payments
       (company_id, code, subscription_id, property_id, tenant_id, date, montant_a_payer, montant_paye, reste_a_payer,
        mois_concerne, annee_concernee, nombre_mois_payes, mois_payes, nombre_mois_dus, mois_dus, statut, payout_id, numero_recu)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      cid, code, subscriptionMap.get(p.subscription_id) || null,
      propertyMap.get(p.property_id) || null, tenantMap.get(p.tenant_id) || null,
      clean(p.date) || null, toInt(p.montant_a_payer), toInt(p.montant_paye), toInt(p.reste_a_payer),
      clean(p.mois_concerne), p.annee_concernee != null ? toInt(p.annee_concernee) : null,
      toInt(p.nombre_mois_payes) || 1, clean(p.mois_payes), toInt(p.nombre_mois_dus), clean(p.mois_dus),
      clean(p.statut) || 'Soldé', payoutMap.get(p.payout_id) || null, clean(p.numero_recu) || null
    );
    counts.payments++;
  }

  for (const v of repairs) {
    const pid = propertyMap.get(v.property_id);
    if (!pid) continue; // une reparation sans bien rattachable est ignoree
    await db.prepare(
      'INSERT INTO repairs (company_id, property_id, mois, annee, montant, description) VALUES (?,?,?,?,?,?)'
    ).run(cid, pid, clean(v.mois) || null, v.annee != null ? toInt(v.annee) : null, toInt(v.montant), clean(v.description) || null);
    counts.repairs++;
  }

  for (const a of audit_log) {
    await db.prepare(
      'INSERT INTO audit_log (company_id, user_id, user_nom, action, entity, label, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(
      cid,
      null,
      clean(a.user_nom) || null,
      clean(a.action) || 'Restauration',
      clean(a.entity) || null,
      clean(a.label) || null,
      clean(a.created_at) || new Date().toISOString()
    );
    counts.audit_log++;
  }

  await migrateInactiveSubscriptionDates(cid);
  res.json({ ok: true, mode, importe: counts });
}));

module.exports = { router, settingsRouter, subscriptionRouter, dataRouter };
