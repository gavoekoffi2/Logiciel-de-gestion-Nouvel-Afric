#!/usr/bin/env node
'use strict';

/**
 * Réinitialise le mot de passe d'un utilisateur Nouvel Afric.
 *
 * Usage recommandé :
 *   RESET_EMAIL="client@example.com" RESET_PASSWORD="NouveauMotDePasse123" node scripts/reset-user-password.js
 *
 * Respecte automatiquement la configuration de base de données du projet :
 *   - DB_PATH pour SQLite local/Hostinger
 *   - TURSO_DATABASE_URL + TURSO_AUTH_TOKEN pour Turso
 */

const { ready, db, hashPassword } = require('../src/db');

function clean(value) {
  return value == null ? '' : String(value).trim();
}

async function main() {
  await ready;

  const email = clean(process.env.RESET_EMAIL).toLowerCase();
  const password = clean(process.env.RESET_PASSWORD);

  if (!email || !password) {
    console.error('Usage: RESET_EMAIL="email@exemple.com" RESET_PASSWORD="NouveauMotDePasse123" node scripts/reset-user-password.js');
    process.exit(1);
  }

  if (password.length < 6) {
    console.error('Erreur: le mot de passe doit contenir au moins 6 caractères.');
    process.exit(1);
  }

  const user = await db.prepare('SELECT id, email, role, actif, company_id FROM users WHERE lower(email) = ?').get(email);
  if (!user) {
    console.error(`Erreur: aucun utilisateur trouvé avec l’e-mail ${email}.`);
    process.exit(1);
  }

  await db.prepare('UPDATE users SET password = ?, actif = 1 WHERE id = ?').run(hashPassword(password), user.id);

  console.log(JSON.stringify({
    ok: true,
    message: 'Mot de passe réinitialisé. Redémarrez l’application Node.js puis reconnectez-vous.',
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      company_id: user.company_id,
      actif: 1,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
