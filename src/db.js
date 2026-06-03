'use strict';

/**
 * Base de donnees SQLite du logiciel de gestion locative "Nouvel Afric".
 *
 * Tout est dans un seul fichier (data/nouvelafric.db) : facile a sauvegarder
 * (il suffit de copier le fichier) et a deployer. SQLite gere parfaitement
 * la charge d'un cabinet de gestion immobiliere (plusieurs utilisateurs en
 * reseau local ou via un petit serveur).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Emplacement de la base : par defaut data/nouvelafric.db, ou DB_PATH (ex. un
// disque persistant /data/... chez un hebergeur en ligne).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'nouvelafric.db');
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Reglages de robustesse / performance pour un usage multi-utilisateurs.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
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

CREATE TABLE IF NOT EXISTS owners (            -- Proprietaires
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nom_prenoms TEXT NOT NULL,
  contact     TEXT,
  email       TEXT,
  adresse     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS tenants (           -- Locataires
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nom_prenoms TEXT NOT NULL,
  contact     TEXT,
  email       TEXT,
  adresse     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS properties (        -- Maisons / biens
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

CREATE TABLE IF NOT EXISTS subscriptions (     -- Souscriptions / baux
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

CREATE TABLE IF NOT EXISTS payments (          -- Reglements / paiements de loyer
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
`);

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
function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) {
    const insUser = db.prepare(
      'INSERT INTO users (username, password, nom, role) VALUES (?,?,?,?)'
    );
    insUser.run('admin', hashPassword('admin123'), 'Administrateur', 'admin');
    insUser.run('secretaire', hashPassword('secret123'), 'Secrétaire', 'secretaire');
  }

  const hasSettings = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
  if (hasSettings === 0) {
    db.prepare(
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

  // Jeu d'exemple repris du fichier Excel d'origine (pour demonstration).
  const propCount = db.prepare('SELECT COUNT(*) AS n FROM properties').get().n;
  if (propCount === 0) {
    seedExampleData();
  }
}

function seedExampleData() {
  const tx = db.transaction(() => {
    const owner = db
      .prepare('INSERT INTO owners (nom_prenoms, contact) VALUES (?, ?)')
      .run('BAHI DJEDJE LAURENT', '0758969275');
    const ownerId = owner.lastInsertRowid;

    const t1 = db
      .prepare('INSERT INTO tenants (nom_prenoms, contact) VALUES (?, ?)')
      .run("N'GUESSAN ANGE", '0151104104').lastInsertRowid;
    const t2 = db
      .prepare('INSERT INTO tenants (nom_prenoms, contact) VALUES (?, ?)')
      .run('AFFESSY FRANCK', '0505660408').lastInsertRowid;

    const p1 = db
      .prepare(
        `INSERT INTO properties
         (code, owner_id, type_construction, nombre_piece, cout_loyer, ville, commune, quartier, part_commission, nombre_porte)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run('MB_P3_C150000_M05022023A1812338', ownerId, 'Maison basse', 3, 150000, 'ABIDJAN', 'YOPOUGON', 'MAROC', 20, 4)
      .lastInsertRowid;
    const p2 = db
      .prepare(
        `INSERT INTO properties
         (code, owner_id, type_construction, nombre_piece, cout_loyer, ville, commune, quartier, part_commission, nombre_porte)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run('MB_P4_C250000_M05022023A545690', ownerId, 'Maison basse', 4, 250000, 'ABIDJAN', 'COCODY', 'RIVIERA PALMERAIE', 10, 1)
      .lastInsertRowid;

    const s1 = db
      .prepare(
        `INSERT INTO subscriptions
         (code, property_id, tenant_id, date_souscription, montant_loyer,
          nombre_mois_caution, montant_caution, nombre_mois_avance, montant_avance,
          autre_frais, montant_autre_frais, date_entree, date_debut_paiement, statut)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run('S05022023A1013772', p1, t1, '2023-02-05', 150000, 2, 300000, 2, 300000, '', 0, '2023-02-05', '2023-02-05', 'Active')
      .lastInsertRowid;
    const s2 = db
      .prepare(
        `INSERT INTO subscriptions
         (code, property_id, tenant_id, date_souscription, montant_loyer,
          nombre_mois_caution, montant_caution, nombre_mois_avance, montant_avance,
          autre_frais, montant_autre_frais, date_entree, date_debut_paiement, statut)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run('S05022023A3370599', p2, t2, '2023-02-05', 250000, 2, 500000, 2, 500000, 'GARAGE', 10000, '2023-02-05', '2023-02-05', 'Active')
      .lastInsertRowid;

    const insPay = db.prepare(
      `INSERT INTO payments
       (code, subscription_id, property_id, tenant_id, date, montant_a_payer, montant_paye, reste_a_payer, mois_concerne, annee_concernee, statut)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    let n = 1000;
    const pay = (sub, prop, ten, montant, mois, annee) =>
      insPay.run(`R0000${n++}`, sub, prop, ten, '2023-02-05', montant, montant, 0, mois, annee, 'Soldé');
    pay(s1, p1, t1, 150000, 'Mars', 2023);
    pay(s1, p1, t1, 150000, 'Mai', 2023);
    pay(s1, p1, t1, 150000, 'Juin', 2023);
    pay(s2, p2, t2, 250000, 'Mai', 2023);
    pay(s2, p2, t2, 250000, 'Juin', 2023);
  });
  tx();
}

seed();

module.exports = { db, hashPassword, verifyPassword };
