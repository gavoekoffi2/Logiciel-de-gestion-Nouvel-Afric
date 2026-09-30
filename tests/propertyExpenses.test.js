'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), `nouvel-afric-expenses-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-property-expenses';

const { app, ready } = require('../src/app');

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
  return values.flatMap((raw) => String(raw).split(/,(?=naf\.sid)/))
    .map((part) => part.split(';')[0]).filter(Boolean).join('; ');
}

test('dépense enregistrée par bien, déduite du solde et visible dans les totaux du tableau de bord', async () => {
  await ready;
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const registered = await request(baseUrl, 'POST', '/api/auth/register', {
      entreprise: 'Agence Dépenses Test', nom: 'Admin Test',
      email: `expenses-${Date.now()}@example.com`, telephone: '+228 90 00 00 11', password: 'secret123',
    });
    assert.equal(registered.res.status, 200);
    const cookie = cookieFrom(registered.res);

    const owner = await request(baseUrl, 'POST', '/api/owners', {
      nom_prenoms: 'Propriétaire Dépenses', contact: '+228 91 00 00 11',
    }, cookie);
    assert.equal(owner.res.status, 200);
    const property = await request(baseUrl, 'POST', '/api/properties', {
      owner_id: owner.data.id, type_construction: 'Maison basse', designation: 'Maison avec dépenses',
      ville: 'Lomé', quartier: 'Adidogomé', part_commission: 10, nombre_porte: 1,
    }, cookie);
    assert.equal(property.res.status, 200);
    const tenant = await request(baseUrl, 'POST', '/api/tenants', {
      nom_prenoms: 'Locataire Dépenses', contact: '+228 92 00 00 11', property_id: property.data.id,
      montant_loyer: 100000, date_souscription: '2026-01-01', date_entree: '2026-01-01',
      date_debut_paiement: '2026-01-01', nombre_mois_caution: 1, nombre_mois_avance: 0,
    }, cookie);
    assert.equal(tenant.res.status, 200);

    const detailsBefore = await request(baseUrl, 'GET', `/api/properties/${property.data.id}/details?mode=month&from=2026-01&to=2026-01`, null, cookie);
    assert.equal(detailsBefore.res.status, 200);
    const subscription = detailsBefore.data.subscriptions[0];
    const payment = await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: subscription.id, mois_concerne: 'Janvier', annee_concernee: 2026,
      montant_a_payer: 100000, montant_paye: 100000, date: '2026-02-05',
    }, cookie);
    assert.equal(payment.res.status, 200);

    const expense = await request(baseUrl, 'POST', '/api/repairs', {
      property_id: property.data.id, mois: 'Janvier', annee: 2026,
      montant: 15000, description: 'Réparation toiture',
    }, cookie);
    assert.equal(expense.res.status, 200, JSON.stringify(expense.data));
    assert.equal(expense.data.property_id, property.data.id);
    assert.equal(expense.data.montant, 15000);

    const propertyExpenses = await request(baseUrl, 'GET', `/api/repairs?property_id=${property.data.id}`, null, cookie);
    assert.equal(propertyExpenses.res.status, 200);
    assert.equal(propertyExpenses.data.length, 1);
    assert.equal(propertyExpenses.data[0].id, expense.data.id);

    const details = await request(baseUrl, 'GET', `/api/properties/${property.data.id}/details?mode=month&from=2026-01&to=2026-01`, null, cookie);
    assert.equal(details.data.repairs.length, 1);
    assert.equal(details.data.totals.total_reparations, 15000);

    const report = await request(baseUrl, 'GET', '/api/recouvrement?mois=Janvier&annee=2026', null, cookie);
    const house = report.data.zones.flatMap((zone) => zone.maisons).find((row) => row.property_id === property.data.id);
    assert.ok(house, 'le bien doit être présent dans le rapport de recouvrement');
    assert.equal(house.reparations, 15000);
    assert.equal(house.solde, 75000, 'les dépenses doivent être déduites après commission');

    const dashboard = await request(baseUrl, 'GET', '/api/dashboard?mode=month&from=2026-01&to=2026-01', null, cookie);
    assert.equal(dashboard.res.status, 200);
    assert.equal(dashboard.data.total_depenses, 15000);
    assert.equal(dashboard.data.depenses_recentes[0].property_id, property.data.id);
    assert.equal(dashboard.data.depenses_recentes[0].property_code, property.data.code);

    const invalidPeriod = await request(baseUrl, 'POST', '/api/repairs', {
      property_id: property.data.id, mois: 'Jannvier', annee: 2026, montant: 2500,
    }, cookie);
    assert.equal(invalidPeriod.res.status, 400, 'une période invalide ne doit pas créer une dépense invisible des rapports');
    const afterInvalid = await request(baseUrl, 'GET', `/api/repairs?property_id=${property.data.id}`, null, cookie);
    assert.equal(afterInvalid.data.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
