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
const { db, hashPassword, computeSubscription } = require('./db');
const { requireRole, publicUser, companyState } = require('./auth');
const { isNoSubscriptionCompanyName } = require('./companyPolicy');
const { normalizePaidMonths, parsePeriods, buildPaidMonthMap, summarizeRecoveryMonths } = require('./paymentPeriods');

const router = express.Router();
const settingsRouter = express.Router();
const subscriptionRouter = express.Router();
const dataRouter = express.Router();

const MOIS = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

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

async function genPropertyCode(type, cout, dateStr) {
  const base = `${typeCode(type)}_C${toInt(cout)}_M${dateCode(dateStr)}`;
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
function monthsUntilNow(startYMD) {
  const now = new Date();
  return monthsUntil(startYMD, now.getFullYear(), now.getMonth() + 1);
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
    LEFT JOIN properties p ON p.id = s.property_id`;
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
  const info = await db.prepare(
    'INSERT INTO tenants (company_id, nom_prenoms, contact, email, adresse, caution, autre_frais, montant_autre_frais) VALUES (?,?,?,?,?,?,?,?)'
  ).run(cid, p.nom_prenoms, p.contact, p.email, p.adresse, toInt(req.body.caution), clean(req.body.autre_frais), toInt(req.body.montant_autre_frais));
  await logAction(req, 'Création', 'Locataire', p.nom_prenoms);
  const tenantId = info.lastInsertRowid;

  // Si un bien est choisi au moment d'enregistrer le locataire, on cree aussi
  // la souscription (le bail) qui relie ce locataire a ce bien.
  const propertyId = toInt(req.body.property_id);
  if (propertyId) {
    const prop = await db.prepare('SELECT * FROM properties WHERE id = ? AND company_id = ?').get(propertyId, cid);
    if (!prop) return res.status(400).json({ error: 'Bien introuvable.' });
    const montantLoyer = toInt(req.body.montant_loyer) || toInt(prop.cout_loyer);
    const nbCaution = toInt(req.body.nombre_mois_caution);
    const nbAvance = toInt(req.body.nombre_mois_avance);
    const nbGarantie = toInt(req.body.nombre_mois_garantie);
    const today = new Date().toISOString().slice(0, 10);
    const s = subscriptionPayload({
      ...req.body,
      property_id: propertyId,
      tenant_id: tenantId,
      montant_loyer: montantLoyer,
      montant_caution: req.body.montant_caution !== undefined ? req.body.montant_caution : nbCaution * montantLoyer,
      montant_avance: req.body.montant_avance !== undefined ? req.body.montant_avance : nbAvance * montantLoyer,
      montant_garantie: req.body.montant_garantie !== undefined ? req.body.montant_garantie : nbGarantie * montantLoyer,
      date_souscription: clean(req.body.date_souscription) || today,
      date_entree: clean(req.body.date_entree) || today,
      date_debut_paiement: clean(req.body.date_debut_paiement) || clean(req.body.date_entree) || today,
      statut: clean(req.body.statut) || 'Active',
    });
    const subErr = await validateSubscription(s, cid);
    if (subErr) return res.status(400).json({ error: subErr });
    const code = await genCode('subscriptions', 'S', s.date_souscription);
    await db.prepare(
      `INSERT INTO subscriptions
       (company_id, code, property_id, tenant_id, date_souscription, montant_loyer, nombre_mois_caution,
        montant_caution, nombre_mois_avance, montant_avance, nombre_mois_garantie, montant_garantie,
        autre_frais, montant_autre_frais, date_entree, date_debut_paiement, statut)
       VALUES (@company_id,@code,@property_id,@tenant_id,@date_souscription,@montant_loyer,@nombre_mois_caution,
        @montant_caution,@nombre_mois_avance,@montant_avance,@nombre_mois_garantie,@montant_garantie,
        @autre_frais,@montant_autre_frais,@date_entree,@date_debut_paiement,@statut)`
    ).run({ company_id: cid, code, ...s });
    await logAction(req, 'Création', 'Souscription', `${code} — ${p.nom_prenoms}`);
  }

  res.json(await db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId));
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
     LEFT JOIN properties p ON p.id = r.property_id
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
  const id = toInt(req.params.id);
  const row = await db.prepare('SELECT nom_prenoms FROM tenants WHERE id = ? AND company_id = ?').get(id, req.companyId);
  await db.prepare('DELETE FROM tenants WHERE id = ? AND company_id = ?').run(id, req.companyId);
  if (row) await logAction(req, 'Suppression', 'Locataire', row.nom_prenoms);
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
           WHERE s.property_id = p.id AND s.statut = 'Active'
         ) THEN 'Occupé' ELSE 'Disponible' END AS statut
  FROM properties p
  LEFT JOIN owners o ON o.id = p.owner_id
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
  if (!p.cout_loyer) return 'Veuillez saisir le coût du loyer.';
  if (p.part_commission > 100) return 'La part de commission doit être inférieure ou égale à 100.';
  return null;
}

router.post('/properties', wrap(async (req, res) => {
  const cid = req.companyId;
  const p = propertyPayload(req.body);
  const err = await validateProperty(p, cid);
  if (err) return res.status(400).json({ error: err });
  const code = await genPropertyCode(p.type_construction, p.cout_loyer, req.body.date);
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
  const sub = await db.prepare("SELECT 1 FROM subscriptions WHERE property_id = ? AND company_id = ? AND statut='Active'").get(id, cid);
  if (sub) return res.status(400).json({ error: 'Impossible de supprimer : ce bien a une souscription active.' });
  const row = await db.prepare('SELECT code FROM properties WHERE id = ? AND company_id = ?').get(id, cid);
  await db.prepare('DELETE FROM properties WHERE id = ? AND company_id = ?').run(id, cid);
  if (row) await logAction(req, 'Suppression', 'Bien', row.code);
  res.json({ ok: true });
}));

// ===========================================================================
// SOUSCRIPTIONS / BAUX
// ===========================================================================
const SUB_SELECT = `
  SELECT s.*, p.code AS property_code, p.type_construction, p.nombre_piece, p.designation,
         o.nom_prenoms AS owner_nom, o.contact AS owner_contact,
         t.nom_prenoms AS tenant_nom, t.contact AS tenant_contact
  FROM subscriptions s
  LEFT JOIN properties p ON p.id = s.property_id
  LEFT JOIN owners o ON o.id = p.owner_id
  LEFT JOIN tenants t ON t.id = s.tenant_id
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
    statut: clean(body.statut) || 'Active',
  };
}

async function validateSubscription(s, companyId, excludeId = 0) {
  if (!s.property_id) return 'Veuillez sélectionner le bien (maison).';
  if (!s.tenant_id) return 'Veuillez sélectionner le locataire.';
  const prop = await db.prepare('SELECT 1 FROM properties WHERE id = ? AND company_id = ?').get(s.property_id, companyId);
  if (!prop) return 'Bien introuvable.';
  const ten = await db.prepare('SELECT 1 FROM tenants WHERE id = ? AND company_id = ?').get(s.tenant_id, companyId);
  if (!ten) return 'Locataire introuvable.';
  if (!s.montant_loyer) return 'Le montant du loyer est requis.';
  if (!s.date_entree) return 'Veuillez saisir la date d’entrée.';
  if (!s.date_debut_paiement) return 'Veuillez saisir la date de début de paiement.';
  if (s.statut === 'Active') {
    const dup = await db.prepare(
      `SELECT 1 FROM subscriptions
       WHERE company_id = ? AND property_id = ? AND tenant_id = ? AND statut = 'Active' AND id <> ?`
    ).get(companyId, s.property_id, s.tenant_id, excludeId || 0);
    if (dup) return 'Ce locataire est déjà actif dans cette maison.';
  }
  return null;
}

async function insertSubscription(companyId, payload, dateForCode) {
  const code = await genCode('subscriptions', 'S', payload.date_souscription || dateForCode);
  const info = await db.prepare(
    `INSERT INTO subscriptions
     (company_id, code, property_id, tenant_id, date_souscription, montant_loyer, nombre_mois_caution,
      montant_caution, nombre_mois_avance, montant_avance, nombre_mois_garantie, montant_garantie,
      autre_frais, montant_autre_frais, date_entree, date_debut_paiement, statut)
     VALUES (@company_id,@code,@property_id,@tenant_id,@date_souscription,@montant_loyer,@nombre_mois_caution,
      @montant_caution,@nombre_mois_avance,@montant_avance,@nombre_mois_garantie,@montant_garantie,
      @autre_frais,@montant_autre_frais,@date_entree,@date_debut_paiement,@statut)`
  ).run({ company_id: companyId, code, ...payload });
  return db.prepare(`${SUB_SELECT} WHERE s.id = ? AND s.company_id = ?`).get(info.lastInsertRowid, companyId);
}

router.post('/subscriptions', wrap(async (req, res) => {
  const cid = req.companyId;
  const s = subscriptionPayload(req.body);
  const err = await validateSubscription(s, cid);
  if (err) return res.status(400).json({ error: err });
  const saved = await insertSubscription(cid, s, s.date_souscription);
  await logAction(req, 'Création', 'Souscription', saved && saved.code);
  res.json(saved);
}));

router.put('/subscriptions/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const s = subscriptionPayload(req.body);
  const err = await validateSubscription(s, cid, id);
  if (err) return res.status(400).json({ error: err });
  await db.prepare(
    `UPDATE subscriptions SET
       property_id=@property_id, tenant_id=@tenant_id, date_souscription=@date_souscription,
       montant_loyer=@montant_loyer, nombre_mois_caution=@nombre_mois_caution, montant_caution=@montant_caution,
       nombre_mois_avance=@nombre_mois_avance, montant_avance=@montant_avance,
       nombre_mois_garantie=@nombre_mois_garantie, montant_garantie=@montant_garantie, autre_frais=@autre_frais,
       montant_autre_frais=@montant_autre_frais, date_entree=@date_entree,
       date_debut_paiement=@date_debut_paiement, statut=@statut
     WHERE id=@id AND company_id=@company_id`
  ).run({ id, company_id: cid, ...s });
  const updated = await db.prepare(`${SUB_SELECT} WHERE s.id = ? AND s.company_id = ?`).get(id, cid);
  await logAction(req, 'Modification', 'Souscription', updated && updated.code);
  res.json(updated);
}));

router.delete('/subscriptions/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const row = await db.prepare('SELECT code FROM subscriptions WHERE id = ? AND company_id = ?').get(id, req.companyId);
  await db.prepare('DELETE FROM subscriptions WHERE id = ? AND company_id = ?').run(id, req.companyId);
  if (row) await logAction(req, 'Suppression', 'Souscription', row.code);
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
    const montantLoyer = toInt(line && line.montant_loyer) || toInt(prop.cout_loyer);
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
  const property = await db.prepare(`${PROPERTY_SELECT} WHERE p.id = ? AND p.company_id = ?`).get(id, cid);
  if (!property) return res.status(404).json({ error: 'Bien introuvable.' });

  const [subs, repairs, allPayments, payoutRows] = await Promise.all([
    db.prepare(`${SUB_SELECT} WHERE s.property_id = ? AND s.company_id = ? ORDER BY s.statut, s.id DESC`).all(id, cid),
    db.prepare('SELECT * FROM repairs WHERE property_id = ? AND company_id = ? ORDER BY annee DESC, id DESC').all(id, cid),
    db.prepare(
      `SELECT r.id, r.code, r.date, r.mois_concerne, r.annee_concernee,
              r.montant_a_payer, r.montant_paye, r.reste_a_payer, r.statut, r.numero_recu,
              r.payout_id, s.code AS subscription_code, t.nom_prenoms AS tenant_nom,
              t.contact AS tenant_contact
       FROM payments r
       LEFT JOIN subscriptions s ON s.id = r.subscription_id
       LEFT JOIN tenants t ON t.id = r.tenant_id
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

  for (const s of subs) {
    const pays = await db.prepare(
      `SELECT id, code, date, mois_concerne, annee_concernee, montant_a_payer, montant_paye, reste_a_payer, statut
       FROM payments WHERE subscription_id = ? AND company_id = ? ORDER BY annee_concernee, id`
    ).all(s.id, cid);

    const paidBy = {};
    let total_paye = 0;
    for (const p of pays) {
      const k = `${p.annee_concernee}-${p.mois_concerne}`;
      paidBy[k] = (paidBy[k] || 0) + (p.montant_paye || 0);
      total_paye += p.montant_paye || 0;
    }

    const loyer = s.montant_loyer || 0;
    // L'echeancier n'est calcule que pour les baux actifs (loyers attendus).
    let echeancier = [];
    if (s.statut === 'Active' && s.date_debut_paiement) {
      echeancier = monthsUntilNow(s.date_debut_paiement).map((mm) => {
        const paye = paidBy[`${mm.annee}-${mm.mois}`] || 0;
        const statut = (loyer > 0 && paye >= loyer) ? 'Payé' : (paye > 0 ? 'Partiel' : 'Impayé');
        return { annee: mm.annee, mois: mm.mois, attendu: loyer, paye, reste: Math.max(0, loyer - paye), statut };
      });
    }
    const total_attendu = echeancier.reduce((a, m) => a + m.attendu, 0);
    const reste = echeancier.reduce((a, m) => a + m.reste, 0);
    const mois_retard = echeancier.filter((m) => m.reste > 0).length;

    s.paiements = pays;
    s.echeancier = echeancier;
    s.resume = { nb_paiements: pays.length, total_attendu, total_paye, reste, mois_retard };
  }

  const payoutLineRows = await db.prepare(
    `SELECT r.payout_id, r.id, r.code, r.date, r.mois_concerne, r.annee_concernee, r.montant_paye,
            p.part_commission, t.nom_prenoms AS tenant_nom
     FROM payments r
     LEFT JOIN properties p ON p.id = r.property_id
     LEFT JOIN tenants t ON t.id = r.tenant_id
     WHERE r.property_id = ? AND r.company_id = ? AND r.payout_id IS NOT NULL
     ORDER BY r.annee_concernee, r.id`
  ).all(id, cid);
  const linesByPayout = payoutLineRows.reduce((acc, l) => {
    l.commission = Math.round((l.montant_paye * (l.part_commission || 0)) / 100);
    l.net = l.montant_paye - l.commission;
    (acc[l.payout_id] ||= []).push(l);
    return acc;
  }, {});
  const payouts = payoutRows.map((v) => ({ ...v, lignes_bien: linesByPayout[v.id] || [] }));

  const totals = {
    total_paye: allPayments.reduce((a, p) => a + (p.montant_paye || 0), 0),
    total_reste: allPayments.reduce((a, p) => a + (p.reste_a_payer || 0), 0),
    total_reparations: repairs.reduce((a, r) => a + (r.montant || 0), 0),
    total_reversements_net: payouts.reduce((a, v) => a + (v.lignes_bien || []).reduce((b, l) => b + (l.net || 0), 0), 0),
    nombre_locataires: subs.length,
    nombre_locataires_actifs: subs.filter((s) => s.statut === 'Active').length,
  };

  res.json({ property, subscriptions: subs, repairs, payments: allPayments, payouts, totals });
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
// RECOUVREMENT : rapport mensuel par ZONE (quartier) -> MAISON -> LOCATAIRE.
// Tout est calcule automatiquement a partir des paiements enregistres.
//   - montant du   = mois attendus (depuis le debut du bail jusqu'au mois choisi) x loyer
//   - montant paye = somme encaissee pour ces periodes
//   - ecart        = du - paye (impayes)
//   - commission partielle = taux du bien x paye   (commission reellement gagnee)
//   - commission generale  = taux du bien x du     (commission sur le total du)
//   - solde (a reverser)   = paye - reparations - commission generale  (peut etre negatif)
// ===========================================================================
router.get('/recouvrement', wrap(async (req, res) => {
  const cid = req.companyId;
  const now = new Date();
  const moisSel = clean(req.query.mois) || MOIS[now.getMonth()];
  const anneeSel = toInt(req.query.annee) || now.getFullYear();
  const emIndex = MOIS.indexOf(moisSel) + 1;
  if (emIndex < 1) return res.status(400).json({ error: 'Mois invalide.' });

  const [subs, pays, reps] = await Promise.all([
    db.prepare(
      `SELECT s.id, s.montant_loyer, s.date_debut_paiement, s.montant_avance,
              p.id AS property_id, p.code AS property_code, p.designation, p.type_construction,
              p.ville, p.commune, p.quartier, p.part_commission,
              o.id AS owner_id, o.nom_prenoms AS owner_nom, o.contact AS owner_contact,
              t.nom_prenoms AS tenant_nom
       FROM subscriptions s
       JOIN properties p ON p.id = s.property_id
       LEFT JOIN owners o ON o.id = p.owner_id
       LEFT JOIN tenants t ON t.id = s.tenant_id
       WHERE s.company_id = ? AND s.statut = 'Active'`
    ).all(cid),
    db.prepare('SELECT subscription_id, mois_concerne, annee_concernee, mois_payes, nombre_mois_payes, montant_paye, numero_recu FROM payments WHERE company_id = ?').all(cid),
    db.prepare('SELECT property_id, montant FROM repairs WHERE company_id = ? AND mois = ? AND annee = ?').all(cid, moisSel, anneeSel),
  ]);

  const within = (mo, an) => (an < anneeSel || (an === anneeSel && (MOIS.indexOf(mo) + 1) <= emIndex));
  const payBySub = buildPaidMonthMap(pays.filter((p) => {
    const periods = parsePeriods(p.mois_payes, p.mois_concerne, p.annee_concernee);
    return periods.some((per) => within(per.mois, per.annee));
  }));
  const repByProp = new Map();
  for (const r of reps) repByProp.set(r.property_id, (repByProp.get(r.property_id) || 0) + (r.montant || 0));

  const maisons = new Map();
  for (const s of subs) {
    const loyer = s.montant_loyer || 0;
    const months = monthsUntil(s.date_debut_paiement, anneeSel, emIndex);
    const pe = payBySub.get(s.id) || { paid: new Map(), total: 0, lastRecu: null };
    const summary = summarizeRecoveryMonths(months, pe, loyer);
    const montantDu = summary.montant_du;
    const montantPaye = summary.montant_paye;

    let M = maisons.get(s.property_id);
    if (!M) {
      M = {
        property_id: s.property_id, code: s.property_code, designation: s.designation, type: s.type_construction,
        zone: s.quartier || s.commune || s.ville || 'Sans zone',
        owner_id: s.owner_id, owner_nom: s.owner_nom, owner_contact: s.owner_contact,
        part_commission: s.part_commission || 0, locataires: [], total_du: 0, total_paye: 0,
      };
      maisons.set(s.property_id, M);
    }
    M.locataires.push({
      tenant_nom: s.tenant_nom, designation: s.designation, loyer,
      mois_payes: summary.mois_payes, mois_payes_liste: summary.mois_payes_liste,
      mois_dus: summary.mois_dus, mois_dus_liste: summary.mois_dus_liste,
      mois_credit: summary.mois_credit, mois_credit_liste: summary.mois_credit_liste,
      montant_du: montantDu, montant_paye: montantPaye, ecart: summary.ecart,
      avance: s.montant_avance || 0, numero_recu: pe.lastRecu,
    });
    M.total_du += montantDu;
    M.total_paye += montantPaye;
  }

  const FIELDS = ['total_du', 'total_paye', 'ecart', 'reparations', 'commission_partielle', 'commission_generale', 'solde'];
  const zones = new Map();
  const recap = Object.fromEntries(FIELDS.map((k) => [k, 0]));
  for (const M of maisons.values()) {
    const taux = M.part_commission || 0;
    M.reparations = repByProp.get(M.property_id) || 0;
    M.ecart = Math.max(0, M.total_du - M.total_paye);
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

  res.json({ mois: moisSel, annee: anneeSel, zones: zonesArr, recap });
}));

// ===========================================================================
// REGLEMENTS / PAIEMENTS
// ===========================================================================
const PAY_SELECT = `
  SELECT r.*, p.code AS property_code, p.type_construction, p.nombre_piece, p.designation, p.cout_loyer,
         t.nom_prenoms AS tenant_nom, t.contact AS tenant_contact,
         s.code AS subscription_code
  FROM payments r
  LEFT JOIN properties p ON p.id = r.property_id
  LEFT JOIN tenants t ON t.id = r.tenant_id
  LEFT JOIN subscriptions s ON s.id = r.subscription_id
`;

router.get('/payments', wrap(async (req, res) => {
  const q = clean(req.query.q);
  const mois = clean(req.query.mois);
  const annee = clean(req.query.annee);
  const statut = clean(req.query.statut);
  let rows = await db.prepare(`${PAY_SELECT} WHERE r.company_id = ? ORDER BY r.id DESC`).all(req.companyId);
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

  // On complete automatiquement le bien, le locataire et le loyer du a partir
  // de la souscription choisie (en restant dans la meme entreprise).
  if (subscription_id) {
    const sub = await db.prepare('SELECT * FROM subscriptions WHERE id = ? AND company_id = ?').get(subscription_id, companyId);
    if (sub) {
      if (!property_id) property_id = sub.property_id;
      if (!tenant_id) tenant_id = sub.tenant_id;
      if (!montant_a_payer) montant_a_payer = sub.montant_loyer;
    } else {
      subscription_id = null;
    }
  }

  const montant_paye = toInt(body.montant_paye);
  const normalized = normalizePaidMonths({
    ...body,
    montant_a_payer,
    montant_paye,
    loyer: montant_a_payer,
  });
  const duePeriods = parsePeriods(body.mois_dus, null, body.annee_concernee);
  const reste = normalized.reste;
  return {
    subscription_id,
    property_id,
    tenant_id,
    date: clean(body.date),
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
  const row = await db.prepare('SELECT code FROM payments WHERE id = ? AND company_id = ?').get(id, req.companyId);
  await db.prepare('DELETE FROM payments WHERE id = ? AND company_id = ?').run(id, req.companyId);
  if (row) await logAction(req, 'Suppression', 'Règlement', row.code);
  res.json({ ok: true });
}));

// Encaissement multiple : enregistre le loyer du mois pour plusieurs souscriptions.
router.post('/payments/bulk', wrap(async (req, res) => {
  const cid = req.companyId;
  const date = clean(req.body.date);
  const mois = clean(req.body.mois);
  const annee = toInt(req.body.annee);
  const ids = Array.isArray(req.body.subscription_ids) ? req.body.subscription_ids.map(toInt) : [];
  if (!mois || !annee) return res.status(400).json({ error: 'Mois et année concernés requis.' });
  if (ids.length === 0) return res.status(400).json({ error: 'Veuillez sélectionner au moins une souscription.' });

  let crees = 0;
  let ignores = 0;
  for (const sid of ids) {
    const sub = await db.prepare("SELECT * FROM subscriptions WHERE id = ? AND company_id = ? AND statut='Active'").get(sid, cid);
    if (!sub) { ignores++; continue; }
    const exist = await db.prepare(
      'SELECT 1 FROM payments WHERE subscription_id=? AND company_id=? AND mois_concerne=? AND annee_concernee=?'
    ).get(sid, cid, mois, annee);
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
  LEFT JOIN owners o ON o.id = v.owner_id
`;

// Detail (par paiement) des loyers encaisses NON encore reverses pour un
// proprietaire ; renvoie aussi les totaux (loyers, commission, net).
async function dueForOwner(companyId, ownerId) {
  const lignes = await db.prepare(
    `SELECT r.id, r.code, r.date, r.mois_concerne, r.annee_concernee, r.montant_paye,
            p.code AS property_code, p.part_commission, t.nom_prenoms AS tenant_nom
     FROM payments r
     JOIN properties p ON p.id = r.property_id
     LEFT JOIN tenants t ON t.id = r.tenant_id
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
     JOIN properties p ON p.id = r.property_id
     JOIN owners o ON o.id = p.owner_id
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
     LEFT JOIN properties p ON p.id = r.property_id
     LEFT JOIN tenants t ON t.id = r.tenant_id
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

  const loyers = selected.reduce((a, l) => a + l.montant_paye, 0);
  const commission = selected.reduce((a, l) => a + l.commission, 0);
  const net = loyers - commission;
  const dates = selected.map((l) => l.date).filter(Boolean).sort();
  const date = clean(req.body.date) || new Date().toISOString().slice(0, 10);

  const code = await genCode('payouts', 'V', date);
  const payoutId = (await db.prepare(
    `INSERT INTO payouts
       (company_id, code, owner_id, date, periode_debut, periode_fin,
        nombre_paiements, montant_loyers, montant_commission, montant_net, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    cid, code, ownerId, date, dates[0] || null, dates[dates.length - 1] || null,
    selected.length, loyers, commission, net, clean(req.body.note) || null
  )).lastInsertRowid;

  for (const l of selected) {
    await db.prepare('UPDATE payments SET payout_id = ? WHERE id = ? AND company_id = ?').run(payoutId, l.id, cid);
  }
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

  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const [
    proprietaires, locataires, maisons, occupees,
    caution, avance, loyer, attendu, encaisseMois, impayesNb, impayesMt, aReverser,
    derniers_paiements, allProps,
  ] = await Promise.all([
    one('SELECT COUNT(*) n FROM owners WHERE company_id = ?', cid),
    one('SELECT COUNT(*) n FROM tenants WHERE company_id = ?', cid),
    one('SELECT COUNT(*) n FROM properties WHERE company_id = ?', cid),
    one("SELECT COUNT(DISTINCT property_id) n FROM subscriptions WHERE company_id = ? AND statut='Active' AND property_id IS NOT NULL", cid),
    one('SELECT COALESCE(SUM(montant_caution),0) s FROM subscriptions WHERE company_id = ?', cid),
    one('SELECT COALESCE(SUM(montant_avance),0) s FROM subscriptions WHERE company_id = ?', cid),
    one('SELECT COALESCE(SUM(montant_paye),0) s FROM payments WHERE company_id = ?', cid),
    one("SELECT COALESCE(SUM(montant_loyer),0) s FROM subscriptions WHERE company_id = ? AND statut='Active'", cid),
    one('SELECT COALESCE(SUM(montant_paye),0) s FROM payments WHERE company_id = ? AND mois_concerne=? AND annee_concernee=?', cid, moisCourant, anneeCourante),
    one("SELECT COUNT(*) n FROM payments WHERE company_id = ? AND statut='Non soldé'", cid),
    one("SELECT COALESCE(SUM(reste_a_payer),0) s FROM payments WHERE company_id = ? AND statut='Non soldé'", cid),
    one(`SELECT COALESCE(SUM(r.montant_paye - ROUND(r.montant_paye * COALESCE(p.part_commission,0) / 100.0)), 0) s
         FROM payments r JOIN properties p ON p.id = r.property_id
         WHERE r.company_id = ? AND r.payout_id IS NULL AND r.montant_paye > 0`, cid),
    db.prepare(`${PAY_SELECT} WHERE r.company_id = ? ORDER BY r.id DESC LIMIT 6`).all(cid),
    db.prepare(`${PROPERTY_SELECT} WHERE p.company_id = ?`).all(cid),
  ]);

  const nb_maisons = maisons.n;
  const nb_occupees = occupees.n;
  const data = {
    moisCourant,
    anneeCourante,
    nb_proprietaires: proprietaires.n,
    nb_locataires: locataires.n,
    nb_maisons,
    nb_occupees,
    nb_disponibles: nb_maisons - nb_occupees,
    total_caution: caution.s,
    total_avance: avance.s,
    total_loyer: loyer.s,
    loyer_attendu: attendu.s,
    loyer_encaisse_mois: encaisseMois.s,
    impayes_nombre: impayesNb.n,
    impayes_montant: impayesMt.s,
    reste_a_reverser: aReverser.s,
  };
  data.reste_attendu_mois = Math.max(0, data.loyer_attendu - data.loyer_encaisse_mois);
  data.derniers_paiements = derniers_paiements;
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
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
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
const DATA_TABLES = ['owners', 'tenants', 'properties', 'subscriptions', 'payouts', 'payments', 'repairs'];

dataRouter.get('/export', requireRole('admin'), wrap(async (req, res) => {
  const cid = req.companyId;
  const [company, owners, tenants, properties, subscriptions, payouts, payments, repairs] = await Promise.all([
    db.prepare('SELECT nom, telephone, email, adresse, devise FROM companies WHERE id = ?').get(cid),
    db.prepare('SELECT * FROM owners WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM tenants WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM properties WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM subscriptions WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM payouts WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM payments WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM repairs WHERE company_id = ? ORDER BY id').all(cid),
  ]);

  const data = {
    format: 'nouvelafric.sauvegarde',
    version: 1,
    exporte_le: new Date().toISOString(),
    entreprise: company || null,
    donnees: { owners, tenants, properties, subscriptions, payouts, payments, repairs },
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

  if (![owners, tenants, properties, subscriptions, payouts, payments, repairs].some((a) => a.length)) {
    return res.status(400).json({ error: 'Fichier de sauvegarde vide ou invalide.' });
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
  const counts = { owners: 0, tenants: 0, properties: 0, subscriptions: 0, payouts: 0, payments: 0, repairs: 0 };

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
      'INSERT INTO tenants (company_id, nom_prenoms, contact, email, adresse, caution) VALUES (?,?,?,?,?,?)'
    ).run(cid, clean(t.nom_prenoms) || 'Sans nom', clean(t.contact), clean(t.email), clean(t.adresse), toInt(t.caution))).lastInsertRowid;
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
    const id = (await db.prepare(
      `INSERT INTO subscriptions
       (company_id, code, property_id, tenant_id, date_souscription, montant_loyer,
        nombre_mois_caution, montant_caution, nombre_mois_avance, montant_avance,
        nombre_mois_garantie, montant_garantie, autre_frais, montant_autre_frais,
        date_entree, date_debut_paiement, statut)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      cid, code, propertyMap.get(s.property_id) || null, tenantMap.get(s.tenant_id) || null,
      clean(s.date_souscription) || null, toInt(s.montant_loyer),
      toInt(s.nombre_mois_caution), toInt(s.montant_caution),
      toInt(s.nombre_mois_avance), toInt(s.montant_avance),
      toInt(s.nombre_mois_garantie), toInt(s.montant_garantie),
      clean(s.autre_frais), toInt(s.montant_autre_frais),
      clean(s.date_entree) || null, clean(s.date_debut_paiement) || null,
      clean(s.statut) || 'Active'
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
       (company_id, code, subscription_id, property_id, tenant_id, date, montant_a_payer, montant_paye, reste_a_payer, mois_concerne, annee_concernee, statut, payout_id, numero_recu)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      cid, code, subscriptionMap.get(p.subscription_id) || null,
      propertyMap.get(p.property_id) || null, tenantMap.get(p.tenant_id) || null,
      clean(p.date) || null, toInt(p.montant_a_payer), toInt(p.montant_paye), toInt(p.reste_a_payer),
      clean(p.mois_concerne), p.annee_concernee != null ? toInt(p.annee_concernee) : null,
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

  res.json({ ok: true, mode, importe: counts });
}));

module.exports = { router, settingsRouter, subscriptionRouter, dataRouter };
