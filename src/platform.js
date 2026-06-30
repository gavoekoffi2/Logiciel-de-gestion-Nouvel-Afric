'use strict';

/**
 * Espace SUPER-ADMINISTRATEUR (proprietaire de la plateforme).
 * Gestion de toutes les entreprises et de leurs abonnements annuels :
 *   - lister / consulter / creer / modifier / supprimer une entreprise ;
 *   - ACTIVER / PROLONGER (1 an), SUSPENDRE, REACTIVER un abonnement ;
 *   - configurer les informations de la plateforme (contact + tarif annuel).
 *
 * Monte sous /api/platform avec requireAuth + requireSuperadmin.
 */

const express = require('express');
const {
  db, hashPassword, computeSubscription, todayYMD, addDaysYMD, addYearsYMD, TRIAL_DAYS,
} = require('./db');
const { isNoSubscriptionCompanyName, noSubscriptionValueForCompany } = require('./companyPolicy');

const router = express.Router();

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (err) { console.error(err); if (!res.headersSent) res.status(500).json({ error: err.message || 'Erreur serveur' }); }
};

async function companyView(c) {
  const admin = await db.prepare(
    "SELECT email, nom FROM users WHERE company_id = ? AND role = 'admin' ORDER BY id LIMIT 1"
  ).get(c.id);
  const nbUsers = (await db.prepare('SELECT COUNT(*) n FROM users WHERE company_id = ?').get(c.id)).n;
  const nbBiens = (await db.prepare('SELECT COUNT(*) n FROM properties WHERE company_id = ?').get(c.id)).n;
  return {
    id: c.id, nom: c.nom, telephone: c.telephone, email: c.email, adresse: c.adresse,
    devise: c.devise, plan: c.plan, created_at: c.created_at,
    admin_email: admin ? admin.email : null,
    admin_nom: admin ? admin.nom : null,
    nb_users: nbUsers, nb_biens: nbBiens,
    no_subscription: isNoSubscriptionCompanyName(c.nom),
    ...computeSubscription(c),
  };
}

// ---------------------------------------------------------------------------
// Vue d'ensemble + liste des entreprises
// ---------------------------------------------------------------------------
router.get('/stats', wrap(async (req, res) => {
  const companies = await db.prepare('SELECT * FROM companies').all();
  let actives = 0, essais = 0, expirees = 0, suspendues = 0, demandes = 0;
  for (const c of companies) {
    const s = computeSubscription(c);
    if (s.statut_effectif === 'actif') actives++;
    else if (s.statut_effectif === 'essai') essais++;
    else if (s.statut_effectif === 'suspendu') suspendues++;
    else expirees++;
    if (c.demande_le) demandes++;
  }
  res.json({ total: companies.length, actives, essais, expirees, suspendues, demandes });
}));

router.get('/companies', wrap(async (req, res) => {
  const q = clean(req.query.q).toLowerCase();
  const companies = await db.prepare('SELECT * FROM companies ORDER BY id DESC').all();
  let views = await Promise.all(companies.map(companyView));
  if (q) {
    views = views.filter((v) =>
      [v.nom, v.admin_email, v.email, v.telephone].some((x) => (x || '').toLowerCase().includes(q)));
  }
  res.json(views);
}));

router.get('/companies/:id', wrap(async (req, res) => {
  const c = await db.prepare('SELECT * FROM companies WHERE id = ?').get(toInt(req.params.id));
  if (!c) return res.status(404).json({ error: 'Entreprise introuvable.' });
  res.json(await companyView(c));
}));

// Creation manuelle d'une entreprise + son administrateur.
router.post('/companies', wrap(async (req, res) => {
  const b = req.body || {};
  const entreprise = clean(b.entreprise);
  const nom = clean(b.nom);
  const email = clean(b.email).toLowerCase();
  const telephone = clean(b.telephone);
  const password = clean(b.password);
  // Illimité si : nom interne (politique companyPolicy) OU choix explicite du super-admin.
  const illimite = (noSubscriptionValueForCompany(entreprise) || b.statut === 'illimite' || b.illimite === true) ? 1 : 0;
  const statut = illimite ? 'actif' : (['actif', 'essai', 'suspendu'].includes(b.statut) ? b.statut : 'essai');

  if (!entreprise) return res.status(400).json({ error: 'Nom de l’entreprise requis.' });
  if (!nom) return res.status(400).json({ error: 'Nom de l’administrateur requis.' });
  if (!isEmail(email)) return res.status(400).json({ error: 'E-mail administrateur invalide.' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum.' });
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(400).json({ error: 'Cette adresse e-mail est déjà utilisée.' });
  }

  const essaiFin = illimite ? null : addDaysYMD(TRIAL_DAYS);
  const abonnementFin = (!illimite && statut === 'actif') ? addYearsYMD(1) : null;
  const companyId = (await db.prepare(
    `INSERT INTO companies (nom, telephone, email, devise, plan, statut, essai_fin, abonnement_fin, illimite)
     VALUES (?,?,?, 'FCFA', 'annuel', ?, ?, ?, ?)`
  ).run(entreprise, telephone, email, statut, essaiFin, abonnementFin, illimite)).lastInsertRowid;

  await db.prepare(
    "INSERT INTO users (username, email, password, nom, role, company_id) VALUES (?, ?, ?, ?, 'admin', ?)"
  ).run(email, email, hashPassword(password), nom, companyId);

  const c = await db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  res.json(await companyView(c));
}));

// Modification du profil d'une entreprise.
router.put('/companies/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const c = await db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Entreprise introuvable.' });
  const b = req.body || {};
  const nextName = clean(b.entreprise) || c.nom;
  const forceNoSubscription = isNoSubscriptionCompanyName(nextName);
  const sql = forceNoSubscription
    ? 'UPDATE companies SET nom=?, telephone=?, email=?, adresse=?, devise=?, illimite=1, statut=\'actif\', demande_le=NULL WHERE id=?'
    : 'UPDATE companies SET nom=?, telephone=?, email=?, adresse=?, devise=? WHERE id=?';
  await db.prepare(sql).run(
    nextName,
    clean(b.telephone),
    clean(b.email),
    clean(b.adresse),
    clean(b.devise) || c.devise || 'FCFA',
    id
  );
  res.json(await companyView(await db.prepare('SELECT * FROM companies WHERE id = ?').get(id)));
}));

// Activer / prolonger l'abonnement annuel (N annees, defaut 1).
async function activer(req, res) {
  const id = toInt(req.params.id);
  const c = await db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Entreprise introuvable.' });
  const annees = Math.max(1, toInt(req.body && req.body.annees) || 1);
  const today = todayYMD();
  // On prolonge a partir de la date de fin si elle est encore dans le futur.
  const base = (c.abonnement_fin && c.abonnement_fin > today) ? c.abonnement_fin : today;
  const fin = addYearsYMD(annees, base);
  await db.prepare(
    "UPDATE companies SET statut='actif', abonnement_fin=?, demande_le=NULL WHERE id=?"
  ).run(fin, id);
  res.json(await companyView(await db.prepare('SELECT * FROM companies WHERE id = ?').get(id)));
}
router.post('/companies/:id/activer', wrap(activer));
router.post('/companies/:id/prolonger', wrap(activer));

// Suspendre l'acces (bloque l'entreprise).
router.post('/companies/:id/suspendre', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const c = await db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Entreprise introuvable.' });
  await db.prepare("UPDATE companies SET statut='suspendu' WHERE id=?").run(id);
  res.json(await companyView(await db.prepare('SELECT * FROM companies WHERE id = ?').get(id)));
}));

// Reactiver une entreprise suspendue (revient a son etat selon les dates).
router.post('/companies/:id/reactiver', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const c = await db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Entreprise introuvable.' });
  const today = todayYMD();
  // Illimite ou abonnement paye encore valide -> actif ; sinon on remet un essai.
  if (c.illimite || (c.abonnement_fin && c.abonnement_fin >= today)) {
    await db.prepare("UPDATE companies SET statut='actif' WHERE id=?").run(id);
  } else {
    await db.prepare("UPDATE companies SET statut='essai', essai_fin=? WHERE id=?").run(addDaysYMD(TRIAL_DAYS), id);
  }
  res.json(await companyView(await db.prepare('SELECT * FROM companies WHERE id = ?').get(id)));
}));

// Accorder / retirer un abonnement ILLIMITE (a vie) — reserve au super-admin.
router.post('/companies/:id/illimite', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const c = await db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Entreprise introuvable.' });
  const on = !(req.body && req.body.on === false); // defaut : activer l'illimite
  if (on) {
    await db.prepare("UPDATE companies SET illimite=1, statut='actif', demande_le=NULL WHERE id=?").run(id);
  } else {
    await db.prepare('UPDATE companies SET illimite=0 WHERE id=?').run(id);
  }
  res.json(await companyView(await db.prepare('SELECT * FROM companies WHERE id = ?').get(id)));
}));

// Reinitialiser le mot de passe de l'administrateur d'une entreprise.
router.post('/companies/:id/admin-password', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  const password = clean(req.body && req.body.password);
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum.' });
  const admin = await db.prepare("SELECT * FROM users WHERE company_id = ? AND role='admin' ORDER BY id LIMIT 1").get(id);
  if (!admin) return res.status(404).json({ error: 'Administrateur introuvable.' });
  await db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(password), admin.id);
  res.json({ ok: true });
}));

// Supprimer une entreprise (et toutes ses donnees).
router.delete('/companies/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id);
  for (const t of ['payments', 'subscriptions', 'properties', 'tenants', 'owners', 'users']) {
    await db.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(id);
  }
  await db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Parametres de la plateforme (contact + tarif annuel affiches aux entreprises)
// ---------------------------------------------------------------------------
router.get('/settings', wrap(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM platform WHERE id = 1').get());
}));

router.put('/settings', wrap(async (req, res) => {
  const b = req.body || {};
  await db.prepare(
    `UPDATE platform SET nom=?, contact_telephone=?, contact_whatsapp=?, contact_email=?,
       prix_annuel=?, devise=?, message=? WHERE id=1`
  ).run(
    clean(b.nom) || 'MaGérance',
    clean(b.contact_telephone),
    clean(b.contact_whatsapp),
    clean(b.contact_email),
    toInt(b.prix_annuel),
    clean(b.devise) || 'FCFA',
    clean(b.message)
  );
  res.json(await db.prepare('SELECT * FROM platform WHERE id = 1').get());
}));

module.exports = router;
