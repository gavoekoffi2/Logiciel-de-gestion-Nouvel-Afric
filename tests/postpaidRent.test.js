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
const { previousRentPeriod } = require('../src/rentCycle');

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

    // Vue « toutes les périodes » : la fiche s'ouvre par défaut sur le seul mois
    // à recouvrer (compteur mensuel), on demande donc l'échéancier complet pour
    // vérifier la règle du terme échu sur l'ensemble du bail.
    const details = await request(baseUrl, 'GET', `/api/properties/${property.id}/details?mode=all`, null, cookie);
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

test('an August collection without an explicit rent month is recorded for July', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, subscription } = await setupProperty(baseUrl);
    const payment = await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: subscription.id,
      montant_a_payer: 50000,
      montant_paye: 50000,
      date: '2026-08-05',
    }, cookie);

    assert.equal(payment.res.status, 200, JSON.stringify(payment.data));
    assert.equal(payment.data.date, '2026-08-05');
    assert.equal(payment.data.mois_concerne, 'Juillet');
    assert.equal(payment.data.annee_concernee, 2026);
    assert.deepEqual(JSON.parse(payment.data.mois_payes), [{ mois: 'Juillet', annee: 2026 }]);

    const july = await request(baseUrl, 'GET', '/api/payments?mode=month&from=2026-07&to=2026-07', undefined, cookie);
    const august = await request(baseUrl, 'GET', '/api/payments?mode=month&from=2026-08&to=2026-08', undefined, cookie);
    assert.equal(july.res.status, 200);
    assert.equal(july.data.length, 1);
    assert.equal(july.data[0].date, '2026-08-05');
    assert.equal(july.data[0].mois_concerne, 'Juillet');
    assert.equal(august.res.status, 200);
    assert.equal(august.data.length, 0);
  });
});

// Le bug signale en production : l'encaissement du mois echu etait bien
// enregistre, mais la liste des reglements — filtree par defaut sur le « mois
// courant » — s'ouvrait sur le mois civil en cours et paraissait vide, comme si
// le logiciel reclamait le loyer du mois en cours.
test('the default rent filter shows the month being collected, not the running month', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, subscription } = await setupProperty(baseUrl);
    const due = previousRentPeriod();

    const payment = await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: subscription.id, montant_paye: 50000,
    }, cookie);
    assert.equal(payment.res.status, 200, JSON.stringify(payment.data));
    assert.equal(payment.data.mois_concerne, due.mois);
    assert.equal(payment.data.annee_concernee, due.annee);

    // Le règlement tout juste saisi doit être visible sur la période par défaut.
    const listed = await request(baseUrl, 'GET', '/api/payments?mode=current', null, cookie);
    assert.equal(listed.res.status, 200);
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0].id, payment.data.id);
    assert.deepEqual(listed.data[0].periodes_filtrees, [{ mois: due.mois, annee: due.annee }]);
  });
});

test('the recovery report never claims the rent of the running month', async () => {
  await withServer(async (baseUrl) => {
    const { cookie } = await setupProperty(baseUrl);
    const now = new Date();
    const due = previousRentPeriod();

    // On demande explicitement le mois civil en cours : le serveur ramène
    // l'état au dernier mois échu et le signale.
    const asked = await request(baseUrl, 'GET',
      `/api/recouvrement?mois=${encodeURIComponent(MOIS[now.getMonth()])}&annee=${now.getFullYear()}`, null, cookie);
    assert.equal(asked.res.status, 200);
    assert.equal(asked.data.periode_ajustee, true);
    assert.equal(asked.data.mois, due.mois);
    assert.equal(asked.data.annee, due.annee);
    assert.equal(asked.data.mois_demande, MOIS[now.getMonth()]);

    // Compteur mensuel : l'état ne porte QUE sur le mois échu affiché — un seul
    // mois dû, un seul loyer. Le mois encore antérieur est un arriéré, compté à
    // part, jamais ajouté au dû du mois.
    const ligne = asked.data.zones[0].maisons[0].locataires[0];
    assert.equal(ligne.mois_dus, 1);
    assert.equal(ligne.montant_du, 50000);
    assert.equal(ligne.arrieres, 50000);
    assert.equal(ligne.arrieres_mois, 1);
    assert.equal(ligne.mois_dus_liste.includes(`${MOIS[now.getMonth()]} ${now.getFullYear()}`), false,
      'le mois en cours ne doit jamais figurer parmi les mois dûs');

    // Sans paramètre, le rapport s'ouvre déjà sur le mois échu.
    const parDefaut = await request(baseUrl, 'GET', '/api/recouvrement', null, cookie);
    assert.equal(parDefaut.data.mois, due.mois);
    assert.equal(parDefaut.data.annee, due.annee);
    assert.equal(parDefaut.data.periode_ajustee, false);
  });
});

test('bulk collection refuses a month that is still running and never duplicates', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, subscription } = await setupProperty(baseUrl);
    const now = new Date();
    const due = previousRentPeriod();

    const refused = await request(baseUrl, 'POST', '/api/payments/bulk', {
      mois: MOIS[now.getMonth()], annee: now.getFullYear(), subscription_ids: [subscription.id],
    }, cookie);
    assert.equal(refused.res.status, 400);
    assert.match(refused.data.error, /pas encore exigible/);

    const ok = await request(baseUrl, 'POST', '/api/payments/bulk', {
      mois: due.mois, annee: due.annee, subscription_ids: [subscription.id],
    }, cookie);
    assert.equal(ok.res.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.crees, 1);

    // Rejouer la même campagne ne crée pas de doublon.
    const again = await request(baseUrl, 'POST', '/api/payments/bulk', {
      mois: due.mois, annee: due.annee, subscription_ids: [subscription.id],
    }, cookie);
    assert.equal(again.data.crees, 0);
    assert.equal(again.data.ignores, 1);
  });
});

test('a multi-month payment is detected by the bulk collection (no double charge)', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, subscription } = await setupProperty(baseUrl);
    const now = new Date();
    const due = previousRentPeriod();
    const before = new Date(now.getFullYear(), now.getMonth() - 2, 1);

    // Le locataire règle 2 mois d'un coup : le mois échu n'est PAS le premier
    // mois du règlement, il n'apparaît donc pas dans `mois_concerne`.
    const payment = await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: subscription.id,
      montant_paye: 100000,
      mois_payes: [
        { mois: MOIS[before.getMonth()], annee: before.getFullYear() },
        { mois: due.mois, annee: due.annee },
      ],
    }, cookie);
    assert.equal(payment.res.status, 200, JSON.stringify(payment.data));
    assert.equal(payment.data.mois_concerne, MOIS[before.getMonth()]);

    const bulk = await request(baseUrl, 'POST', '/api/payments/bulk', {
      mois: due.mois, annee: due.annee, subscription_ids: [subscription.id],
    }, cookie);
    assert.equal(bulk.data.crees, 0, 'un mois déjà réglé dans un paiement groupé ne doit pas être réencaissé');
    assert.equal(bulk.data.ignores, 1);
  });
});

test('a mistyped rent year is refused instead of creating a phantom credit', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, subscription } = await setupProperty(baseUrl);
    const due = previousRentPeriod();

    const typo = await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: subscription.id,
      montant_paye: 50000,
      mois_payes: [{ mois: due.mois, annee: due.annee + 40 }],
    }, cookie);
    assert.equal(typo.res.status, 400);
    assert.match(typo.data.error, /Période de loyer improbable/);

    // Une avance raisonnable reste possible : le locataire a le droit de payer
    // d'avance, on ne la lui réclame simplement jamais.
    const avance = await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: subscription.id,
      montant_paye: 50000,
      mois_payes: [{ mois: MOIS[new Date().getMonth()], annee: new Date().getFullYear() }],
    }, cookie);
    assert.equal(avance.res.status, 200, JSON.stringify(avance.data));
  });
});

test('a lease carrying collected rents cannot be deleted', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, subscription } = await setupProperty(baseUrl);
    await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: subscription.id, montant_paye: 50000,
    }, cookie);

    const refused = await request(baseUrl, 'DELETE', `/api/subscriptions/${subscription.id}`, null, cookie);
    assert.equal(refused.res.status, 400);
    assert.match(refused.data.error, /loyers encaissés/);

    const stillThere = await request(baseUrl, 'GET', `/api/subscriptions/${subscription.id}`, null, cookie);
    assert.equal(stillThere.res.status, 200);
  });
});

test('a rent already paid out to the owner can no longer be edited or deleted', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, property, subscription } = await setupProperty(baseUrl);
    const payment = await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: subscription.id, montant_paye: 50000,
    }, cookie);

    const details = await request(baseUrl, 'GET', `/api/properties/${property.id}/details`, null, cookie);
    const ownerId = details.data.property.owner_id;
    const payout = await request(baseUrl, 'POST', '/api/payouts', { owner_id: ownerId }, cookie);
    assert.equal(payout.res.status, 200, JSON.stringify(payout.data));
    assert.equal(payout.data.montant_loyers, 50000);

    const edit = await request(baseUrl, 'PUT', `/api/payments/${payment.data.id}`, {
      subscription_id: subscription.id, montant_paye: 10, montant_a_payer: 10,
    }, cookie);
    assert.equal(edit.res.status, 400);
    assert.match(edit.data.error, /déjà été reversé/);

    const removed = await request(baseUrl, 'DELETE', `/api/payments/${payment.data.id}`, null, cookie);
    assert.equal(removed.res.status, 400);
    assert.match(removed.data.error, /déjà été reversé/);

    // Le reversement annulé, la correction redevient possible.
    await request(baseUrl, 'DELETE', `/api/payouts/${payout.data.id}`, null, cookie);
    const retry = await request(baseUrl, 'DELETE', `/api/payments/${payment.data.id}`, null, cookie);
    assert.equal(retry.res.status, 200);
  });
});

test('two simultaneous payouts never reverse the same rent twice', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, property, subscription } = await setupProperty(baseUrl);
    await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: subscription.id, montant_paye: 50000,
    }, cookie);
    const details = await request(baseUrl, 'GET', `/api/properties/${property.id}/details`, null, cookie);
    const ownerId = details.data.property.owner_id;

    const [a, b] = await Promise.all([
      request(baseUrl, 'POST', '/api/payouts', { owner_id: ownerId }, cookie),
      request(baseUrl, 'POST', '/api/payouts', { owner_id: ownerId }, cookie),
    ]);

    // Selon l'ordre d'exécution, le perdant est refusé soit à la lecture
    // (plus rien à reverser : 400), soit au rattachement (loyer déjà pris : 409).
    const statuses = [a.res.status, b.res.status].sort();
    assert.equal(statuses[0], 200, 'un des deux reversements doit aboutir');
    assert.ok([400, 409].includes(statuses[1]), `le second doit être refusé, reçu ${statuses[1]}`);

    const history = await request(baseUrl, 'GET', '/api/payouts', null, cookie);
    assert.equal(history.data.length, 1);
    assert.equal(history.data[0].montant_loyers, 50000);
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
