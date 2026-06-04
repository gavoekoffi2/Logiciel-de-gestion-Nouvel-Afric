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

function typeCode(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('immeuble')) return 'MI';
  if (t.includes('basse')) return 'MB';
  if (t.includes('compos')) return 'MC';
  return 'MX';
}

// Les codes restent uniques au niveau global (le suffixe aleatoire l'assure).
async function codeExists(table, code) {
  return !!(await db.prepare(`SELECT 1 FROM ${table} WHERE code = ?`).get(code));
}

async function genPropertyCode(type, pieces, cout, dateStr) {
  const base = `${typeCode(type)}_P${toInt(pieces)}_C${toInt(cout)}_M${dateCode(dateStr)}`;
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
    'INSERT INTO owners (company_id, nom_prenoms, contact, email, adresse) VALUES (?,?,?,?,?)'
  ).run(cid, p.nom_prenoms, p.contact, p.email, p.adresse);
  res.json(await db.prepare('SELECT * FROM owners WHERE id = ?').get(info.lastInsertRowid));
}));

router.put('/owners/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const p = personPayload(req.body);
  const err = await validatePerson(p, 'owners', cid, id, 'propriétaire');
  if (err) return res.status(400).json({ error: err });
  await db.prepare(
    'UPDATE owners SET nom_prenoms=?, contact=?, email=?, adresse=? WHERE id=? AND company_id=?'
  ).run(p.nom_prenoms, p.contact, p.email, p.adresse, id, cid);
  res.json(await db.prepare('SELECT * FROM owners WHERE id = ? AND company_id = ?').get(id, cid));
}));

router.delete('/owners/:id', wrap(async (req, res) => {
  await db.prepare('DELETE FROM owners WHERE id = ? AND company_id = ?').run(toInt(req.params.id), req.companyId);
  res.json({ ok: true });
}));

// ===========================================================================
// LOCATAIRES
// ===========================================================================
router.get('/tenants', wrap(async (req, res) => {
  const cid = req.companyId;
  const q = clean(req.query.q);
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = await db.prepare(
      `SELECT * FROM tenants
       WHERE company_id = ? AND (nom_prenoms LIKE ? OR contact LIKE ? OR email LIKE ? OR adresse LIKE ?)
       ORDER BY nom_prenoms COLLATE NOCASE`
    ).all(cid, like, like, like, like);
  } else {
    rows = await db.prepare('SELECT * FROM tenants WHERE company_id = ? ORDER BY nom_prenoms COLLATE NOCASE').all(cid);
  }
  res.json(rows);
}));

router.post('/tenants', wrap(async (req, res) => {
  const cid = req.companyId;
  const p = personPayload(req.body);
  const err = await validatePerson(p, 'tenants', cid, 0, 'locataire');
  if (err) return res.status(400).json({ error: err });
  const info = await db.prepare(
    'INSERT INTO tenants (company_id, nom_prenoms, contact, email, adresse) VALUES (?,?,?,?,?)'
  ).run(cid, p.nom_prenoms, p.contact, p.email, p.adresse);
  res.json(await db.prepare('SELECT * FROM tenants WHERE id = ?').get(info.lastInsertRowid));
}));

router.put('/tenants/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const p = personPayload(req.body);
  const err = await validatePerson(p, 'tenants', cid, id, 'locataire');
  if (err) return res.status(400).json({ error: err });
  await db.prepare(
    'UPDATE tenants SET nom_prenoms=?, contact=?, email=?, adresse=? WHERE id=? AND company_id=?'
  ).run(p.nom_prenoms, p.contact, p.email, p.adresse, id, cid);
  res.json(await db.prepare('SELECT * FROM tenants WHERE id = ? AND company_id = ?').get(id, cid));
}));

router.delete('/tenants/:id', wrap(async (req, res) => {
  await db.prepare('DELETE FROM tenants WHERE id = ? AND company_id = ?').run(toInt(req.params.id), req.companyId);
  res.json({ ok: true });
}));

// ===========================================================================
// MAISONS / BIENS
// ===========================================================================
const PROPERTY_SELECT = `
  SELECT p.*, o.nom_prenoms AS owner_nom, o.contact AS owner_contact,
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

// Maisons disponibles (pour une nouvelle souscription).
router.get('/properties/available', wrap(async (req, res) => {
  const current = toInt(req.query.current); // bien deja lie (en modification)
  const rows = (await db.prepare(`${PROPERTY_SELECT} WHERE p.company_id = ?`).all(req.companyId))
    .filter((r) => r.statut === 'Disponible' || r.id === current);
  res.json(rows);
}));

function propertyPayload(body) {
  return {
    owner_id: toInt(body.owner_id) || null,
    type_construction: clean(body.type_construction),
    nombre_piece: toInt(body.nombre_piece),
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
  if (!p.type_construction) return 'Veuillez sélectionner le type de construction.';
  if (!p.nombre_piece) return 'Veuillez saisir le nombre de pièces.';
  if (!p.cout_loyer) return 'Veuillez saisir le coût du loyer.';
  if (p.part_commission > 100) return 'La part de commission doit être inférieure ou égale à 100.';
  return null;
}

router.post('/properties', wrap(async (req, res) => {
  const cid = req.companyId;
  const p = propertyPayload(req.body);
  const err = await validateProperty(p, cid);
  if (err) return res.status(400).json({ error: err });
  const code = await genPropertyCode(p.type_construction, p.nombre_piece, p.cout_loyer, req.body.date);
  const info = await db.prepare(
    `INSERT INTO properties
     (company_id, code, owner_id, type_construction, nombre_piece, cout_loyer, ville, commune, quartier, observation, part_commission, nombre_porte)
     VALUES (@company_id,@code,@owner_id,@type_construction,@nombre_piece,@cout_loyer,@ville,@commune,@quartier,@observation,@part_commission,@nombre_porte)`
  ).run({ company_id: cid, code, ...p });
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
       cout_loyer=@cout_loyer, ville=@ville, commune=@commune, quartier=@quartier,
       observation=@observation, part_commission=@part_commission, nombre_porte=@nombre_porte
     WHERE id=@id AND company_id=@company_id`
  ).run({ id, company_id: cid, ...p });
  res.json(await db.prepare(`${PROPERTY_SELECT} WHERE p.id = ? AND p.company_id = ?`).get(id, cid));
}));

router.delete('/properties/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const sub = await db.prepare("SELECT 1 FROM subscriptions WHERE property_id = ? AND company_id = ? AND statut='Active'").get(id, cid);
  if (sub) return res.status(400).json({ error: 'Impossible de supprimer : ce bien a une souscription active.' });
  await db.prepare('DELETE FROM properties WHERE id = ? AND company_id = ?').run(id, cid);
  res.json({ ok: true });
}));

// ===========================================================================
// SOUSCRIPTIONS / BAUX
// ===========================================================================
const SUB_SELECT = `
  SELECT s.*, p.code AS property_code, p.type_construction, p.nombre_piece,
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
  return {
    property_id: toInt(body.property_id) || null,
    tenant_id: toInt(body.tenant_id) || null,
    date_souscription: clean(body.date_souscription),
    montant_loyer,
    nombre_mois_caution: nbCaution,
    montant_caution: body.montant_caution !== undefined ? toInt(body.montant_caution) : nbCaution * montant_loyer,
    nombre_mois_avance: nbAvance,
    montant_avance: body.montant_avance !== undefined ? toInt(body.montant_avance) : nbAvance * montant_loyer,
    autre_frais: clean(body.autre_frais),
    montant_autre_frais: toInt(body.montant_autre_frais),
    date_entree: clean(body.date_entree),
    date_debut_paiement: clean(body.date_debut_paiement),
    statut: clean(body.statut) || 'Active',
  };
}

async function validateSubscription(s, companyId) {
  if (!s.property_id) return 'Veuillez sélectionner le bien (maison).';
  if (!s.tenant_id) return 'Veuillez sélectionner le locataire.';
  const prop = await db.prepare('SELECT 1 FROM properties WHERE id = ? AND company_id = ?').get(s.property_id, companyId);
  if (!prop) return 'Bien introuvable.';
  const ten = await db.prepare('SELECT 1 FROM tenants WHERE id = ? AND company_id = ?').get(s.tenant_id, companyId);
  if (!ten) return 'Locataire introuvable.';
  if (!s.montant_loyer) return 'Le montant du loyer est requis.';
  if (!s.date_entree) return 'Veuillez saisir la date d’entrée.';
  if (!s.date_debut_paiement) return 'Veuillez saisir la date de début de paiement.';
  return null;
}

router.post('/subscriptions', wrap(async (req, res) => {
  const cid = req.companyId;
  const s = subscriptionPayload(req.body);
  const err = await validateSubscription(s, cid);
  if (err) return res.status(400).json({ error: err });
  const code = await genCode('subscriptions', 'S', s.date_souscription);
  const info = await db.prepare(
    `INSERT INTO subscriptions
     (company_id, code, property_id, tenant_id, date_souscription, montant_loyer, nombre_mois_caution,
      montant_caution, nombre_mois_avance, montant_avance, autre_frais, montant_autre_frais,
      date_entree, date_debut_paiement, statut)
     VALUES (@company_id,@code,@property_id,@tenant_id,@date_souscription,@montant_loyer,@nombre_mois_caution,
      @montant_caution,@nombre_mois_avance,@montant_avance,@autre_frais,@montant_autre_frais,
      @date_entree,@date_debut_paiement,@statut)`
  ).run({ company_id: cid, code, ...s });
  res.json(await db.prepare(`${SUB_SELECT} WHERE s.id = ?`).get(info.lastInsertRowid));
}));

router.put('/subscriptions/:id', wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const s = subscriptionPayload(req.body);
  const err = await validateSubscription(s, cid);
  if (err) return res.status(400).json({ error: err });
  await db.prepare(
    `UPDATE subscriptions SET
       property_id=@property_id, tenant_id=@tenant_id, date_souscription=@date_souscription,
       montant_loyer=@montant_loyer, nombre_mois_caution=@nombre_mois_caution, montant_caution=@montant_caution,
       nombre_mois_avance=@nombre_mois_avance, montant_avance=@montant_avance, autre_frais=@autre_frais,
       montant_autre_frais=@montant_autre_frais, date_entree=@date_entree,
       date_debut_paiement=@date_debut_paiement, statut=@statut
     WHERE id=@id AND company_id=@company_id`
  ).run({ id, company_id: cid, ...s });
  res.json(await db.prepare(`${SUB_SELECT} WHERE s.id = ? AND s.company_id = ?`).get(id, cid));
}));

router.delete('/subscriptions/:id', wrap(async (req, res) => {
  await db.prepare('DELETE FROM subscriptions WHERE id = ? AND company_id = ?').run(toInt(req.params.id), req.companyId);
  res.json({ ok: true });
}));

// ===========================================================================
// REGLEMENTS / PAIEMENTS
// ===========================================================================
const PAY_SELECT = `
  SELECT r.*, p.code AS property_code, p.type_construction, p.nombre_piece, p.cout_loyer,
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
  const reste = Math.max(0, montant_a_payer - montant_paye);
  return {
    subscription_id,
    property_id,
    tenant_id,
    date: clean(body.date),
    montant_a_payer,
    montant_paye,
    reste_a_payer: reste,
    mois_concerne: clean(body.mois_concerne),
    annee_concernee: toInt(body.annee_concernee),
    statut: reste <= 0 ? 'Soldé' : 'Non soldé',
  };
}

function validatePayment(r) {
  if (!r.property_id) return 'Veuillez sélectionner la souscription / le bien concerné.';
  if (!r.tenant_id) return 'Le locataire est requis.';
  if (!r.mois_concerne) return 'Veuillez sélectionner le mois concerné.';
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
      reste_a_payer, mois_concerne, annee_concernee, statut)
     VALUES (@company_id,@code,@subscription_id,@property_id,@tenant_id,@date,@montant_a_payer,@montant_paye,
      @reste_a_payer,@mois_concerne,@annee_concernee,@statut)`
  ).run({ company_id: cid, code, ...r });
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
       mois_concerne=@mois_concerne, annee_concernee=@annee_concernee, statut=@statut
     WHERE id=@id AND company_id=@company_id`
  ).run({ id, company_id: cid, ...r });
  res.json(await db.prepare(`${PAY_SELECT} WHERE r.id = ? AND r.company_id = ?`).get(id, cid));
}));

router.delete('/payments/:id', wrap(async (req, res) => {
  await db.prepare('DELETE FROM payments WHERE id = ? AND company_id = ?').run(toInt(req.params.id), req.companyId);
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
        reste_a_payer, mois_concerne, annee_concernee, statut)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(cid, code, sub.id, sub.property_id, sub.tenant_id, date || null,
      sub.montant_loyer, sub.montant_loyer, 0, mois, annee, 'Soldé');
    crees++;
  }
  res.json({ ok: true, crees, ignores });
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
    caution, avance, loyer, attendu, encaisseMois, impayesNb, impayesMt,
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
  const role = clean(req.body.role) === 'admin' ? 'admin' : 'secretaire';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail invalide.' });
  if (!password) return res.status(400).json({ error: 'Mot de passe requis.' });
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(400).json({ error: 'Cette adresse e-mail est déjà utilisée.' });
  }
  const info = await db.prepare(
    'INSERT INTO users (username, email, password, nom, role, company_id) VALUES (NULL, ?, ?, ?, ?, ?)'
  ).run(email, hashPassword(password), nom, role, cid);
  res.json(publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
}));

router.put('/users/:id', requireRole('admin'), wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  const user = await db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(id, cid);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const nom = clean(req.body.nom) || user.nom;
  const role = clean(req.body.role) === 'admin' ? 'admin' : 'secretaire';
  const actif = req.body.actif === undefined ? user.actif : (req.body.actif ? 1 : 0);
  const password = clean(req.body.password);
  if (password) {
    await db.prepare('UPDATE users SET nom=?, role=?, actif=?, password=? WHERE id=? AND company_id=?')
      .run(nom, role, actif, hashPassword(password), id, cid);
  } else {
    await db.prepare('UPDATE users SET nom=?, role=?, actif=? WHERE id=? AND company_id=?').run(nom, role, actif, id, cid);
  }
  res.json(publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
}));

router.delete('/users/:id', requireRole('admin'), wrap(async (req, res) => {
  const cid = req.companyId;
  const id = toInt(req.params.id);
  if (id === req.userId) return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
  await db.prepare('DELETE FROM users WHERE id = ? AND company_id = ?').run(id, cid);
  res.json({ ok: true });
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

  await db.prepare(
    'UPDATE companies SET nom=?, telephone=?, email=?, adresse=?, devise=?, logo=? WHERE id=?'
  ).run(
    clean(b.entreprise) || 'Mon entreprise',
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
const DATA_TABLES = ['owners', 'tenants', 'properties', 'subscriptions', 'payments'];

dataRouter.get('/export', requireRole('admin'), wrap(async (req, res) => {
  const cid = req.companyId;
  const [company, owners, tenants, properties, subscriptions, payments] = await Promise.all([
    db.prepare('SELECT nom, telephone, email, adresse, devise FROM companies WHERE id = ?').get(cid),
    db.prepare('SELECT * FROM owners WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM tenants WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM properties WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM subscriptions WHERE company_id = ? ORDER BY id').all(cid),
    db.prepare('SELECT * FROM payments WHERE company_id = ? ORDER BY id').all(cid),
  ]);

  const data = {
    format: 'nouvelafric.sauvegarde',
    version: 1,
    exporte_le: new Date().toISOString(),
    entreprise: company || null,
    donnees: { owners, tenants, properties, subscriptions, payments },
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
  const payments = list('payments');

  if (!owners.length && !tenants.length && !properties.length && !subscriptions.length && !payments.length) {
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
  const counts = { owners: 0, tenants: 0, properties: 0, subscriptions: 0, payments: 0 };

  for (const o of owners) {
    const id = (await db.prepare(
      'INSERT INTO owners (company_id, nom_prenoms, contact, email, adresse) VALUES (?,?,?,?,?)'
    ).run(cid, clean(o.nom_prenoms) || 'Sans nom', clean(o.contact), clean(o.email), clean(o.adresse))).lastInsertRowid;
    if (o.id != null) ownerMap.set(o.id, id);
    counts.owners++;
  }

  for (const t of tenants) {
    const id = (await db.prepare(
      'INSERT INTO tenants (company_id, nom_prenoms, contact, email, adresse) VALUES (?,?,?,?,?)'
    ).run(cid, clean(t.nom_prenoms) || 'Sans nom', clean(t.contact), clean(t.email), clean(t.adresse))).lastInsertRowid;
    if (t.id != null) tenantMap.set(t.id, id);
    counts.tenants++;
  }

  for (const p of properties) {
    const code = await uniqueCode('properties', 'MX', p.code);
    const id = (await db.prepare(
      `INSERT INTO properties
       (company_id, code, owner_id, type_construction, nombre_piece, cout_loyer, ville, commune, quartier, observation, part_commission, nombre_porte)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      cid, code, ownerMap.get(p.owner_id) || null,
      clean(p.type_construction), p.nombre_piece != null ? toInt(p.nombre_piece) : null,
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
        autre_frais, montant_autre_frais, date_entree, date_debut_paiement, statut)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      cid, code, propertyMap.get(s.property_id) || null, tenantMap.get(s.tenant_id) || null,
      clean(s.date_souscription) || null, toInt(s.montant_loyer),
      toInt(s.nombre_mois_caution), toInt(s.montant_caution),
      toInt(s.nombre_mois_avance), toInt(s.montant_avance),
      clean(s.autre_frais), toInt(s.montant_autre_frais),
      clean(s.date_entree) || null, clean(s.date_debut_paiement) || null,
      clean(s.statut) || 'Active'
    )).lastInsertRowid;
    if (s.id != null) subscriptionMap.set(s.id, id);
    counts.subscriptions++;
  }

  for (const p of payments) {
    const code = await uniqueCode('payments', 'R', p.code);
    await db.prepare(
      `INSERT INTO payments
       (company_id, code, subscription_id, property_id, tenant_id, date, montant_a_payer, montant_paye, reste_a_payer, mois_concerne, annee_concernee, statut)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      cid, code, subscriptionMap.get(p.subscription_id) || null,
      propertyMap.get(p.property_id) || null, tenantMap.get(p.tenant_id) || null,
      clean(p.date) || null, toInt(p.montant_a_payer), toInt(p.montant_paye), toInt(p.reste_a_payer),
      clean(p.mois_concerne), p.annee_concernee != null ? toInt(p.annee_concernee) : null,
      clean(p.statut) || 'Soldé'
    );
    counts.payments++;
  }

  res.json({ ok: true, mode, importe: counts });
}));

module.exports = { router, settingsRouter, subscriptionRouter, dataRouter };
