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
const { isNoSubscriptionCompanyName, noSubscriptionValueForCompany } = require('./companyPolicy');

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
  const noSubscription = isNoSubscriptionCompanyName(c.nom);
  return {
    id: c.id, nom: c.nom, telephone: c.telephone, email: c.email,
    adresse: c.adresse, devise: c.devise, logo: c.logo, plan: c.plan,
    no_subscription: noSubscription,
    ...sub,
    ...(noSubscription ? {
      illimite: false,
      statut: 'actif',
      essai_fin: null,
      abonnement_fin: null,
      demande_le: null,
      en_essai: false,
      jours_restants: null,
      echeance: null,
    } : {}),
  };
}

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------
// Le cookie de session prouve QUI s'est connecte, jamais CE QU'IL A LE DROIT DE
// FAIRE : role, entreprise et etat du compte sont relus en base a chaque appel.
// Sans cela, un compte desactive, supprime ou retrograde garderait tous ses
// droits jusqu'a l'expiration du cookie (12 h) — l'administrateur qui coupe
// l'acces d'un employe croirait l'avoir coupe alors qu'il ne l'est pas.
async function requireAuth(req, res, next) {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Non authentifié' });
    }
    const user = await db.prepare(
      'SELECT id, email, nom, role, company_id, actif FROM users WHERE id = ?'
    ).get(req.session.userId);
    if (!user || !user.actif) {
      req.session = null;
      return res.status(401).json({ error: 'Votre accès a été désactivé. Contactez votre administrateur.' });
    }
    req.userId = user.id;
    req.userRole = user.role;
    req.companyId = user.company_id || null;
    req.userNom = user.nom || user.email || null;
    // La session suit l'etat reel (role modifie, entreprise reattribuee).
    req.session.role = user.role;
    req.session.companyId = user.company_id || null;
    req.session.userNom = req.userNom;
    return next();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
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

    const illimite = noSubscriptionValueForCompany(entreprise);
    const statut = illimite ? 'actif' : 'essai';
    const essaiFin = illimite ? null : addDaysYMD(TRIAL_DAYS);
    // L'entreprise et son administrateur sont crees dans la MEME transaction :
    // si le compte echoue (e-mail pris entre-temps), aucune entreprise fantome
    // sans administrateur ne reste en base.
    let companyId;
    let userId;
    try {
      const results = await db.batch([
        {
          sql: `INSERT INTO companies (nom, telephone, email, devise, plan, statut, essai_fin, illimite)
                VALUES (?,?,?, 'FCFA', 'annuel', ?, ?, ?)`,
          args: [entreprise, telephone, email, statut, essaiFin, illimite],
        },
        {
          sql: `INSERT INTO users (username, email, password, nom, role, company_id)
                VALUES (?, ?, ?, ?, 'admin', last_insert_rowid())`,
          args: [email, email, hashPassword(password), nom],
        },
      ]);
      companyId = Number(results[0].lastInsertRowid);
      userId = Number(results[1].lastInsertRowid);
    } catch (e) {
      return res.status(400).json({ error: 'Cette adresse e-mail est déjà utilisée.' });
    }

    req.session.userId = userId;
    req.session.role = 'admin';
    req.session.companyId = companyId;
    req.session.userNom = nom || email || null;

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    res.json({ user: publicUser(user), company: await companyState(companyId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---------------------------------------------------------------------------
// Connexion par e-mail, téléphone/username ou identifiant interne.
// ---------------------------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const identifier = clean((req.body || {}).email || (req.body || {}).identifier).toLowerCase();
    const password = clean((req.body || {}).password);
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
    }
    const user = await db.prepare(
      'SELECT * FROM users WHERE actif = 1 AND (lower(email) = ? OR lower(username) = ?)'
    ).get(identifier, identifier);
    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.companyId = user.company_id || null;
    req.session.userNom = user.nom || user.email || null;
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
  // Compte supprime ou desactive pendant que la session etait ouverte : on
  // ferme la session au lieu de laisser l'application s'ouvrir normalement.
  if (!user || !user.actif) {
    req.session = null;
    return res.status(401).json({ error: 'Non authentifié' });
  }
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

// Changement de son propre e-mail de connexion (tout utilisateur connecte,
// super-admin compris). Demande le mot de passe actuel et verifie l'unicite.
router.post('/email', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Non authentifié' });
  const current = clean((req.body || {}).current);
  const email = clean((req.body || {}).email).toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !verifyPassword(current, user.password)) {
    return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
  }
  if (email === clean(user.email).toLowerCase()) {
    return res.status(400).json({ error: 'C\'est déjà votre adresse e-mail actuelle.' });
  }
  const taken = await db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(email, user.id);
  if (taken) return res.status(400).json({ error: 'Cette adresse e-mail est déjà utilisée par un autre compte.' });
  try {
    await db.prepare('UPDATE users SET email = ?, username = ? WHERE id = ?').run(email, email, user.id);
  } catch (e) {
    return res.status(400).json({ error: 'Cette adresse e-mail est déjà utilisée par un autre compte.' });
  }
  // Le nom affiche dans la session peut deriver de l'e-mail : on le rafraichit.
  if (!clean(user.nom)) req.session.userNom = email;
  res.json({ ok: true, user: publicUser({ ...user, email, username: email }) });
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
