'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nouvel-afric-backup-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-session-secret-platform-backup';
process.env.SUPERADMIN_EMAIL = 'superadmin-test@nouvelafric.tg';
process.env.SUPERADMIN_PASSWORD = 'SuperBackup123';

const { app, ready } = require('../src/app');

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function cookieHeader(headers) {
  const raw = headers.get('set-cookie') || '';
  return raw.split(',').map((part) => part.split(';')[0]).filter(Boolean).join('; ');
}

test('super-admin can export and restore a complete platform backup', async () => {
  await ready;
  const { server, base } = await startServer();
  try {
    let res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'superadmin-test@nouvelafric.tg', password: 'SuperBackup123' }),
    });
    assert.equal(res.status, 200);
    const cookie = cookieHeader(res.headers);
    assert.match(cookie, /naf\.sid=/);

    res = await fetch(`${base}/api/platform/backup/export`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const backup = await res.json();
    assert.equal(backup.format, 'nouvelafric.platform.backup');
    assert.ok(Array.isArray(backup.tables.users));
    assert.ok(backup.tables.users.some((u) => u.role === 'superadmin'));
    assert.ok(Array.isArray(backup.tables.companies));

    res = await fetch(`${base}/api/platform/backup/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ...backup, confirmation: 'RESTAURER' }),
    });
    assert.equal(res.status, 200);
    const restored = await res.json();
    assert.equal(restored.ok, true);
    assert.ok(restored.imported.users >= 1);

    res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'superadmin-test@nouvelafric.tg', password: 'SuperBackup123' }),
    });
    assert.equal(res.status, 200);
    const meCookie = cookieHeader(res.headers);
    res = await fetch(`${base}/api/auth/me`, { headers: { cookie: meCookie } });
    assert.equal(res.status, 200);
    const me = await res.json();
    assert.equal(me.user.role, 'superadmin');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
