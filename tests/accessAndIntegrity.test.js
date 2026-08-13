'use strict';

/**
 * Contrôle d'accès et intégrité comptable.
 *
 * Ces tests couvrent des situations où le logiciel donnait auparavant l'illusion
 * d'avoir protégé quelque chose : un employé « désactivé » qui continuait de
 * travailler, une entreprise qui perdait son dernier administrateur, un
 * propriétaire supprimé dont les biens devenaient orphelins, ou un fichier
 * incomplet qui effaçait des données sans rien restaurer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), `nouvel-afric-access-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-access';
process.env.SUPERADMIN_EMAIL = 'superadmin-access@nouvelafric.tg';
process.env.SUPERADMIN_PASSWORD = 'SuperAccess123';

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
  if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
  return { res, data };
}

function cookieFrom(res) {
  const values = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return values.flatMap((raw) => String(raw).split(/,(?=naf\.sid)/)).map((part) => part.split(';')[0]).filter(Boolean).join('; ');
}

let seq = 0;
const uniqueEmail = (prefix) => `${prefix}-${Date.now()}-${seq++}-${Math.random().toString(36).slice(2)}@example.com`;

async function registerCompany(baseUrl, name = 'Agence Accès') {
  const email = uniqueEmail('admin');
  const registered = await request(baseUrl, 'POST', '/api/auth/register', {
    entreprise: name, nom: 'Admin Test', email, telephone: '+228 90 00 00 11', password: 'secret123',
  });
  assert.equal(registered.res.status, 200, JSON.stringify(registered.data));
  return { cookie: cookieFrom(registered.res), email, adminId: registered.data.user.id };
}

async function login(baseUrl, email, password) {
  const res = await request(baseUrl, 'POST', '/api/auth/login', { email, password });
  return { status: res.res.status, cookie: res.res.status === 200 ? cookieFrom(res.res) : null };
}

// ---------------------------------------------------------------------------
// Contrôle d'accès : la session ne fige plus les droits
// ---------------------------------------------------------------------------

test('deactivating an employee cuts their access immediately, not in 12 hours', async () => {
  await withServer(async (baseUrl) => {
    const { cookie: adminCookie } = await registerCompany(baseUrl);
    const email = uniqueEmail('secretaire');
    const created = await request(baseUrl, 'POST', '/api/users', {
      email, password: 'secret123', nom: 'Secrétaire', role: 'secretaire',
    }, adminCookie);
    assert.equal(created.res.status, 200, JSON.stringify(created.data));

    const session = await login(baseUrl, email, 'secret123');
    assert.equal(session.status, 200);
    // La secrétaire travaille normalement.
    assert.equal((await request(baseUrl, 'GET', '/api/owners', null, session.cookie)).res.status, 200);

    // L'administrateur désactive son compte pendant qu'elle est connectée.
    const disabled = await request(baseUrl, 'PUT', `/api/users/${created.data.id}`, { actif: 0 }, adminCookie);
    assert.equal(disabled.res.status, 200, JSON.stringify(disabled.data));

    // Son cookie ne lui donne plus aucun accès, sans attendre son expiration.
    const blocked = await request(baseUrl, 'GET', '/api/owners', null, session.cookie);
    assert.equal(blocked.res.status, 401);
    const blockedWrite = await request(baseUrl, 'POST', '/api/owners', {
      nom_prenoms: 'Ne doit pas exister', contact: '+228 90 00 00 00',
    }, session.cookie);
    assert.equal(blockedWrite.res.status, 401);
    // Et elle ne peut plus se reconnecter.
    assert.equal((await login(baseUrl, email, 'secret123')).status, 401);
  });
});

test('a deleted account loses its session at once', async () => {
  await withServer(async (baseUrl) => {
    const { cookie: adminCookie } = await registerCompany(baseUrl);
    const email = uniqueEmail('parti');
    const created = await request(baseUrl, 'POST', '/api/users', {
      email, password: 'secret123', nom: 'Employé parti', role: 'assistant',
    }, adminCookie);
    const session = await login(baseUrl, email, 'secret123');
    assert.equal(session.status, 200);

    await request(baseUrl, 'DELETE', `/api/users/${created.data.id}`, null, adminCookie);

    assert.equal((await request(baseUrl, 'GET', '/api/tenants', null, session.cookie)).res.status, 401);
    assert.equal((await request(baseUrl, 'GET', '/api/auth/me', null, session.cookie)).res.status, 401);
  });
});

test('demoting an administrator removes their admin powers right away', async () => {
  await withServer(async (baseUrl) => {
    const { cookie: adminCookie } = await registerCompany(baseUrl);
    const email = uniqueEmail('second-admin');
    const created = await request(baseUrl, 'POST', '/api/users', {
      email, password: 'secret123', nom: 'Second admin', role: 'admin',
    }, adminCookie);
    const session = await login(baseUrl, email, 'secret123');
    assert.equal((await request(baseUrl, 'GET', '/api/users', null, session.cookie)).res.status, 200);

    await request(baseUrl, 'PUT', `/api/users/${created.data.id}`, { role: 'secretaire' }, adminCookie);

    // Écran des utilisateurs et journal : réservés à l'administrateur.
    assert.equal((await request(baseUrl, 'GET', '/api/users', null, session.cookie)).res.status, 403);
    assert.equal((await request(baseUrl, 'GET', '/api/audit', null, session.cookie)).res.status, 403);
    // Mais son travail courant reste possible.
    assert.equal((await request(baseUrl, 'GET', '/api/owners', null, session.cookie)).res.status, 200);
  });
});

test('a company can never lose its last active administrator', async () => {
  await withServer(async (baseUrl) => {
    const { cookie, adminId } = await registerCompany(baseUrl);

    const demoted = await request(baseUrl, 'PUT', `/api/users/${adminId}`, { role: 'secretaire' }, cookie);
    assert.equal(demoted.res.status, 400);
    assert.match(demoted.data.error, /dernier administrateur/);

    const disabled = await request(baseUrl, 'PUT', `/api/users/${adminId}`, { actif: 0 }, cookie);
    assert.equal(disabled.res.status, 400);

    // Toujours administrateur, donc toujours maître de son entreprise.
    assert.equal((await request(baseUrl, 'GET', '/api/users', null, cookie)).res.status, 200);

    // Avec un second administrateur, la rétrogradation redevient possible.
    const second = await request(baseUrl, 'POST', '/api/users', {
      email: uniqueEmail('relais'), password: 'secret123', nom: 'Relais', role: 'admin',
    }, cookie);
    assert.equal(second.res.status, 200);
    const ok = await request(baseUrl, 'PUT', `/api/users/${adminId}`, { role: 'secretaire' }, cookie);
    assert.equal(ok.res.status, 200, JSON.stringify(ok.data));
  });
});

test('user accounts require a password of at least six characters', async () => {
  await withServer(async (baseUrl) => {
    const { cookie } = await registerCompany(baseUrl);
    const weak = await request(baseUrl, 'POST', '/api/users', {
      email: uniqueEmail('faible'), password: '1', nom: 'Faible', role: 'secretaire',
    }, cookie);
    assert.equal(weak.res.status, 400);
    assert.match(weak.data.error, /6 caractères/);
  });
});

test('a taken e-mail never leaves an ownerless company behind', async () => {
  await withServer(async (baseUrl) => {
    const { email } = await registerCompany(baseUrl, 'Agence Unique');
    const again = await request(baseUrl, 'POST', '/api/auth/register', {
      entreprise: 'Entreprise Fantôme', nom: 'Autre', email, telephone: '+228 90 00 00 12', password: 'secret123',
    });
    assert.equal(again.res.status, 400);

    const superCookie = (await login(baseUrl, 'superadmin-access@nouvelafric.tg', 'SuperAccess123')).cookie;
    const companies = await request(baseUrl, 'GET', '/api/platform/companies', null, superCookie);
    assert.equal(companies.data.some((c) => c.nom === 'Entreprise Fantôme'), false,
      'aucune entreprise ne doit subsister quand la création de son administrateur échoue');
  });
});

// ---------------------------------------------------------------------------
// Intégrité comptable
// ---------------------------------------------------------------------------

test('an owner who still holds properties or payouts cannot be deleted', async () => {
  await withServer(async (baseUrl) => {
    const { cookie } = await registerCompany(baseUrl);
    const owner = await request(baseUrl, 'POST', '/api/owners', {
      nom_prenoms: 'Propriétaire Lié', contact: '+228 90 33 33 33',
    }, cookie);
    const property = await request(baseUrl, 'POST', '/api/properties', {
      owner_id: owner.data.id, type_construction: 'Villa', designation: 'Villa Agoè', cout_loyer: 90000,
      ville: 'Lomé', quartier: 'Agoè', part_commission: 10, nombre_porte: 1,
    }, cookie);

    const refused = await request(baseUrl, 'DELETE', `/api/owners/${owner.data.id}`, null, cookie);
    assert.equal(refused.res.status, 400);
    assert.match(refused.data.error, /bien\(s\)/);

    // Le bien libéré, la fiche redevient supprimable.
    await request(baseUrl, 'DELETE', `/api/properties/${property.data.id}`, null, cookie);
    const removed = await request(baseUrl, 'DELETE', `/api/owners/${owner.data.id}`, null, cookie);
    assert.equal(removed.res.status, 200, JSON.stringify(removed.data));
  });
});

test('a partial file never wipes company data in « replace » mode', async () => {
  await withServer(async (baseUrl) => {
    const { cookie } = await registerCompany(baseUrl);
    await request(baseUrl, 'POST', '/api/owners', { nom_prenoms: 'À conserver', contact: '+228 90 44 44 44' }, cookie);

    // Fichier ne contenant que le journal : le remplacement effacerait tout.
    const refused = await request(baseUrl, 'POST', '/api/data/import', {
      mode: 'remplacer',
      donnees: { audit_log: [{ action: 'Test', entity: 'Divers', label: 'x' }] },
    }, cookie);
    assert.equal(refused.res.status, 400);
    assert.match(refused.data.error, /sans rien restaurer/);

    const owners = await request(baseUrl, 'GET', '/api/owners', null, cookie);
    assert.equal(owners.data.length, 1, 'les données existantes doivent être intactes');
    assert.equal(owners.data[0].nom_prenoms, 'À conserver');
  });
});

test('deleting a company removes its payouts, repairs and activity log too', async () => {
  await withServer(async (baseUrl) => {
    const { cookie } = await registerCompany(baseUrl, 'Agence À Supprimer');
    const owner = await request(baseUrl, 'POST', '/api/owners', {
      nom_prenoms: 'Propriétaire Supprimé', contact: '+228 90 55 55 55',
    }, cookie);
    const property = await request(baseUrl, 'POST', '/api/properties', {
      owner_id: owner.data.id, type_construction: 'Maison basse', designation: 'Cour Bè', cout_loyer: 40000,
      ville: 'Lomé', quartier: 'Bè', part_commission: 10, nombre_porte: 1,
    }, cookie);
    const tenant = await request(baseUrl, 'POST', '/api/tenants', {
      nom_prenoms: 'Locataire Supprimé', contact: '+228 90 66 66 66',
    }, cookie);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const batch = await request(baseUrl, 'POST', `/api/properties/${property.data.id}/tenants`, {
      date_souscription: ymd(start), date_entree: ymd(start), date_debut_paiement: ymd(start),
      tenants: [{ tenant_id: tenant.data.id, montant_loyer: 40000 }],
    }, cookie);
    await request(baseUrl, 'POST', '/api/payments', {
      subscription_id: batch.data.subscriptions[0].id, montant_paye: 40000,
    }, cookie);
    await request(baseUrl, 'POST', '/api/repairs', {
      property_id: property.data.id, mois: 'Janvier', annee: now.getFullYear(), montant: 5000, description: 'Test',
    }, cookie);
    await request(baseUrl, 'POST', '/api/payouts', { owner_id: owner.data.id }, cookie);

    const superCookie = (await login(baseUrl, 'superadmin-access@nouvelafric.tg', 'SuperAccess123')).cookie;
    const companies = await request(baseUrl, 'GET', '/api/platform/companies', null, superCookie);
    const target = companies.data.find((c) => c.nom === 'Agence À Supprimer');
    assert.ok(target, 'entreprise de test introuvable');

    const before = await request(baseUrl, 'GET', '/api/platform/backup/export', null, superCookie);
    const countFor = (tables, name) => tables[name].filter((r) => r.company_id === target.id).length;
    assert.ok(countFor(before.data.tables, 'payouts') > 0);
    assert.ok(countFor(before.data.tables, 'repairs') > 0);
    assert.ok(countFor(before.data.tables, 'audit_log') > 0);

    const removed = await request(baseUrl, 'DELETE', `/api/platform/companies/${target.id}`, null, superCookie);
    assert.equal(removed.res.status, 200);

    const after = await request(baseUrl, 'GET', '/api/platform/backup/export', null, superCookie);
    for (const table of ['owners', 'tenants', 'properties', 'subscriptions', 'payouts', 'payments', 'repairs', 'audit_log', 'users']) {
      assert.equal(countFor(after.data.tables, table), 0,
        `des lignes de « ${table} » subsistent après la suppression de l'entreprise`);
    }
  });
});

test('an incomplete platform backup is refused before anything is erased', async () => {
  await withServer(async (baseUrl) => {
    await registerCompany(baseUrl, 'Agence Préservée');
    const superCookie = (await login(baseUrl, 'superadmin-access@nouvelafric.tg', 'SuperAccess123')).cookie;

    // Enveloppe vide : détruisait auparavant toute la plateforme sans rien restaurer.
    const empty = await request(baseUrl, 'POST', '/api/platform/backup/import', {
      tables: {}, confirmation: 'RESTAURER',
    }, superCookie);
    assert.equal(empty.res.status, 400);

    // Fichier sans super-administrateur : ce n'est pas une sauvegarde complète.
    const partial = await request(baseUrl, 'POST', '/api/platform/backup/import', {
      tables: { users: [{ id: 1, email: 'x@y.z', role: 'admin', password: 'x' }] }, confirmation: 'RESTAURER',
    }, superCookie);
    assert.equal(partial.res.status, 400);

    // La plateforme est intacte et le super-admin toujours connecté.
    const companies = await request(baseUrl, 'GET', '/api/platform/companies', null, superCookie);
    assert.equal(companies.res.status, 200);
    assert.ok(companies.data.some((c) => c.nom === 'Agence Préservée'));
  });
});
