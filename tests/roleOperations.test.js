'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.DB_PATH = path.join(os.tmpdir(), `nouvel-afric-role-ops-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-role-operations';

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

async function login(baseUrl, email, password) {
  const out = await request(baseUrl, 'POST', '/api/auth/login', { email, password });
  assert.equal(out.res.status, 200, `${email} should login`);
  return cookieFrom(out.res);
}

async function createWorker(baseUrl, adminCookie, role, suffix) {
  const email = `${role}-${suffix}@example.com`;
  const password = `pass-${suffix}`;
  const created = await request(baseUrl, 'POST', '/api/users', {
    nom: `${role} Test`,
    email,
    password,
    role,
  }, adminCookie);
  assert.equal(created.res.status, 200);
  assert.equal(created.data.role, role);
  return { email, password, cookie: await login(baseUrl, email, password) };
}

test('assistant and secretary can both create business records at the same time', async () => {
  await withServer(async (baseUrl) => {
    const suffix = Date.now();
    const registered = await request(baseUrl, 'POST', '/api/auth/register', {
      entreprise: 'Agence Multi Utilisateurs',
      nom: 'Admin Test',
      email: `admin-${suffix}@example.com`,
      telephone: '+228 90 00 00 03',
      password: 'secret123',
    });
    assert.equal(registered.res.status, 200);
    const adminCookie = cookieFrom(registered.res);

    const assistant = await createWorker(baseUrl, adminCookie, 'assistant', suffix);
    const secretary = await createWorker(baseUrl, adminCookie, 'secretaire', suffix);

    const createPropertyAs = async (cookie, label, phone) => {
      const owner = await request(baseUrl, 'POST', '/api/owners', {
        nom_prenoms: `Propriétaire ${label}`,
        contact: phone,
      }, cookie);
      assert.equal(owner.res.status, 200);

      const property = await request(baseUrl, 'POST', '/api/properties', {
        owner_id: owner.data.id,
        type_construction: 'RDC',
        designation: `Bien créé par ${label}`,
        ville: 'Lomé',
        commune: 'Golfe',
        quartier: label,
        part_commission: 10,
        nombre_porte: 2,
      }, cookie);
      assert.equal(property.res.status, 200);
      assert.equal(property.data.owner_id, owner.data.id);
      return property.data;
    };

    const [assistantProperty, secretaryProperty] = await Promise.all([
      createPropertyAs(assistant.cookie, 'assistant', '+228 91 00 00 01'),
      createPropertyAs(secretary.cookie, 'secretaire', '+228 91 00 00 02'),
    ]);

    assert.notEqual(assistantProperty.id, secretaryProperty.id);
    assert.match(assistantProperty.code, /^RDC_M/);
    assert.match(secretaryProperty.code, /^RDC_M/);

    const properties = await request(baseUrl, 'GET', '/api/properties', null, secretary.cookie);
    assert.equal(properties.res.status, 200);
    assert.ok(properties.data.some((p) => p.id === assistantProperty.id));
    assert.ok(properties.data.some((p) => p.id === secretaryProperty.id));
  });
});

test('operational navigation keeps tenant and payment work centralized inside properties', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const navOrder = appJs.match(/const NAV_ORDER = \[([^\]]+)\]/);
  assert.ok(navOrder, 'NAV_ORDER should be declared');
  for (const key of ['proprietaires', 'maisons', 'quartiers', 'reversements']) {
    assert.match(navOrder[1], new RegExp(`'${key}'`));
  }
  for (const hiddenKey of ['locataires', 'souscriptions', 'reglements', 'recouvrement']) {
    assert.doesNotMatch(navOrder[1], new RegExp(`'${hiddenKey}'`));
  }

  const propertyDetail = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'maisonDetail.js'), 'utf8');
  assert.match(propertyDetail, /Ajouter un locataire dans ce bien/);
  assert.match(propertyDetail, /Encaisser un loyer/);
  assert.match(propertyDetail, /Paiements du bien sur la période/);
});
