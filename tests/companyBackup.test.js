'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nouvel-afric-company-backup-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-session-secret-company-backup';
process.env.SUPERADMIN_EMAIL = 'superadmin-company-backup@nouvelafric.tg';
process.env.SUPERADMIN_PASSWORD = 'SuperBackup123';
process.env.SEED_DEMO = '';

const { app, ready } = require('../src/app');
const { db } = require('../src/db');

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function cookieHeader(headers) {
  const raw = headers.get('set-cookie') || '';
  return raw.split(',').map((part) => part.split(';')[0]).filter(Boolean).join('; ');
}

async function registerCompany(base, email, entreprise) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entreprise, nom: 'Admin Test', telephone: '+22890000000', email, password: 'AdminBackup123' }),
  });
  assert.equal(res.status, 200);
  return cookieHeader(res.headers);
}

test('company admin can export and restore only its own company data', async () => {
  await ready;
  const { server, base } = await startServer();
  try {
    const cookieA = await registerCompany(base, 'admin-a@nouvelafric.tg', 'Agence A');
    const cookieB = await registerCompany(base, 'admin-b@nouvelafric.tg', 'Agence B');

    let res = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookieA } });
    const meA = await res.json();
    const cidA = meA.company.id;
    res = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookieB } });
    const meB = await res.json();
    const cidB = meB.company.id;

    const ownerA = (await db.prepare(
      'INSERT INTO owners (company_id, nom_prenoms, contact, email, adresse, type_logement, pieces_logement) VALUES (?,?,?,?,?,?,?)'
    ).run(cidA, 'Propriétaire A', '90000001', 'owner-a@test.tg', 'Lomé', 'Villa', '3 chambres')).lastInsertRowid;
    const tenantA = (await db.prepare(
      'INSERT INTO tenants (company_id, nom_prenoms, contact, email, adresse, caution, autre_frais, montant_autre_frais) VALUES (?,?,?,?,?,?,?,?)'
    ).run(cidA, 'Locataire A', '90000002', 'tenant-a@test.tg', 'Agoè', 20000, 'Garage', 15000)).lastInsertRowid;
    const propertyA = (await db.prepare(
      'INSERT INTO properties (company_id, code, owner_id, designation, cout_loyer, ville, commune, quartier, part_commission) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(cidA, 'BIEN-A', ownerA, 'Maison A', 75000, 'Lomé', 'Golfe', 'Agoè', 10)).lastInsertRowid;
    const subA = (await db.prepare(
      `INSERT INTO subscriptions
       (company_id, code, property_id, tenant_id, date_souscription, montant_loyer, nombre_mois_caution, montant_caution,
        nombre_mois_avance, montant_avance, nombre_mois_garantie, montant_garantie, autre_frais, montant_autre_frais,
        date_entree, date_debut_paiement, statut)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(cidA, 'SUB-A', propertyA, tenantA, '2026-01-01', 75000, 2, 150000, 1, 75000, 1, 75000, 'Garage', 15000, '2026-01-01', '2026-01-01', 'Active')).lastInsertRowid;
    await db.prepare(
      `INSERT INTO payments
       (company_id, code, subscription_id, property_id, tenant_id, date, montant_a_payer, montant_paye, reste_a_payer,
        mois_concerne, annee_concernee, nombre_mois_payes, mois_payes, nombre_mois_dus, mois_dus, statut, numero_recu)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(cidA, 'PAY-A', subA, propertyA, tenantA, '2026-02-01', 150000, 100000, 50000, 'Janvier', 2026, 2, 'Janvier,Février', 1, 'Mars', 'Non soldé', 'REC-001');
    await db.prepare(
      'INSERT INTO audit_log (company_id, user_id, user_nom, action, entity, label) VALUES (?,?,?,?,?,?)'
    ).run(cidA, meA.user.id, 'Admin Test', 'Création', 'Test', 'Donnée A');

    await db.prepare('INSERT INTO owners (company_id, nom_prenoms, contact) VALUES (?,?,?)').run(cidB, 'Propriétaire B', '90000003');

    res = await fetch(`${base}/api/data/export`, { headers: { cookie: cookieA } });
    assert.equal(res.status, 200);
    const backup = await res.json();
    assert.equal(backup.format, 'nouvelafric.sauvegarde');
    assert.equal(backup.donnees.owners.length, 1);
    assert.equal(backup.donnees.tenants[0].montant_autre_frais, 15000);
    assert.equal(backup.donnees.payments[0].mois_payes, 'Janvier,Février');
    assert.equal(backup.donnees.audit_log.length, 1);

    await db.prepare('DELETE FROM payments WHERE company_id = ?').run(cidA);
    await db.prepare('DELETE FROM subscriptions WHERE company_id = ?').run(cidA);
    await db.prepare('DELETE FROM properties WHERE company_id = ?').run(cidA);
    await db.prepare('DELETE FROM tenants WHERE company_id = ?').run(cidA);
    await db.prepare('DELETE FROM owners WHERE company_id = ?').run(cidA);
    await db.prepare('DELETE FROM audit_log WHERE company_id = ?').run(cidA);

    res = await fetch(`${base}/api/data/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ ...backup, mode: 'remplacer' }),
    });
    assert.equal(res.status, 200);
    const restored = await res.json();
    assert.equal(restored.ok, true);
    assert.equal(restored.importe.owners, 1);
    assert.equal(restored.importe.audit_log, 1);

    const restoredTenant = await db.prepare('SELECT * FROM tenants WHERE company_id = ?').get(cidA);
    assert.equal(restoredTenant.montant_autre_frais, 15000);
    const restoredPayment = await db.prepare('SELECT * FROM payments WHERE company_id = ?').get(cidA);
    assert.equal(restoredPayment.nombre_mois_payes, 2);
    assert.equal(restoredPayment.mois_dus, 'Mars');
    const otherCompanyOwner = await db.prepare('SELECT * FROM owners WHERE company_id = ?').get(cidB);
    assert.equal(otherCompanyOwner.nom_prenoms, 'Propriétaire B');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
