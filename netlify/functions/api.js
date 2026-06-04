'use strict';

/**
 * Fonction serverless Netlify : réutilise l'application Express (src/app.js)
 * via serverless-http. Toutes les requêtes /api/* y sont redirigées
 * (voir netlify.toml). Les fichiers statiques sont servis par le CDN Netlify.
 */

const serverless = require('serverless-http');
const { app, ready } = require('../../src/app');

const handler = serverless(app);

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  await ready; // s'assurer que la base est initialisée (schéma + données)

  // Netlify fournit l'URL d'origine : on la donne à Express comme chemin réel
  // (ex. /api/owners), quel que soit le chemin de redirection interne.
  if (event.rawUrl) {
    try { event.path = new URL(event.rawUrl).pathname; } catch (_) { /* on garde event.path */ }
  }

  return handler(event, context);
};
