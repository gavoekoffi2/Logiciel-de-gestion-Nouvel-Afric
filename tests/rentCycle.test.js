'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  previousRentPeriod, lastDuePeriod, isPeriodDue, clampToDuePeriod, isPeriodTooFarAhead,
} = require('../src/rentCycle');
const { normalizeRange, dueMonthValue } = require('../src/periodRange');

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

test('the last due rent period is always the previous calendar month', () => {
  const due = lastDuePeriod('2026-08-31');
  assert.equal(due.mois, 'Juillet');
  assert.equal(due.annee, 2026);
  assert.equal(due.monthNumber, 7);
  assert.equal(due.value, '2026-07');
  assert.equal(due.label, 'Juillet 2026');
});

test('the running month is never due, the previous one always is', () => {
  const ref = '2026-08-15';
  assert.equal(isPeriodDue({ mois: 'Juillet', annee: 2026 }, ref), true);
  assert.equal(isPeriodDue({ mois: 'Août', annee: 2026 }, ref), false);
  assert.equal(isPeriodDue({ mois: 'Septembre', annee: 2026 }, ref), false);
  // Un mois ancien reste exigible tant qu'il n'est pas payé.
  assert.equal(isPeriodDue({ mois: 'Décembre', annee: 2025 }, ref), true);
});

test('a period is clamped down to the last due month, never up', () => {
  const ref = '2026-08-15';
  assert.equal(clampToDuePeriod({ mois: 'Août', annee: 2026 }, ref).value, '2026-07');
  assert.equal(clampToDuePeriod({ mois: 'Décembre', annee: 2027 }, ref).value, '2026-07');
  assert.equal(clampToDuePeriod({ mois: 'Mars', annee: 2026 }, ref).value, '2026-03');
  // Une période illisible retombe sur le dernier mois exigible.
  assert.equal(clampToDuePeriod({ mois: 'Inconnu', annee: 0 }, ref).value, '2026-07');
});

test('an advance stays possible but a mistyped year is rejected', () => {
  const ref = '2026-08-15';
  assert.equal(isPeriodTooFarAhead({ mois: 'Décembre', annee: 2026 }, ref), false);
  assert.equal(isPeriodTooFarAhead({ mois: 'Juillet', annee: 2027 }, ref), false);
  assert.equal(isPeriodTooFarAhead({ mois: 'Août', annee: 2027 }, ref), true);
  assert.equal(isPeriodTooFarAhead({ mois: 'Janvier', annee: 2062 }, ref), true);
});

test('« mois courant » means the month being collected, not the running month', () => {
  const ref = new Date(2026, 7, 15); // 15 août 2026
  const range = normalizeRange({ mode: 'current' }, { ref });
  assert.equal(range.fromValue, '2026-07');
  assert.equal(range.toValue, '2026-07');
  assert.equal(dueMonthValue(ref), '2026-07');
});

test('a stale client cannot force the running month through the current filter', () => {
  const ref = new Date(2026, 7, 15);
  // Onglet resté ouvert depuis juillet : il envoie encore from/to = 2026-08.
  const range = normalizeRange({ mode: 'current', from: '2026-08', to: '2026-08' }, { ref });
  assert.equal(range.fromValue, '2026-07');
  assert.equal(range.toValue, '2026-07');
});

test('« depuis janvier » stops on the last due month', () => {
  const ref = new Date(2026, 7, 15);
  const range = normalizeRange({ mode: 'ytd' }, { ref });
  assert.equal(range.fromValue, '2026-01');
  assert.equal(range.toValue, '2026-07');
  assert.equal(range.monthCount, 7);
});

test('in January the year-to-date range covers the closed rent year', () => {
  const ref = new Date(2026, 0, 10); // 10 janvier 2026 : on recouvre décembre 2025
  const range = normalizeRange({ mode: 'ytd' }, { ref });
  assert.equal(range.fromValue, '2025-01');
  assert.equal(range.toValue, '2025-12');
});

test('an explicit month range is honoured as typed', () => {
  const ref = new Date(2026, 7, 15);
  const range = normalizeRange({ mode: 'range', from: '2026-02', to: '2026-05' }, { ref });
  assert.equal(range.fromValue, '2026-02');
  assert.equal(range.toValue, '2026-05');
});
