'use strict';

/**
 * Authentification par e-mail + abonnement (plateforme multi-entreprises).
 *
 * Roles :
 *   - 'superadmin'  : proprietaire de la plateforme (aucune entreprise). Supervise
 *                     toutes les entreprises et active leurs abonnements.
 *   - 'admin'       : administrateur d'UNE entreprise (parametres, utilisateurs).
 *   - 'secretaire'  : gestion courante d'UNE entreprise.
 *
 * La session (cookie signe) porte : userId, role, companyId.
 */

const express = require('express');
const {
  db, hashPassword, verifyPassword, computeSubscription, addDaysYMD, TRIAL_DAYS,
} = require('./db');

const router = express.Router();

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, username: u.username, nom: u.nom, role: u.role, company_id: u.company_id };
}

// Charge l'entreprise + l'etat d'abonnement pour les reponses /me et /register.
async function companyState(companyId) {
  if (!companyId) return null;
  const c = await db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!c) return null;
  const sub = computeSubscription(c);
  return {
    id: c.id, nom: c.nom, telephone: c.telephone, email: c.email,
    adresse: c.adresse, devise: c.devise, logo: c.logo, plan: c.plan,
    ...sub,
  };
}

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    req.userId = req.session.userId;
    req.userRole = req.session.role;
    req.companyId = req.session.companyId || null;
    return next();
  }
  return res.status(401).json({ error: 'Non authentifié' });
}

function requireSuperadmin(req, res, next) {
  if (req.userRole === 'superadmin') return next();
  return res.status(403).json({ error: 'Accès réservé au super-administrateur.' });
}

function requireCompany(req, res, next) {
  if (req.companyId) return next();
  return res.status(403).json({ error: 'Aucune entreprise associée à ce compte.' });
}

// Exige un role precis AU SEIN d'une entreprise (ex : 'admin').
function requireRole(role) {
  return (req, res, next) => {
    if (req.userRole === role) return next();
    return res.status(403).json({ error: 'Accès réservé à l’administrateur.' });
  };
}

// Exige un abonnement actif (essai en cours ou abonnement paye valide).
async function requireActiveSubscription(req, res, next) {
  try {
    const c = await db.prepare('SELECT * FROM companies WHERE id = ?').get(req.companyId);
    const sub = computeSubscription(c);
    if (sub.actif) { req.subscription = sub; return next(); }
    return res.status(402).json({
      error: "Votre abonnement n’est pas actif. Contactez l’administrateur pour l’activer.",
      code: 'subscription',
      statut_effectif: sub.statut_effectif,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}

// ---------------------------------------------------------------------------
// Inscription d'une entreprise (publique) : cree l'entreprise + son admin.
// ---------------------------------------------------------------------------
router.post('/register', async (req, res) => {
  try {
    const b = req.body || {};
    const entreprise = clean(b.entreprise);
    const nom = clean(b.nom);
    const email = clean(b.email).toLowerCase();
    const telephone = clean(b.telephone);
    const password = clean(b.password);

    if (!entreprise) return res.status(400).json({ error: 'Veuillez saisir le nom de votre entreprise.' });
    if (!nom) return res.status(400).json({ error: 'Veuillez saisir votre nom complet.' });
    if (!isEmail(email)) return res.status(400).json({ error: 'Veuillez saisir une adresse e-mail valide.' });
    if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });

    const exists = await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
    if (exists) return res.status(400).json({ error: 'Cette adresse e-mail est déjà utilisée.' });

    const essaiFin = addDaysYMD(TRIAL_DAYS);
    const companyId = (await db.prepare(
      `INSERT INTO companies (nom, telephone, email, devise, plan, statut, essai_fin)
       VALUES (?,?,?, 'FCFA', 'annuel', 'essai', ?)`
    ).run(entreprise, telephone, email, essaiFin)).lastInsertRowid;

    const userId = (await db.prepare(
      "INSERT INTO users (username, email, password, nom, role, company_id) VALUES (NULL, ?, ?, ?, 'admin', ?)"
    ).run(email, hashPassword(password), nom, companyId)).lastInsertRowid;

    req.session.userId = userId;
    req.session.role = 'admin';
    req.session.companyId = companyId;

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    res.json({ user: publicUser(user), company: await companyState(companyId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---------------------------------------------------------------------------
// Connexion par e-mail.
// ---------------------------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const email = clean((req.body || {}).email).toLowerCase();
    const password = clean((req.body || {}).password);
    if (!email || !password) {
      return res.status(400).json({ error: 'E-mail et mot de passe requis.' });
    }
    const user = await db.prepare('SELECT * FROM users WHERE email = ? AND actif = 1').get(email);
    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ error: 'E-mail ou mot de passe incorrect.' });
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.companyId = user.company_id || null;
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Non authentifié' });
  const company = user.role === 'superadmin' ? null : await companyState(user.company_id);
  res.json({ user: publicUser(user), company });
});

// Changement de son propre mot de passe (tout utilisateur connecte).
router.post('/password', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Non authentifié' });
  const current = clean((req.body || {}).current);
  const next = clean((req.body || {}).password);
  if (next.length < 6) return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !verifyPassword(current, user.password)) {
    return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
  }
  await db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(next), user.id);
  res.json({ ok: true });
});

module.exports = {
  router,
  requireAuth,
  requireSuperadmin,
  requireCompany,
  requireRole,
  requireActiveSubscription,
  publicUser,
  companyState,
};
