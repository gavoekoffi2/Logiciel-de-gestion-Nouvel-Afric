'use strict';

const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

function collectionDate(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year >= 1900 && month >= 1 && month <= 12) return new Date(year, month - 1, 1);
  }
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function previousRentPeriod(paymentDate = new Date()) {
  const date = collectionDate(paymentDate);
  const previous = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  const annee = previous.getFullYear();
  const monthNumber = previous.getMonth() + 1;
  return {
    mois: MOIS[monthNumber - 1],
    annee,
    value: `${annee}-${String(monthNumber).padStart(2, '0')}`,
  };
}

module.exports = { previousRentPeriod };
