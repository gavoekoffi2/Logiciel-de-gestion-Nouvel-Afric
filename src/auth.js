'use strict';

/**
 * Authentification par session.
 * - Deux roles : "admin" (acces complet, parametres, utilisateurs) et
 *   "secretaire" (gestion courante : biens, locataires, souscriptions, paiements).
 */

const express = require('express');
const { db, verifyPassword } = require('./db');

const router = express.Router();

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, nom: u.nom, role: u.role };
}

// Middleware : exige une session connectee.
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Non authentifié' });
}

// Middleware : exige un role precis (ex: 'admin').
function requireRole(role) {
  return (req, res, next) => {
    if (req.session && req.session.role === role) return next();
    return res.status(403).json({ error: 'Accès réservé à l’administrateur' });
  };
}

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    }
    const user = await db
      .prepare('SELECT * FROM users WHERE username = ? AND actif = 1')
      .get(String(username).trim().toLowerCase());

    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
    }

    req.session.userId = user.id;
    req.session.role = user.role;
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/logout', (req, res) => {
  req.session = null; // cookie-session : on efface la session
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Non authentifié' });
  res.json({ user: publicUser(user) });
});

module.exports = { router, requireAuth, requireRole, publicUser };
