'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), `nouvel-afric-concurrent-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-concurrent-payments';

const { app, ready } = require('../src/app');

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
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { res, data };
}

function cookieFrom(res) {
  const values = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return values.flatMap((raw) => String(raw).split(/,(?=naf\.sid)/)).map((part) => part.split(';')[0]).filter(Boolean).join('; ');
}

async function createNouvelAfrikFixture(baseUrl) {
  const suffix = `${process.pid}-${Date.now()}`;
  const adminEmail = `admin-concurrent-${suffix}@example.com`;
  const registered = await request(baseUrl, 'POST', '/api/auth/register', {
    entreprise: 'Nouvel Afrik',
    nom: 'Admin Nouvel Afrik',
    email: adminEmail,
    telephone: '+228 90 00 00 00',
    password: 'secret123',
  });
  assert.equal(registered.res.status, 200, JSON.stringify(registered.data));
  const adminCookie = cookieFrom(registered.res);

  const assistantEmail = `assistant-${suffix}@example.com`;
  const secretaryEmail = `secretaire-${suffix}@example.com`;
  const assistant = await request(baseUrl, 'POST', '/api/users', {
    email: assistantEmail,
    nom: 'Assistant Test',
    role: 'assistant',
    password: 'secret123',
  }, adminCookie);
  assert.equal(assistant.res.status, 200, JSON.stringify(assistant.data));
  const secretary = await request(baseUrl, 'POST', '/api/users', {
    email: secretaryEmail,
    nom: 'Secrétaire Test',
    role: 'secretaire',
    password: 'secret123',
  }, adminCookie);
  assert.equal(secretary.res.status, 200, JSON.stringify(secretary.data));

  const owner = await request(baseUrl, 'POST', '/api/owners', {
    nom_prenoms: 'Propriétaire Concurrent',
    contact: '+228 90 11 11 11',
  }, adminCookie);
  assert.equal(owner.res.status, 200, JSON.stringify(owner.data));

  const property = await request(baseUrl, 'POST', '/api/properties', {
    owner_id: owner.data.id,
    type_construction: 'Maison basse',
    designation: 'Maison test concurrence',
    cout_loyer: 50000,
    ville: 'Lomé',
    quartier: 'Agoè',
    part_commission: 10,
    nombre_porte: 2,
  }, adminCookie);
  assert.equal(property.res.status, 200, JSON.stringify(property.data));

  const tenantA = await request(baseUrl, 'POST', '/api/tenants', {
    nom_prenoms: 'Locataire Assistant',
    contact: '+228 91 22 22 22',
  }, adminCookie);
  const tenantB = await request(baseUrl, 'POST', '/api/tenants', {
    nom_prenoms: 'Locataire Secrétaire',
    contact: '+228 91 33 33 33',
  }, adminCookie);
  assert.equal(tenantA.res.status, 200, JSON.stringify(tenantA.data));
  assert.equal(tenantB.res.status, 200, JSON.stringify(tenantB.data));

  const batch = await request(baseUrl, 'POST', `/api/properties/${property.data.id}/tenants`, {
    date_souscription: '2026-01-01',
    date_entree: '2026-01-01',
    date_debut_paiement: '2026-01-01',
    tenants: [
      { tenant_id: tenantA.data.id, montant_loyer: 50000 },
      { tenant_id: tenantB.data.id, montant_loyer: 75000 },
    ],
  }, adminCookie);
  assert.equal(batch.res.status, 200, JSON.stringify(batch.data));

  const assistantLogin = await request(baseUrl, 'POST', '/api/auth/login', {
    email: assistantEmail,
    password: 'secret123',
  });
  const secretaryLogin = await request(baseUrl, 'POST', '/api/auth/login', {
    email: secretaryEmail,
    password: 'secret123',
  });
  assert.equal(assistantLogin.res.status, 200, JSON.stringify(assistantLogin.data));
  assert.equal(secretaryLogin.res.status, 200, JSON.stringify(secretaryLogin.data));

  return {
    assistantCookie: cookieFrom(assistantLogin.res),
    secretaryCookie: cookieFrom(secretaryLogin.res),
    subscriptions: batch.data.subscriptions,
  };
}

test('assistant and secretary can validate rent payments at the same time', async () => {
  await withServer(async (baseUrl) => {
    const { assistantCookie, secretaryCookie, subscriptions } = await createNouvelAfrikFixture(baseUrl);
    const [subA, subB] = subscriptions;

    const [payA, payB] = await Promise.all([
      request(baseUrl, 'POST', '/api/payments', {
        subscription_id: subA.id,
        date: '2026-02-05',
        montant_paye: subA.montant_loyer,
        mois_payes: JSON.stringify([{ mois: 'Février', annee: 2026 }]),
        mois_concerne: 'Février',
        annee_concernee: 2026,
      }, assistantCookie),
      request(baseUrl, 'POST', '/api/payments', {
        subscription_id: subB.id,
        date: '2026-02-05',
        montant_paye: subB.montant_loyer,
        mois_payes: JSON.stringify([{ mois: 'Février', annee: 2026 }]),
        mois_concerne: 'Février',
        annee_concernee: 2026,
      }, secretaryCookie),
    ]);

    assert.equal(payA.res.status, 200, JSON.stringify(payA.data));
    assert.equal(payB.res.status, 200, JSON.stringify(payB.data));
    assert.equal(payA.data.statut, 'Soldé');
    assert.equal(payB.data.statut, 'Soldé');
  });
});

test('API accepts a one-franc short payment as sold without asking users to add 1', async () => {
  await withServer(async (baseUrl) => {
    const { secretaryCookie, subscriptions } = await createNouvelAfrikFixture(baseUrl);
    const sub = subscriptions[0];
    const payment = await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: sub.id,
      date: '2026-03-05',
      montant_paye: sub.montant_loyer - 1,
      mois_payes: JSON.stringify([{ mois: 'Mars', annee: 2026 }]),
      mois_concerne: 'Mars',
      annee_concernee: 2026,
    }, secretaryCookie);

    assert.equal(payment.res.status, 200, JSON.stringify(payment.data));
    assert.equal(payment.data.montant_a_payer, sub.montant_loyer);
    assert.equal(payment.data.montant_paye, sub.montant_loyer - 1);
    assert.equal(payment.data.reste_a_payer, 0);
    assert.equal(payment.data.statut, 'Soldé');
  });
});
