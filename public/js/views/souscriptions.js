import { api, icon, el, escapeHtml, dataTable, formModal, confirmDialog, toast, badge, fmt, pageHeader, printDocument, docHeader, codeCell } from '../core.js';

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
        { label: 'Entrée', render: (r) => fmt.date(r.date_entree) },
        { label: 'Statut', render: (r) => badge(r.statut, r.statut === 'Active' ? 'green' : 'gray') },
      ],
      rows,
      actions: [
        { title: 'Imprimer le contrat', icon: 'print', variant: 'btn-ghost', onClick: (r) => printContrat(r.id) },
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

    formModal({
      title: row ? 'Modifier la souscription' : 'Nouvelle souscription',
      size: 'lg',
      fields: [
        { name: 'property_id', label: 'Bien (maison)', type: 'select', required: true,
          options: props.map((p) => ({ value: p.id, label: `${p.code} — ${fmt.money(p.cout_loyer)}` })) },
        { name: 'tenant_id', label: 'Locataire', type: 'select', required: true,
          options: tenants.map((t) => ({ value: t.id, label: t.nom_prenoms })) },
        { name: 'date_souscription', label: 'Date de souscription', type: 'date' },
        { name: 'montant_loyer', label: 'Montant du loyer', type: 'number', readonly: true },
        { name: 'nombre_mois_caution', label: 'Nombre de mois de caution', type: 'number', min: 0 },
        { name: 'montant_caution', label: 'Montant caution', type: 'number', readonly: true },
        { name: 'nombre_mois_avance', label: 'Nombre de mois d’avance', type: 'number', min: 0 },
        { name: 'montant_avance', label: 'Montant avance', type: 'number', readonly: true },
        { name: 'autre_frais', label: 'Autres frais (libellé)', placeholder: 'ex. Garage' },
        { name: 'montant_autre_frais', label: 'Montant autres frais', type: 'number', min: 0 },
        { name: 'date_entree', label: 'Date d’entrée', type: 'date', required: true },
        { name: 'date_debut_paiement', label: 'Date début de paiement', type: 'date', required: true },
        { name: 'statut', label: 'Statut', type: 'select', options: ['Active', 'Desactive'] },
      ],
      values: row || {
        date_souscription: fmt.today(), date_entree: fmt.today(), date_debut_paiement: fmt.today(),
        nombre_mois_caution: 2, nombre_mois_avance: 2, montant_autre_frais: 0, statut: 'Active',
      },
      onChange: (v, changed, set) => {
        if (changed === 'property_id') {
          const p = propMap[String(v.property_id)];
          if (p) { set('montant_loyer', p.cout_loyer); v.montant_loyer = p.cout_loyer; }
        }
        const loyer = Number(v.montant_loyer) || 0;
        set('montant_caution', (Number(v.nombre_mois_caution) || 0) * loyer);
        set('montant_avance', (Number(v.nombre_mois_avance) || 0) * loyer);
      },
      onSubmit: async (v) => {
        const saved = row ? await api.put('/api/subscriptions/' + row.id, v) : await api.post('/api/subscriptions', v);
        toast(row ? 'Souscription modifiée.' : 'Souscription enregistrée.');
        load();
        if (!row && saved && saved.id) {
          setTimeout(async () => {
            const ok = await confirmDialog({ title: 'Contrat de location', okLabel: 'Imprimer',
              message: 'Souhaitez-vous imprimer le contrat de location ?' });
            if (ok) printContrat(saved.id);
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

// ---------- Impression du contrat de location ---------------------------
export async function printContrat(id) {
  const s = await api.get('/api/subscriptions/' + id);
  const total = (s.montant_caution || 0) + (s.montant_avance || 0) + (s.montant_autre_frais || 0);
  const row = (k, v) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`;
  const body = `
    ${docHeader()}
    <h2 class="doc-title">CONTRAT DE LOCATION</h2>
    <table class="kv">
      ${row('Identifiant de la souscription', `<span style="font-family:monospace">${escapeHtml(s.code)}</span>`)}
      ${row('Identifiant du bien', `<span style="font-family:monospace">${escapeHtml(s.property_code || '—')}</span>`)}
      ${row('Type de construction', escapeHtml(s.type_construction || '—'))}
      ${row('Nombre de pièces', s.nombre_piece ?? '—')}
      ${row('Coût du loyer', fmt.money(s.montant_loyer))}
    </table>
    <h3 style="margin:18px 0 4px;color:#0b5740">Propriétaire</h3>
    <table class="kv">
      ${row('Nom et prénoms', escapeHtml(s.owner_nom || '—'))}
      ${row('Contact', escapeHtml(s.owner_contact || '—'))}
    </table>
    <h3 style="margin:18px 0 4px;color:#0b5740">Locataire</h3>
    <table class="kv">
      ${row('Nom et prénoms', escapeHtml(s.tenant_nom || '—'))}
      ${row('Contact', escapeHtml(s.tenant_contact || '—'))}
    </table>
    <h3 style="margin:18px 0 4px;color:#0b5740">Conditions financières</h3>
    <table class="kv">
      ${row('Nombre de mois de caution', s.nombre_mois_caution ?? 0)}
      ${row('Montant caution', fmt.money(s.montant_caution))}
      ${row('Nombre de mois d’avance', s.nombre_mois_avance ?? 0)}
      ${row('Montant avance', fmt.money(s.montant_avance))}
      ${row('Autres frais', escapeHtml(s.autre_frais || '—'))}
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
      <div><div class="line"></div>SIGNATURE DU PROPRIÉTAIRE</div>
    </div>`;
  printDocument('Contrat de location — ' + s.code, body);
}
