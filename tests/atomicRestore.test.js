'use strict';

/**
 * RESTAURATION ATOMIQUE. Une restauration en mode « remplacer » efface les
 * donnees puis recharge le fichier. Si elle echoue en cours de route (fichier
 * abime, coupure, serveur qui redemarre), la base doit revenir exactement a son
 * etat d'avant : jamais des donnees effacees et une sauvegarde a moitie chargee.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), `nouvel-afric-atomic-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-atomic';
process.env.SUPERADMIN_EMAIL = 'superadmin-atomic@nouvelafric.tg';
process.env.SUPERADMIN_PASSWORD = 'SuperAtomic123';

const { app, ready } = require('../src/app');
const { db } = require('../src/db');

async function withServer(fn) {
  await ready;
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(baseUrl, method, url, body, cookie) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  return { res, data: text ? JSON.parse(text) : null };
}

function cookieFrom(res) {
  const values = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  return values.flatMap((raw) => String(raw).split(/,(?=naf\.sid)/)).map((part) => part.split(';')[0]).filter(Boolean).join('; ');
}

// Une agence avec un propriétaire, un bien, un locataire, un bail et un loyer.
async function agence(baseUrl, nom) {
  const registered = await request(baseUrl, 'POST', '/api/auth/register', {
    entreprise: nom, nom: 'Admin', email: `atomic-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    telephone: '+228 90 00 00 00', password: 'secret123',
  });
  assert.equal(registered.res.status, 200, JSON.stringify(registered.data));
  const cookie = cookieFrom(registered.res);
  const owner = await request(baseUrl, 'POST', '/api/owners', { nom_prenoms: `Propriétaire ${nom}`, contact: '90' }, cookie);
  const property = await request(baseUrl, 'POST', '/api/properties', {
    owner_id: owner.data.id, type_construction: 'RDC', designation: `Bien ${nom}`, part_commission: 10,
  }, cookie);
  const tenant = await request(baseUrl, 'POST', '/api/tenants', {
    nom_prenoms: `Locataire ${nom}`, contact: '91', property_id: property.data.id, montant_loyer: 80000,
    date_entree: '2026-01-01', date_debut_paiement: '2026-01-01',
  }, cookie);
  assert.equal(tenant.res.status, 200, JSON.stringify(tenant.data));
  const subs = await request(baseUrl, 'GET', '/api/subscriptions/active', null, cookie);
  const pay = await request(baseUrl, 'POST', '/api/payments', {
    subscription_id: subs.data[0].id, montant_paye: 80000, mois_concerne: 'Janvier', annee_concernee: 2026, date: '2026-02-03',
  }, cookie);
  assert.equal(pay.res.status, 200, JSON.stringify(pay.data));
  return { cookie, companyId: registered.data.company.id };
}

async function snapshot(companyId) {
  const out = {};
  for (const t of ['owners', 'tenants', 'properties', 'subscriptions', 'payments']) {
    out[t] = await db.prepare(`SELECT * FROM ${t} WHERE company_id = ? ORDER BY id`).all(companyId);
  }
  return out;
}

test('une restauration « remplacer » qui échoue en cours de route ne perd aucune donnée', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, companyId } = await agence(baseUrl, 'Agence Panne');
    const exported = await request(baseUrl, 'GET', '/api/data/export', null, cookie);
    assert.equal(exported.res.status, 200);
    const avant = await snapshot(companyId);
    assert.equal(avant.payments.length, 1);

    // Panne simulée APRÈS l'effacement et une partie des insertions : c'est
    // exactement le scénario qui faisait perdre les données.
    const batch = db.batch;
    db.batch = (statements) => batch.call(db, [...statements.slice(0, -2), { sql: 'INSERT INTO table_inexistante VALUES (1)', args: [] }]);
    let echec;
    try {
      echec = await request(baseUrl, 'POST', '/api/data/import', { ...exported.data, mode: 'remplacer' }, cookie);
    } finally {
      db.batch = batch;
    }
    assert.equal(echec.res.status, 400);
    assert.match(echec.data.error, /aucune donnée n’a été modifiée/);

    // Tout est exactement comme avant.
    assert.deepEqual(await snapshot(companyId), avant);
  });
});

test('une restauration « remplacer » réussie garde les codes d’origine et les liens entre fiches', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, companyId } = await agence(baseUrl, 'Agence Codes');
    const exported = await request(baseUrl, 'GET', '/api/data/export', null, cookie);
    const avant = await snapshot(companyId);

    const ok = await request(baseUrl, 'POST', '/api/data/import', { ...exported.data, mode: 'remplacer' }, cookie);
    assert.equal(ok.res.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.importe.payments, 1);

    const apres = await snapshot(companyId);
    assert.deepEqual(apres.properties.map((p) => p.code), avant.properties.map((p) => p.code));
    assert.deepEqual(apres.subscriptions.map((s) => s.code), avant.subscriptions.map((s) => s.code));
    assert.deepEqual(apres.payments.map((p) => p.code), avant.payments.map((p) => p.code));
    // Les liens sont remappés vers les nouvelles fiches.
    assert.equal(apres.payments[0].subscription_id, apres.subscriptions[0].id);
    assert.equal(apres.subscriptions[0].property_id, apres.properties[0].id);
    assert.equal(apres.properties[0].owner_id, apres.owners[0].id);

    // L'état de recouvrement se lit toujours correctement après restauration.
    const rapport = await request(baseUrl, 'GET', '/api/recouvrement?mois=Janvier&annee=2026', null, cookie);
    assert.equal(rapport.data.recap.total_paye, 80000);

    // La restauration est tracée dans le journal.
    const journal = await db.prepare("SELECT 1 FROM audit_log WHERE company_id = ? AND action = 'Restauration' AND entity = 'Sauvegarde'").get(companyId);
    assert.ok(journal);
  });
});

test('une restauration complète de la plateforme invalide ne touche à aucune agence', async () => {
  await withServer(async (baseUrl) => {
    const { companyId } = await agence(baseUrl, 'Agence Plateforme');
    const login = await request(baseUrl, 'POST', '/api/auth/login', { email: 'superadmin-atomic@nouvelafric.tg', password: 'SuperAtomic123' });
    assert.equal(login.res.status, 200);
    const cookie = cookieFrom(login.res);
    const exported = await request(baseUrl, 'GET', '/api/platform/backup/export', null, cookie);
    const avant = await snapshot(companyId);
    const companiesAvant = await db.prepare('SELECT COUNT(*) AS n FROM companies').get();

    // Fichier abîmé : deux comptes avec le même e-mail. L'insertion échoue
    // après l'effacement de TOUTE la plateforme.
    const abime = JSON.parse(JSON.stringify(exported.data));
    abime.tables.users.push({ ...abime.tables.users[0], id: 999999 });
    const echec = await request(baseUrl, 'POST', '/api/platform/backup/import', { ...abime, confirmation: 'RESTAURER' }, cookie);
    assert.equal(echec.res.status, 400, JSON.stringify(echec.data));
    assert.match(echec.data.error, /aucune donnée n’a été modifiée/);

    assert.deepEqual(await snapshot(companyId), avant);
    assert.deepEqual(await db.prepare('SELECT COUNT(*) AS n FROM companies').get(), companiesAvant);
    // Le super-admin peut toujours se connecter.
    const relogin = await request(baseUrl, 'POST', '/api/auth/login', { email: 'superadmin-atomic@nouvelafric.tg', password: 'SuperAtomic123' });
    assert.equal(relogin.res.status, 200);
  });
});

test('supprimer une entreprise efface toutes ses données, reversements et journal compris', async () => {
  await withServer(async (baseUrl) => {
    const { companyId } = await agence(baseUrl, 'Agence Supprimée');
    const login = await request(baseUrl, 'POST', '/api/auth/login', { email: 'superadmin-atomic@nouvelafric.tg', password: 'SuperAtomic123' });
    const cookie = cookieFrom(login.res);
    const del = await request(baseUrl, 'DELETE', `/api/platform/companies/${companyId}`, null, cookie);
    assert.equal(del.res.status, 200, JSON.stringify(del.data));
    for (const t of ['owners', 'tenants', 'properties', 'subscriptions', 'payments', 'payouts', 'repairs', 'audit_log', 'users']) {
      const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE company_id = ?`).get(companyId);
      assert.equal(row.n, 0, `${t} doit être vide`);
    }
  });
});
