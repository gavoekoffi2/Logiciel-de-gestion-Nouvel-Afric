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
async function setup(baseUrl, { caution = 0, avance = 0 } = {}) {
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
    nombre_mois_caution: caution, nombre_mois_avance: avance,
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


// ---------------------------------------------------------------------------
// Deuxieme signalement de l'agence :
//   « les montants sont tellement eleves que ca ne correspond pas aux collectes.
//     Meme quand on supprime un bien, le montant deja enregistre ne part pas. »
//   « ceux qui ont des arrieres ne sont plus affiches, et quand on veut
//     encaisser un arriere ca vient automatiquement sur aout. »
// ---------------------------------------------------------------------------

test('les arriérés restent affichés et encaissables quand la fiche est calée sur le mois', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, property, subscription } = await setup(baseUrl);
    const moisAffiche = periodBefore(0);
    const arriere = periodBefore(2);

    // Seul le mois affiché est réglé : les deux mois d'avant restent dus.
    await encaisser(baseUrl, cookie, subscription.id, moisAffiche, LOYER);

    const fiche = await request(baseUrl, 'GET', `/api/properties/${property.id}/details`, null, cookie);
    assert.equal(fiche.res.status, 200, JSON.stringify(fiche.data));
    const sub = fiche.data.subscriptions.find((s) => s.id === subscription.id);

    // L'échéancier du mois ne contient que le mois affiché…
    assert.deepEqual(sub.echeancier.map((m) => `${m.mois} ${m.annee}`), [`${moisAffiche.mois} ${moisAffiche.annee}`]);
    // …mais les mois en retard restent listés à part, encaissables.
    const enRetard = sub.arrieres_echeancier || [];
    assert.equal(enRetard.length, 2, 'les deux mois antérieurs impayés doivent rester visibles');
    assert.ok(enRetard.some((m) => m.mois === arriere.mois && m.annee === arriere.annee));
    for (const m of enRetard) {
      assert.equal(m.reste, LOYER);
      assert.equal(m.echu, true);
    }
    assert.equal(sub.resume.arrieres, 2 * LOYER);
    // Et ils ne contaminent pas les compteurs du mois.
    assert.equal(sub.resume.total_paye, LOYER);
    assert.equal(sub.resume.total_attendu, LOYER);
    assert.equal(sub.resume.reste, 0);
  });
});

test('encaisser un arriéré l’impute au mois en retard, pas au mois en cours', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, property, subscription } = await setup(baseUrl);
    const moisAffiche = periodBefore(0);
    const arriere = periodBefore(2);

    await encaisser(baseUrl, cookie, subscription.id, arriere, LOYER);

    // Le règlement est bien tombé sur le mois d'arriéré.
    const rapportArriere = await recouvrement(baseUrl, cookie, arriere);
    assert.equal(ligneDe(rapportArriere).montant_paye, LOYER);
    // Le mois en cours de recouvrement, lui, n'a rien reçu.
    const rapportMois = await recouvrement(baseUrl, cookie, moisAffiche);
    assert.equal(ligneDe(rapportMois).montant_paye, 0);
    assert.equal(ligneDe(rapportMois).ecart, LOYER);

    // Et l'arriéré soldé disparaît bien de la liste des retards.
    const fiche = await request(baseUrl, 'GET', `/api/properties/${property.id}/details`, null, cookie);
    const sub = fiche.data.subscriptions.find((s) => s.id === subscription.id);
    const restants = (sub.arrieres_echeancier || []).map((m) => `${m.mois} ${m.annee}`);
    assert.equal(restants.includes(`${arriere.mois} ${arriere.annee}`), false);
    assert.equal(sub.resume.arrieres, LOYER, 'il reste le seul mois intermédiaire impayé');
  });
});

test('cautions et avances sont l’encours détenu, pas les baux signés dans le mois', async () => {
  await withServer(async (baseUrl) => {
    const { cookie } = await setup(baseUrl, { caution: 2, avance: 1 });

    // Le bail a été signé il y a 3 mois. Un filtrage sur la date de signature
    // afficherait 0 pour le mois en cours — c'est ce que voyait l'agence, à
    // l'envers : apres une ressaisie du parc, tous les baux portaient la meme
    // date et la tuile cumulait d'un coup toutes les cautions.
    const dashboard = await request(baseUrl, 'GET', '/api/dashboard', null, cookie);
    assert.equal(dashboard.data.total_caution, 2 * LOYER);
    assert.equal(dashboard.data.total_avance, LOYER);

    // L'encours ne bouge pas avec la période affichée : ce n'est pas un flux.
    const cumul = await request(baseUrl, 'GET', '/api/dashboard?mode=all', null, cookie);
    assert.equal(cumul.data.total_caution, 2 * LOYER);
    assert.equal(cumul.data.total_avance, LOYER);
  });
});

test('supprimer un bien retire ses montants des compteurs sans effacer l’historique', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, property, subscription } = await setup(baseUrl, { caution: 2 });
    await encaisser(baseUrl, cookie, subscription.id, periodBefore(0), LOYER);

    const avant = await request(baseUrl, 'GET', '/api/dashboard', null, cookie);
    assert.equal(avant.data.total_loyer, LOYER);
    assert.equal(avant.data.total_caution, 2 * LOYER);
    assert.ok(avant.data.reste_a_reverser > 0);

    const supprime = await request(baseUrl, 'DELETE', `/api/properties/${property.id}`, null, cookie);
    assert.equal(supprime.res.status, 200, JSON.stringify(supprime.data));

    // Plus rien de ce bien ne doit peser sur les compteurs.
    const apres = await request(baseUrl, 'GET', '/api/dashboard', null, cookie);
    assert.equal(apres.data.total_loyer, 0);
    assert.equal(apres.data.total_caution, 0);
    assert.equal(apres.data.total_avance, 0);
    assert.equal(apres.data.loyer_attendu, 0);
    assert.equal(apres.data.impayes_montant, 0);
    assert.equal(apres.data.reste_a_reverser, 0);

    // Le tableau de bord dit désormais la même chose que l'écran Reversements.
    const du = await request(baseUrl, 'GET', '/api/payouts/due', null, cookie);
    assert.equal(du.data.reduce((total, r) => total + r.net, 0), apres.data.reste_a_reverser);

    // L'historique comptable, lui, reste consultable.
    const bail = await request(baseUrl, 'GET', `/api/subscriptions/${subscription.id}`, null, cookie);
    assert.equal(bail.res.status, 200);
    assert.equal(bail.data.statut, 'Desactive');
    const reglements = await request(baseUrl, 'GET', '/api/payments?mode=all', null, cookie);
    assert.equal(reglements.data.length, 1, 'le règlement reste dans le journal des règlements');
  });
});


// ---------------------------------------------------------------------------
// Troisieme signalement : « les arrieres des locataires ne s'affichent pas.
// Il faut que ca s'affiche, pour qu'on sache combien de mois chaque locataire
// doit. »
// ---------------------------------------------------------------------------

test('la liste des locataires indique combien de mois chacun doit', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, subscription } = await setup(baseUrl);

    // Bail ouvert il y a 3 mois, rien de payé : 3 mois échus restent dus.
    const liste = await request(baseUrl, 'GET', '/api/tenants', null, cookie);
    assert.equal(liste.res.status, 200, JSON.stringify(liste.data));
    const locataire = liste.data[0];
    assert.equal(locataire.mois_dus, 3);
    assert.equal(locataire.montant_du, 3 * LOYER);
    assert.equal(locataire.mois_dus_liste.length, 3);
    assert.equal(locataire.premier_mois_du, `${periodBefore(2).mois} ${periodBefore(2).annee}`);
    // Le mois civil en cours n'est jamais réclamé : il n'est pas encore exigible.
    const moisCourant = MOIS[new Date().getMonth()];
    assert.equal(locataire.mois_dus_liste.some((m) => m.startsWith(moisCourant)), false);

    // Encaisser un mois le retire de la liste des mois dus.
    await encaisser(baseUrl, cookie, subscription.id, periodBefore(2), LOYER);
    const apres = await request(baseUrl, 'GET', '/api/tenants', null, cookie);
    assert.equal(apres.data[0].mois_dus, 2);
    assert.equal(apres.data[0].montant_du, 2 * LOYER);

    // Un paiement partiel laisse le mois dû, pour le reste seulement.
    await encaisser(baseUrl, cookie, subscription.id, periodBefore(1), 100000);
    const partiel = await request(baseUrl, 'GET', '/api/tenants', null, cookie);
    assert.equal(partiel.data[0].mois_dus, 2);
    assert.equal(partiel.data[0].montant_du, 2 * LOYER - 100000);
  });
});

test('la fiche d’un locataire détaille les mois qu’il doit, un par un', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, subscription, property } = await setup(baseUrl);
    await encaisser(baseUrl, cookie, subscription.id, periodBefore(1), LOYER);

    const liste = await request(baseUrl, 'GET', '/api/tenants', null, cookie);
    const fiche = await request(baseUrl, 'GET', `/api/tenants/${liste.data[0].id}/details`, null, cookie);
    assert.equal(fiche.res.status, 200, JSON.stringify(fiche.data));

    // Les deux mois restants, du plus ancien au plus récent, avec leur bien.
    const dus = fiche.data.arrieres.map((m) => `${m.mois} ${m.annee}`);
    assert.deepEqual(dus, [
      `${periodBefore(2).mois} ${periodBefore(2).annee}`,
      `${periodBefore(0).mois} ${periodBefore(0).annee}`,
    ]);
    for (const m of fiche.data.arrieres) {
      assert.equal(m.reste, LOYER);
      assert.equal(m.property_code, property.code);
      assert.equal(m.statut, 'Impayé');
    }
    assert.equal(fiche.data.totals.mois_dus, 2);
    assert.equal(fiche.data.totals.montant_du, 2 * LOYER);
  });
});

test('un locataire à jour n’affiche aucun mois dû', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, subscription } = await setup(baseUrl);
    for (const back of [0, 1, 2]) {
      await encaisser(baseUrl, cookie, subscription.id, periodBefore(back), LOYER);
    }
    const liste = await request(baseUrl, 'GET', '/api/tenants', null, cookie);
    assert.equal(liste.data[0].mois_dus, 0);
    assert.equal(liste.data[0].montant_du, 0);
    assert.equal(liste.data[0].premier_mois_du, null);

    const fiche = await request(baseUrl, 'GET', `/api/tenants/${liste.data[0].id}/details`, null, cookie);
    assert.deepEqual(fiche.data.arrieres, []);
  });
});
