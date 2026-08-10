'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { previousRentPeriod } = require('../src/rentCycle');

test('an August collection defaults to the July rent period', () => {
  assert.deepEqual(previousRentPeriod('2026-08-05'), {
    mois: 'Juillet',
    annee: 2026,
    value: '2026-07',
  });
});

test('a January collection defaults to December of the previous year', () => {
  assert.deepEqual(previousRentPeriod('2026-01-10'), {
    mois: 'Décembre',
    annee: 2025,
    value: '2025-12',
  });
});
