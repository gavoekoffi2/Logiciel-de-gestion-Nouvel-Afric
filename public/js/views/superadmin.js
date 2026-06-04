// Espace SUPER-ADMINISTRATEUR : entreprises, parametres plateforme, compte.
import {
  api, el, escapeHtml, dataTable, formModal, confirmDialog, toast, badge, icon, store, pageHeader,
} from '../core.js';

function frDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}
function money(n, dev) {
  return (Math.round(Number(n) || 0)).toLocaleString('fr-FR').replace(/ /g, ' ') + ' ' + (dev || 'FCFA');
}

const STATE = {
  actif:    { label: 'Actif',    variant: 'green' },
  essai:    { label: 'Essai',    variant: 'amber' },
  expire:   { label: 'Expiré',   variant: 'red' },
  suspendu: { label: 'Suspendu', variant: 'gray' },
};

// =========================================================================
// ENTREPRISES
// =========================================================================
async function renderCompanies() {
  let q = '';
  const root = el(`
    <div>
      <div class="stats-grid grid" id="stats" style="margin-bottom:18px"></div>
      <div class="toolbar">
        <div class="search">${icon('search', 17)}<input type="text" id="search" placeholder="Rechercher (entreprise, e-mail…)" /></div>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="addBtn">${icon('plus', 17)} Ajouter une entreprise</button>
      </div>
      <div id="list"></div>
    </div>`);
  pageHeader(root);

  const statsBox = root.querySelector('#stats');
  const listBox = root.querySelector('#list');

  async function loadStats() {
    const s = await api.get('/api/platform/stats');
    const card = (v, l, ic, cls) => `<div class="stat"><div class="ic ${cls}">${icon(ic, 22)}</div><div><div class="v">${v}</div><div class="l">${l}</div></div></div>`;
    statsBox.innerHTML =
      card(s.total, 'Entreprises', 'building', 'ic-brand') +
      card(s.actives, 'Actives', 'collect', 'ic-green') +
      card(s.essais, 'En essai', 'wallet', 'ic-amber') +
      card(s.expirees + s.suspendues, 'Expirées / suspendues', 'inbox', 'ic-red') +
      card(s.demandes, 'Demandes en attente', 'money', 'ic-blue');
  }

  function actionsCell(row) {
    const box = el('<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end"></div>');
    const mk = (label, cls, fn) => { const b = el(`<button class="btn btn-sm ${cls}">${label}</button>`); b.onclick = fn; box.appendChild(b); };

    mk(row.statut_effectif === 'actif' ? '+1 an' : 'Activer', 'btn-primary', () => activer(row));
    if (row.illimite) mk('Retirer ∞', 'btn-ghost', () => illimite(row, false));
    else mk('∞ Illimité', 'btn-accent', () => illimite(row, true));
    if (row.statut_effectif === 'suspendu') mk('Réactiver', 'btn-ghost', () => simpleAction(row, 'reactiver', 'Entreprise réactivée.'));
    else mk('Suspendre', 'btn-ghost', () => suspendre(row));
    const edit = el(`<button class="btn btn-icon btn-sm btn-ghost" title="Modifier">${icon('edit', 15)}</button>`); edit.onclick = () => openEdit(row); box.appendChild(edit);
    const del = el(`<button class="btn btn-icon btn-sm btn-ghost" title="Supprimer">${icon('trash', 15)}</button>`); del.onclick = () => remove(row); box.appendChild(del);
    return box;
  }

  async function load() {
    listBox.innerHTML = '<div class="spinner"></div>';
    const rows = await api.get('/api/platform/companies' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    listBox.innerHTML = '';
    listBox.appendChild(dataTable({
      columns: [
        { label: 'Entreprise', render: (r) => `<b>${escapeHtml(r.nom)}</b>${r.demande_le ? ' &nbsp;<span class="badge badge-blue">Demande</span>' : ''}` },
        { label: 'Admin (e-mail)', render: (r) => escapeHtml(r.admin_email || '—') },
        { label: 'Statut', render: (r) => (r.illimite ? badge('Illimité', 'blue') : badge((STATE[r.statut_effectif] || STATE.expire).label, (STATE[r.statut_effectif] || STATE.expire).variant)) },
        { label: 'Échéance', render: (r) => (r.illimite ? '∞' : frDate(r.echeance)) },
        { label: 'Jours', num: true, render: (r) => (r.illimite ? '∞' : (r.actif ? r.jours_restants : '—')) },
        { label: 'Biens', num: true, render: (r) => r.nb_biens },
        { label: 'Actions', render: (r) => actionsCell(r) },
      ],
      rows,
      empty: 'Aucune entreprise pour le moment.',
    }));
  }

  async function activer(row) {
    const ok = await confirmDialog({
      title: 'Activer l’abonnement',
      okLabel: 'Activer (1 an)',
      message: `Activer / prolonger l’abonnement de « ${row.nom} » d’un an ?`,
    });
    if (!ok) return;
    try { await api.post(`/api/platform/companies/${row.id}/activer`, { annees: 1 }); toast('Abonnement activé (+1 an).'); load(); loadStats(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function suspendre(row) {
    const ok = await confirmDialog({ title: 'Suspendre', danger: true, okLabel: 'Suspendre', message: `Bloquer l’accès de « ${row.nom} » ?` });
    if (!ok) return;
    simpleAction(row, 'suspendre', 'Entreprise suspendue.');
  }
  async function simpleAction(row, action, msg) {
    try { await api.post(`/api/platform/companies/${row.id}/${action}`); toast(msg); load(); loadStats(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function illimite(row, on) {
    const ok = await confirmDialog({
      title: on ? 'Abonnement illimité' : 'Retirer l’illimité',
      okLabel: on ? 'Accorder l’illimité' : 'Retirer',
      danger: !on,
      message: on
        ? `Accorder un abonnement ILLIMITÉ (à vie, sans échéance) à « ${row.nom} » ?`
        : `Retirer l’abonnement illimité de « ${row.nom} » ? Son accès dépendra de nouveau de son échéance.`,
    });
    if (!ok) return;
    try { await api.post(`/api/platform/companies/${row.id}/illimite`, { on }); toast(on ? 'Abonnement illimité accordé.' : 'Illimité retiré.'); load(); loadStats(); }
    catch (e) { toast(e.message, 'error'); }
  }

  function openCreate() {
    formModal({
      title: 'Nouvelle entreprise',
      size: 'lg',
      fields: [
        { name: 'entreprise', label: 'Nom de l’entreprise', required: true, col: 2 },
        { name: 'nom', label: 'Nom de l’administrateur', required: true },
        { name: 'telephone', label: 'Téléphone', placeholder: '+228 90 12 34 56' },
        { name: 'email', label: 'E-mail (connexion admin)', required: true },
        { name: 'password', label: 'Mot de passe', required: true, hint: '6 caractères minimum.' },
        { name: 'statut', label: 'État de départ', type: 'select', options: [
          { value: 'essai', label: 'Essai gratuit' }, { value: 'actif', label: 'Actif (1 an)' }] },
      ],
      values: { statut: 'essai' },
      onSubmit: async (v) => { await api.post('/api/platform/companies', v); toast('Entreprise créée.'); load(); loadStats(); },
    });
  }

  function openEdit(row) {
    formModal({
      title: `Modifier « ${row.nom} »`,
      size: 'lg',
      fields: [
        { name: 'entreprise', label: 'Nom de l’entreprise', required: true, col: 2 },
        { name: 'telephone', label: 'Téléphone' },
        { name: 'email', label: 'E-mail de l’entreprise' },
        { name: 'adresse', label: 'Adresse', col: 2 },
        { name: 'new_password', label: 'Nouveau mot de passe admin', hint: 'Laisser vide pour ne pas changer.' },
      ],
      values: { entreprise: row.nom, telephone: row.telephone || '', email: row.email || '', adresse: row.adresse || '' },
      onSubmit: async (v) => {
        await api.put(`/api/platform/companies/${row.id}`, v);
        if (v.new_password) await api.post(`/api/platform/companies/${row.id}/admin-password`, { password: v.new_password });
        toast('Entreprise modifiée.'); load();
      },
    });
  }

  async function remove(row) {
    const ok = await confirmDialog({
      title: 'Supprimer l’entreprise', danger: true, okLabel: 'Supprimer définitivement',
      message: `Supprimer « ${row.nom} » et TOUTES ses données (utilisateurs, biens, locataires, paiements) ? Action irréversible.`,
    });
    if (!ok) return;
    try { await api.del(`/api/platform/companies/${row.id}`); toast('Entreprise supprimée.'); load(); loadStats(); }
    catch (e) { toast(e.message, 'error'); }
  }

  root.querySelector('#addBtn').onclick = openCreate;
  let timer;
  root.querySelector('#search').addEventListener('input', (e) => { q = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(load, 250); });

  await Promise.all([loadStats(), load()]);
}

// =========================================================================
// PARAMETRES DE LA PLATEFORME
// =========================================================================
async function renderPlatform() {
  const p = await api.get('/api/platform/settings');
  const root = el(`
    <div class="grid" style="grid-template-columns:1fr;gap:18px;max-width:760px">
      <div class="card card-pad">
        <h3 style="font-size:16px;margin-bottom:4px">Coordonnées affichées aux entreprises</h3>
        <p class="muted" style="margin:0 0 16px;font-size:13px">Ces informations apparaissent sur l’écran « Mon abonnement » des entreprises pour qu’elles vous contactent et paient.</p>
        <form id="pf" class="form-grid">
          <div class="field col-2"><label>Nom de la plateforme</label><input name="nom" /></div>
          <div class="field"><label>Téléphone</label><input name="contact_telephone" placeholder="+228 90 00 00 00" /></div>
          <div class="field"><label>WhatsApp</label><input name="contact_whatsapp" placeholder="+228 90 00 00 00" /></div>
          <div class="field"><label>E-mail</label><input name="contact_email" placeholder="contact@nouvelafric.tg" /></div>
          <div class="field"><label>Devise</label><input name="devise" placeholder="FCFA" /></div>
          <div class="field"><label>Prix de l’abonnement annuel</label><input type="number" name="prix_annuel" min="0" step="500" /></div>
          <div class="field col-2"><label>Message d’abonnement</label><textarea name="message" placeholder="Instructions de paiement / message affiché aux entreprises"></textarea></div>
          <div class="col-2" style="text-align:right"><button class="btn btn-primary" type="submit">${icon('settings', 16)} Enregistrer</button></div>
        </form>
      </div>
    </div>`);
  pageHeader(root);

  const form = root.querySelector('#pf');
  ['nom', 'contact_telephone', 'contact_whatsapp', 'contact_email', 'devise', 'prix_annuel', 'message'].forEach((k) => {
    if (form.elements[k]) form.elements[k].value = p[k] != null ? p[k] : '';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      nom: form.elements.nom.value,
      contact_telephone: form.elements.contact_telephone.value,
      contact_whatsapp: form.elements.contact_whatsapp.value,
      contact_email: form.elements.contact_email.value,
      devise: form.elements.devise.value,
      prix_annuel: form.elements.prix_annuel.value,
      message: form.elements.message.value,
    };
    try { await api.put('/api/platform/settings', body); toast('Paramètres enregistrés.'); }
    catch (err) { toast(err.message, 'error'); }
  });
}

// =========================================================================
// MON COMPTE (super-admin)
// =========================================================================
async function renderAccount() {
  const root = el(`
    <div class="grid" style="grid-template-columns:1fr;gap:18px;max-width:560px">
      <div class="card card-pad">
        <h3 style="font-size:16px;margin-bottom:10px">Mon compte</h3>
        <p style="margin:0 0 4px"><span class="muted">E-mail :</span> <b>${escapeHtml(store.user.email || '—')}</b></p>
        <p style="margin:0"><span class="muted">Rôle :</span> Super-administrateur</p>
      </div>
      <div class="card card-pad">
        <h3 style="font-size:16px;margin-bottom:12px">Changer mon mot de passe</h3>
        <form id="pwdForm" class="form-grid">
          <div class="field"><label>Mot de passe actuel</label><input type="password" name="current" autocomplete="current-password" /></div>
          <div class="field"><label>Nouveau mot de passe</label><input type="password" name="password" autocomplete="new-password" /></div>
          <div class="col-2" style="text-align:right"><button class="btn btn-primary" type="submit">Enregistrer</button></div>
        </form>
      </div>
    </div>`);
  pageHeader(root);

  const pwdForm = root.querySelector('#pwdForm');
  pwdForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/auth/password', { current: pwdForm.elements.current.value, password: pwdForm.elements.password.value });
      toast('Mot de passe modifié.');
      pwdForm.reset();
    } catch (err) { toast(err.message, 'error'); }
  });
}

export const companies = { render: renderCompanies };
export const platform = { render: renderPlatform };
export const account = { render: renderAccount };
