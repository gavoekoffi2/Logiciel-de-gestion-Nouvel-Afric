import { api, icon, el, escapeHtml, dataTable, badge, fmt, pageHeader, formModal, openModal, confirmDialog, toast, MOIS } from '../core.js';

function miniStat(label, value, danger) {
  return `<div style="background:#f8fafc;border:1px solid #eef2f6;border-radius:12px;padding:12px">
    <div style="font-size:17px;font-weight:850;${danger ? 'color:#b91c1c' : 'color:#0f172a'}">${value}</div>
    <div style="font-size:12px;color:#64748b;margin-top:2px">${escapeHtml(label)}</div>
  </div>`;
}

function infoLine(label, value) {
  return `<div style="padding:8px 0;border-bottom:1px solid #f1f5f9">
    <div class="muted" style="font-size:12px">${escapeHtml(label)}</div>
    <div style="font-weight:650;color:#0f172a">${value || '—'}</div>
  </div>`;
}

function sectionTitle(title, subtitle = '') {
  return `<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:20px 0 10px">
    <div>
      <h3 style="font-size:16px;margin:0;color:#0f172a">${title}</h3>
      ${subtitle ? `<div class="muted" style="font-size:12.5px;margin-top:3px">${escapeHtml(subtitle)}</div>` : ''}
    </div>
  </div>`;
}

function displayFees(raw) {
  if (!raw) return '—';
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map((f) => `${escapeHtml(f.libelle)}: ${fmt.money(f.montant)}`).join(' · ');
  } catch (_) { /* ancien format texte */ }
  return escapeHtml(raw);
}

// Premier mois encore impaye (pour pre-remplir l'encaissement).
function nextUnpaid(s) {
  return (s.echeancier || []).find((m) => m.reste > 0) || null;
}

export async function render() {
  const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
  if (!id) { location.hash = '#/maisons'; return; }

  const content = document.getElementById('content');
  content.innerHTML = '<div class="spinner"></div>';
  let data;
  try { data = await api.get('/api/properties/' + id + '/details'); }
  catch (e) { content.innerHTML = `<div class="alert alert-error">${escapeHtml(e.message)}</div>`; return; }

  const p = data.property;
  const subs = data.subscriptions || [];
  const repairs = data.repairs || [];
  const payments = data.payments || [];
  const payouts = data.payouts || [];
  const totals = data.totals || {};
  const actifs = subs.filter((s) => s.statut === 'Active');
  const enRetard = actifs.filter((s) => s.resume && s.resume.mois_retard > 0).length;
  const totalAttendu = subs.reduce((a, s) => a + ((s.resume && s.resume.total_attendu) || 0), 0);
  const totalImpaye = actifs.reduce((a, s) => a + ((s.resume && s.resume.reste) || 0), 0);
  const locationText = [p.ville, p.commune, p.quartier].filter(Boolean).join(' · ') || '—';

  // Encaisser un loyer pour un bail, depuis la maison. presetMonth = échéance ciblée.
  function openEncaisser(s, presetMonth) {
    const loyer = s.montant_loyer || 0;
    const pm = presetMonth || nextUnpaid(s) || {};
    formModal({
      title: 'Encaisser un loyer — ' + (s.tenant_nom || ''),
      fields: [
        { name: 'mois_concerne', label: 'Mois concerné', type: 'select', required: true, options: MOIS },
        { name: 'annee_concernee', label: 'Année concernée', type: 'number', required: true },
        { name: 'montant_a_payer', label: 'Montant à payer', type: 'number', readonly: true },
        { name: 'montant_paye', label: 'Montant payé', type: 'number', required: true, min: 0 },
        { name: 'date', label: 'Date du paiement', type: 'date' },
        { name: 'numero_recu', label: 'N° de reçu', placeholder: 'ex. 269' },
      ],
      values: {
        mois_concerne: pm.mois || MOIS[new Date().getMonth()],
        annee_concernee: pm.annee || new Date().getFullYear(),
        montant_a_payer: loyer,
        montant_paye: pm.reste != null ? pm.reste : loyer,
        date: fmt.today(),
      },
      onSubmit: async (v) => {
        await api.post('/api/payments', { subscription_id: s.id, montant_a_payer: loyer, ...v });
        toast('Paiement enregistré.');
        render();
      },
    });
  }

  function openRepairForm() {
    formModal({
      title: 'Ajouter une dépense / réparation sur ce bien',
      fields: [
        { name: 'mois', label: 'Mois', type: 'select', options: MOIS, required: true },
        { name: 'annee', label: 'Année', type: 'number', required: true },
        { name: 'montant', label: 'Montant', type: 'number', min: 0, step: 1000, required: true },
        { name: 'description', label: 'Description', type: 'textarea', col: 2, placeholder: 'Ex. plomberie, peinture, serrure, rénovation…' },
      ],
      values: { mois: MOIS[new Date().getMonth()], annee: new Date().getFullYear() },
      submitLabel: 'Ajouter la dépense',
      onSubmit: async (v) => {
        await api.post('/api/repairs', { property_id: p.id, ...v });
        toast('Dépense ajoutée au bien.');
        render();
      },
    });
  }

  async function removeRepair(row) {
    const ok = await confirmDialog({
      title: 'Supprimer la dépense', danger: true, okLabel: 'Supprimer',
      message: `Supprimer cette dépense de ${fmt.money(row.montant)} ?`,
    });
    if (!ok) return;
    await api.del('/api/repairs/' + row.id);
    toast('Dépense supprimée.');
    render();
  }

  async function openAddTenants() {
    const tenants = await api.get('/api/tenants');
    const activeIds = new Set(actifs.map((s) => Number(s.tenant_id)));
    const available = tenants.filter((t) => !activeIds.has(Number(t.id)));
    if (!available.length) {
      toast('Aucun locataire disponible à ajouter dans cette maison.', 'error');
      return;
    }
    const rows = available.map((t) => `
      <tr>
        <td style="width:34px"><input type="checkbox" name="tenant" value="${t.id}" /></td>
        <td><b>${escapeHtml(t.nom_prenoms)}</b><br><span class="muted">${escapeHtml(t.contact || '—')}</span></td>
        <td><input type="number" name="loyer_${t.id}" min="1" step="1000" value="${Number(p.cout_loyer) || 0}" style="width:130px" /></td>
        <td><input type="number" name="caution_${t.id}" min="0" step="1000" value="0" style="width:130px" /></td>
        <td><input type="number" name="avance_${t.id}" min="0" step="1000" value="0" style="width:130px" /></td>
        <td><input type="number" name="garantie_${t.id}" min="0" step="1000" value="0" style="width:130px" /></td>
      </tr>`).join('');
    const { modal, close } = openModal(`
      <div class="modal-head"><h3>Ajouter des locataires dans cette maison</h3><button class="close" data-close>&times;</button></div>
      <form id="batchTenantForm">
        <div class="modal-body">
          <div id="batchError" class="alert alert-error" style="display:none"></div>
          <div class="form-grid" style="margin-bottom:14px">
            <div class="field"><label>Date de souscription</label><input type="date" name="date_souscription" value="${fmt.today()}" /></div>
            <div class="field"><label>Date d’entrée</label><input type="date" name="date_entree" value="${fmt.today()}" required /></div>
            <div class="field"><label>Date début de paiement</label><input type="date" name="date_debut_paiement" value="${fmt.today()}" required /></div>
            <div class="field"><label>Mois de caution</label><input type="number" name="nombre_mois_caution" min="0" value="0" /></div>
            <div class="field"><label>Mois d’avance</label><input type="number" name="nombre_mois_avance" min="0" value="0" /></div>
            <div class="field"><label>Mois de garantie</label><input type="number" name="nombre_mois_garantie" min="0" value="0" /></div>
          </div>
          <div class="hint" style="margin-bottom:10px">Cochez les locataires à affecter. Saisissez librement le loyer, la caution, l’avance et la garantie pour chaque locataire.</div>
          <div class="table-wrap"><table class="data"><thead><tr><th></th><th>Locataire</th><th class="num">Loyer</th><th class="num">Caution</th><th class="num">Avance</th><th class="num">Garantie</th></tr></thead><tbody>${rows}</tbody></table></div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn btn-ghost" data-close>Annuler</button>
          <button type="submit" class="btn btn-primary">Ajouter les locataires</button>
        </div>
      </form>`, { size: 'lg' });
    modal.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
    modal.querySelector('#batchTenantForm').onsubmit = async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const selected = [...form.querySelectorAll('input[name="tenant"]:checked')];
      const errBox = modal.querySelector('#batchError');
      errBox.style.display = 'none';
      if (!selected.length) {
        errBox.textContent = 'Veuillez sélectionner au moins un locataire.';
        errBox.style.display = 'block';
        return;
      }
      const tenantsPayload = selected.map((input) => {
        const tenantId = Number(input.value);
        return {
          tenant_id: tenantId,
          montant_loyer: Number(form.elements[`loyer_${tenantId}`].value) || 0,
          montant_caution: Number(form.elements[`caution_${tenantId}`].value) || 0,
          montant_avance: Number(form.elements[`avance_${tenantId}`].value) || 0,
          montant_garantie: Number(form.elements[`garantie_${tenantId}`].value) || 0,
        };
      });
      try {
        await api.post('/api/properties/' + p.id + '/tenants', {
          date_souscription: form.elements.date_souscription.value,
          date_entree: form.elements.date_entree.value,
          date_debut_paiement: form.elements.date_debut_paiement.value,
          nombre_mois_caution: Number(form.elements.nombre_mois_caution.value) || 0,
          nombre_mois_avance: Number(form.elements.nombre_mois_avance.value) || 0,
          nombre_mois_garantie: Number(form.elements.nombre_mois_garantie.value) || 0,
          tenants: tenantsPayload,
        });
        close();
        toast(selected.length + ' locataire(s) ajouté(s) à la maison.');
        render();
      } catch (err) {
        errBox.textContent = err.message || 'Erreur';
        errBox.style.display = 'block';
      }
    };
  }

  function renderSub(s) {
    const r = s.resume || { total_attendu: 0, total_paye: 0, reste: 0, mois_retard: 0 };
    const card = el('<div class="card card-pad" style="margin-bottom:14px;border-left:4px solid #2563eb"></div>');
    const retard = r.mois_retard > 0
      ? `<span class="badge badge-red">${r.mois_retard} mois en retard</span>`
      : '<span class="badge badge-green">À jour</span>';
    const head = el(`
      <div>
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:flex-start">
          <div>
            <div style="font-weight:850;font-size:15px">${icon('tenants', 16)} ${escapeHtml(s.tenant_nom || '—')}</div>
            <div class="muted" style="font-size:13px;line-height:1.6">
              Contact : ${escapeHtml(s.tenant_contact || '—')}<br>
              Bail <span style="font-family:monospace">${escapeHtml(s.code)}</span>
              · entrée ${fmt.date(s.date_entree)} · paiement depuis ${fmt.date(s.date_debut_paiement)}
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            ${badge(s.statut === 'Active' ? 'Bail actif' : 'Bail désactivé', s.statut === 'Active' ? 'green' : 'gray')}
            ${s.statut === 'Active' ? retard : ''}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px;margin:12px 0">
          ${miniStat('Loyer mensuel', fmt.money(s.montant_loyer))}
          ${miniStat('Caution', fmt.money(s.montant_caution))}
          ${miniStat('Avance', fmt.money(s.montant_avance))}
          ${miniStat('Garantie', fmt.money(s.montant_garantie))}
          ${miniStat('Total attendu', fmt.money(r.total_attendu))}
          ${miniStat('Total payé', fmt.money(r.total_paye))}
          ${miniStat('Reste dû', fmt.money(r.reste), r.reste > 0)}
        </div>
        ${s.autre_frais || s.montant_autre_frais ? `<div class="muted" style="font-size:13px;margin-bottom:10px">Autres frais : ${displayFees(s.autre_frais)} — total ${fmt.money(s.montant_autre_frais)}</div>` : ''}
      </div>`);
    card.appendChild(head);

    if (s.statut === 'Active') {
      const bar = el('<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"></div>');
      const encBtn = el(`<button class="btn btn-accent btn-sm">${icon('collect', 15)} Encaisser un loyer</button>`);
      encBtn.onclick = () => openEncaisser(s, null);
      bar.appendChild(encBtn);
      card.appendChild(bar);

      card.appendChild(dataTable({
        columns: [
          { label: 'Période', render: (m) => `${escapeHtml(m.mois)} ${m.annee}` },
          { label: 'Attendu', num: true, render: (m) => fmt.money(m.attendu) },
          { label: 'Payé', num: true, render: (m) => fmt.money(m.paye) },
          { label: 'Reste', num: true, render: (m) => (m.reste > 0 ? `<b style="color:#b91c1c">${fmt.money(m.reste)}</b>` : fmt.money(0)) },
          { label: 'Statut', render: (m) => badge(m.statut, m.statut === 'Payé' ? 'green' : (m.statut === 'Partiel' ? 'amber' : 'red')) },
        ],
        rows: s.echeancier || [],
        actions: [
          { title: 'Encaisser ce mois', icon: 'collect', variant: 'btn-accent', show: (m) => m.reste > 0, onClick: (m) => openEncaisser(s, m) },
        ],
        empty: 'Aucune échéance.',
      }));
    } else if ((s.paiements || []).length) {
      card.appendChild(dataTable({
        columns: [
          { label: 'Période', render: (m) => `${escapeHtml(m.mois_concerne || '—')} ${m.annee_concernee || ''}` },
          { label: 'Payé', num: true, render: (m) => fmt.money(m.montant_paye) },
          { label: 'Date', render: (m) => fmt.date(m.date) },
          { label: 'Statut', render: (m) => badge(m.statut, m.statut === 'Soldé' ? 'green' : 'red') },
        ],
        rows: s.paiements,
        empty: 'Aucun paiement.',
      }));
    } else {
      card.appendChild(el('<p class="muted" style="margin:0">Aucun paiement enregistré.</p>'));
    }
    return card;
  }

  const root = el(`
    <div>
      <button class="btn btn-ghost btn-sm" id="back" style="margin-bottom:12px">${icon('back', 16)} Retour aux biens</button>

      <div class="card card-pad" style="margin-bottom:16px;background:linear-gradient(135deg,#f8fafc,#ffffff);border:1px solid #e2e8f0">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px">
          <div>
            <div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;font-weight:800">Fiche complète du bien</div>
            <h2 style="font-size:21px;margin:5px 0 4px;color:#0f172a">${icon('houses', 22)} ${escapeHtml(p.type_construction || 'Bien')}${p.designation ? ' — ' + escapeHtml(p.designation) : ''}</h2>
            <div class="muted" style="font-size:13px">Code : <span style="font-family:monospace;font-weight:800;color:#0f172a">${escapeHtml(p.code)}</span></div>
          </div>
          <div style="display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" id="addTenantsTop">${icon('plus', 15)} Ajouter des locataires</button>
            ${badge(p.statut, p.statut === 'Occupé' ? 'amber' : 'green')}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-top:16px">
          ${miniStat('Locataires actifs', fmt.int(actifs.length))}
          ${miniStat('À jour / En retard', `${fmt.int(actifs.length - enRetard)} / ${fmt.int(enRetard)}`, enRetard > 0)}
          ${miniStat('Loyers attendus', fmt.money(totalAttendu))}
          ${miniStat('Loyers encaissés', fmt.money(totals.total_paye))}
          ${miniStat('Impayés', fmt.money(totalImpaye), totalImpaye > 0)}
          ${miniStat('Dépenses / travaux', fmt.money(totals.total_reparations))}
          ${miniStat('Net déjà reversé', fmt.money(totals.total_reversements_net))}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:16px">
        <div class="card card-pad">
          <h3 style="font-size:15px;margin:0 0 8px">Informations du bien</h3>
          ${infoLine('Désignation', escapeHtml(p.designation || '—'))}
          ${infoLine('Type / construction', escapeHtml(p.type_construction || '—'))}
          ${infoLine("Nombre d'appartement(s)", fmt.int(p.nombre_porte || 0))}
          ${infoLine('Loyer mensuel', fmt.money(p.cout_loyer))}
          ${infoLine('Commission agence', `${fmt.int(p.part_commission || 0)} %`)}
          ${infoLine('Localisation', escapeHtml(locationText))}
          ${infoLine('Observation', escapeHtml(p.observation || '—'))}
        </div>
        <div class="card card-pad">
          <h3 style="font-size:15px;margin:0 0 8px">Propriétaire du bien</h3>
          ${infoLine('Nom', escapeHtml(p.owner_nom || '—'))}
          ${infoLine('Contact', escapeHtml(p.owner_contact || '—'))}
          ${infoLine('E-mail', escapeHtml(p.owner_email || '—'))}
          ${infoLine('Adresse', escapeHtml(p.owner_adresse || '—'))}
          <div style="margin-top:12px" class="muted">Tout ce qui est encaissé sur ce bien est rattaché à ce propriétaire pour les reversements.</div>
        </div>
      </div>

      ${sectionTitle('Locataires, baux et paiements attendus', 'Chaque locataire lié à ce bien, avec son bail, son échéancier et ses retards.')}
      <div style="display:flex;justify-content:flex-end;margin:-4px 0 12px">
        <button class="btn btn-primary btn-sm" id="addTenants">${icon('plus', 15)} Ajouter des locataires</button>
      </div>
      <div id="subs"></div>

      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px">
        <div>${sectionTitle('Dépenses / réparations du bien', 'Travaux, réparations ou charges déduites du suivi du bien.')}</div>
        <button class="btn btn-primary btn-sm" id="addRepair">${icon('plus', 15)} Ajouter une dépense</button>
      </div>
      <div id="repairs"></div>

      ${sectionTitle('Historique complet des paiements du bien', 'Tous les encaissements enregistrés sur ce bien, tous locataires confondus.')}
      <div id="payments"></div>

      ${sectionTitle('Reversements liés à ce bien', 'Reversements propriétaire contenant au moins un paiement de ce bien.')}
      <div id="payouts"></div>
    </div>`);
  pageHeader(root);
  root.querySelector('#back').onclick = () => { location.hash = '#/maisons'; };
  root.querySelector('#addTenantsTop').onclick = openAddTenants;
  root.querySelector('#addTenants').onclick = openAddTenants;
  root.querySelector('#addRepair').onclick = openRepairForm;

  const subsBox = root.querySelector('#subs');
  if (!subs.length) {
    subsBox.innerHTML = '<div class="card card-pad"><p class="muted" style="margin:0">Aucune souscription (locataire) pour ce bien.</p></div>';
  } else {
    subs.forEach((s) => subsBox.appendChild(renderSub(s)));
  }

  root.querySelector('#repairs').appendChild(dataTable({
    columns: [
      { label: 'Période', render: (r) => `${escapeHtml(r.mois || '—')} ${r.annee || ''}` },
      { label: 'Montant', num: true, render: (r) => fmt.money(r.montant) },
      { label: 'Description', render: (r) => escapeHtml(r.description || '—') },
      { label: 'Créé le', render: (r) => fmt.date(r.created_at) },
    ],
    rows: repairs,
    actions: [
      { title: 'Supprimer', icon: 'trash', variant: 'btn-danger', onClick: (r) => removeRepair(r) },
    ],
    empty: 'Aucune dépense ou réparation enregistrée pour ce bien.',
  }));

  root.querySelector('#payments').appendChild(dataTable({
    columns: [
      { label: 'Reçu', render: (r) => r.numero_recu ? escapeHtml(r.numero_recu) : codeCellFallback(r.code) },
      { label: 'Locataire', render: (r) => escapeHtml(r.tenant_nom || '—') },
      { label: 'Période', render: (r) => `${escapeHtml(r.mois_concerne || '—')} ${r.annee_concernee || ''}` },
      { label: 'Date', render: (r) => fmt.date(r.date) },
      { label: 'À payer', num: true, render: (r) => fmt.money(r.montant_a_payer) },
      { label: 'Payé', num: true, render: (r) => fmt.money(r.montant_paye) },
      { label: 'Reste', num: true, render: (r) => (r.reste_a_payer > 0 ? `<b style="color:#b91c1c">${fmt.money(r.reste_a_payer)}</b>` : fmt.money(0)) },
      { label: 'Reversement', render: (r) => r.payout_id ? badge('Reversé', 'green') : badge('À reverser', 'amber') },
    ],
    rows: payments,
    empty: 'Aucun paiement enregistré pour ce bien.',
  }));

  root.querySelector('#payouts').appendChild(dataTable({
    columns: [
      { label: 'Code', render: (r) => codeCellFallback(r.code) },
      { label: 'Date', render: (r) => fmt.date(r.date) },
      { label: 'Paiements du bien', num: true, render: (r) => fmt.int((r.lignes_bien || []).length) },
      { label: 'Loyers du bien', num: true, render: (r) => fmt.money((r.lignes_bien || []).reduce((a, l) => a + (l.montant_paye || 0), 0)) },
      { label: 'Commission', num: true, render: (r) => fmt.money((r.lignes_bien || []).reduce((a, l) => a + (l.commission || 0), 0)) },
      { label: 'Net du bien', num: true, render: (r) => fmt.money((r.lignes_bien || []).reduce((a, l) => a + (l.net || 0), 0)) },
      { label: 'Note', render: (r) => escapeHtml(r.note || '—') },
    ],
    rows: payouts,
    empty: 'Aucun reversement ne contient encore de paiement de ce bien.',
  }));
}

function codeCellFallback(code) {
  return `<span style="font-family:monospace;font-weight:700">${escapeHtml(code || '—')}</span>`;
}
