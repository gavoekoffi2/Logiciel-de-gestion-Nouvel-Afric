import { api, icon, el, escapeHtml, dataTable, formModal, confirmDialog, toast, badge, fmt, pageHeader, MOIS } from '../core.js';

const FEE_LABELS = ['Gardiennage', 'Entretien', 'Eau', 'WC', 'Ordures', 'Nettoyage', 'Sécurité'];

function feeFields() {
  return [
    ...FEE_LABELS.map((label) => ({ name: `fee_${label}`, label: `${label} — montant`, type: 'number', min: 0, step: 1 })),
    { name: 'fee_autre_label', label: 'Autre frais — libellé' },
    { name: 'fee_autre_montant', label: 'Autre frais — montant', type: 'number', min: 0, step: 1 },
    { name: 'montant_autre_frais', label: 'Total autres frais', type: 'number', readonly: true },
    { name: 'autre_frais', label: 'Autres frais JSON', type: 'hidden' },
  ];
}

function collectFees(v) {
  const fees = [];
  FEE_LABELS.forEach((label) => {
    const montant = Number(v[`fee_${label}`]) || 0;
    if (montant > 0) fees.push({ libelle: label, montant });
  });
  const otherLabel = String(v.fee_autre_label || '').trim();
  const otherAmount = Number(v.fee_autre_montant) || 0;
  if (otherLabel && otherAmount > 0) fees.push({ libelle: otherLabel, montant: otherAmount });
  return fees;
}
function parseFees(raw) {
  if (!raw) return [];
  try { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr; } catch (_) { /* ancien format */ }
  return raw ? [{ libelle: String(raw), montant: 0 }] : [];
}
function feesToFormValues(row) {
  const out = { ...(row || {}) };
  parseFees(row && row.autre_frais).forEach((f) => {
    if (FEE_LABELS.includes(f.libelle)) out[`fee_${f.libelle}`] = f.montant || 0;
    else { out.fee_autre_label = f.libelle || ''; out.fee_autre_montant = f.montant || 0; }
  });
  return out;
}
function feesTotal(v) { return collectFees(v).reduce((a, f) => a + f.montant, 0); }
function serializeFees(v) {
  const fees = collectFees(v);
  return { autre_frais: fees.length ? JSON.stringify(fees) : '', montant_autre_frais: fees.reduce((a, f) => a + f.montant, 0) };
}
function displayFees(raw) {
  if (!raw) return '—';
  const arr = parseFees(raw);
  if (arr.length) return arr.map((f) => `${escapeHtml(f.libelle)}${f.montant ? ': ' + fmt.money(f.montant) : ''}`).join('<br>');
  return escapeHtml(raw);
}
function miniStat(label, value, danger) {
  return `<div style="background:#f8fafc;border:1px solid #eef2f6;border-radius:10px;padding:10px 12px">
    <div style="font-size:16px;font-weight:800;${danger ? 'color:#b91c1c' : 'color:#0f172a'}">${value}</div>
    <div style="font-size:12px;color:#64748b">${escapeHtml(label)}</div>
  </div>`;
}

export async function render() {
  let q = '';
  const root = el(`
    <div>
      <div class="toolbar">
        <div class="search">${icon('search', 17)}<input type="text" id="search" placeholder="Rechercher un locataire ou son bien…" /></div>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="addBtn">${icon('plus', 17)} Ajouter un locataire</button>
      </div>
      <div id="list"></div>
    </div>`);
  pageHeader(root);
  const listBox = root.querySelector('#list');

  async function load() {
    listBox.innerHTML = '<div class="spinner"></div>';
    const rows = await api.get('/api/tenants' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    listBox.innerHTML = '';
    listBox.appendChild(dataTable({
      columns: [
        { label: 'Nom & prénoms', render: (r) => `<b>${escapeHtml(r.nom_prenoms)}</b>` },
        { label: 'Contact', render: (r) => escapeHtml(r.contact || '—') },
        { label: 'Bien actuel', render: (r) => r.active_property_code ? `${codeCell(r.active_property_code)}<br><span class="muted">${escapeHtml(r.active_property_type || '')}${r.active_property_designation ? ' — ' + escapeHtml(r.active_property_designation) : ''}</span>` : '<span class="muted">Aucun bien actif</span>' },
        { label: 'Loyer', num: true, render: (r) => r.active_property_loyer ? fmt.money(r.active_property_loyer) : '—' },
        { label: 'Frais prévus', render: (r) => displayFees(r.autre_frais) },
        { label: 'Caution', num: true, render: (r) => fmt.money(r.caution || 0) },
      ],
      rows,
      actions: [
        { title: 'Entrer dans le locataire', icon: 'eye', variant: 'btn-primary', onClick: (r) => { location.hash = '#/locataire?id=' + r.id; } },
        { title: 'Modifier', icon: 'edit', onClick: (r) => openForm(r) },
        { title: 'Supprimer', icon: 'trash', variant: 'btn-ghost', onClick: (r) => remove(r) },
      ],
      empty: 'Aucun locataire enregistré.',
    }));
  }

  async function openForm(row) {
    const fields = [
      { name: 'nom_prenoms', label: 'Nom et prénoms', required: true, col: 2 },
      { name: 'contact', label: 'Contact (téléphone)', required: true },
      { name: 'email', label: 'Email' },
      { name: 'adresse', label: 'Adresse', type: 'textarea' },
      { name: 'caution', label: 'Caution enregistrée sur la fiche locataire', type: 'number', min: 0, step: 1 },
      ...feeFields(),
    ];
    if (!row) {
      fields.push(
        { name: 'date_souscription', label: 'Date de souscription', type: 'date' },
        { name: 'montant_loyer', label: 'Montant du loyer', type: 'number', readonly: true },
        { name: 'nombre_mois_caution', label: 'Nombre de mois de caution', type: 'number', min: 0 },
        { name: 'montant_caution', label: 'Montant caution', type: 'number', readonly: true },
        { name: 'nombre_mois_garantie', label: 'Nombre de mois de garantie', type: 'number', min: 0 },
        { name: 'montant_garantie', label: 'Montant garantie', type: 'number', readonly: true },
        { name: 'nombre_mois_avance', label: 'Nombre de mois d’avance', type: 'number', min: 0 },
        { name: 'montant_avance', label: 'Montant avance', type: 'number', readonly: true },
        { name: 'date_entree', label: 'Date d’entrée', type: 'date', required: true },
        { name: 'date_debut_paiement', label: 'Date début de paiement', type: 'date', required: true },
        { name: 'statut', label: 'Statut du bail', type: 'select', options: ['Active', 'Desactive'] },
      );
    }
    const initial = row ? feesToFormValues(row) : {
      date_souscription: fmt.today(), date_entree: fmt.today(), date_debut_paiement: fmt.today(),
      nombre_mois_caution: 2, nombre_mois_avance: 2, nombre_mois_garantie: 0,
      montant_autre_frais: 0, statut: 'Active',
    };
    formModal({
      title: row ? 'Modifier le locataire' : 'Nouveau locataire',
      size: 'lg',
      fields,
      values: initial,
      onChange: (v, changed, set) => {
        const loyer = Number(v.montant_loyer) || 0;
        if (!row) {
          set('montant_caution', (Number(v.nombre_mois_caution) || 0) * loyer);
          set('montant_avance', (Number(v.nombre_mois_avance) || 0) * loyer);
          set('montant_garantie', (Number(v.nombre_mois_garantie) || 0) * loyer);
        }
        set('montant_autre_frais', feesTotal(v));
      },
      onSubmit: async (v) => {
        const payload = { ...v, ...serializeFees(v) };
        if (row) await api.put('/api/tenants/' + row.id, payload);
        else await api.post('/api/tenants', payload);
        toast(row ? 'Locataire modifié.' : 'Locataire ajouté.');
        load();
      },
    });
  }

  async function remove(row) {
    const ok = await confirmDialog({ title: 'Supprimer le locataire', danger: true, okLabel: 'Supprimer', message: `Supprimer « ${row.nom_prenoms} » ?` });
    if (!ok) return;
    try {
      await api.del('/api/tenants/' + row.id);
      toast('Locataire supprimé.');
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  root.querySelector('#addBtn').onclick = () => openForm(null);
  let timer;
  root.querySelector('#search').addEventListener('input', (e) => { q = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(load, 250); });
  await load();
}

export async function renderDetail() {
  const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
  if (!id) { location.hash = '#/locataires'; return; }
  const content = document.getElementById('content');
  content.innerHTML = '<div class="spinner"></div>';
  let data;
  try { data = await api.get('/api/tenants/' + id + '/details'); }
  catch (e) { content.innerHTML = `<div class="alert alert-error">${escapeHtml(e.message)}</div>`; return; }
  const t = data.tenant;
  const subs = data.subscriptions || [];
  const payments = data.payments || [];
  const totals = data.totals || {};
  const root = el(`
    <div>
      <button class="btn btn-ghost btn-sm" id="back" style="margin-bottom:12px">${icon('back', 16)} Retour aux locataires</button>
      <div class="card card-pad" style="margin-bottom:16px;background:linear-gradient(135deg,#f8fafc,#ffffff);border:1px solid #e2e8f0">
        <div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;font-weight:800">Fiche complète du locataire</div>
        <h2 style="font-size:21px;margin:5px 0 4px;color:#0f172a">${icon('tenants', 22)} ${escapeHtml(t.nom_prenoms)}</h2>
        <div class="muted">${escapeHtml(t.contact || '—')} ${t.email ? ' · ' + escapeHtml(t.email) : ''}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-top:16px">
          ${miniStat('Baux / biens liés', fmt.int(subs.length))}
          ${miniStat('Loyers payés', fmt.money(totals.loyers_payes))}
          ${miniStat('Reste à payer', fmt.money(totals.reste_a_payer), totals.reste_a_payer > 0)}
          ${miniStat('Cautions', fmt.money(totals.cautions))}
          ${miniStat('Avances', fmt.money(totals.avances))}
          ${miniStat('Autres frais', fmt.money(totals.autres_frais))}
        </div>
      </div>
      <h3 style="font-size:16px;margin:18px 0 10px">Biens / souscriptions de ce locataire</h3>
      <div id="subs"></div>
      <h3 style="font-size:16px;margin:18px 0 10px">Paiements du locataire</h3>
      <div id="payments"></div>
    </div>`);
  pageHeader(root);
  root.querySelector('#back').onclick = () => { location.hash = '#/locataires'; };
  root.querySelector('#subs').appendChild(dataTable({
    columns: [
      { label: 'Bien', render: (s) => `${codeCell(s.property_code)}<br><span class="muted">${escapeHtml(s.type_construction || '')}${s.designation ? ' — ' + escapeHtml(s.designation) : ''}</span>` },
      { label: 'Loyer', num: true, render: (s) => fmt.money(s.montant_loyer) },
      { label: 'Caution', num: true, render: (s) => fmt.money(s.montant_caution) },
      { label: 'Avance', num: true, render: (s) => fmt.money(s.montant_avance) },
      { label: 'Autres frais', render: (s) => displayFees(s.autre_frais) },
      { label: 'Total frais', num: true, render: (s) => fmt.money(s.montant_autre_frais) },
      { label: 'Statut', render: (s) => badge(s.statut, s.statut === 'Active' ? 'green' : 'gray') },
    ],
    rows: subs,
    actions: [{ title: 'Voir le bien', icon: 'houses', variant: 'btn-ghost', onClick: (s) => { location.hash = '#/bien?id=' + s.property_id; } }],
    empty: 'Aucun bien lié à ce locataire.',
  }));
  root.querySelector('#payments').appendChild(dataTable({
    columns: [
      { label: 'Bien', render: (p) => codeCell(p.property_code) },
      { label: 'Période', render: (p) => `${escapeHtml(p.mois_concerne || '—')} ${p.annee_concernee || ''}` },
      { label: 'Date', render: (p) => fmt.date(p.date) },
      { label: 'Payé', num: true, render: (p) => fmt.money(p.montant_paye) },
      { label: 'Reste', num: true, render: (p) => p.reste_a_payer > 0 ? `<b style="color:#b91c1c">${fmt.money(p.reste_a_payer)}</b>` : fmt.money(0) },
      { label: 'Statut', render: (p) => badge(p.statut, p.statut === 'Soldé' ? 'green' : 'red') },
    ],
    rows: payments,
    empty: 'Aucun paiement enregistré pour ce locataire.',
  }));
}

function codeCell(code) {
  return `<span style="font-family:monospace;font-weight:700">${escapeHtml(code || '—')}</span>`;
}
