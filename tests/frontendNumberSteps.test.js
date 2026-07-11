'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('tenant/property money inputs accept exact FCFA amounts without browser step +/-1 validation', () => {
  const maisonDetail = read('public/js/views/maisonDetail.js');
  const souscriptions = read('public/js/views/souscriptions.js');
  const locataires = read('public/js/views/locataires.js');

  assert.match(maisonDetail, /name: 'montant_loyer'[\s\S]*?min: 1, step: 1/);
  assert.doesNotMatch(maisonDetail, /name: 'montant_loyer'[\s\S]*?step: 1000/);

  assert.match(souscriptions, /name: 'montant_loyer'[\s\S]*?min: 1, step: 1/);
  assert.doesNotMatch(souscriptions, /step: 1000/);
  assert.doesNotMatch(souscriptions, /step: 500/);

  assert.doesNotMatch(locataires, /step: 1000/);
  assert.doesNotMatch(locataires, /step: 500/);
});
