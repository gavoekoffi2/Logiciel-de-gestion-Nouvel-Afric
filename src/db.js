'use strict';

/**
 * Base de donnees du logiciel de gestion locative "Nouvel Afric".
 *
 * PLATEFORME MULTI-ENTREPRISES (SaaS) :
 *   - Chaque entreprise (agence) possede son propre espace et ne voit QUE ses
 *     donnees (isolation par "company_id").
 *   - Un "super-administrateur" (proprietaire de la plateforme) supervise toutes
 *     les entreprises et active/prolonge leurs abonnements ANNUELS manuellement.
 *   - Chaque entreprise demarre par un ESSAI GRATUIT, puis doit etre activee par
 *     le super-administrateur apres paiement (activation manuelle, pas de paiement
 *     en ligne pour le moment).
 *
 * Stockage : libSQL (100 % compatible SQLite) via @libsql/client :
 *   - EN LOCAL  : un simple fichier  data/nouvelafric.db
 *   - EN LIGNE  : une base hebergee gratuitement sur Turso (TURSO_DATABASE_URL).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Connexion. Choix automatique du client libSQL.
// ---------------------------------------------------------------------------
let client;
if (process.env.TURSO_DATABASE_URL) {
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (process.env.LIBSQL_WEB) {
    const { createClient } = require('@libsql/client/web');
    const url = process.env.TURSO_DATABASE_URL.replace(/^libsql:\/\//, 'https://');
    client = createClient({ url, authToken });
    console.log('Base de donnees : Turso (en ligne, client web/HTTP).');
  } else {
    const { createClient } = require('@libsql/client');
    client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken });
    console.log('Base de donnees : Turso (en ligne) - les donnees sont conservees.');
  }
} else {
  const { createClient } = require('@libsql/client');
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'nouvelafric.db');
  const DB_DIR = path.dirname(DB_PATH);
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  client = createClient({ url: `file:${DB_PATH}` });
  console.log(`Base de donnees : fichier local (${DB_PATH}).`);
}

// ---------------------------------------------------------------------------
// Adaptateur asynchrone .prepare(sql).get()/.all()/.run()
// ---------------------------------------------------------------------------
function buildStmt(sql, params) {
  if (params.length === 0) return sql;
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    return { sql, args: params[0] };
  }
  return { sql, args: params };
}

const db = {
  prepare(sql) {
    return {
      async get(...params) {
        const r = await client.execute(buildStmt(sql, params));
        return r.rows[0];
      },
      async all(...params) {
        const r = await client.execute(buildStmt(sql, params));
        return r.rows;
      },
      async run(...params) {
        const r = await client.execute(buildStmt(sql, params));
        return {
          lastInsertRowid: r.lastInsertRowid == null ? undefined : Number(r.lastInsertRowid),
          changes: r.rowsAffected,
        };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
-- Entreprises (locataires de la plateforme). Contient le profil/branding ET
-- l'etat de l'abonnement annuel.
CREATE TABLE IF NOT EXISTS companies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nom            TEXT NOT NULL,
  telephone      TEXT,
  email          TEXT,
  adresse        TEXT,
  devise         TEXT NOT NULL DEFAULT 'FCFA',
  logo           TEXT,
  plan           TEXT NOT NULL DEFAULT 'annuel',
  statut         TEXT NOT NULL DEFAULT 'essai',   -- 'essai' | 'actif' | 'suspendu'
  essai_fin      TEXT,                            -- fin de l'essai gratuit (YYYY-MM-DD)
  abonnement_fin TEXT,                            -- fin de l'abonnement paye (YYYY-MM-DD)
  illimite       INTEGER NOT NULL DEFAULT 0,      -- 1 = abonnement illimite (a vie)
  demande_le     TEXT,                            -- date de demande d'activation (ou NULL)
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Parametres de la plateforme (1 seule ligne) : ce que le super-admin affiche
-- aux entreprises pour s'abonner (contact + tarif annuel).
CREATE TABLE IF NOT EXISTS platform (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  nom               TEXT NOT NULL DEFAULT 'Nouvel Afric',
  contact_telephone TEXT,
  contact_whatsapp  TEXT,
  contact_email     TEXT,
  prix_annuel       INTEGER NOT NULL DEFAULT 50000,
  devise            TEXT NOT NULL DEFAULT 'FCFA',
  message           TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT,
  email      TEXT,
  password   TEXT NOT NULL,
  nom        TEXT,
  role       TEXT NOT NULL DEFAULT 'secretaire',  -- 'superadmin' | 'admin' | 'secretaire'
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  actif      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  entreprise TEXT NOT NULL DEFAULT 'NOUVEL AFRIC',
  telephone  TEXT,
  email      TEXT,
  adresse    TEXT,
  devise     TEXT NOT NULL DEFAULT 'FCFA',
  logo       TEXT
);

CREATE TABLE IF NOT EXISTS owners (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  nom_prenoms TEXT NOT NULL,
  contact     TEXT,
  email       TEXT,
  adresse     TEXT,
  type_logement   TEXT,   -- 'Villa' | 'Appartement'
  pieces_logement TEXT,   -- ex. 'Chambre salon', '3 chambres salon'
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS tenants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  nom_prenoms TEXT NOT NULL,
  contact     TEXT,
  email       TEXT,
  adresse     TEXT,
  caution     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS properties (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  code              TEXT UNIQUE NOT NULL,
  owner_id          INTEGER REFERENCES owners(id) ON DELETE SET NULL,
  type_construction TEXT,                          -- 'RDC' | 'R+1' | 'R+2' | 'R+3'
  nombre_piece      INTEGER,                         -- (ancien champ, conserve)
  designation       TEXT,                            -- texte libre (ex. 'Appartement meuble')
  cout_loyer        INTEGER NOT NULL DEFAULT 0,
  ville             TEXT,
  commune           TEXT,
  quartier          TEXT,
  observation       TEXT,
  part_commission   REAL NOT NULL DEFAULT 0,
  nombre_porte      INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id          INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  code                TEXT UNIQUE NOT NULL,
  property_id         INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  tenant_id           INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  date_souscription   TEXT,
  montant_loyer       INTEGER NOT NULL DEFAULT 0,
  nombre_mois_caution INTEGER NOT NULL DEFAULT 0,
  montant_caution     INTEGER NOT NULL DEFAULT 0,
  nombre_mois_avance  INTEGER NOT NULL DEFAULT 0,
  montant_avance      INTEGER NOT NULL DEFAULT 0,
  nombre_mois_garantie INTEGER NOT NULL DEFAULT 0,
  montant_garantie    INTEGER NOT NULL DEFAULT 0,
  autre_frais         TEXT,
  montant_autre_frais INTEGER NOT NULL DEFAULT 0,
  date_entree         TEXT,
  date_debut_paiement TEXT,
  statut              TEXT NOT NULL DEFAULT 'Active',  -- 'Active' | 'Desactive'
  created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Reversements aux proprietaires : l'agence encaisse les loyers, preleve sa
-- commission (part_commission du bien) et reverse le net au proprietaire.
-- Chaque reglement encaisse est rattache (payout_id) au reversement qui le
-- couvre, ce qui interdit tout double reversement.
CREATE TABLE IF NOT EXISTS payouts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id         INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  code               TEXT UNIQUE NOT NULL,
  owner_id           INTEGER REFERENCES owners(id) ON DELETE SET NULL,
  date               TEXT,
  periode_debut      TEXT,
  periode_fin        TEXT,
  nombre_paiements   INTEGER NOT NULL DEFAULT 0,
  montant_loyers     INTEGER NOT NULL DEFAULT 0,
  montant_commission INTEGER NOT NULL DEFAULT 0,
  montant_net        INTEGER NOT NULL DEFAULT 0,
  note               TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  code            TEXT UNIQUE NOT NULL,
  subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
  property_id     INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  tenant_id       INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  date            TEXT,
  montant_a_payer INTEGER NOT NULL DEFAULT 0,
  montant_paye    INTEGER NOT NULL DEFAULT 0,
  reste_a_payer   INTEGER NOT NULL DEFAULT 0,
  mois_concerne   TEXT,
  annee_concernee INTEGER,
  statut          TEXT NOT NULL DEFAULT 'Soldé',  -- 'Soldé' | 'Non soldé'
  payout_id       INTEGER REFERENCES payouts(id) ON DELETE SET NULL,  -- reversement couvrant ce loyer
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Journal d'activite : trace QUI fait QUOI (ajout / modification / suppression).
-- L'administrateur le consulte pour superviser le travail de son equipe.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  user_id    INTEGER,                 -- auteur (peut etre supprime ensuite)
  user_nom   TEXT,                    -- nom de l'auteur au moment de l'action
  action     TEXT,                    -- 'Création' | 'Modification' | 'Suppression'
  entity     TEXT,                    -- 'Propriétaire' | 'Locataire' | 'Bien' | ...
  label      TEXT,                    -- libelle lisible (nom / code)
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

`;

// Index crees APRES les migrations : certains portent sur des colonnes ajoutees
// par une migration (company_id, payout_id) et ne peuvent donc etre crees qu'une
// fois la colonne presente. CREATE INDEX IF NOT EXISTS reste idempotent.
const INDEXES_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_company  ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_owners_company ON owners(company_id);
CREATE INDEX IF NOT EXISTS idx_tenants_company ON tenants(company_id);
CREATE INDEX IF NOT EXISTS idx_prop_company   ON properties(company_id);
CREATE INDEX IF NOT EXISTS idx_sub_company    ON subscriptions(company_id);
CREATE INDEX IF NOT EXISTS idx_pay_company    ON payments(company_id);
CREATE INDEX IF NOT EXISTS idx_prop_owner     ON properties(owner_id);
CREATE INDEX IF NOT EXISTS idx_sub_prop       ON subscriptions(property_id);
CREATE INDEX IF NOT EXISTS idx_sub_tenant     ON subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pay_sub        ON payments(subscription_id);
CREATE INDEX IF NOT EXISTS idx_pay_periode    ON payments(annee_concernee, mois_concerne);
CREATE INDEX IF NOT EXISTS idx_pay_payout     ON payments(payout_id);
CREATE INDEX IF NOT EXISTS idx_payouts_company ON payouts(company_id);
CREATE INDEX IF NOT EXISTS idx_payouts_owner   ON payouts(owner_id);
CREATE INDEX IF NOT EXISTS idx_audit_company   ON audit_log(company_id);
`;

// Migrations pour les bases deja existantes (ajout de colonnes). Chaque ALTER
// echoue silencieusement si la colonne est deja presente.
const MIGRATIONS = [
  "ALTER TABLE settings ADD COLUMN logo TEXT",
  "ALTER TABLE companies ADD COLUMN illimite INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN email TEXT",
  "ALTER TABLE users ADD COLUMN company_id INTEGER",
  "ALTER TABLE owners ADD COLUMN company_id INTEGER",
  "ALTER TABLE tenants ADD COLUMN company_id INTEGER",
  "ALTER TABLE properties ADD COLUMN company_id INTEGER",
  "ALTER TABLE subscriptions ADD COLUMN company_id INTEGER",
  "ALTER TABLE payments ADD COLUMN company_id INTEGER",
  "ALTER TABLE payments ADD COLUMN payout_id INTEGER",
  "ALTER TABLE owners ADD COLUMN type_logement TEXT",
  "ALTER TABLE owners ADD COLUMN pieces_logement TEXT",
  "ALTER TABLE tenants ADD COLUMN caution INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE properties ADD COLUMN designation TEXT",
  "ALTER TABLE subscriptions ADD COLUMN nombre_mois_garantie INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE subscriptions ADD COLUMN montant_garantie INTEGER NOT NULL DEFAULT 0",
];

// ---------------------------------------------------------------------------
// Securite : hachage des mots de passe (scrypt, integre a Node, sans dependance)
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Dates (format YYYY-MM-DD) et calcul de l'etat d'abonnement
// ---------------------------------------------------------------------------
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayYMD() { return ymd(new Date()); }
function addDaysYMD(days, from) {
  const d = from ? new Date(from) : new Date();
  d.setDate(d.getDate() + days);
  return ymd(d);
}
function addYearsYMD(years, from) {
  const d = from ? new Date(from) : new Date();
  d.setFullYear(d.getFullYear() + years);
  return ymd(d);
}
function diffDays(toDate, fromDate) {
  const a = new Date(toDate + 'T00:00:00');
  const b = new Date((fromDate || todayYMD()) + 'T00:00:00');
  return Math.round((a - b) / 86400000);
}

/**
 * Calcule l'etat effectif de l'abonnement d'une entreprise.
 * Renvoie { statut_effectif, actif, en_essai, jours_restants, echeance, ... }.
 *   - statut_effectif : 'actif' | 'essai' | 'expire' | 'suspendu'
 *   - actif           : true si l'acces a l'application est autorise
 */
function computeSubscription(company) {
  if (!company) return { statut_effectif: 'expire', actif: false, en_essai: false, illimite: false, jours_restants: 0, echeance: null };
  const today = todayYMD();
  const base = {
    statut: company.statut,
    illimite: !!company.illimite,
    essai_fin: company.essai_fin || null,
    abonnement_fin: company.abonnement_fin || null,
    demande_le: company.demande_le || null,
  };
  if (company.statut === 'suspendu') {
    return { ...base, statut_effectif: 'suspendu', actif: false, en_essai: false, jours_restants: 0, echeance: company.abonnement_fin || null };
  }
  // Abonnement illimite (a vie) : toujours actif, sans echeance.
  if (company.illimite) {
    return { ...base, statut_effectif: 'actif', actif: true, en_essai: false, jours_restants: null, echeance: null };
  }
  if (company.statut === 'actif') {
    const fin = company.abonnement_fin;
    if (fin && fin >= today) {
      return { ...base, statut_effectif: 'actif', actif: true, en_essai: false, jours_restants: Math.max(0, diffDays(fin, today)), echeance: fin };
    }
    return { ...base, statut_effectif: 'expire', actif: false, en_essai: false, jours_restants: 0, echeance: fin || null };
  }
  // essai
  const fin = company.essai_fin;
  if (fin && fin >= today) {
    return { ...base, statut_effectif: 'essai', actif: true, en_essai: true, jours_restants: Math.max(0, diffDays(fin, today)), echeance: fin };
  }
  return { ...base, statut_effectif: 'expire', actif: false, en_essai: true, jours_restants: 0, echeance: fin || null };
}

// ---------------------------------------------------------------------------
// Initialisation des donnees : plateforme, super-admin, migration, demo
// ---------------------------------------------------------------------------
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);

async function seedPlatform() {
  const has = (await db.prepare('SELECT COUNT(*) AS n FROM platform').get()).n;
  if (has) return;
  await db.prepare(
    `INSERT INTO platform (id, nom, contact_telephone, contact_whatsapp, contact_email, prix_annuel, devise, message)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'Nouvel Afric',
    '+228 90 00 00 00',
    '+228 90 00 00 00',
    'contact@nouvelafric.tg',
    50000,
    'FCFA',
    "Pour activer votre abonnement annuel, contactez-nous (téléphone / WhatsApp / e-mail). Dès réception de votre paiement, nous activons votre compte."
  );
}

async function seedSuperAdmin() {
  const exists = await db.prepare("SELECT 1 FROM users WHERE role = 'superadmin'").get();
  if (exists) return;
  const email = (process.env.SUPERADMIN_EMAIL || 'superadmin@nouvelafric.tg').trim().toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD || 'SuperAdmin2025';
  await db.prepare(
    "INSERT INTO users (username, email, password, nom, role, company_id) VALUES (NULL, ?, ?, ?, 'superadmin', NULL)"
  ).run(email, hashPassword(password), 'Super administrateur');
  console.log(`Super-administrateur cree : ${email} (pensez a changer le mot de passe).`);
}

// Rattache d'eventuelles donnees mono-entreprise existantes a une 1ere entreprise.
async function migrateLegacyData() {
  const companyCount = (await db.prepare('SELECT COUNT(*) AS n FROM companies').get()).n;
  if (companyCount > 0) return; // deja multi-entreprises

  const legacyUsers = await db
    .prepare("SELECT * FROM users WHERE role <> 'superadmin' AND company_id IS NULL")
    .all();
  const orphanData =
    (await db.prepare('SELECT COUNT(*) AS n FROM owners WHERE company_id IS NULL').get()).n +
    (await db.prepare('SELECT COUNT(*) AS n FROM properties WHERE company_id IS NULL').get()).n +
    (await db.prepare('SELECT COUNT(*) AS n FROM tenants WHERE company_id IS NULL').get()).n;

  if (legacyUsers.length === 0 && orphanData === 0) return; // base vierge : rien a migrer

  const s = await db.prepare('SELECT * FROM settings WHERE id = 1').get();
  const nom = (s && s.entreprise) || 'NOUVEL AFRIC';
  // L'entreprise historique est "offerte" (active 10 ans) pour ne rien casser.
  const companyId = (await db.prepare(
    `INSERT INTO companies (nom, telephone, email, adresse, devise, logo, plan, statut, essai_fin, abonnement_fin)
     VALUES (?,?,?,?,?,?, 'annuel', 'actif', ?, ?)`
  ).run(
    nom,
    (s && s.telephone) || null,
    (s && s.email) || null,
    (s && s.adresse) || null,
    (s && s.devise) || 'FCFA',
    (s && s.logo) || null,
    addDaysYMD(3650),
    addYearsYMD(10)
  )).lastInsertRowid;

  for (const t of ['owners', 'tenants', 'properties', 'subscriptions', 'payments']) {
    await db.prepare(`UPDATE ${t} SET company_id = ? WHERE company_id IS NULL`).run(companyId);
  }
  for (const u of legacyUsers) {
    const email = (u.email || `${u.username || ('user' + u.id)}@nouvelafric.local`).toLowerCase();
    await db.prepare('UPDATE users SET company_id = ?, email = ? WHERE id = ?').run(companyId, email, u.id);
  }
  console.log(`Migration : entreprise historique "${nom}" creee (id ${companyId}).`);
}

// Jeu de demonstration TOGOLAIS (local uniquement, jamais en production).
async function seedDemoCompany() {
  const companyId = (await db.prepare(
    `INSERT INTO companies (nom, telephone, email, adresse, devise, plan, statut, essai_fin, abonnement_fin)
     VALUES (?,?,?,?,?, 'annuel', 'actif', ?, ?)`
  ).run(
    'IMMOBILIER DU GOLFE',
    '+228 90 12 34 56',
    'contact@immobiliergolfe.tg',
    'Tokoin, Lomé - Togo',
    'FCFA',
    addDaysYMD(3650),
    addYearsYMD(5)
  )).lastInsertRowid;

  await db.prepare(
    "INSERT INTO users (username, email, password, nom, role, company_id) VALUES (NULL, ?, ?, ?, 'admin', ?)"
  ).run('demo@immobiliergolfe.tg', hashPassword('demo1234'), 'Komla MENSAH', companyId);
  await db.prepare(
    "INSERT INTO users (username, email, password, nom, role, company_id) VALUES (NULL, ?, ?, ?, 'secretaire', ?)"
  ).run('secretaire@immobiliergolfe.tg', hashPassword('demo1234'), 'Afi ADJAVON', companyId);

  const ownerId = (await db
    .prepare('INSERT INTO owners (company_id, nom_prenoms, contact) VALUES (?,?,?)')
    .run(companyId, 'MENSAH Kossi', '+228 90 22 33 44')).lastInsertRowid;

  const t1 = (await db
    .prepare('INSERT INTO tenants (company_id, nom_prenoms, contact) VALUES (?,?,?)')
    .run(companyId, 'AGBEKO Yawo', '+228 91 23 45 67')).lastInsertRowid;
  const t2 = (await db
    .prepare('INSERT INTO tenants (company_id, nom_prenoms, contact) VALUES (?,?,?)')
    .run(companyId, 'LAWSON Adjo', '+228 92 34 56 78')).lastInsertRowid;

  const insProp = db.prepare(
    `INSERT INTO properties
     (company_id, code, owner_id, type_construction, nombre_piece, cout_loyer, ville, commune, quartier, part_commission, nombre_porte)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const p1 = (await insProp.run(companyId, 'MB_P3_C75000_DEMOA1001', ownerId, 'Maison basse', 3, 75000, 'LOMÉ', 'Golfe', 'Tokoin', 20, 4)).lastInsertRowid;
  const p2 = (await insProp.run(companyId, 'MB_P4_C120000_DEMOA1002', ownerId, 'Maison basse', 4, 120000, 'LOMÉ', 'Golfe', 'Agoè-Nyivé', 10, 1)).lastInsertRowid;

  const insSub = db.prepare(
    `INSERT INTO subscriptions
     (company_id, code, property_id, tenant_id, date_souscription, montant_loyer,
      nombre_mois_caution, montant_caution, nombre_mois_avance, montant_avance,
      autre_frais, montant_autre_frais, date_entree, date_debut_paiement, statut)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const s1 = (await insSub.run(companyId, 'SDEMOA2001', p1, t1, '2025-01-10', 75000, 2, 150000, 2, 150000, '', 0, '2025-01-10', '2025-01-10', 'Active')).lastInsertRowid;
  const s2 = (await insSub.run(companyId, 'SDEMOA2002', p2, t2, '2025-02-01', 120000, 2, 240000, 1, 120000, 'GARAGE', 10000, '2025-02-01', '2025-02-01', 'Active')).lastInsertRowid;

  const insPay = db.prepare(
    `INSERT INTO payments
     (company_id, code, subscription_id, property_id, tenant_id, date, montant_a_payer, montant_paye, reste_a_payer, mois_concerne, annee_concernee, statut)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let n = 3000;
  const pay = (sub, prop, ten, montant, mois, annee) =>
    insPay.run(companyId, `RDEMOA${n++}`, sub, prop, ten, '2025-02-05', montant, montant, 0, mois, annee, 'Soldé');
  await pay(s1, p1, t1, 75000, 'Janvier', 2025);
  await pay(s1, p1, t1, 75000, 'Février', 2025);
  await pay(s2, p2, t2, 120000, 'Février', 2025);
}

// ---------------------------------------------------------------------------
// Initialisation : schema, migrations puis donnees initiales.
// ---------------------------------------------------------------------------
async function init() {
  try { await client.execute('PRAGMA foreign_keys = ON'); } catch (_) { /* ignore sur Turso */ }
  await client.executeMultiple(SCHEMA_SQL);
  for (const sql of MIGRATIONS) {
    try { await client.execute(sql); } catch (_) { /* colonne deja presente */ }
  }
  // Les index sont crees apres les migrations (cf. INDEXES_SQL) pour qu'ils
  // puissent porter sur des colonnes ajoutees par une migration.
  await client.executeMultiple(INDEXES_SQL);
  await seedPlatform();
  await seedSuperAdmin();
  await migrateLegacyData();

  // Demo : uniquement hors production, et seulement si aucune entreprise.
  const wantDemo = process.env.SEED_DEMO ? true : process.env.NODE_ENV !== 'production';
  const companyCount = (await db.prepare('SELECT COUNT(*) AS n FROM companies').get()).n;
  if (wantDemo && companyCount === 0) {
    await seedDemoCompany();
  }
}

const ready = init();

module.exports = {
  db,
  ready,
  hashPassword,
  verifyPassword,
  computeSubscription,
  todayYMD,
  addDaysYMD,
  addYearsYMD,
  TRIAL_DAYS,
};
