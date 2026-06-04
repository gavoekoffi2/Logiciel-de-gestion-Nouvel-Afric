'use strict';

/**
 * Construction de l'application Express (sans demarrage du serveur).
 *   - par server.js          -> serveur classique (local, Render…)
 *   - par netlify/functions  -> fonction serverless (Netlify)
 *
 * Plateforme multi-entreprises : authentification par e-mail, isolation des
 * donnees par entreprise, espace super-administrateur, abonnement annuel.
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');

const { ready, db } = require('./db');
const {
  router: authRouter, requireAuth, requireSuperadmin, requireCompany, requireActiveSubscription,
} = require('./auth');
const { router: apiRouter, settingsRouter, subscriptionRouter, dataRouter } = require('./api');
const platformRouter = require('./platform');

const isProd = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();

app.disable('x-powered-by');
if (isProd) app.set('trust proxy', 1);
// Limite genereuse : couvre les logos (data URL) et surtout la RESTAURATION d'une
// sauvegarde complete (proprietaires + locataires + biens + baux + reglements).
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(cookieSession({
  name: 'naf.sid',
  keys: [process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')],
  httpOnly: true,
  sameSite: 'lax',
  secure: isProd,
  maxAge: 1000 * 60 * 60 * 12, // 12 h
}));

// ----- Routes publiques --------------------------------------------------
// Authentification (inscription, connexion, /me, déconnexion, mot de passe).
app.use('/api/auth', authRouter);

// Identité visuelle de la PLATEFORME (page de connexion / inscription).
app.get('/api/branding', async (req, res) => {
  try {
    const p = await db.prepare('SELECT nom FROM platform WHERE id = 1').get();
    res.json({ entreprise: (p && p.nom) || 'Nouvel Afric', logo: null });
  } catch (_) {
    res.json({ entreprise: 'Nouvel Afric', logo: null });
  }
});

// ----- Toute la suite exige une session connectée ------------------------
app.use('/api', requireAuth);

// Espace super-administrateur (gestion des entreprises + plateforme).
app.use('/api/platform', requireSuperadmin, platformRouter);

// Abonnement de l'entreprise (consultable même si expiré -> permet la demande d'activation).
app.use('/api/subscription', requireCompany, subscriptionRouter);

// Paramètres/branding de l'entreprise (consultable même si expiré).
app.use('/api/settings', requireCompany, settingsRouter);

// Sauvegarde / restauration des données de l'entreprise (réservé à l'admin via
// le routeur). Volontairement placé AVANT la barrière d'abonnement actif : on ne
// retient jamais les données du client en otage (l'export reste possible même si
// l'abonnement a expiré).
app.use('/api/data', requireCompany, dataRouter);

// API métier : isolée par entreprise ET protégée par l'abonnement actif.
app.use('/api', requireCompany, requireActiveSubscription, apiRouter);

// ----- Pages publiques ---------------------------------------------------
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'register.html')));

// Application principale : nécessite une session.
app.get('/', (req, res, next) => {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  next();
});

// Fichiers statiques (CSS, JS, pages d'impression...).
app.use(express.static(PUBLIC_DIR));

// SPA : toute autre route HTML renvoie l'application (si connecté).
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (!req.session || !req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

module.exports = { app, ready };
