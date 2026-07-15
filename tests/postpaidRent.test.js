'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), `nouvel-afric-postpaid-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-postpaid';

const { app, ready } = require('../src/app');
const { MOIS } = require('../src/paymentPeriods');

async function withServer(fn) {
  await ready;
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(baseUrl);
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
  const data = text ? JSON.parse(text) : null;
  return { res, data };
}

function cookieFrom(res) {
  const values = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return values.flatMap((raw) => String(raw).split(/,(?=naf\.sid)/)).map((part) => part.split(';')[0]).filter(Boolean).join('; ');
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

async function setupProperty(baseUrl) {
  const email = `postpaid-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const registered = await request(baseUrl, 'POST', '/api/auth/register', {
    entreprise: 'Agence Terme Échu',
    nom: 'Admin Test',
    email,
    telephone: '+228 90 00 00 09',
    password: 'secret123',
  });
  assert.equal(registered.res.status, 200);
  const cookie = cookieFrom(registered.res);

  const owner = await request(baseUrl, 'POST', '/api/owners', {
    nom_prenoms: 'Propriétaire Échu', contact: '+228 90 11 11 22',
  }, cookie);
  const property = await request(baseUrl, 'POST', '/api/properties', {
    owner_id: owner.data.id, type_construction: 'Maison basse', designation: 'Cour A',
    cout_loyer: 50000, ville: 'Lomé', quartier: 'Bè', part_commission: 10, nombre_porte: 2,
  }, cookie);
  const tenant = await request(baseUrl, 'POST', '/api/tenants', {
    nom_prenoms: 'Locataire Échu', contact: '+228 90 22 22 33',
  }, cookie);

  // Bail commençant 2 mois avant aujourd'hui : l'échéancier couvre donc
  // 2 mois passés (échus) + le mois en cours (à échoir).
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const batch = await request(baseUrl, 'POST', `/api/properties/${property.data.id}/tenants`, {
    date_souscription: ymd(start), date_entree: ymd(start), date_debut_paiement: ymd(start),
    nombre_mois_caution: 1, nombre_mois_avance: 0,
    tenants: [{ tenant_id: tenant.data.id, montant_loyer: 50000 }],
  }, cookie);
  assert.equal(batch.res.status, 200, JSON.stringify(batch.data));
  return { cookie, property: property.data, subscription: batch.data.subscriptions[0] };
}

test('current (in-progress) month is « À échoir » and never counts as unpaid/late', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, property } = await setupProperty(baseUrl);
    const now = new Date();
    const curMonth = MOIS[now.getMonth()];
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonth = MOIS[prev.getMonth()];

    const details = await request(baseUrl, 'GET', `/api/properties/${property.id}/details`, null, cookie);
    assert.equal(details.res.status, 200);
    const sub = details.data.subscriptions[0];

    const current = sub.echeancier.find((m) => m.mois === curMonth && m.annee === now.getFullYear());
    assert.ok(current, 'the current month must appear in the schedule');
    assert.equal(current.echu, false);
    assert.equal(current.statut, 'À échoir');
    assert.equal(current.reste, 0, 'the in-progress month is not yet due');

    const previous = sub.echeancier.find((m) => m.mois === prevMonth && m.annee === prev.getFullYear());
    assert.ok(previous, 'the previous month must appear in the schedule');
    assert.equal(previous.echu, true);
    assert.equal(previous.statut, 'Impayé');
    assert.equal(previous.reste, 50000);

    // Deux mois passés impayés, le mois en cours n'est pas compté en retard.
    assert.equal(sub.resume.mois_retard, 2);
  });
});

test('a departed tenant frees the property while keeping the history', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, property, subscription } = await setupProperty(baseUrl);

    let prop = await request(baseUrl, 'GET', `/api/properties/${property.id}/details`, null, cookie);
    assert.equal(prop.data.property.statut, 'Occupé');

    const depart = await request(baseUrl, 'POST', `/api/subscriptions/${subscription.id}/depart`, {}, cookie);
    assert.equal(depart.res.status, 200, JSON.stringify(depart.data));
    assert.equal(depart.data.ok, true);

    const archived = await request(baseUrl, 'GET', `/api/subscriptions/${subscription.id}`, null, cookie);
    assert.equal(archived.data.statut, 'Desactive');

    // Le bail n'est plus actif -> le bien redevient disponible, mais reste consultable.
    prop = await request(baseUrl, 'GET', `/api/properties/${property.id}/details`, null, cookie);
    assert.equal(prop.data.property.statut, 'Disponible');
    assert.equal(prop.data.subscriptions.length, 1, 'the closed lease stays visible in the property');

    const active = await request(baseUrl, 'GET', '/api/subscriptions/active', null, cookie);
    assert.equal(active.data.some((s) => s.id === subscription.id), false);
  });
});

test('a departed tenant lease can then be permanently deleted', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, property, subscription } = await setupProperty(baseUrl);
    await request(baseUrl, 'POST', `/api/subscriptions/${subscription.id}/depart`, {}, cookie);

    const removed = await request(baseUrl, 'DELETE', `/api/subscriptions/${subscription.id}`, null, cookie);
    assert.equal(removed.res.status, 200);
    assert.equal(removed.data.ok, true);

    const gone = await request(baseUrl, 'GET', `/api/subscriptions/${subscription.id}`, null, cookie);
    assert.equal(gone.res.status, 404);
  });
});
