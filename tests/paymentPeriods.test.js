const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePaidMonths, buildPaidMonthMap, summarizeRecoveryMonths } = require('../src/paymentPeriods');

test('normalizePaidMonths keeps explicit paid months and exposes the first month for legacy filters', () => {
  const result = normalizePaidMonths({
    mois_payes: ['Janvier', 'Février'],
    annee_concernee: 2026,
    montant_a_payer: 100000,
    montant_paye: 200000,
    loyer: 100000,
  });
  assert.deepEqual(result.months, [
    { mois: 'Janvier', annee: 2026 },
    { mois: 'Février', annee: 2026 },
  ]);
  assert.equal(result.count, 2);
  assert.equal(result.primary.mois, 'Janvier');
  assert.equal(result.amountDue, 200000);
  assert.equal(result.status, 'Soldé');
});

test('normalizePaidMonths treats explicit total due as total, not as monthly unit', () => {
  const result = normalizePaidMonths({
    mois_payes: [{ mois: 'Janvier', annee: 2026 }, { mois: 'Février', annee: 2026 }],
    montant_a_payer: 150000,
    montant_paye: 150000,
  });
  assert.equal(result.count, 2);
  assert.equal(result.amountDue, 150000);
  assert.equal(result.reste, 0);
  assert.equal(result.status, 'Soldé');
});

test('normalizePaidMonths accepts one-franc rounding difference without requiring users to add 1', () => {
  const result = normalizePaidMonths({
    mois_payes: [{ mois: 'Janvier', annee: 2026 }],
    montant_a_payer: 100000,
    montant_paye: 99999,
  });
  assert.equal(result.amountDue, 100000);
  assert.equal(result.reste, 0);
  assert.equal(result.status, 'Soldé');
});

test('summarizeRecoveryMonths marks month paid when it is short by only one franc', () => {
  const expected = [{ mois: 'Janvier', annee: 2026 }];
  const paymentMap = buildPaidMonthMap([
    { subscription_id: 8, mois_payes: JSON.stringify([{ mois: 'Janvier', annee: 2026 }]), montant_paye: 99999, numero_recu: 'R1' },
  ]);
  const summary = summarizeRecoveryMonths(expected, paymentMap.get(8), 100000);
  assert.equal(summary.mois_payes, 1);
  assert.equal(summary.mois_dus, 0);
  assert.equal(summary.ecart, 0);
});

test('summarizeRecoveryMonths accounts for partial payment: 3 due months, 1 paid month leaves 2 months due', () => {
  const expected = [
    { mois: 'Janvier', annee: 2026 },
    { mois: 'Février', annee: 2026 },
    { mois: 'Mars', annee: 2026 },
  ];
  const paymentMap = buildPaidMonthMap([
    { subscription_id: 7, mois_payes: JSON.stringify([{ mois: 'Janvier', annee: 2026 }]), montant_paye: 100000, numero_recu: 'R1' },
  ]);
  const summary = summarizeRecoveryMonths(expected, paymentMap.get(7), 100000);
  assert.equal(summary.mois_payes, 1);
  assert.deepEqual(summary.mois_payes_liste, ['Janvier 2026']);
  assert.equal(summary.mois_dus, 2);
  assert.deepEqual(summary.mois_dus_liste, ['Février 2026', 'Mars 2026']);
  assert.equal(summary.montant_du, 300000);
  assert.equal(summary.montant_paye, 100000);
  assert.equal(summary.ecart, 200000);
});

test('advance payment burns future months: 6 months paid and 3 months elapsed leaves 3 months credit', () => {
  const expected = [
    { mois: 'Janvier', annee: 2026 },
    { mois: 'Février', annee: 2026 },
    { mois: 'Mars', annee: 2026 },
  ];
  const paymentMap = buildPaidMonthMap([
    { subscription_id: 9, mois_payes: JSON.stringify([
      { mois: 'Janvier', annee: 2026 }, { mois: 'Février', annee: 2026 }, { mois: 'Mars', annee: 2026 },
      { mois: 'Avril', annee: 2026 }, { mois: 'Mai', annee: 2026 }, { mois: 'Juin', annee: 2026 },
    ]), montant_paye: 600000, numero_recu: 'R2' },
  ]);
  const summary = summarizeRecoveryMonths(expected, paymentMap.get(9), 100000);
  assert.equal(summary.mois_payes, 3);
  assert.equal(summary.mois_dus, 0);
  assert.equal(summary.mois_credit, 3);
  assert.deepEqual(summary.mois_credit_liste, ['Avril 2026', 'Mai 2026', 'Juin 2026']);
  assert.equal(summary.ecart, 0);
});
