'use strict';

/**
 * Serveur de l'application "Nouvel Afric - Gestion locative".
 *
 * Lancement :  npm install  puis  npm start
 * L'application est ensuite disponible sur http://localhost:3000
 * (ou sur l'adresse IP du serveur dans le reseau local, pour un acces partage).
 *
 * (Pour Netlify, c'est netlify/functions/api.js qui reutilise la meme app.)
 */

const { app, ready } = require('./src/app');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

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
