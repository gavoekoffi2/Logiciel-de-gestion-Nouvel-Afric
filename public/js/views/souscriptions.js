import { api, icon, el, escapeHtml, dataTable, formModal, confirmDialog, toast, badge, fmt, pageHeader, printDocument, docHeader, codeCell, store } from '../core.js';

const FEE_LABELS = ['Gardiennage', 'Entretien', 'Eau', 'WC', 'Ordures', 'Nettoyage', 'Sécurité'];
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
function feesPayload(v) {
  const fees = collectFees(v);
  return { autre_frais: fees.length ? JSON.stringify(fees) : '', montant_autre_frais: fees.reduce((a, f) => a + f.montant, 0) };
}
function feesTotal(v) { return collectFees(v).reduce((a, f) => a + f.montant, 0); }
function displayFees(raw) {
  const fees = parseFees(raw);
  if (!fees.length) return '—';
  return fees.map((f) => `${escapeHtml(f.libelle)}${f.montant ? ': ' + fmt.money(f.montant) : ''}`).join('<br>');
}
function applyTenantFees(tenant, set) {
  const fees = parseFees(tenant && tenant.autre_frais);
  FEE_LABELS.forEach((label) => set(`fee_${label}`, 0));
  set('fee_autre_label', '');
  set('fee_autre_montant', 0);
  fees.forEach((f) => {
    if (FEE_LABELS.includes(f.libelle)) set(`fee_${f.libelle}`, f.montant || 0);
    else { set('fee_autre_label', f.libelle || ''); set('fee_autre_montant', f.montant || 0); }
  });
  const total = fees.reduce((a, f) => a + (Number(f.montant) || 0), 0);
  set('montant_autre_frais', total);
  set('autre_frais', fees.length ? JSON.stringify(fees) : '');
}

export async function render() {
  let q = '';
  const root = el(`
    <div>
      <div class="toolbar">
        <div class="search">${icon('search', 17)}<input type="text" id="search" placeholder="Rechercher (code, bien, locataire…)" /></div>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="addBtn">${icon('plus', 17)} Nouvelle souscription</button>
      </div>
      <div id="list"></div>
    </div>`);
  pageHeader(root);
  const listBox = root.querySelector('#list');

  async function load() {
    listBox.innerHTML = '<div class="spinner"></div>';
    const rows = await api.get('/api/subscriptions' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    listBox.innerHTML = '';
    listBox.appendChild(dataTable({
      columns: [
        { label: 'Code', render: (r) => codeCell(r.code) },
        { label: 'Bien', render: (r) => codeCell(r.property_code) },
        { label: 'Locataire', render: (r) => `<b>${escapeHtml(r.tenant_nom || '—')}</b>` },
        { label: 'Loyer', num: true, render: (r) => fmt.money(r.montant_loyer) },
        { label: 'Caution', num: true, render: (r) => fmt.money(r.montant_caution) },
        { label: 'Avance', num: true, render: (r) => fmt.money(r.montant_avance) },
        { label: 'Garantie', num: true, render: (r) => fmt.money(r.montant_garantie) },
        { label: 'Entrée', render: (r) => fmt.date(r.date_entree) },
        { label: 'Statut', render: (r) => badge(r.statut, r.statut === 'Active' ? 'green' : 'gray') },
      ],
      rows,
      actions: [
        { title: "Imprimer la fiche d'identification", icon: 'print', variant: 'btn-ghost', onClick: (r) => printFiche(r.id) },
        { title: 'Modifier', icon: 'edit', onClick: (r) => openForm(r) },
        { title: 'Supprimer', icon: 'trash', onClick: (r) => remove(r) },
      ],
      empty: 'Aucune souscription enregistrée.',
    }));
  }

  async function openForm(row) {
    const [props, tenants] = await Promise.all([
      api.get('/api/properties/available' + (row ? `?current=${row.property_id}` : '')),
      api.get('/api/tenants'),
    ]);
    if (props.length === 0) { toast('Aucun bien disponible. Ajoutez un bien ou libérez-en un.', 'error'); return; }
    if (tenants.length === 0) { toast('Veuillez d’abord enregistrer un locataire.', 'error'); return; }
    const propMap = Object.fromEntries(props.map((p) => [String(p.id), p]));
    const tenantMap = Object.fromEntries(tenants.map((t) => [String(t.id), t]));

    const defaults = {
      date_souscription: fmt.today(), date_entree: fmt.today(), date_debut_paiement: fmt.today(),
      nombre_mois_caution: 2, nombre_mois_avance: 2, nombre_mois_garantie: 0, montant_autre_frais: 0, statut: 'Active',
    };
    const values = row ? feesToFormValues(row) : defaults;
    formModal({
      title: row ? 'Modifier la souscription' : 'Nouvelle souscription',
      size: 'lg',
      fields: [
        { name: 'property_id', label: 'Bien (maison)', type: 'select', required: true,
          options: props.map((p) => ({ value: p.id, label: `${p.code} — ${fmt.money(p.cout_loyer)}` })) },
        { name: 'tenant_id', label: 'Locataire', type: 'select', required: true,
          options: tenants.map((t) => ({ value: t.id, label: t.nom_prenoms })) },
        { name: 'date_souscription', label: 'Date de souscription', type: 'date' },
        { name: 'montant_loyer', label: 'Montant du loyer', type: 'number', required: true, min: 1, step: 1000, hint: 'Modifiable : chaque locataire peut avoir son propre loyer.' },
        { name: 'nombre_mois_caution', label: 'Nombre de mois de caution', type: 'number', min: 0, hint: 'Indicatif : le montant reste saisissable librement.' },
        { name: 'montant_caution', label: 'Montant caution', type: 'number', min: 0, step: 1000, hint: 'À saisir manuellement.' },
        { name: 'nombre_mois_avance', label: 'Nombre de mois d’avance', type: 'number', min: 0, hint: 'Indicatif : le montant reste saisissable librement.' },
        { name: 'montant_avance', label: 'Montant avance', type: 'number', min: 0, step: 1000, hint: 'À saisir manuellement.' },
        { name: 'nombre_mois_garantie', label: 'Nombre de mois de garantie', type: 'number', min: 0, hint: 'Indicatif : le montant reste saisissable librement.' },
        { name: 'montant_garantie', label: 'Montant garantie', type: 'number', min: 0, step: 1000, hint: 'À saisir manuellement.' },
        ...FEE_LABELS.map((label) => ({ name: `fee_${label}`, label: `${label} — montant`, type: 'number', min: 0, step: 500 })),
        { name: 'fee_autre_label', label: 'Autre frais — libellé' },
        { name: 'fee_autre_montant', label: 'Autre frais — montant', type: 'number', min: 0, step: 500 },
        { name: 'montant_autre_frais', label: 'Total autres frais', type: 'number', readonly: true },
        { name: 'autre_frais', label: 'Autres frais JSON', type: 'hidden' },
        { name: 'date_entree', label: 'Date d’entrée', type: 'date', required: true },
        { name: 'date_debut_paiement', label: 'Date début de paiement', type: 'date', required: true },
        { name: 'statut', label: 'Statut', type: 'select', options: ['Active', 'Desactive'] },
      ],
      values,
      onChange: (v, changed, set) => {
        if (changed === 'property_id') {
          const p = propMap[String(v.property_id)];
          if (p) { set('montant_loyer', p.cout_loyer); v.montant_loyer = p.cout_loyer; }
        }
        if (changed === 'tenant_id') {
          applyTenantFees(tenantMap[String(v.tenant_id)], set);
        }
        const loyer = Number(v.montant_loyer) || 0;
        if (!row && changed === 'property_id') {
          set('montant_caution', (Number(v.nombre_mois_caution) || 0) * loyer);
          set('montant_avance', (Number(v.nombre_mois_avance) || 0) * loyer);
          set('montant_garantie', (Number(v.nombre_mois_garantie) || 0) * loyer);
        }
        set('montant_autre_frais', feesTotal(v));
      },
      onSubmit: async (v) => {
        const payload = { ...v, ...feesPayload(v) };
        const saved = row ? await api.put('/api/subscriptions/' + row.id, payload) : await api.post('/api/subscriptions', payload);
        toast(row ? 'Souscription modifiée.' : 'Souscription enregistrée.');
        load();
        if (!row && saved && saved.id) {
          setTimeout(async () => {
            const ok = await confirmDialog({ title: "Formulaire d'identification du locataire", okLabel: 'Imprimer',
              message: "Souhaitez-vous imprimer le formulaire d'identification du locataire ?" });
            if (ok) printFiche(saved.id);
          }, 200);
        }
      },
    });
  }

  async function remove(row) {
    const ok = await confirmDialog({ title: 'Supprimer la souscription', danger: true, okLabel: 'Supprimer',
      message: `Supprimer la souscription « ${row.code} » ? Les règlements liés ne seront plus rattachés.` });
    if (!ok) return;
    await api.del('/api/subscriptions/' + row.id);
    toast('Souscription supprimée.');
    load();
  }

  root.querySelector('#addBtn').onclick = () => openForm(null);
  let timer;
  root.querySelector('#search').addEventListener('input', (e) => { q = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(load, 250); });
  await load();
}

// ---------- Impression de la fiche d'identification du locataire --------
// (anciennement « contrat » : sans aucune information sur le propriétaire)
export async function printFiche(id) {
  const s = await api.get('/api/subscriptions/' + id);
  const total = (s.montant_caution || 0) + (s.montant_avance || 0) + (s.montant_garantie || 0) + (s.montant_autre_frais || 0);
  const row = (k, v) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`;
  const body = `
    ${docHeader()}
    <h2 class="doc-title">FORMULAIRE D’IDENTIFICATION DU LOCATAIRE</h2>
    <h3 style="margin:8px 0 4px;color:#0b5740">Locataire</h3>
    <table class="kv">
      ${row('Nom et prénoms', `<b>${escapeHtml(s.tenant_nom || '—')}</b>`)}
      ${row('Contact', escapeHtml(s.tenant_contact || '—'))}
    </table>
    <h3 style="margin:18px 0 4px;color:#0b5740">Bien loué</h3>
    <table class="kv">
      ${row('Identifiant de la souscription', `<span style="font-family:monospace">${escapeHtml(s.code)}</span>`)}
      ${row('Identifiant du bien', `<span style="font-family:monospace">${escapeHtml(s.property_code || '—')}</span>`)}
      ${row('Type de bien', escapeHtml(s.type_construction || '—'))}
      ${row('Désignation', escapeHtml(s.designation || '—'))}
      ${row('Coût du loyer', fmt.money(s.montant_loyer))}
    </table>
    <h3 style="margin:18px 0 4px;color:#0b5740">Conditions financières</h3>
    <table class="kv">
      ${row('Nombre de mois de caution', s.nombre_mois_caution ?? 0)}
      ${row('Montant caution', fmt.money(s.montant_caution))}
      ${row('Nombre de mois d’avance', s.nombre_mois_avance ?? 0)}
      ${row('Montant avance', fmt.money(s.montant_avance))}
      ${row('Nombre de mois de garantie', s.nombre_mois_garantie ?? 0)}
      ${row('Montant garantie', fmt.money(s.montant_garantie))}
      ${row('Autres frais', displayFees(s.autre_frais))}
      ${row('Montant autres frais', fmt.money(s.montant_autre_frais))}
      <tr class="montant-fort"><td class="k"><b>Montant total payé par le locataire</b></td><td class="v">${fmt.money(total)}</td></tr>
    </table>
    <h3 style="margin:18px 0 4px;color:#0b5740">Dates</h3>
    <table class="kv">
      ${row('Date de souscription', fmt.date(s.date_souscription))}
      ${row('Date d’entrée dans le logement', fmt.date(s.date_entree))}
      ${row('Date de début de paiement', fmt.date(s.date_debut_paiement))}
    </table>
    <div class="sign">
      <div><div class="line"></div>SIGNATURE DU LOCATAIRE</div>
      <div><div class="line"></div>SIGNATURE (${escapeHtml(store.settings.entreprise || 'NOUVEL AFRIC')})</div>
    </div>`;
  printDocument("Fiche d’identification — " + s.code, body);
}
