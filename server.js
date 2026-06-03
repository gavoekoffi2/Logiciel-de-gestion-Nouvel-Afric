'use strict';

/**
 * Serveur de l'application "Nouvel Afric - Gestion locative".
 *
 * Lancement :  npm install  puis  npm start
 * L'application est ensuite disponible sur http://localhost:3000
 * (ou sur l'adresse IP du serveur dans le reseau local, pour un acces partage).
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');

const { ready } = require('./src/db');
const { router: authRouter, requireAuth } = require('./src/auth');
const apiRouter = require('./src/api');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const isProd = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');
if (isProd) app.set('trust proxy', 1); // derriere le proxy HTTPS de l'hebergeur
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Session stockee dans un cookie signe : aucune donnee a conserver cote serveur,
// donc les connexions resistent aux redemarrages (ideal pour un hebergement gratuit).
app.use(cookieSession({
  name: 'naf.sid',
  keys: [process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')],
  httpOnly: true,
  sameSite: 'lax',
  secure: isProd,              // cookie envoye uniquement en HTTPS en production
  maxAge: 1000 * 60 * 60 * 12, // 12 h
}));

// Routes d'authentification (publiques).
app.use('/api/auth', authRouter);

// Toute l'API metier exige une session connectee.
app.use('/api', requireAuth, apiRouter);

// Page de connexion (publique).
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Protege l'application principale : redirige vers /login si non connecte.
app.get('/', (req, res, next) => {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  next();
});

// Fichiers statiques (CSS, JS, pages d'impression...).
app.use(express.static(path.join(__dirname, 'public')));

// Pour toute autre route HTML non-API, renvoyer l'application (SPA).
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (!req.session || !req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

// On attend que la base soit prete (schema + donnees initiales) avant de
// demarrer le serveur, afin de ne jamais repondre avant que tout soit en place.
ready
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`\n  Nouvel Afric - Gestion locative`);
      console.log(`  Serveur démarré sur http://localhost:${PORT}`);
      console.log(`  (accessible sur le réseau via http://<adresse-ip-du-serveur>:${PORT})\n`);
    });
  })
  .catch((err) => {
    console.error('Échec de l’initialisation de la base de données :', err);
    process.exit(1);
  });
