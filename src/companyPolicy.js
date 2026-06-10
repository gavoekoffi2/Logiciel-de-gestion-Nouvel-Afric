'use strict';

/**
 * Règles métier spéciales liées au type de compte entreprise.
 *
 * Certaines entreprises internes doivent utiliser le logiciel comme un produit
 * classique : pas d'écran abonnement, pas d'essai, pas de notion "illimité"
 * visible côté utilisateur. En base, on réutilise `companies.illimite = 1`
 * uniquement comme mécanisme technique pour que l'accès reste actif.
 */

function normalizeCompanyName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isNoSubscriptionCompanyName(value) {
  const name = normalizeCompanyName(value);
  if (!name) return false;

  // Couvre les variantes entendues/utilisées : Nouvel Afric, Nouvel Afrik,
  // Nouvelle Afrique, Les Nouvelles Afrique, etc.
  const hasNew = /\b(nouvel|nouvelle|nouvelles)\b/.test(name);
  const hasAfrica = /\b(afric|afrik|afrique|africa)\b/.test(name);
  return hasNew && hasAfrica;
}

function noSubscriptionValueForCompany(value) {
  return isNoSubscriptionCompanyName(value) ? 1 : 0;
}

module.exports = {
  normalizeCompanyName,
  isNoSubscriptionCompanyName,
  noSubscriptionValueForCompany,
};
