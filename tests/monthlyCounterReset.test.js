'use strict';

/**
 * NON-REGRESSION — LE COMPTEUR DE RECOUVREMENT REPART DE ZERO CHAQUE MOIS.
 *
 * Probleme signale par l'agence : « nous sommes en septembre, nous recoltons le
 * loyer d'aout, mais les montants encaisses le mois passe sont restes dans le
 * tableau. Quand on enregistre une entree pour ce mois, les montants
 * s'additionnent, alors que le compteur devait revenir a zero. »
 *
 * Ce fichier verrouille la regle sur les trois ecrans qui affichaient un cumul :
 * l'etat de recouvrement, le tableau de bord et la fiche d'un bien.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), `nouvel-afric-reset-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-reset';

const { app, ready } = require('../src/app');
const { MOIS } = require('../src/paymentPeriods');
const { lastDuePeriod, buildPeriod } = require('../src/rentCycle');

const LOYER = 187000;

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
  return { res, data: text ? JSON.parse(text) : null };
}

function cookieFrom(res) {
  const values = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return values.flatMap((raw) => String(raw).split(/,(?=naf\.sid)/)).map((part) => part.split(';')[0]).filter(Boolean).join('; ');
}

// Periode situee `back` mois avant le dernier mois exigible.
function periodBefore(back) {
  const due = lastDuePeriod();
  const index = due.index - back;
  return buildPeriod(Math.floor(index / 12), (index % 12) + 1);
}

const ymd = (period) => `${period.annee}-${String(MOIS.indexOf(period.mois) + 1).padStart(2, '0')}-01`;

// Une agence, un bien « Kaky 2 », un locataire dont le bail court depuis 3 mois.
async function setup(baseUrl) {
  const email = `reset-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const registered = await request(baseUrl, 'POST', '/api/auth/register', {
    entreprise: 'Agence Compteur Mensuel',
    nom: 'Admin Test',
    email,
    telephone: '+228 90 00 00 11',
    password: 'secret123',
  });
  assert.equal(registered.res.status, 200, JSON.stringify(registered.data));
  const cookie = cookieFrom(registered.res);

  const owner = await request(baseUrl, 'POST', '/api/owners', {
    nom_prenoms: 'Propriétaire Kaky', contact: '+228 90 11 11 33',
  }, cookie);
  const property = await request(baseUrl, 'POST', '/api/properties', {
    owner_id: owner.data.id, type_construction: 'RDC', designation: 'Kaky 2',
    ville: 'Lomé', quartier: 'Bè', part_commission: 0, nombre_porte: 1,
  }, cookie);
  const tenant = await request(baseUrl, 'POST', '/api/tenants', {
    nom_prenoms: 'Locataire Kaky', contact: '+228 90 22 22 44',
  }, cookie);

  const debut = periodBefore(2);
  const batch = await request(baseUrl, 'POST', `/api/properties/${property.data.id}/tenants`, {
    date_souscription: ymd(debut), date_entree: ymd(debut), date_debut_paiement: ymd(debut),
    nombre_mois_caution: 0, nombre_mois_avance: 0,
    tenants: [{ tenant_id: tenant.data.id, montant_loyer: LOYER }],
  }, cookie);
  assert.equal(batch.res.status, 200, JSON.stringify(batch.data));
  return { cookie, property: property.data, subscription: batch.data.subscriptions[0] };
}

async function encaisser(baseUrl, cookie, subscriptionId, period, montant) {
  const paiement = await request(baseUrl, 'POST', '/api/payments', {
    subscription_id: subscriptionId,
    montant_paye: montant,
    mois_payes: JSON.stringify([{ mois: period.mois, annee: period.annee }]),
    mois_concerne: period.mois,
    annee_concernee: period.annee,
  }, cookie);
  assert.equal(paiement.res.status, 200, JSON.stringify(paiement.data));
  return paiement.data;
}

const recouvrement = (baseUrl, cookie, period) => request(baseUrl, 'GET',
  `/api/recouvrement?mois=${encodeURIComponent(period.mois)}&annee=${period.annee}`, null, cookie);

const ligneDe = (rapport) => rapport.data.zones[0].maisons[0].locataires[0];
const maisonDe = (rapport) => rapport.data.zones[0].maisons[0];

test('le loyer encaissé pour un mois ne suit pas le locataire dans le rapport du mois suivant', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, subscription } = await setup(baseUrl);
    const moisPasse = periodBefore(1);
    const moisAffiche = periodBefore(0);

    // Tous les mois antérieurs sont soldés : rien ne doit rester à traîner.
    await encaisser(baseUrl, cookie, subscription.id, periodBefore(2), LOYER);
    await encaisser(baseUrl, cookie, subscription.id, moisPasse, LOYER);

    // Le mois où l'argent a réellement été encaissé.
    const passe = await recouvrement(baseUrl, cookie, moisPasse);
    assert.equal(passe.res.status, 200, JSON.stringify(passe.data));
    assert.equal(ligneDe(passe).montant_paye, LOYER);
    assert.equal(maisonDe(passe).total_paye, LOYER);

    // LE MOIS SUIVANT : le compteur repart de zéro. Les 187 000 du mois passé
    // ne doivent plus apparaître nulle part dans les totaux du mois affiché.
    const courant = await recouvrement(baseUrl, cookie, moisAffiche);
    assert.equal(courant.res.status, 200, JSON.stringify(courant.data));
    const ligne = ligneDe(courant);
    assert.equal(ligne.montant_paye, 0, 'le mois affiché démarre à zéro encaissé');
    assert.equal(ligne.montant_du, LOYER, 'un seul mois de loyer est dû, pas le cumul du bail');
    assert.equal(ligne.ecart, LOYER);
    assert.equal(ligne.arrieres, 0, 'le mois passé était soldé : aucun arriéré');
    assert.equal(maisonDe(courant).total_paye, 0);
    assert.equal(maisonDe(courant).total_du, LOYER);
    assert.equal(courant.data.recap.total_paye, 0);
    assert.equal(courant.data.portee, 'mois');
  });
});

test('un encaissement du mois en cours ne s’ajoute jamais à celui du mois précédent', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, subscription } = await setup(baseUrl);
    const moisPasse = periodBefore(1);
    const moisAffiche = periodBefore(0);

    await encaisser(baseUrl, cookie, subscription.id, moisPasse, LOYER);
    await encaisser(baseUrl, cookie, subscription.id, moisAffiche, 100000);

    const courant = await recouvrement(baseUrl, cookie, moisAffiche);
    const ligne = ligneDe(courant);
    // C'est exactement le symptôme signalé : on doit lire 100 000, jamais 287 000.
    assert.equal(ligne.montant_paye, 100000);
    assert.equal(ligne.montant_du, LOYER);
    assert.equal(ligne.ecart, LOYER - 100000);
    assert.equal(ligne.statut_mois, 'Partiel');
    assert.equal(maisonDe(courant).total_paye, 100000);
    assert.equal(courant.data.recap.total_paye, 100000);

    // Le rapport du mois passé, lui, n'a pas bougé.
    const passe = await recouvrement(baseUrl, cookie, moisPasse);
    assert.equal(ligneDe(passe).montant_paye, LOYER);
    assert.equal(ligneDe(passe).ecart, 0);
  });
});

test('les impayés des mois précédents sont chiffrés à part, sans gonfler le mois affiché', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, subscription } = await setup(baseUrl);
    const moisAffiche = periodBefore(0);

    // Rien n'est payé : le bail court depuis 3 mois, 2 mois sont échus avant
    // le mois affiché.
    const courant = await recouvrement(baseUrl, cookie, moisAffiche);
    const ligne = ligneDe(courant);
    assert.equal(ligne.montant_du, LOYER, 'le dû du mois reste un seul loyer');
    assert.equal(ligne.montant_paye, 0);
    assert.equal(ligne.ecart, LOYER);
    assert.equal(ligne.arrieres_mois, 2, 'les deux mois antérieurs sont des arriérés');
    assert.equal(ligne.arrieres, 2 * LOYER);
    assert.equal(maisonDe(courant).total_arrieres, 2 * LOYER);
    assert.equal(courant.data.recap.total_arrieres, 2 * LOYER);
    // L'arriéré ne doit JAMAIS être ajouté au dû ni à l'écart du mois.
    assert.equal(courant.data.recap.total_du, LOYER);
    assert.equal(courant.data.recap.ecart, LOYER);

    // Solder un arriéré le fait disparaître de la colonne arriérés sans rien
    // changer aux totaux du mois affiché.
    await encaisser(baseUrl, cookie, subscription.id, periodBefore(2), LOYER);
    const apres = await recouvrement(baseUrl, cookie, moisAffiche);
    assert.equal(ligneDe(apres).arrieres, LOYER);
    assert.equal(ligneDe(apres).arrieres_mois, 1);
    assert.equal(ligneDe(apres).montant_paye, 0);
    assert.equal(ligneDe(apres).montant_du, LOYER);
  });
});

test('le tableau de bord et la fiche du bien comptent eux aussi le mois seul', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, property, subscription } = await setup(baseUrl);
    const moisPasse = periodBefore(1);
    const moisAffiche = periodBefore(0);

    await encaisser(baseUrl, cookie, subscription.id, moisPasse, LOYER);
    await encaisser(baseUrl, cookie, subscription.id, moisAffiche, 100000);

    // Tableau de bord : sans paramètre, il présente le mois à recouvrer.
    const dashboard = await request(baseUrl, 'GET', '/api/dashboard', null, cookie);
    assert.equal(dashboard.res.status, 200, JSON.stringify(dashboard.data));
    assert.equal(dashboard.data.periode.mode, 'month');
    assert.equal(dashboard.data.periode.from, moisAffiche.value);
    assert.equal(dashboard.data.total_loyer, 100000, 'seuls les loyers du mois affiché sont comptés');
    assert.equal(dashboard.data.loyer_attendu, LOYER);

    // Le cumul reste consultable à la demande.
    const cumul = await request(baseUrl, 'GET', '/api/dashboard?mode=all', null, cookie);
    assert.equal(cumul.data.total_loyer, LOYER + 100000);

    // Fiche du bien : même règle.
    const fiche = await request(baseUrl, 'GET', `/api/properties/${property.id}/details`, null, cookie);
    assert.equal(fiche.res.status, 200, JSON.stringify(fiche.data));
    assert.equal(fiche.data.totals.total_paye, 100000);
    assert.equal(fiche.data.periode.from, moisAffiche.value);
    const sub = fiche.data.subscriptions.find((s) => s.id === subscription.id);
    assert.equal(sub.resume.total_paye, 100000);
    assert.equal(sub.resume.total_attendu, LOYER);
    // Le mois encore impayé d'avant reste visible, mais à part.
    assert.equal(sub.resume.arrieres, LOYER);
    assert.equal(sub.resume.arrieres_mois, 1);

    const ficheCumul = await request(baseUrl, 'GET', `/api/properties/${property.id}/details?mode=all`, null, cookie);
    assert.equal(ficheCumul.data.totals.total_paye, LOYER + 100000);
    assert.equal(ficheCumul.data.subscriptions.find((s) => s.id === subscription.id).resume.arrieres, 0);
  });
});

test('le « à reverser » du tableau de bord reste aligné sur l’écran Reversements', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, subscription } = await setup(baseUrl);
    await encaisser(baseUrl, cookie, subscription.id, periodBefore(1), LOYER);
    await encaisser(baseUrl, cookie, subscription.id, periodBefore(0), 100000);

    // Ce qui reste à reverser est une dette qui s'accumule jusqu'au versement :
    // elle ne se remet pas à zéro avec le mois, sinon le tableau de bord
    // annoncerait moins que l'écran Reversements.
    const dashboard = await request(baseUrl, 'GET', '/api/dashboard', null, cookie);
    const du = await request(baseUrl, 'GET', '/api/payouts/due', null, cookie);
    const attendu = du.data.reduce((total, r) => total + r.net, 0);
    assert.equal(attendu, LOYER + 100000, 'commission nulle sur ce bien : le net est le brut');
    assert.equal(dashboard.data.reste_a_reverser, attendu);
    // Et cela n'a pas contaminé les compteurs mensuels.
    assert.equal(dashboard.data.total_loyer, 100000);
  });
});
