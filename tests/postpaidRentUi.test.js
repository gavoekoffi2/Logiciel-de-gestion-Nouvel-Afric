'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const house = fs.readFileSync(path.join(root, 'public/js/views/maisonDetail.js'), 'utf8');
const payments = fs.readFileSync(path.join(root, 'public/js/views/reglements.js'), 'utf8');

for (const [name, source] of [['fiche du bien', house], ['règlements', payments]]) {
  test(`${name} uses the shared previous-month rent default`, () => {
    assert.match(source, /previousRentPeriod/);
    assert.match(source, /Date réelle d'encaissement/);
    assert.match(source, /Mois de loyer réglé/);
  });
}

test('the property payment form never falls back to the current month', () => {
  assert.doesNotMatch(house, /pm\.mois \|\| MOIS\[new Date\(\)\.getMonth\(\)\]/);
  assert.match(house, /const pm = presetMonth \|\| previousRentPeriod\(\)/);
  assert.doesNotMatch(house, /nextUnpaid/);
});

test('changing a new collection date recalculates the previous rent month', () => {
  assert.match(house, /previousRentPeriod\(v\.date\)/);
  assert.match(payments, /previousRentPeriod\(v\.date\)/);
  assert.match(payments, /previousRentPeriod\(event\.target\.value\)/);
});
