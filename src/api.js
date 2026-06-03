'use strict';

/**
 * API REST : toute la logique de gestion locative transposee du fichier Excel.
 *   Proprietaires, Locataires, Maisons, Souscriptions, Reglements,
 *   Tableau de bord, Parametres et Utilisateurs.
 */

const express = require('express');
const { db, hashPassword } = require('./db');
const { requireRole, publicUser } = require('./auth');

const router = express.Router();

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

function codeExists(table, code) {
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE code = ?`).get(code);
}

function genPropertyCode(type, pieces, cout, dateStr) {
  const base = `${typeCode(type)}_P${toInt(pieces)}_C${toInt(cout)}_M${dateCode(dateStr)}`;
  let code;
  do { code = `${base}A${rand()}`; } while (codeExists('properties', code));
  return code;
}

function genCode(table, prefix, dateStr) {
  let code;
  do { code = `${prefix}${dateCode(dateStr)}A${rand()}`; } while (codeExists(table, code));
  return code;
}

// Petit utilitaire pour rattraper les erreurs d'une route sans repeter try/catch.
const wrap = (fn) => (req, res) => {
  try { fn(req, res); }
  catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
};

// ===========================================================================
// PROPRIETAIRES
// ===========================================================================
router.get('/owners', wrap((req, res) => {
  const q = clean(req.query.q);
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = db.prepare(
      `SELECT * FROM owners
       WHERE nom_prenoms LIKE ? OR contact LIKE ? OR email LIKE ? OR adresse LIKE ?
       ORDER BY nom_prenoms COLLATE NOCASE`
    ).all(like, like, like, like);
  } else {
    rows = db.prepare('SELECT * FROM owners ORDER BY nom_prenoms COLLATE NOCASE').all();
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

function validatePerson(p, table, excludeId, label) {
  if (!p.nom_prenoms) return 'Veuillez saisir le nom et prénoms.';
  if (!p.contact) return 'Veuillez saisir le contact.';
  const dup = db
    .prepare(`SELECT id FROM ${table} WHERE lower(nom_prenoms) = lower(?) AND id <> ?`)
    .get(p.nom_prenoms, excludeId || 0);
  if (dup) return `Ce nom de ${label} existe déjà. Ajoutez un élément distinctif s’il s’agit de deux personnes différentes.`;
  return null;
}

router.post('/owners', wrap((req, res) => {
  const p = personPayload(req.body);
  const err = validatePerson(p, 'owners', 0, 'propriétaire');
  if (err) return res.status(400).json({ error: err });
  const info = db.prepare(
    'INSERT INTO owners (nom_prenoms, contact, email, adresse) VALUES (?,?,?,?)'
  ).run(p.nom_prenoms, p.contact, p.email, p.adresse);
  res.json(db.prepare('SELECT * FROM owners WHERE id = ?').get(info.lastInsertRowid));
}));

router.put('/owners/:id', wrap((req, res) => {
  const id = toInt(req.params.id);
  const p = personPayload(req.body);
  const err = validatePerson(p, 'owners', id, 'propriétaire');
  if (err) return res.status(400).json({ error: err });
  db.prepare(
    'UPDATE owners SET nom_prenoms=?, contact=?, email=?, adresse=? WHERE id=?'
  ).run(p.nom_prenoms, p.contact, p.email, p.adresse, id);
  res.json(db.prepare('SELECT * FROM owners WHERE id = ?').get(id));
}));

router.delete('/owners/:id', wrap((req, res) => {
  db.prepare('DELETE FROM owners WHERE id = ?').run(toInt(req.params.id));
  res.json({ ok: true });
}));

// ===========================================================================
// LOCATAIRES
// ===========================================================================
router.get('/tenants', wrap((req, res) => {
  const q = clean(req.query.q);
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = db.prepare(
      `SELECT * FROM tenants
       WHERE nom_prenoms LIKE ? OR contact LIKE ? OR email LIKE ? OR adresse LIKE ?
       ORDER BY nom_prenoms COLLATE NOCASE`
    ).all(like, like, like, like);
  } else {
    rows = db.prepare('SELECT * FROM tenants ORDER BY nom_prenoms COLLATE NOCASE').all();
  }
  res.json(rows);
}));

router.post('/tenants', wrap((req, res) => {
  const p = personPayload(req.body);
  const err = validatePerson(p, 'tenants', 0, 'locataire');
  if (err) return res.status(400).json({ error: err });
  const info = db.prepare(
    'INSERT INTO tenants (nom_prenoms, contact, email, adresse) VALUES (?,?,?,?)'
  ).run(p.nom_prenoms, p.contact, p.email, p.adresse);
  res.json(db.prepare('SELECT * FROM tenants WHERE id = ?').get(info.lastInsertRowid));
}));

router.put('/tenants/:id', wrap((req, res) => {
  const id = toInt(req.params.id);
  const p = personPayload(req.body);
  const err = validatePerson(p, 'tenants', id, 'locataire');
  if (err) return res.status(400).json({ error: err });
  db.prepare(
    'UPDATE tenants SET nom_prenoms=?, contact=?, email=?, adresse=? WHERE id=?'
  ).run(p.nom_prenoms, p.contact, p.email, p.adresse, id);
  res.json(db.prepare('SELECT * FROM tenants WHERE id = ?').get(id));
}));

router.delete('/tenants/:id', wrap((req, res) => {
  db.prepare('DELETE FROM tenants WHERE id = ?').run(toInt(req.params.id));
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

router.get('/properties', wrap((req, res) => {
  const q = clean(req.query.q);
  const statut = clean(req.query.statut);
  let rows = db.prepare(`${PROPERTY_SELECT} ORDER BY p.id DESC`).all();
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
router.get('/properties/available', wrap((req, res) => {
  const current = toInt(req.query.current); // bien deja lie (en modification)
  const rows = db.prepare(`${PROPERTY_SELECT}`).all()
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

function validateProperty(p) {
  if (!p.owner_id) return 'Veuillez sélectionner le propriétaire.';
  if (!p.type_construction) return 'Veuillez sélectionner le type de construction.';
  if (!p.nombre_piece) return 'Veuillez saisir le nombre de pièces.';
  if (!p.cout_loyer) return 'Veuillez saisir le coût du loyer.';
  if (p.part_commission > 100) return 'La part de commission doit être inférieure ou égale à 100.';
  return null;
}

router.post('/properties', wrap((req, res) => {
  const p = propertyPayload(req.body);
  const err = validateProperty(p);
  if (err) return res.status(400).json({ error: err });
  const code = genPropertyCode(p.type_construction, p.nombre_piece, p.cout_loyer, req.body.date);
  const info = db.prepare(
    `INSERT INTO properties
     (code, owner_id, type_construction, nombre_piece, cout_loyer, ville, commune, quartier, observation, part_commission, nombre_porte)
     VALUES (@code,@owner_id,@type_construction,@nombre_piece,@cout_loyer,@ville,@commune,@quartier,@observation,@part_commission,@nombre_porte)`
  ).run({ code, ...p });
  res.json(db.prepare(`${PROPERTY_SELECT} WHERE p.id = ?`).get(info.lastInsertRowid));
}));

router.put('/properties/:id', wrap((req, res) => {
  const id = toInt(req.params.id);
  const p = propertyPayload(req.body);
  const err = validateProperty(p);
  if (err) return res.status(400).json({ error: err });
  db.prepare(
    `UPDATE properties SET
       owner_id=@owner_id, type_construction=@type_construction, nombre_piece=@nombre_piece,
       cout_loyer=@cout_loyer, ville=@ville, commune=@commune, quartier=@quartier,
       observation=@observation, part_commission=@part_commission, nombre_porte=@nombre_porte
     WHERE id=@id`
  ).run({ id, ...p });
  res.json(db.prepare(`${PROPERTY_SELECT} WHERE p.id = ?`).get(id));
}));

router.delete('/properties/:id', wrap((req, res) => {
  const id = toInt(req.params.id);
  const sub = db.prepare("SELECT 1 FROM subscriptions WHERE property_id = ? AND statut='Active'").get(id);
  if (sub) return res.status(400).json({ error: 'Impossible de supprimer : ce bien a une souscription active.' });
  db.prepare('DELETE FROM properties WHERE id = ?').run(id);
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

router.get('/subscriptions', wrap((req, res) => {
  const q = clean(req.query.q);
  let rows = db.prepare(`${SUB_SELECT} ORDER BY s.id DESC`).all();
  if (q) {
    const s = q.toLowerCase();
    rows = rows.filter((r) =>
      [r.code, r.property_code, r.tenant_nom, r.statut].some((v) => (v || '').toLowerCase().includes(s)));
  }
  res.json(rows);
}));

router.get('/subscriptions/active', wrap((req, res) => {
  res.json(db.prepare(`${SUB_SELECT} WHERE s.statut='Active' ORDER BY t.nom_prenoms COLLATE NOCASE`).all());
}));

router.get('/subscriptions/:id', wrap((req, res) => {
  const row = db.prepare(`${SUB_SELECT} WHERE s.id = ?`).get(toInt(req.params.id));
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

function validateSubscription(s) {
  if (!s.property_id) return 'Veuillez sélectionner le bien (maison).';
  if (!s.tenant_id) return 'Veuillez sélectionner le locataire.';
  if (!s.montant_loyer) return 'Le montant du loyer est requis.';
  if (!s.date_entree) return 'Veuillez saisir la date d’entrée.';
  if (!s.date_debut_paiement) return 'Veuillez saisir la date de début de paiement.';
  return null;
}

router.post('/subscriptions', wrap((req, res) => {
  const s = subscriptionPayload(req.body);
  const err = validateSubscription(s);
  if (err) return res.status(400).json({ error: err });
  const code = genCode('subscriptions', 'S', s.date_souscription);
  const info = db.prepare(
    `INSERT INTO subscriptions
     (code, property_id, tenant_id, date_souscription, montant_loyer, nombre_mois_caution,
      montant_caution, nombre_mois_avance, montant_avance, autre_frais, montant_autre_frais,
      date_entree, date_debut_paiement, statut)
     VALUES (@code,@property_id,@tenant_id,@date_souscription,@montant_loyer,@nombre_mois_caution,
      @montant_caution,@nombre_mois_avance,@montant_avance,@autre_frais,@montant_autre_frais,
      @date_entree,@date_debut_paiement,@statut)`
  ).run({ code, ...s });
  res.json(db.prepare(`${SUB_SELECT} WHERE s.id = ?`).get(info.lastInsertRowid));
}));

router.put('/subscriptions/:id', wrap((req, res) => {
  const id = toInt(req.params.id);
  const s = subscriptionPayload(req.body);
  const err = validateSubscription(s);
  if (err) return res.status(400).json({ error: err });
  db.prepare(
    `UPDATE subscriptions SET
       property_id=@property_id, tenant_id=@tenant_id, date_souscription=@date_souscription,
       montant_loyer=@montant_loyer, nombre_mois_caution=@nombre_mois_caution, montant_caution=@montant_caution,
       nombre_mois_avance=@nombre_mois_avance, montant_avance=@montant_avance, autre_frais=@autre_frais,
       montant_autre_frais=@montant_autre_frais, date_entree=@date_entree,
       date_debut_paiement=@date_debut_paiement, statut=@statut
     WHERE id=@id`
  ).run({ id, ...s });
  res.json(db.prepare(`${SUB_SELECT} WHERE s.id = ?`).get(id));
}));

router.delete('/subscriptions/:id', wrap((req, res) => {
  db.prepare('DELETE FROM subscriptions WHERE id = ?').run(toInt(req.params.id));
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

router.get('/payments', wrap((req, res) => {
  const q = clean(req.query.q);
  const mois = clean(req.query.mois);
  const annee = clean(req.query.annee);
  const statut = clean(req.query.statut);
  let rows = db.prepare(`${PAY_SELECT} ORDER BY r.id DESC`).all();
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

router.get('/payments/:id', wrap((req, res) => {
  const row = db.prepare(`${PAY_SELECT} WHERE r.id = ?`).get(toInt(req.params.id));
  if (!row) return res.status(404).json({ error: 'Règlement introuvable' });
  res.json(row);
}));

function paymentPayload(body) {
  let subscription_id = toInt(body.subscription_id) || null;
  let property_id = toInt(body.property_id) || null;
  let tenant_id = toInt(body.tenant_id) || null;
  let montant_a_payer = toInt(body.montant_a_payer);

  // On complete automatiquement le bien, le locataire et le loyer du a partir
  // de la souscription choisie (comme dans le fichier Excel d'origine).
  if (subscription_id) {
    const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscription_id);
    if (sub) {
      if (!property_id) property_id = sub.property_id;
      if (!tenant_id) tenant_id = sub.tenant_id;
      if (!montant_a_payer) montant_a_payer = sub.montant_loyer;
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

router.post('/payments', wrap((req, res) => {
  const r = paymentPayload(req.body);
  const err = validatePayment(r);
  if (err) return res.status(400).json({ error: err });
  const code = genCode('payments', 'R', r.date);
  const info = db.prepare(
    `INSERT INTO payments
     (code, subscription_id, property_id, tenant_id, date, montant_a_payer, montant_paye,
      reste_a_payer, mois_concerne, annee_concernee, statut)
     VALUES (@code,@subscription_id,@property_id,@tenant_id,@date,@montant_a_payer,@montant_paye,
      @reste_a_payer,@mois_concerne,@annee_concernee,@statut)`
  ).run({ code, ...r });
  res.json(db.prepare(`${PAY_SELECT} WHERE r.id = ?`).get(info.lastInsertRowid));
}));

router.put('/payments/:id', wrap((req, res) => {
  const id = toInt(req.params.id);
  const r = paymentPayload(req.body);
  const err = validatePayment(r);
  if (err) return res.status(400).json({ error: err });
  db.prepare(
    `UPDATE payments SET
       subscription_id=@subscription_id, property_id=@property_id, tenant_id=@tenant_id, date=@date,
       montant_a_payer=@montant_a_payer, montant_paye=@montant_paye, reste_a_payer=@reste_a_payer,
       mois_concerne=@mois_concerne, annee_concernee=@annee_concernee, statut=@statut
     WHERE id=@id`
  ).run({ id, ...r });
  res.json(db.prepare(`${PAY_SELECT} WHERE r.id = ?`).get(id));
}));

router.delete('/payments/:id', wrap((req, res) => {
  db.prepare('DELETE FROM payments WHERE id = ?').run(toInt(req.params.id));
  res.json({ ok: true });
}));

// Encaissement multiple : enregistre le loyer du mois pour plusieurs souscriptions.
router.post('/payments/bulk', wrap((req, res) => {
  const date = clean(req.body.date);
  const mois = clean(req.body.mois);
  const annee = toInt(req.body.annee);
  const ids = Array.isArray(req.body.subscription_ids) ? req.body.subscription_ids.map(toInt) : [];
  if (!mois || !annee) return res.status(400).json({ error: 'Mois et année concernés requis.' });
  if (ids.length === 0) return res.status(400).json({ error: 'Veuillez sélectionner au moins une souscription.' });

  let crees = 0;
  let ignores = 0;
  const tx = db.transaction(() => {
    for (const sid of ids) {
      const sub = db.prepare("SELECT * FROM subscriptions WHERE id = ? AND statut='Active'").get(sid);
      if (!sub) { ignores++; continue; }
      // Eviter un double encaissement pour la meme periode.
      const exist = db.prepare(
        'SELECT 1 FROM payments WHERE subscription_id=? AND mois_concerne=? AND annee_concernee=?'
      ).get(sid, mois, annee);
      if (exist) { ignores++; continue; }
      const code = genCode('payments', 'R', date);
      db.prepare(
        `INSERT INTO payments
         (code, subscription_id, property_id, tenant_id, date, montant_a_payer, montant_paye,
          reste_a_payer, mois_concerne, annee_concernee, statut)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(code, sub.id, sub.property_id, sub.tenant_id, date || null,
        sub.montant_loyer, sub.montant_loyer, 0, mois, annee, 'Soldé');
      crees++;
    }
  });
  tx();
  res.json({ ok: true, crees, ignores });
}));

// ===========================================================================
// TABLEAU DE BORD
// ===========================================================================
router.get('/dashboard', wrap((req, res) => {
  const now = new Date();
  const moisCourant = MOIS[now.getMonth()];
  const anneeCourante = now.getFullYear();

  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const nb_maisons = one('SELECT COUNT(*) n FROM properties').n;
  const nb_occupees = one(
    "SELECT COUNT(DISTINCT property_id) n FROM subscriptions WHERE statut='Active' AND property_id IS NOT NULL"
  ).n;

  const data = {
    moisCourant,
    anneeCourante,
    nb_proprietaires: one('SELECT COUNT(*) n FROM owners').n,
    nb_locataires: one('SELECT COUNT(*) n FROM tenants').n,
    nb_maisons,
    nb_occupees,
    nb_disponibles: nb_maisons - nb_occupees,
    total_caution: one('SELECT COALESCE(SUM(montant_caution),0) s FROM subscriptions').s,
    total_avance: one('SELECT COALESCE(SUM(montant_avance),0) s FROM subscriptions').s,
    total_loyer: one('SELECT COALESCE(SUM(montant_paye),0) s FROM payments').s,
    loyer_attendu: one("SELECT COALESCE(SUM(montant_loyer),0) s FROM subscriptions WHERE statut='Active'").s,
    loyer_encaisse_mois: one(
      'SELECT COALESCE(SUM(montant_paye),0) s FROM payments WHERE mois_concerne=? AND annee_concernee=?',
      moisCourant, anneeCourante
    ).s,
    impayes_nombre: one("SELECT COUNT(*) n FROM payments WHERE statut='Non soldé'").n,
    impayes_montant: one("SELECT COALESCE(SUM(reste_a_payer),0) s FROM payments WHERE statut='Non soldé'").s,
  };
  data.reste_attendu_mois = Math.max(0, data.loyer_attendu - data.loyer_encaisse_mois);

  data.derniers_paiements = db.prepare(
    `${PAY_SELECT} ORDER BY r.id DESC LIMIT 6`
  ).all();
  data.maisons_disponibles = db.prepare(`${PROPERTY_SELECT}`).all()
    .filter((r) => r.statut === 'Disponible').slice(0, 6);

  res.json(data);
}));

// ===========================================================================
// PARAMETRES
// ===========================================================================
router.get('/settings', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM settings WHERE id = 1').get());
}));

router.put('/settings', requireRole('admin'), wrap((req, res) => {
  const b = req.body || {};
  db.prepare(
    'UPDATE settings SET entreprise=?, telephone=?, email=?, adresse=?, devise=? WHERE id=1'
  ).run(
    clean(b.entreprise) || 'NOUVEL AFRIC',
    clean(b.telephone),
    clean(b.email),
    clean(b.adresse),
    clean(b.devise) || 'FCFA'
  );
  res.json(db.prepare('SELECT * FROM settings WHERE id = 1').get());
}));

// ===========================================================================
// UTILISATEURS (administrateur uniquement)
// ===========================================================================
router.get('/users', requireRole('admin'), wrap((req, res) => {
  res.json(db.prepare('SELECT id, username, nom, role, actif, created_at FROM users ORDER BY id').all());
}));

router.post('/users', requireRole('admin'), wrap((req, res) => {
  const username = clean(req.body.username).toLowerCase();
  const password = clean(req.body.password);
  const nom = clean(req.body.nom);
  const role = clean(req.body.role) === 'admin' ? 'admin' : 'secretaire';
  if (!username || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(400).json({ error: 'Cet identifiant existe déjà.' });
  }
  const info = db.prepare(
    'INSERT INTO users (username, password, nom, role) VALUES (?,?,?,?)'
  ).run(username, hashPassword(password), nom, role);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
}));

router.put('/users/:id', requireRole('admin'), wrap((req, res) => {
  const id = toInt(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const nom = clean(req.body.nom) || user.nom;
  const role = clean(req.body.role) === 'admin' ? 'admin' : 'secretaire';
  const actif = req.body.actif === undefined ? user.actif : (req.body.actif ? 1 : 0);
  const password = clean(req.body.password);
  if (password) {
    db.prepare('UPDATE users SET nom=?, role=?, actif=?, password=? WHERE id=?')
      .run(nom, role, actif, hashPassword(password), id);
  } else {
    db.prepare('UPDATE users SET nom=?, role=?, actif=? WHERE id=?').run(nom, role, actif, id);
  }
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
}));

router.delete('/users/:id', requireRole('admin'), wrap((req, res) => {
  const id = toInt(req.params.id);
  if (id === req.session.userId) return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
}));

module.exports = router;
