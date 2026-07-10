'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), `nouvel-afric-test-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-multi-tenants';

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
  const data = text ? JSON.parse(text) : null;
  return { res, data };
}

function cookieFrom(res) {
  const values = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return values.flatMap((raw) => String(raw).split(/,(?=naf\.sid)/)).map((part) => part.split(';')[0]).filter(Boolean).join('; ');
}

test('a property can receive several active tenants with different rents in one batch', async () => {
  await withServer(async (baseUrl) => {
    const email = `multi-${Date.now()}@example.com`;
    const registered = await request(baseUrl, 'POST', '/api/auth/register', {
      entreprise: 'Agence Multi Locataires',
      nom: 'Admin Test',
      email,
      telephone: '+228 90 00 00 01',
      password: 'secret123',
    });
    assert.equal(registered.res.status, 200);
    const cookie = cookieFrom(registered.res);
    assert.ok(cookie.includes('naf.sid'));

    const owner = await request(baseUrl, 'POST', '/api/owners', {
      nom_prenoms: 'Propriétaire Multi',
      contact: '+228 90 11 11 11',
    }, cookie);
    assert.equal(owner.res.status, 200);

    const property = await request(baseUrl, 'POST', '/api/properties', {
      owner_id: owner.data.id,
      type_construction: 'Maison basse',
      designation: 'Maison cour commune',
      cout_loyer: 50000,
      ville: 'Lomé',
      quartier: 'Adidogomé',
      part_commission: 10,
      nombre_porte: 4,
    }, cookie);
    assert.equal(property.res.status, 200);

    const tenantA = await request(baseUrl, 'POST', '/api/tenants', {
      nom_prenoms: 'Locataire A',
      contact: '+228 90 22 22 22',
    }, cookie);
    const tenantB = await request(baseUrl, 'POST', '/api/tenants', {
      nom_prenoms: 'Locataire B',
      contact: '+228 90 33 33 33',
    }, cookie);
    assert.equal(tenantA.res.status, 200);
    assert.equal(tenantB.res.status, 200);

    const batch = await request(baseUrl, 'POST', `/api/properties/${property.data.id}/tenants`, {
      date_souscription: '2026-01-01',
      date_entree: '2026-01-01',
      date_debut_paiement: '2026-01-01',
      nombre_mois_caution: 1,
      nombre_mois_avance: 0,
      tenants: [
        { tenant_id: tenantA.data.id, montant_loyer: 45000, montant_caution: 90000, montant_avance: 25000, montant_garantie: 10000 },
        { tenant_id: tenantB.data.id, montant_loyer: 70000, montant_caution: 110000, montant_avance: 30000, montant_garantie: 15000 },
      ],
    }, cookie);
    assert.equal(batch.res.status, 200);
    assert.equal(batch.data.count, 2);
    assert.deepEqual(batch.data.subscriptions.map((s) => s.montant_loyer).sort((a, b) => a - b), [45000, 70000]);
    assert.deepEqual(batch.data.subscriptions.map((s) => s.montant_caution).sort((a, b) => a - b), [90000, 110000]);
    assert.deepEqual(batch.data.subscriptions.map((s) => s.montant_avance).sort((a, b) => a - b), [25000, 30000]);
    assert.deepEqual(batch.data.subscriptions.map((s) => s.montant_garantie).sort((a, b) => a - b), [10000, 15000]);

    const details = await request(baseUrl, 'GET', `/api/properties/${property.data.id}/details`, null, cookie);
    assert.equal(details.res.status, 200);
    assert.equal(details.data.totals.nombre_locataires_actifs, 2);
    assert.deepEqual(details.data.subscriptions.map((s) => s.montant_loyer).sort((a, b) => a - b), [45000, 70000]);
    assert.deepEqual(details.data.subscriptions.map((s) => s.montant_caution).sort((a, b) => a - b), [90000, 110000]);
    assert.deepEqual(details.data.subscriptions.map((s) => s.montant_avance).sort((a, b) => a - b), [25000, 30000]);
    assert.deepEqual(details.data.subscriptions.map((s) => s.montant_garantie).sort((a, b) => a - b), [10000, 15000]);

    const duplicate = await request(baseUrl, 'POST', `/api/properties/${property.data.id}/tenants`, {
      date_entree: '2026-01-01',
      date_debut_paiement: '2026-01-01',
      tenants: [{ tenant_id: tenantA.data.id, montant_loyer: 45000 }],
    }, cookie);
    assert.equal(duplicate.res.status, 400);
    assert.match(duplicate.data.error, /déjà actif/i);
  });
});

test('tenant can be created directly inside a property with its own rent and cannot be active elsewhere', async () => {
  await withServer(async (baseUrl) => {
    const email = `inside-property-${Date.now()}@example.com`;
    const registered = await request(baseUrl, 'POST', '/api/auth/register', {
      entreprise: 'Agence Ajout Dans Bien',
      nom: 'Admin Test',
      email,
      telephone: '+228 90 00 00 02',
      password: 'secret123',
    });
    assert.equal(registered.res.status, 200);
    const cookie = cookieFrom(registered.res);

    const owner = await request(baseUrl, 'POST', '/api/owners', {
      nom_prenoms: 'Propriétaire Direct',
      contact: '+228 91 11 11 11',
    }, cookie);
    assert.equal(owner.res.status, 200);

    const propertyA = await request(baseUrl, 'POST', '/api/properties', {
      owner_id: owner.data.id,
      type_construction: 'Immeuble',
      designation: 'Bien sans loyer global A',
      ville: 'Lomé',
      quartier: 'Agoè',
      part_commission: 10,
      nombre_porte: 3,
    }, cookie);
    assert.equal(propertyA.res.status, 200);
    assert.equal(propertyA.data.cout_loyer, 0);

    const propertyB = await request(baseUrl, 'POST', '/api/properties', {
      owner_id: owner.data.id,
      type_construction: 'Immeuble',
      designation: 'Bien sans loyer global B',
      ville: 'Lomé',
      quartier: 'Agoè',
      part_commission: 10,
      nombre_porte: 2,
    }, cookie);
    assert.equal(propertyB.res.status, 200);

    const tenant = await request(baseUrl, 'POST', '/api/tenants', {
      nom_prenoms: 'Locataire Direct Bien',
      contact: '+228 91 22 22 22',
      email: 'direct@example.com',
      adresse: 'Lomé',
      property_id: propertyA.data.id,
      montant_loyer: 123456,
      nombre_mois_caution: 2,
      nombre_mois_avance: 1,
      nombre_mois_garantie: 0,
      autre_frais: JSON.stringify([{ libelle: 'Eau', montant: 5000 }]),
      montant_autre_frais: 5000,
      date_souscription: '2026-01-01',
      date_entree: '2026-01-01',
      date_debut_paiement: '2026-01-01',
    }, cookie);
    assert.equal(tenant.res.status, 200);

    const details = await request(baseUrl, 'GET', `/api/properties/${propertyA.data.id}/details`, null, cookie);
    assert.equal(details.res.status, 200);
    assert.equal(details.data.subscriptions.length, 1);
    assert.equal(details.data.subscriptions[0].montant_loyer, 123456);
    assert.equal(details.data.subscriptions[0].montant_caution, 246912);
    assert.equal(details.data.subscriptions[0].montant_avance, 123456);

    const recovery = await request(baseUrl, 'GET', '/api/recouvrement?mois=Janvier&annee=2026', null, cookie);
    assert.equal(recovery.res.status, 200);
    assert.equal(recovery.data.zones[0].maisons[0].locataires[0].loyer, 123456);

    const duplicateElsewhere = await request(baseUrl, 'POST', '/api/subscriptions', {
      property_id: propertyB.data.id,
      tenant_id: tenant.data.id,
      date_souscription: '2026-01-02',
      montant_loyer: 50000,
      date_entree: '2026-01-02',
      date_debut_paiement: '2026-01-02',
      statut: 'Active',
    }, cookie);
    assert.equal(duplicateElsewhere.res.status, 400);
    assert.match(duplicateElsewhere.data.error, /déjà actif dans un bien/i);
  });
});
