'use strict';

/**
 * Assure le compte dedie Nouvel Afrik / Nouvelles Afrique :
 * - entreprise active + illimitee (pas d'ecran abonnement) ;
 * - logo affiche sur la page de connexion dediee /e/nouvel-afrik ;
 * - administrateur principal actif avec mot de passe defini par env.
 *
 * Usage:
 *   DB_PATH=/opt/nouvel-afric/data/nouvelafric.db \
 *   NOUVEL_AFRIK_ADMIN_EMAIL=admin@nouvelafrik.tg \
 *   NOUVEL_AFRIK_ADMIN_PASSWORD='...' \
 *   node scripts/ensure-nouvel-afrik-account.js
 */

const { ready, db, hashPassword } = require('../src/db');

const ADMIN_EMAIL = (process.env.NOUVEL_AFRIK_ADMIN_EMAIL || 'admin@nouvelafrik.tg').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.NOUVEL_AFRIK_ADMIN_PASSWORD || '').trim();
const COMPANY_NAME = (process.env.NOUVEL_AFRIK_COMPANY_NAME || 'Nouvel Afrik').trim();
const ADMIN_NAME = (process.env.NOUVEL_AFRIK_ADMIN_NAME || 'Administrateur Nouvel Afrik').trim();
const LOGO = process.env.NOUVEL_AFRIK_LOGO || '/assets/nouvel-afrik-logo.jpg';

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isNouvelAfrikName(value) {
  const n = normalize(value);
  return /\b(nouvel|nouvelle|nouvelles)\b/.test(n) && /\b(afric|afrik|afrique|africa)\b/.test(n);
}

(async () => {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
    throw new Error('Definir NOUVEL_AFRIK_ADMIN_PASSWORD avec au moins 8 caracteres.');
  }
  await ready;

  const companies = await db.prepare('SELECT * FROM companies ORDER BY id').all();
  let company = companies.find((c) => normalize(c.nom) === normalize(COMPANY_NAME))
    || companies.find((c) => isNouvelAfrikName(c.nom));

  if (!company) {
    const info = await db.prepare(
      `INSERT INTO companies (nom, telephone, email, devise, logo, plan, statut, essai_fin, abonnement_fin, illimite, demande_le)
       VALUES (?, '', ?, 'FCFA', ?, 'dedie', 'actif', NULL, NULL, 1, NULL)`
    ).run(COMPANY_NAME, ADMIN_EMAIL, LOGO);
    company = await db.prepare('SELECT * FROM companies WHERE id = ?').get(info.lastInsertRowid);
  } else {
    await db.prepare(
      `UPDATE companies
       SET nom = ?, email = ?, logo = ?, plan = 'dedie', statut = 'actif',
           essai_fin = NULL, abonnement_fin = NULL, illimite = 1, demande_le = NULL
       WHERE id = ?`
    ).run(COMPANY_NAME, ADMIN_EMAIL, LOGO, company.id);
    company = await db.prepare('SELECT * FROM companies WHERE id = ?').get(company.id);
  }

  const existingEmailOwner = await db.prepare('SELECT * FROM users WHERE email = ?').get(ADMIN_EMAIL);
  if (existingEmailOwner && Number(existingEmailOwner.company_id) !== Number(company.id)) {
    throw new Error(`L'e-mail ${ADMIN_EMAIL} est deja utilise par une autre entreprise/user id ${existingEmailOwner.id}.`);
  }

  const admin = existingEmailOwner || await db.prepare(
    "SELECT * FROM users WHERE company_id = ? AND role = 'admin' ORDER BY id LIMIT 1"
  ).get(company.id);

  if (admin) {
    await db.prepare(
      `UPDATE users SET username = ?, email = ?, password = ?, nom = ?, role = 'admin', company_id = ?, actif = 1
       WHERE id = ?`
    ).run(ADMIN_EMAIL, ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD), ADMIN_NAME, company.id, admin.id);
  } else {
    await db.prepare(
      "INSERT INTO users (username, email, password, nom, role, company_id, actif) VALUES (?, ?, ?, ?, 'admin', ?, 1)"
    ).run(ADMIN_EMAIL, ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD), ADMIN_NAME, company.id);
  }

  const out = {
    ok: true,
    link: '/e/nouvel-afrik',
    company: await db.prepare('SELECT id, nom, email, plan, statut, illimite, logo FROM companies WHERE id = ?').get(company.id),
    admin: await db.prepare('SELECT id, email, nom, role, actif, company_id FROM users WHERE email = ?').get(ADMIN_EMAIL),
  };
  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
