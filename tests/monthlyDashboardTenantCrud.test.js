'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), `nouvel-afric-monthly-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-monthly-dashboard';

const { app, ready } = require('../src/app');
const dbModule = require('../src/db');
const db = dbModule.db;

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

async function fixture(baseUrl) {
  const registered = await request(baseUrl, 'POST', '/api/auth/register', {
    entreprise: 'Agence Mensuelle', nom: 'DG Test',
    email: `monthly-${Date.now()}@example.com`, telephone: '+228 90 00 00 09', password: 'secret123',
  });
  assert.equal(registered.res.status, 200);
  const cookie = cookieFrom(registered.res);
  const owner = await request(baseUrl, 'POST', '/api/owners', {
    nom_prenoms: 'Propriétaire Test', contact: '+228 91 00 00 09',
  }, cookie);
  const property = await request(baseUrl, 'POST', '/api/properties', {
    owner_id: owner.data.id, type_construction: 'Immeuble', designation: 'Bien mensuel',
    ville: 'Lomé', quartier: 'Centre', part_commission: 10, nombre_porte: 2,
  }, cookie);
  return { cookie, property: property.data };
}

test('dashboard et dossier du bien isolent un mois et additionnent une plage', async () => {
  await ready;
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const { cookie, property } = await fixture(baseUrl);
    const tenant = await request(baseUrl, 'POST', '/api/tenants', {
      nom_prenoms: 'Locataire Période', contact: '+228 92 00 00 09',
      property_id: property.id, montant_loyer: 100000,
      date_souscription: '2026-01-01', date_entree: '2026-01-01', date_debut_paiement: '2026-01-01',
      nombre_mois_caution: 1, nombre_mois_avance: 0,
    }, cookie);
    assert.equal(tenant.res.status, 200);
    const details = await request(baseUrl, 'GET', `/api/properties/${property.id}/details?mode=range&from=2026-01&to=2026-02`, null, cookie);
    const subscription = details.data.subscriptions[0];

    for (const [mois, montant] of [['Janvier', 100000], ['Février', 80000]]) {
      const payment = await request(baseUrl, 'POST', '/api/payments', {
        subscription_id: subscription.id, mois_concerne: mois, annee_concernee: 2026,
        montant_a_payer: 100000, montant_paye: montant, date: '2026-02-05',
      }, cookie);
      assert.equal(payment.res.status, 200);
    }

    const febDashboard = await request(baseUrl, 'GET', '/api/dashboard?mode=month&from=2026-02&to=2026-02', null, cookie);
    assert.equal(febDashboard.data.total_loyer, 80000);
    assert.equal(febDashboard.data.impayes_montant, 20000);
    assert.equal(febDashboard.data.periode.label, 'Février 2026');

    const rangeDashboard = await request(baseUrl, 'GET', '/api/dashboard?mode=range&from=2026-01&to=2026-02', null, cookie);
    assert.equal(rangeDashboard.data.total_loyer, 180000);
    assert.equal(rangeDashboard.data.loyer_attendu, 200000);

    const febProperty = await request(baseUrl, 'GET', `/api/properties/${property.id}/details?mode=month&from=2026-02&to=2026-02`, null, cookie);
    assert.equal(febProperty.data.totals.total_paye, 80000);
    assert.equal(febProperty.data.payments.length, 1);
    assert.equal(febProperty.data.subscriptions[0].resume.total_attendu, 100000);

    const foreignRegistration = await request(baseUrl, 'POST', '/api/auth/register', {
      entreprise: 'Agence Étrangère', nom: 'DG Étranger', email: `foreign-${Date.now()}@example.com`,
      telephone: '+228 95 00 00 09', password: 'secret123',
    });
    const foreignCookie = cookieFrom(foreignRegistration.res);
    const foreignOwner = await request(baseUrl, 'POST', '/api/owners', {
      nom_prenoms: 'Propriétaire Étranger', contact: '+228 96 00 00 09',
    }, foreignCookie);
    const foreignProperty = await request(baseUrl, 'POST', '/api/properties', {
      owner_id: foreignOwner.data.id, type_construction: 'Villa', designation: 'Bien étranger',
      ville: 'Lomé', quartier: 'Nord', part_commission: 10, nombre_porte: 1,
    }, foreignCookie);
    const foreignTenant = await request(baseUrl, 'POST', '/api/tenants', {
      nom_prenoms: 'Locataire Étranger', contact: '+228 97 00 00 09',
      property_id: foreignProperty.data.id, montant_loyer: 70000,
      date_souscription: '2026-01-01', date_entree: '2026-01-01', date_debut_paiement: '2026-01-01',
    }, foreignCookie);
    const rejected = await request(baseUrl, 'POST', '/api/payments', {
      property_id: foreignProperty.data.id, tenant_id: foreignTenant.data.id,
      mois_concerne: 'Janvier', annee_concernee: 2026,
      montant_a_payer: 70000, montant_paye: 70000,
    }, cookie);
    assert.equal(rejected.res.status, 400);

    const meA = await request(baseUrl, 'GET', '/api/auth/me', null, cookie);
    const meForeign = await request(baseUrl, 'GET', '/api/auth/me', null, foreignCookie);
    const companyA = meA.data.company.id;
    await db.prepare(`INSERT INTO audit_log (company_id, user_id, user_nom, action, entity, label)
      VALUES (?, ?, 'Historique A', 'Lecture', 'Test', 'corrupt-audit')`)
      .run(companyA, meForeign.data.user.id);
    const isolatedAudit = await request(baseUrl, 'GET', '/api/audit?q=corrupt-audit', null, cookie);
    assert.equal(isolatedAudit.data[0].current_nom, null);
    assert.equal(isolatedAudit.data[0].current_email, null);
    await db.prepare('UPDATE properties SET owner_id = ? WHERE id = ? AND company_id = ?')
      .run(foreignOwner.data.id, property.id, companyA);
    const isolatedProperties = await request(baseUrl, 'GET', '/api/properties', null, cookie);
    assert.equal(isolatedProperties.data.find((x) => x.id === property.id).owner_nom, null);

    await db.prepare('UPDATE subscriptions SET property_id = ? WHERE id = ? AND company_id = ?')
      .run(foreignProperty.data.id, subscription.id, companyA);
    const isolatedTenants = await request(baseUrl, 'GET', '/api/tenants', null, cookie);
    assert.equal(isolatedTenants.data.find((x) => x.id === tenant.data.id).active_property_code, null);
    const isolatedRecovery = await request(baseUrl, 'GET', '/api/recouvrement?mois=Janvier&annee=2026', null, cookie);
    assert.doesNotMatch(JSON.stringify(isolatedRecovery.data), /Locataire Étranger|Bien étranger|Propriétaire Étranger/);

    await db.prepare(`INSERT INTO payments
      (company_id, code, property_id, tenant_id, date, montant_a_payer, montant_paye, reste_a_payer, mois_concerne, annee_concernee, statut)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(companyA, `RCORRUPT${Date.now()}`, foreignProperty.data.id, tenant.data.id, '2026-01-10', 70000, 70000, 0, 'Janvier', 2026, 'Soldé');
    const isolatedDue = await request(baseUrl, 'GET', '/api/payouts/due', null, cookie);
    assert.equal(isolatedDue.data.length, 0);

    await db.prepare(`INSERT INTO payouts
      (company_id, code, owner_id, date, nombre_paiements, montant_loyers, montant_commission, montant_net)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(companyA, `VCORRUPT${Date.now()}`, foreignOwner.data.id, '2026-01-31', 0, 0, 0, 0);
    const isolatedPayouts = await request(baseUrl, 'GET', '/api/payouts', null, cookie);
    assert.equal(isolatedPayouts.data[0].owner_nom, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('suppression locataire autorisée sans paiement et bloquée avec historique', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const { cookie, property } = await fixture(baseUrl);
    await db.prepare(`CREATE TRIGGER fail_test_subscription BEFORE INSERT ON subscriptions
      BEGIN SELECT RAISE(ABORT, 'échec bail simulé'); END`).run();
    const failedAtomicCreate = await request(baseUrl, 'POST', '/api/tenants', {
      nom_prenoms: 'Doit Être Annulé', contact: '+228 99 00 00 09',
      property_id: property.id, montant_loyer: 45000,
      date_souscription: '2026-02-01', date_entree: '2026-02-01', date_debut_paiement: '2026-02-01',
    }, cookie);
    assert.equal(failedAtomicCreate.res.status, 500);
    const orphan = await db.prepare("SELECT 1 FROM tenants WHERE nom_prenoms = 'Doit Être Annulé'").get();
    assert.equal(orphan, undefined);
    await db.prepare('DROP TRIGGER fail_test_subscription').run();

    const erroneous = await request(baseUrl, 'POST', '/api/tenants', {
      nom_prenoms: 'Erreur Saisie', contact: '+228 93 00 00 09',
      property_id: property.id, montant_loyer: 50000,
      date_souscription: '2026-03-01', date_entree: '2026-03-01', date_debut_paiement: '2026-03-01',
    }, cookie);
    const erroneousDetails = await request(baseUrl, 'GET', `/api/properties/${property.id}/details`, null, cookie);
    const erroneousSubscription = erroneousDetails.data.subscriptions.find((s) => s.tenant_id === erroneous.data.id);
    const updated = await request(baseUrl, 'PUT', `/api/subscriptions/${erroneousSubscription.id}/tenant`, {
      ...erroneousSubscription,
      nom_prenoms: 'Erreur Corrigée', contact: '+228 93 11 11 09', email: 'corrige@example.com',
      adresse: 'Lomé', montant_loyer: 55000, caution: 55000,
    }, cookie);
    assert.equal(updated.res.status, 200);
    assert.equal(updated.data.tenant_nom, 'Erreur Corrigée');
    assert.equal(updated.data.montant_loyer, 55000);
    const maskedUpdate = await request(baseUrl, 'PUT', `/api/subscriptions/${erroneousSubscription.id}/tenant`, {
      ...updated.data,
      nom_prenoms: 'Erreur Corrigée', contact: updated.data.tenant_contact,
      email: updated.data.tenant_email || '', adresse: updated.data.tenant_adresse || '',
      montant_loyer: 56000,
    }, cookie);
    assert.equal(maskedUpdate.res.status, 200);
    const rawTenant = await db.prepare('SELECT contact FROM tenants WHERE id = ?').get(erroneous.data.id);
    assert.equal(rawTenant.contact, '+228 93 11 11 09');
    const deleted = await request(baseUrl, 'DELETE', `/api/tenants/${erroneous.data.id}`, null, cookie);
    assert.equal(deleted.res.status, 200);

    const protectedTenant = await request(baseUrl, 'POST', '/api/tenants', {
      nom_prenoms: 'Historique Protégé', contact: '+228 94 00 00 09',
      property_id: property.id, montant_loyer: 60000,
      date_souscription: '2026-04-01', date_entree: '2026-04-01', date_debut_paiement: '2026-04-01',
    }, cookie);
    const details = await request(baseUrl, 'GET', `/api/properties/${property.id}/details?mode=month&from=2026-04&to=2026-04`, null, cookie);
    const subscription = details.data.subscriptions.find((s) => s.tenant_id === protectedTenant.data.id);
    await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: subscription.id, mois_concerne: 'Avril', annee_concernee: 2026,
      montant_a_payer: 60000, montant_paye: 60000, date: '2026-05-02',
    }, cookie);
    const blocked = await request(baseUrl, 'DELETE', `/api/tenants/${protectedTenant.data.id}`, null, cookie);
    assert.equal(blocked.res.status, 400);
    assert.match(blocked.data.error, /historique comptable/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('un bail clôturé reste compté jusqu’au dernier mois dû sans créer de dette future', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const { cookie, property } = await fixture(baseUrl);
    const tenant = await request(baseUrl, 'POST', '/api/tenants', {
      nom_prenoms: 'Ancien Locataire', contact: '+228 98 00 00 09',
      property_id: property.id, montant_loyer: 50000,
      date_souscription: '2026-01-01', date_entree: '2026-01-01', date_debut_paiement: '2026-01-01',
    }, cookie);
    const before = await request(baseUrl, 'GET', `/api/properties/${property.id}/details`, null, cookie);
    const subscription = before.data.subscriptions.find((s) => s.tenant_id === tenant.data.id);
    const invalidDeparture = await request(baseUrl, 'POST', `/api/subscriptions/${subscription.id}/depart`, {
      date_fin: 'not-a-date',
    }, cookie);
    assert.equal(invalidDeparture.res.status, 400);
    const invalidStatus = await request(baseUrl, 'PUT', `/api/subscriptions/${subscription.id}`, {
      property_id: property.id,
      tenant_id: tenant.data.id,
      montant_loyer: 50000,
      date_souscription: '2026-01-01',
      date_entree: '2026-01-01',
      date_debut_paiement: '2026-01-01',
      statut: 'Inconnu',
    }, cookie);
    assert.equal(invalidStatus.res.status, 400);

    const departed = await request(baseUrl, 'POST', `/api/subscriptions/${subscription.id}/depart`, {
      date_fin: '2026-03-15',
    }, cookie);
    assert.equal(departed.res.status, 200);

    const genericEdit = await request(baseUrl, 'PUT', `/api/subscriptions/${subscription.id}`, {
      property_id: property.id,
      tenant_id: tenant.data.id,
      montant_loyer: 50000,
      date_souscription: '2026-01-01',
      date_entree: '2026-01-01',
      date_debut_paiement: '2026-01-01',
      statut: 'Desactive',
    }, cookie);
    assert.equal(genericEdit.res.status, 200);
    assert.equal(genericEdit.data.date_fin, '2026-03-15');

    const dashboard = await request(baseUrl, 'GET', '/api/dashboard?mode=range&from=2026-01&to=2026-06', null, cookie);
    assert.equal(dashboard.data.loyer_attendu, 100000);
    assert.equal(dashboard.data.impayes_nombre, 2);
    assert.equal(dashboard.data.impayes_montant, 100000);

    const recoveryBeforePayment = await request(baseUrl, 'GET', '/api/recouvrement?mois=Janvier&annee=2026', null, cookie);
    assert.equal(recoveryBeforePayment.data.recap.total_du, 50000);
    assert.equal(recoveryBeforePayment.data.recap.total_paye, 0);

    const multiMonthPayment = await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: subscription.id,
      mois_payes: [
        { mois: 'Janvier', annee: 2026 },
        { mois: 'Février', annee: 2026 },
      ],
      montant_a_payer: 100000,
      montant_paye: 100000,
      date: '2026-02-28',
    }, cookie);
    assert.equal(multiMonthPayment.res.status, 200);
    const recoveryJanuary = await request(baseUrl, 'GET', '/api/recouvrement?mois=Janvier&annee=2026', null, cookie);
    assert.equal(recoveryJanuary.data.recap.total_du, 50000);
    assert.equal(recoveryJanuary.data.recap.total_paye, 50000);
    assert.equal(recoveryJanuary.data.recap.ecart, 0);

    const details = await request(baseUrl, 'GET', `/api/properties/${property.id}/details?mode=range&from=2026-01&to=2026-06`, null, cookie);
    const historical = details.data.subscriptions.find((s) => s.id === subscription.id);
    assert.equal(historical.resume.total_attendu, 100000);
    assert.equal(historical.echeancier.length, 2);

    const legacyTenant = await request(baseUrl, 'POST', '/api/tenants', {
      nom_prenoms: 'Ancien Sans Date', contact: '+228 90 99 00 09',
    }, cookie);
    const me = await request(baseUrl, 'GET', '/api/auth/me', null, cookie);
    const legacyCode = `SLEGACY${Date.now()}`;
    const legacySubId = (await db.prepare(`INSERT INTO subscriptions
      (company_id, code, property_id, tenant_id, date_souscription, montant_loyer,
       date_entree, date_debut_paiement, date_fin, statut)
      VALUES (?,?,?,?,?,?,?,?,NULL,'Desactive')`)
      .run(me.data.company.id, legacyCode, property.id, legacyTenant.data.id, '2026-01-01', 30000, '2026-01-01', '2026-01-01')).lastInsertRowid;
    await db.prepare(`INSERT INTO audit_log (company_id, action, entity, label, created_at)
      VALUES (?, 'Modification', 'Souscription', ?, '2026-03-15 10:00:00')`)
      .run(me.data.company.id, `Départ historique (${legacyCode})`);
    await dbModule.migrateInactiveSubscriptionDates();
    const migrated = await db.prepare('SELECT date_fin FROM subscriptions WHERE id = ?').get(legacySubId);
    assert.equal(migrated.date_fin, '2026-03-15');
    const migratedDashboard = await request(baseUrl, 'GET', '/api/dashboard?mode=range&from=2026-01&to=2026-06', null, cookie);
    assert.equal(migratedDashboard.data.loyer_attendu, 160000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
