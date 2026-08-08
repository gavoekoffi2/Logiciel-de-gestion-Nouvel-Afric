'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMonthValue,
  normalizeRange,
  periodInRange,
  paymentAmountsInRange,
} = require('../src/periodRange');

test('normalise un mois précis et une plage mensuelle inclusive', () => {
  assert.deepEqual(parseMonthValue('2026-08'), { annee: 2026, mois: 'Août', index: 24319 });
  const range = normalizeRange({ from: '2026-06', to: '2026-08' });
  assert.equal(range.fromValue, '2026-06');
  assert.equal(range.toValue, '2026-08');
  assert.equal(range.monthCount, 3);
  assert.equal(periodInRange({ mois: 'Juillet', annee: 2026 }, range), true);
  assert.equal(periodInRange({ mois: 'Mai', annee: 2026 }, range), false);
});

test('préserve l’identité comptable et recalcule le statut de chaque tranche', () => {
  const payment = {
    mois_concerne: 'Janvier', annee_concernee: 2026,
    mois_payes: JSON.stringify([
      { mois: 'Janvier', annee: 2026 }, { mois: 'Février', annee: 2026 }, { mois: 'Mars', annee: 2026 },
    ]),
    montant_a_payer: 100, montant_paye: 50, reste_a_payer: 50, statut: 'Non soldé',
  };
  const monthly = ['2026-01', '2026-02', '2026-03'].map((value) =>
    paymentAmountsInRange(payment, normalizeRange({ from: value, to: value })));
  for (const item of monthly) assert.equal(item.reste_a_payer, item.montant_a_payer - item.montant_paye);
  assert.deepEqual(monthly.map((x) => [x.montant_a_payer, x.montant_paye, x.reste_a_payer]), [
    [34, 17, 17], [33, 17, 16], [33, 16, 17],
  ]);
  assert.equal(monthly.reduce((sum, x) => sum + x.reste_a_payer, 0), 50);
  assert.ok(monthly.every((x) => x.statut === 'Non soldé'));
});
