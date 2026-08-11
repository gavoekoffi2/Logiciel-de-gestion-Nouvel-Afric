'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const house = read('public/js/views/maisonDetail.js');
const payments = read('public/js/views/reglements.js');
const recovery = read('public/js/views/recouvrement.js');
const controls = read('public/js/periodControls.js');

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

// Le filtre de période est le point où le bug se voyait : ouvert sur le mois
// civil en cours, il masquait le règlement qu'on venait d'enregistrer.
test('the period filter is anchored on the last due month, not the calendar month', () => {
  assert.match(controls, /export function dueMonthValue/);
  assert.match(controls, /if \(mode === 'current'\) from = to = due;/);
  // Plus aucun écran ne peut demander le mois civil en cours.
  assert.doesNotMatch(controls, /currentMonthValue/);
  assert.match(controls, /max="\$\{due\}"/);
});

test('period filters never let the user go past the last due month', () => {
  assert.match(controls, /const capped = \(value\) => \(value && value > due \? due : value\);/);
});

test('the recovery screen only offers rent months that are already due', () => {
  assert.match(recovery, /previousRentPeriod/);
  assert.match(recovery, /moisDisponibles/);
  assert.match(recovery, /periode_ajustee/);
  // La liste des mois se recalcule quand l'année change.
  assert.match(recovery, /syncMonthOptions/);
});

test('the property file opens on the whole lease history, not a single month', () => {
  assert.match(house, /periodState\(hashParams, 'all'\)/);
});

test('the bulk collection screen states and enforces the postpaid rule', () => {
  assert.match(payments, /terme échu/);
  assert.match(payments, /syncBulkMonths/);
});
