'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isNoSubscriptionCompanyName, noSubscriptionValueForCompany } = require('../src/companyPolicy');

test('Nouvel Afric company names are treated as no-subscription accounts', () => {
  assert.equal(isNoSubscriptionCompanyName('Nouvel Afric'), true);
  assert.equal(isNoSubscriptionCompanyName('NOUVEL AFRIK'), true);
  assert.equal(isNoSubscriptionCompanyName('Nouvelle Afrique'), true);
  assert.equal(isNoSubscriptionCompanyName('  Les Nouvelles Afrique  '), true);
});

test('regular companies keep the normal subscription flow', () => {
  assert.equal(isNoSubscriptionCompanyName('Immobilier du Golfe'), false);
  assert.equal(isNoSubscriptionCompanyName('Agence Koffi'), false);
  assert.equal(isNoSubscriptionCompanyName(''), false);
});

test('no-subscription flag maps directly to the companies.illimite storage value', () => {
  assert.equal(noSubscriptionValueForCompany('Nouvel Afric'), 1);
  assert.equal(noSubscriptionValueForCompany('Immobilier du Golfe'), 0);
});
