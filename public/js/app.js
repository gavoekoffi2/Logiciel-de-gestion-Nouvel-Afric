// =========================================================================
// app.js — point d'entree : session, navigation, routage
//   3 modes : super-administrateur · entreprise active · entreprise bloquee
// =========================================================================
import { api, store, icon } from './core.js';
import * as dashboard from './views/dashboard.js';
import * as proprietaires from './views/proprietaires.js';
import * as maisons from './views/maisons.js';
import * as maisonDetail from './views/maisonDetail.js';
import * as quartiers from './views/quartiers.js';
import * as locataires from './views/locataires.js';
import * as souscriptions from './views/souscriptions.js';
import * as reglements from './views/reglements.js';
import * as reversements from './views/reversements.js';
import * as recouvrement from './views/recouvrement.js';
import * as parametres from './views/parametres.js';
import * as journal from './views/journal.js';
import * as abonnement from './views/abonnement.js';
import * as sauvegardes from './views/sauvegardes.js';
import * as superadmin from './views/superadmin.js';

// Routes des utilisateurs d'entreprise.
const ROUTES = {
  dashboard:     { label: 'Tableau de bord', icon: 'dashboard',     mod: dashboard },
  proprietaires: { label: 'Propriétaires',   icon: 'owners',        mod: proprietaires },
  maisons:       { label: 'Maisons / Biens', icon: 'houses',        mod: maisons },
  bien:          { label: 'Détail du bien',  icon: 'houses',        mod: maisonDetail },
  quartiers:     { label: 'Quartiers',       icon: 'houses',        mod: quartiers },
  locataires:    { label: 'Locataires',      icon: 'tenants',       mod: locataires },
  locataire:     { label: 'Détail du locataire', icon: 'tenants',    mod: { render: locataires.renderDetail } },
  souscriptions: { label: 'Souscriptions',   icon: 'subscriptions', mod: souscriptions },
  reglements:    { label: 'Règlements',      icon: 'payments',      mod: reglements },
  recouvrement:  { label: 'Recouvrement',    icon: 'collect',       mod: recouvrement },
  reversements:  { label: 'Reversements',    icon: 'money',         mod: reversements },
  abonnement:    { label: 'Mon abonnement',  icon: 'wallet',        mod: abonnement },
  sauvegardes:   { label: 'Sauvegardes',     icon: 'inbox',         mod: sauvegardes, adminOnly: true },
  parametres:    { label: 'Paramètres',      icon: 'settings',      mod: parametres, adminOnly: true },
  journal:       { label: 'Journal d’activité', icon: 'clock',      mod: journal, adminOnly: true },
};
const NAV_ORDER = ['dashboard', 'proprietaires', 'maisons', 'quartiers', 'locataires', 'souscriptions', 'reglements', 'recouvrement', 'reversements'];

// Routes du super-administrateur.
const SUPER_ROUTES = {
  entreprises:  { label: 'Entreprises',  icon: 'building',  mod: superadmin.companies },
  plateforme:   { label: 'Plateforme',   icon: 'settings',  mod: superadmin.platform },
  sauvegardes:  { label: 'Sauvegardes',  icon: 'inbox',     mod: superadmin.backups },
  compte:       { label: 'Mon compte',   icon: 'users',     mod: superadmin.account },
};
const SUPER_NAV = ['entreprises', 'plateforme', 'sauvegardes', 'compte'];

const routesFor = () => (store.isSuper ? SUPER_ROUTES : ROUTES);
const blocked = () => !store.isSuper && store.company && !store.company.actif;
const noSubscriptionAccount = () => !store.isSuper && store.company && store.company.no_subscription;

// ---------- Navigation ---------------------------------------------------
function buildNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  if (store.isSuper) {
    SUPER_NAV.forEach((k) => nav.appendChild(navLink(k)));
    return;
  }
  if (blocked()) { nav.appendChild(navLink('abonnement')); return; }
  NAV_ORDER.forEach((k) => nav.appendChild(navLink(k)));
  if (store.user.role === 'admin') {
    nav.appendChild(navSep('Administration'));
    if (!noSubscriptionAccount()) nav.appendChild(navLink('abonnement'));
    nav.appendChild(navLink('sauvegardes'));
    nav.appendChild(navLink('parametres'));
    nav.appendChild(navLink('journal'));
  }
}
function navSep(text) {
  const d = document.createElement('div');
  d.className = 'nav-sep';
  d.textContent = text;
  return d;
}
// Libelle d'une route — pour un compte illimite classique, "Mon abonnement" devient "Mon compte".
function labelFor(key) {
  if (key === 'abonnement' && store.company && store.company.illimite && !store.company.no_subscription) return 'Mon compte';
  return routesFor()[key].label;
}
function navLink(key) {
  const r = routesFor()[key];
  const a = document.createElement('a');
  a.dataset.route = key;
  a.innerHTML = `${icon(r.icon)}<span>${labelFor(key)}</span>`;
  a.onclick = () => { location.hash = '#/' + key; };
  return a;
}

async function renderRoute() {
  const routes = routesFor();
  const def = store.isSuper ? 'entreprises' : 'dashboard';
  let key = (location.hash.replace(/^#\//, '') || def).split('?')[0];

  // Entreprise bloquee : on force l'ecran d'abonnement.
  if (blocked()) key = 'abonnement';
  // Compte interne sans abonnement : meme si l'URL est saisie a la main, on ne
  // montre jamais l'ecran abonnement.
  if (key === 'abonnement' && noSubscriptionAccount()) key = def;
  if (!routes[key]) key = def;
  if (routes[key].adminOnly && store.user.role !== 'admin') key = def;

  document.querySelectorAll('.nav a').forEach((a) =>
    a.classList.toggle('active', a.dataset.route === key));
  document.getElementById('pageTitle').textContent = labelFor(key);
  closeSidebar();

  const content = document.getElementById('content');
  content.innerHTML = '<div class="spinner"></div>';
  try {
    await routes[key].mod.render();
  } catch (err) {
    if (err && err.code === 'subscription') return; // gere par __subscriptionBlocked
    content.innerHTML = `<div class="alert alert-error">${err.message || 'Erreur de chargement'}</div>`;
  }
}

// ---------- Bandeau d'abonnement (essai / expiration proche) -------------
function renderBanner() {
  let bar = document.getElementById('subBanner');
  if (bar) bar.remove();
  if (store.isSuper || !store.company) return;
  if (noSubscriptionAccount()) return;
  const c = store.company;
  let html = '';
  if (c.statut_effectif === 'essai') {
    html = `Essai gratuit — <b>${c.jours_restants} jour(s)</b> restant(s). `
      + `<a href="#/abonnement">Passer à l’abonnement annuel</a>.`;
  } else if (c.statut_effectif === 'actif' && !c.illimite && typeof c.jours_restants === 'number' && c.jours_restants <= 15) {
    html = `Votre abonnement expire dans <b>${c.jours_restants} jour(s)</b>. `
      + `<a href="#/abonnement">Renouveler</a>.`;
  }
  if (!html) return;
  bar = document.createElement('div');
  bar.id = 'subBanner';
  bar.style.cssText = 'background:#fef3c7;color:#92400e;padding:9px 22px;font-size:13.5px;'
    + 'font-weight:600;border-bottom:1px solid #fde68a;text-align:center';
  bar.innerHTML = html;
  const main = document.querySelector('.main');
  const topbar = document.querySelector('.topbar');
  main.insertBefore(bar, topbar.nextSibling);
}

// ---------- Menu mobile --------------------------------------------------
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('backdrop').style.display = 'block';
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('backdrop').style.display = 'none';
}

// ---------- Initialisation ----------------------------------------------
async function init() {
  let me;
  try {
    me = await api.get('/api/auth/me');
  } catch {
    window.location.href = '/login';
    return;
  }
  store.user = me.user;
  store.company = me.company || null;
  store.isSuper = me.user.role === 'superadmin';

  if (store.isSuper) {
    store.settings = { entreprise: 'Administration', devise: 'FCFA' };
  } else {
    try { store.settings = await api.get('/api/settings'); }
    catch { store.settings = { entreprise: (store.company && store.company.nom) || 'NOUVEL AFRIC', devise: 'FCFA' }; }
  }

  // En-tete utilisateur
  const displayName = store.user.nom || store.user.email || '—';
  document.getElementById('userName').textContent = displayName;
  const RLAB = { admin: 'Administrateur', assistant: 'Assistant', secretaire: 'Secrétaire' };
  document.getElementById('userRole').textContent =
    store.isSuper ? 'Super-administrateur' : (RLAB[store.user.role] || 'Secrétaire');
  document.getElementById('userAvatar').textContent = displayName.trim().charAt(0).toUpperCase();
  applyBranding();

  buildNav();

  document.getElementById('logoutBtn').onclick = async () => {
    try { await api.post('/api/auth/logout'); } catch (_) { /* ignore */ }
    window.location.href = '/login';
  };
  document.getElementById('burger').onclick = openSidebar;
  document.getElementById('backdrop').onclick = closeSidebar;

  // Blocage d'abonnement detecte lors d'un appel API metier.
  window.__subscriptionBlocked = () => {
    if (store.company) store.company.actif = false;
    buildNav();
    if (location.hash !== '#/abonnement') location.hash = '#/abonnement';
    else renderRoute();
  };

  window.addEventListener('hashchange', renderRoute);

  if (blocked()) location.hash = '#/abonnement';
  else if (!location.hash) location.hash = store.isSuper ? '#/entreprises' : '#/dashboard';

  renderBanner();
  await renderRoute();
}

// Applique le nom + le logo dans la barre laterale.
function applyBranding() {
  const b = document.querySelector('.sidebar-brand b');
  const sub = document.querySelector('.sidebar-brand span');
  const img = document.querySelector('.sidebar-brand .brand-mark');
  if (store.isSuper) {
    if (b) b.textContent = 'ADMINISTRATION';
    if (sub) sub.textContent = 'Plateforme';
    if (img) img.src = '/assets/logo.svg';
    return;
  }
  if (b) b.textContent = store.settings.entreprise || 'NOUVEL AFRIC';
  if (sub) sub.textContent = 'Gestion locative';
  if (img) img.src = store.settings.logo || '/assets/logo.svg';
}
// Rafraichit l'en-tete apres modification des parametres.
window.refreshBrand = applyBranding;

init();
