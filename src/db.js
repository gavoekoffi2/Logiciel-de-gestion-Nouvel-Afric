'use strict';

/**
 * Base de donnees du logiciel de gestion locative "Nouvel Afric".
 *
 * Utilise libSQL (100 % compatible SQLite) via @libsql/client :
 *   - EN LOCAL  : un simple fichier  data/nouvelafric.db
 *   - EN LIGNE  : une base hebergee GRATUITEMENT sur Turso (les donnees y sont
 *                 conservees en permanence), activee des que la variable
 *                 d'environnement TURSO_DATABASE_URL est definie.
 *
 * L'acces a la base est asynchrone : un petit adaptateur "db.prepare(sql)"
 * reproduit l'interface habituelle .get() / .all() / .run() (avec await) afin
 * de garder un code clair et proche du SQLite classique.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

// ---------------------------------------------------------------------------
// Connexion : Turso (en ligne) si configure, sinon fichier local.
// ---------------------------------------------------------------------------
let client;
if (process.env.TURSO_DATABASE_URL) {
  client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  console.log('Base de donnees : Turso (en ligne) - les donnees sont conservees.');
} else {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'nouvelafric.db');
  const DB_DIR = path.dirname(DB_PATH);
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  client = createClient({ url: `file:${DB_PATH}` });
  console.log(`Base de donnees : fichier local (${DB_PATH}).`);
}

// ---------------------------------------------------------------------------
// Adaptateur asynchrone .prepare(sql).get()/.all()/.run()
//  - 1 seul argument objet  -> parametres nommes (@cle / :cle)
//  - sinon                  -> parametres positionnels (?)
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
          // libSQL renvoie un BigInt : on le convertit en nombre classique.
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
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT UNIQUE NOT NULL,
  password   TEXT NOT NULL,
  nom        TEXT,
  role       TEXT NOT NULL DEFAULT 'secretaire',  -- 'admin' | 'secretaire'
  actif      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  entreprise TEXT NOT NULL DEFAULT 'NOUVEL AFRIC',
  telephone  TEXT,
  email      TEXT,
  adresse    TEXT,
  devise     TEXT NOT NULL DEFAULT 'FCFA'
);

CREATE TABLE IF NOT EXISTS owners (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nom_prenoms TEXT NOT NULL,
  contact     TEXT,
  email       TEXT,
  adresse     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS tenants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nom_prenoms TEXT NOT NULL,
  contact     TEXT,
  email       TEXT,
  adresse     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS properties (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT UNIQUE NOT NULL,
  owner_id          INTEGER REFERENCES owners(id) ON DELETE SET NULL,
  type_construction TEXT,
  nombre_piece      INTEGER,
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
  code                TEXT UNIQUE NOT NULL,
  property_id         INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  tenant_id           INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  date_souscription   TEXT,
  montant_loyer       INTEGER NOT NULL DEFAULT 0,
  nombre_mois_caution INTEGER NOT NULL DEFAULT 0,
  montant_caution     INTEGER NOT NULL DEFAULT 0,
  nombre_mois_avance  INTEGER NOT NULL DEFAULT 0,
  montant_avance      INTEGER NOT NULL DEFAULT 0,
  autre_frais         TEXT,
  montant_autre_frais INTEGER NOT NULL DEFAULT 0,
  date_entree         TEXT,
  date_debut_paiement TEXT,
  statut              TEXT NOT NULL DEFAULT 'Active',  -- 'Active' | 'Desactive'
  created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
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
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_prop_owner   ON properties(owner_id);
CREATE INDEX IF NOT EXISTS idx_sub_prop     ON subscriptions(property_id);
CREATE INDEX IF NOT EXISTS idx_sub_tenant   ON subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pay_sub      ON payments(subscription_id);
CREATE INDEX IF NOT EXISTS idx_pay_periode  ON payments(annee_concernee, mois_concerne);
`;

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
// Donnees initiales (utilisateurs, parametres, et un jeu d'exemple)
// ---------------------------------------------------------------------------
async function seed() {
  const userCount = (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n;
  if (userCount === 0) {
    const insUser = db.prepare('INSERT INTO users (username, password, nom, role) VALUES (?,?,?,?)');
    await insUser.run('admin', hashPassword('admin123'), 'Administrateur', 'admin');
    await insUser.run('secretaire', hashPassword('secret123'), 'Secrétaire', 'secretaire');
  }

  const hasSettings = (await db.prepare('SELECT COUNT(*) AS n FROM settings').get()).n;
  if (hasSettings === 0) {
    await db.prepare(
      `INSERT INTO settings (id, entreprise, telephone, email, adresse, devise)
       VALUES (1, ?, ?, ?, ?, ?)`
    ).run(
      'NOUVEL AFRIC',
      '+225 00 00 00 00',
      'contact@nouvelafric.ci',
      'Abidjan, Côte d’Ivoire',
      'FCFA'
    );
  }

  const propCount = (await db.prepare('SELECT COUNT(*) AS n FROM properties').get()).n;
  if (propCount === 0) {
    await seedExampleData();
  }
}

async function seedExampleData() {
  const ownerId = (await db
    .prepare('INSERT INTO owners (nom_prenoms, contact) VALUES (?, ?)')
    .run('BAHI DJEDJE LAURENT', '0758969275')).lastInsertRowid;

  const t1 = (await db
    .prepare('INSERT INTO tenants (nom_prenoms, contact) VALUES (?, ?)')
    .run("N'GUESSAN ANGE", '0151104104')).lastInsertRowid;
  const t2 = (await db
    .prepare('INSERT INTO tenants (nom_prenoms, contact) VALUES (?, ?)')
    .run('AFFESSY FRANCK', '0505660408')).lastInsertRowid;

  const insProp = db.prepare(
    `INSERT INTO properties
     (code, owner_id, type_construction, nombre_piece, cout_loyer, ville, commune, quartier, part_commission, nombre_porte)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const p1 = (await insProp.run('MB_P3_C150000_M05022023A1812338', ownerId, 'Maison basse', 3, 150000, 'ABIDJAN', 'YOPOUGON', 'MAROC', 20, 4)).lastInsertRowid;
  const p2 = (await insProp.run('MB_P4_C250000_M05022023A545690', ownerId, 'Maison basse', 4, 250000, 'ABIDJAN', 'COCODY', 'RIVIERA PALMERAIE', 10, 1)).lastInsertRowid;

  const insSub = db.prepare(
    `INSERT INTO subscriptions
     (code, property_id, tenant_id, date_souscription, montant_loyer,
      nombre_mois_caution, montant_caution, nombre_mois_avance, montant_avance,
      autre_frais, montant_autre_frais, date_entree, date_debut_paiement, statut)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const s1 = (await insSub.run('S05022023A1013772', p1, t1, '2023-02-05', 150000, 2, 300000, 2, 300000, '', 0, '2023-02-05', '2023-02-05', 'Active')).lastInsertRowid;
  const s2 = (await insSub.run('S05022023A3370599', p2, t2, '2023-02-05', 250000, 2, 500000, 2, 500000, 'GARAGE', 10000, '2023-02-05', '2023-02-05', 'Active')).lastInsertRowid;

  const insPay = db.prepare(
    `INSERT INTO payments
     (code, subscription_id, property_id, tenant_id, date, montant_a_payer, montant_paye, reste_a_payer, mois_concerne, annee_concernee, statut)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  let n = 1000;
  const pay = (sub, prop, ten, montant, mois, annee) =>
    insPay.run(`R0000${n++}`, sub, prop, ten, '2023-02-05', montant, montant, 0, mois, annee, 'Soldé');
  await pay(s1, p1, t1, 150000, 'Mars', 2023);
  await pay(s1, p1, t1, 150000, 'Mai', 2023);
  await pay(s1, p1, t1, 150000, 'Juin', 2023);
  await pay(s2, p2, t2, 250000, 'Mai', 2023);
  await pay(s2, p2, t2, 250000, 'Juin', 2023);
}

// Initialisation : creation du schema puis donnees initiales.
// `ready` est attendu par le serveur avant d'accepter les requetes.
async function init() {
  try { await client.execute('PRAGMA foreign_keys = ON'); } catch (_) { /* ignore sur Turso */ }
  await client.executeMultiple(SCHEMA_SQL);
  await seed();
}

const ready = init();

module.exports = { db, ready, hashPassword, verifyPassword };
