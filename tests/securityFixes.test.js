'use strict';

/**
 * Corrections issues de la revue de code :
 *   - un compte desactive par l'administrateur perd l'acces immediatement ;
 *   - le nom « Nouvel Afric » ne donne pas d'acces illimite par inscription
 *     publique ni par simple renommage de l'entreprise ;
 *   - un reglement de montant negatif est refuse.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), `nouvel-afric-security-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-security';

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
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  return { res, data: text ? JSON.parse(text) : null };
}

function cookieFrom(res) {
  const values = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return values.flatMap((raw) => String(raw).split(/,(?=naf\.sid)/)).map((part) => part.split(';')[0]).filter(Boolean).join('; ');
}

const uniqueEmail = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

async function register(baseUrl, entreprise) {
  const registered = await request(baseUrl, 'POST', '/api/auth/register', {
    entreprise, nom: 'Admin', email: uniqueEmail('sec'), telephone: '+228 90 00 00 00', password: 'secret123',
  });
  assert.equal(registered.res.status, 200, JSON.stringify(registered.data));
  return { cookie: cookieFrom(registered.res), data: registered.data };
}

test('un utilisateur désactivé perd l’accès sans attendre l’expiration de sa session', async () => {
  await withServer(async (baseUrl) => {
    const { cookie: adminCookie } = await register(baseUrl, 'Agence Sécurité');
    const email = uniqueEmail('employe');
    const created = await request(baseUrl, 'POST', '/api/users', {
      email, password: 'secret123', nom: 'Employé', role: 'secretaire',
    }, adminCookie);
    assert.equal(created.res.status, 200, JSON.stringify(created.data));

    const login = await request(baseUrl, 'POST', '/api/auth/login', { email, password: 'secret123' });
    assert.equal(login.res.status, 200);
    const employeCookie = cookieFrom(login.res);
    assert.equal((await request(baseUrl, 'GET', '/api/owners', null, employeCookie)).res.status, 200);

    const off = await request(baseUrl, 'PUT', `/api/users/${created.data.id}`, { actif: false, role: 'secretaire' }, adminCookie);
    assert.equal(off.res.status, 200, JSON.stringify(off.data));

    assert.equal((await request(baseUrl, 'GET', '/api/owners', null, employeCookie)).res.status, 401);
    assert.equal((await request(baseUrl, 'GET', '/api/auth/me', null, employeCookie)).res.status, 401);
  });
});

test('s’inscrire ou se renommer « Nouvel Afric » ne donne pas d’accès illimité', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, data } = await register(baseUrl, 'Nouvelle Afrique Immobilier');
    const company = await db.prepare('SELECT illimite, statut FROM companies WHERE id = ?').get(data.company.id);
    assert.equal(company.illimite, 0);
    assert.equal(company.statut, 'essai');
    assert.equal(data.company.no_subscription, false);

    const other = await register(baseUrl, 'Agence Ordinaire');
    const renamed = await request(baseUrl, 'PUT', '/api/settings', { entreprise: 'Nouvel Afrik' }, other.cookie);
    assert.equal(renamed.res.status, 200, JSON.stringify(renamed.data));
    const after = await db.prepare('SELECT illimite, statut FROM companies WHERE id = ?').get(other.data.company.id);
    assert.equal(after.illimite, 0);
    assert.equal(after.statut, 'essai');
    assert.ok(cookie);
  });
});

test('un règlement de montant négatif est refusé', async () => {
  await withServer(async (baseUrl) => {
    const { cookie } = await register(baseUrl, 'Agence Montants');
    const owner = await request(baseUrl, 'POST', '/api/owners', { nom_prenoms: 'Propriétaire N', contact: '+228 90 11 11 11' }, cookie);
    const property = await request(baseUrl, 'POST', '/api/properties', {
      owner_id: owner.data.id, type_construction: 'RDC', designation: 'Bien N', part_commission: 0,
    }, cookie);
    const tenant = await request(baseUrl, 'POST', '/api/tenants', {
      nom_prenoms: 'Locataire N', contact: '+228 90 22 22 22', property_id: property.data.id, montant_loyer: 50000,
      date_entree: '2026-01-01', date_debut_paiement: '2026-01-01',
    }, cookie);
    assert.equal(tenant.res.status, 200, JSON.stringify(tenant.data));
    const subs = await request(baseUrl, 'GET', '/api/subscriptions/active', null, cookie);

    const negatif = await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: subs.data[0].id, montant_paye: -50000, mois_concerne: 'Janvier', annee_concernee: 2026,
    }, cookie);
    assert.equal(negatif.res.status, 400);
    assert.match(negatif.data.error, /positif/);
  });
});
