// =========================================================================
// app.js — point d'entree : chargement session, navigation, routage
// =========================================================================
import { api, store, icon, toast } from './core.js';
import * as dashboard from './views/dashboard.js';
import * as proprietaires from './views/proprietaires.js';
import * as maisons from './views/maisons.js';
import * as locataires from './views/locataires.js';
import * as souscriptions from './views/souscriptions.js';
import * as reglements from './views/reglements.js';
import * as parametres from './views/parametres.js';

const ROUTES = {
  dashboard:     { label: 'Tableau de bord', icon: 'dashboard',     mod: dashboard },
  proprietaires: { label: 'Propriétaires',   icon: 'owners',        mod: proprietaires },
  maisons:       { label: 'Maisons / Biens', icon: 'houses',        mod: maisons },
  locataires:    { label: 'Locataires',      icon: 'tenants',       mod: locataires },
  souscriptions: { label: 'Souscriptions',   icon: 'subscriptions', mod: souscriptions },
  reglements:    { label: 'Règlements',      icon: 'payments',      mod: reglements },
  parametres:    { label: 'Paramètres',      icon: 'settings',      mod: parametres, adminOnly: true },
};

const NAV_ORDER = ['dashboard', 'proprietaires', 'maisons', 'locataires', 'souscriptions', 'reglements'];

function buildNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  NAV_ORDER.forEach((key) => nav.appendChild(navLink(key)));
  if (store.user.role === 'admin') {
    nav.appendChild(navSep('Administration'));
    nav.appendChild(navLink('parametres'));
  }
}
function navSep(text) {
  const d = document.createElement('div');
  d.className = 'nav-sep';
  d.textContent = text;
  return d;
}
function navLink(key) {
  const r = ROUTES[key];
  const a = document.createElement('a');
  a.dataset.route = key;
  a.innerHTML = `${icon(r.icon)}<span>${r.label}</span>`;
  a.onclick = () => { location.hash = '#/' + key; };
  return a;
}

async function renderRoute() {
  let key = (location.hash.replace(/^#\//, '') || 'dashboard').split('?')[0];
  if (!ROUTES[key] || (ROUTES[key].adminOnly && store.user.role !== 'admin')) key = 'dashboard';

  document.querySelectorAll('.nav a').forEach((a) =>
    a.classList.toggle('active', a.dataset.route === key));
  document.getElementById('pageTitle').textContent = ROUTES[key].label;
  closeSidebar();

  const content = document.getElementById('content');
  content.innerHTML = '<div class="spinner"></div>';
  try {
    await ROUTES[key].mod.render();
  } catch (err) {
    content.innerHTML = `<div class="alert alert-error">${err.message || 'Erreur de chargement'}</div>`;
  }
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
  try {
    const [me, settings] = await Promise.all([api.get('/api/auth/me'), api.get('/api/settings')]);
    store.user = me.user;
    store.settings = settings;
  } catch {
    window.location.href = '/login';
    return;
  }

  // En-tete utilisateur
  document.getElementById('userName').textContent = store.user.nom || store.user.username;
  document.getElementById('userRole').textContent = store.user.role === 'admin' ? 'Administrateur' : 'Secrétaire';
  document.getElementById('userAvatar').textContent =
    (store.user.nom || store.user.username).trim().charAt(0).toUpperCase();
  document.querySelector('.sidebar-brand b').textContent = store.settings.entreprise || 'NOUVEL AFRIC';

  buildNav();

  document.getElementById('logoutBtn').onclick = async () => {
    await api.post('/api/auth/logout');
    window.location.href = '/login';
  };
  document.getElementById('burger').onclick = openSidebar;
  document.getElementById('backdrop').onclick = closeSidebar;

  window.addEventListener('hashchange', renderRoute);
  if (!location.hash) location.hash = '#/dashboard';
  await renderRoute();
}

// Petit utilitaire global pour rafraichir l'en-tete apres modif des parametres.
window.refreshBrand = () => {
  document.querySelector('.sidebar-brand b').textContent = store.settings.entreprise || 'NOUVEL AFRIC';
};

init();
