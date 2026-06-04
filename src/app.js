'use strict';

/**
 * Construction de l'application Express (sans demarrage du serveur).
 *
 * Ce module est utilise :
 *   - par server.js          -> serveur classique (local, Render…)
 *   - par netlify/functions  -> fonction serverless (Netlify)
 *
 * `ready` est la promesse d'initialisation de la base (schema + donnees).
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');

const { ready } = require('./db');
const { router: authRouter, requireAuth } = require('./auth');
const apiRouter = require('./api');

const isProd = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();

app.disable('x-powered-by');
if (isProd) app.set('trust proxy', 1); // derriere le proxy HTTPS de l'hebergeur
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Session stockee dans un cookie signe : aucune donnee a conserver cote serveur,
// donc les connexions resistent aux redemarrages (ideal pour l'hebergement gratuit
// et indispensable en mode serverless).
app.use(cookieSession({
  name: 'naf.sid',
  keys: [process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')],
  httpOnly: true,
  sameSite: 'lax',
  secure: isProd,
  maxAge: 1000 * 60 * 60 * 12, // 12 h
}));

// Routes d'authentification (publiques).
app.use('/api/auth', authRouter);

// Toute l'API metier exige une session connectee.
app.use('/api', requireAuth, apiRouter);

// Page de connexion (publique).
app.get('/login', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

// Protege l'application principale : redirige vers /login si non connecte.
app.get('/', (req, res, next) => {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  next();
});

// Fichiers statiques (CSS, JS, pages d'impression...).
app.use(express.static(PUBLIC_DIR));

// Pour toute autre route HTML non-API, renvoyer l'application (SPA).
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
