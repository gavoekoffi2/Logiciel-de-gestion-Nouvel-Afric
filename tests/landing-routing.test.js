const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../src/app'), 'utf8');
const landing = fs.readFileSync(require.resolve('../public/landing.html'), 'utf8');

test('MaGérance landing is restricted to the business hostname', () => {
  assert.match(source, /const isMageranceHost/);
  assert.match(source, /isMageranceHost\(req\)/);
  assert.match(source, /return res\.redirect\('\/login'\)/);
  assert.match(source, /app\.get\('\/e\/:slug', \(req, res\) => res\.sendFile\(path\.join\(PUBLIC_DIR, 'login\.html'\)\)\)/);
});

test('the MaGérance landing markets real software operations', () => {
  for (const feature of ['caution', 'Encaisser un loyer', 'Reste à reverser', 'dépense / réparation', 'Journal d’activité', 'sauvegarde']) {
    assert.match(landing, new RegExp(feature, 'i'));
  }
});
