'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const propertyView = fs.readFileSync(path.join(root, 'public/js/views/maisonDetail.js'), 'utf8');
const dashboardView = fs.readFileSync(path.join(root, 'public/js/views/dashboard.js'), 'utf8');

test('la dépense proposée suit le mois affiché pour rester visible après validation', () => {
  assert.match(propertyView, /selectedPeriod\.mode === 'all'[\s\S]*selectedPeriod\.to \|\| selectedPeriod\.from/);
  assert.match(propertyView, /Dépense enregistrée et comptabilisée pour ce bien/);
});

test('le tableau de bord affiche le total et les dernières dépenses de la période', () => {
  assert.match(dashboardView, /Dépenses de la période/);
  assert.match(dashboardView, /d\.total_depenses/);
  assert.match(dashboardView, /d\.depenses_recentes/);
  assert.match(dashboardView, /property_designation/);
});
