import { api, icon, el, escapeHtml, dataTable, formModal, confirmDialog, toast, badge, fmt, MOIS, montantEnLettres, pageHeader, printDocument, docHeader, openModal, store, codeCell } from '../core.js';

const anneeCourante = new Date().getFullYear();
const moisCourant = MOIS[new Date().getMonth()];
const PAYMENT_TOLERANCE = 1;

function parseMonthText(txt, year) {
  return String(txt || '').split(',').map((m) => m.trim()).filter(Boolean).map((mois) => ({ mois, annee: Number(year) || anneeCourante }));
}
function monthListText(raw, fallbackMonth, fallbackYear) {
  if (raw) {
    try { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr.map((m) => `${m.mois} ${m.annee}`).join(', '); } catch (_) { return String(raw); }
  }
  return fallbackMonth ? `${fallbackMonth} ${fallbackYear || ''}`.trim() : '—';
}
function monthsPayload(v) {
  const paid = parseMonthText(v.mois_payes_txt || v.mois_concerne, v.annee_concernee);
  const due = parseMonthText(v.mois_dus_txt, v.annee_concernee);
  return {
    ...v,
    mois_payes: JSON.stringify(paid),
    nombre_mois_payes: paid.length,
    mois_concerne: paid[0] && paid[0].mois,
    annee_concernee: paid[0] && paid[0].annee,
    mois_dus: due.length ? JSON.stringify(due) : '',
    nombre_mois_dus: due.length,
  };
}

export async function render() {
  const filtre = { q: '', mois: '', annee: '', statut: '' };
  const annees = [];
  for (let a = anneeCourante + 1; a >= anneeCourante - 6; a--) annees.push(a);

  const root = el(`
    <div>
      <div class="toolbar">
        <div class="search">${icon('search', 17)}<input type="text" id="search" placeholder="Rechercher (code, bien, locataire…)" /></div>
        <div class="filters">
          <select id="fMois"><option value="">Tous les mois</option>${MOIS.map((m) => `<option>${m}</option>`).join('')}</select>
          <select id="fAnnee"><option value="">Toutes années</option>${annees.map((a) => `<option>${a}</option>`).join('')}</select>
          <select id="fStatut"><option value="">Tous statuts</option><option>Soldé</option><option>Non soldé</option></select>
        </div>
        <div class="spacer"></div>
        <button class="btn btn-accent" id="bulkBtn">${icon('collect', 17)} Encaissement du mois</button>
        <button class="btn btn-primary" id="addBtn">${icon('plus', 17)} Nouveau paiement</button>
      </div>
      <div id="list"></div>
    </div>`);
  pageHeader(root);
  const listBox = root.querySelector('#list');

  async function load() {
    listBox.innerHTML = '<div class="spinner"></div>';
    const p = new URLSearchParams();
    Object.entries(filtre).forEach(([k, v]) => { if (v) p.set(k, v); });
    const rows = await api.get('/api/payments' + (p.toString() ? '?' + p : ''));
    listBox.innerHTML = '';
    listBox.appendChild(dataTable({
      columns: [
        { label: 'Code', render: (r) => codeCell(r.code) },
        { label: 'Locataire', render: (r) => `<b>${escapeHtml(r.tenant_nom || '—')}</b>` },
        { label: 'Bien', render: (r) => codeCell(r.property_code) },
        { label: 'Mois payés', render: (r) => `${r.nombre_mois_payes || 1} mois<br><span class="muted">${escapeHtml(monthListText(r.mois_payes, r.mois_concerne, r.annee_concernee))}</span>` },
        { label: 'Mois dûs', render: (r) => r.nombre_mois_dus ? `${r.nombre_mois_dus} mois<br><span class="muted">${escapeHtml(monthListText(r.mois_dus))}</span>` : '—' },
        { label: 'À payer', num: true, render: (r) => fmt.money(r.montant_a_payer) },
        { label: 'Payé', num: true, render: (r) => fmt.money(r.montant_paye) },
        { label: 'Reste', num: true, render: (r) => r.reste_a_payer > 0 ? `<span style="color:#b91c1c;font-weight:700">${fmt.money(r.reste_a_payer)}</span>` : fmt.money(0) },
        { label: 'Statut', render: (r) => badge(r.statut, r.statut === 'Soldé' ? 'green' : 'red') },
        { label: 'Date', render: (r) => fmt.date(r.date) },
      ],
      rows,
      actions: [
        { title: 'Imprimer le reçu', icon: 'print', variant: 'btn-ghost', onClick: (r) => printRecu(r.id) },
        { title: 'Modifier', icon: 'edit', onClick: (r) => openForm(r) },
        { title: 'Supprimer', icon: 'trash', onClick: (r) => remove(r) },
      ],
      empty: 'Aucun règlement enregistré.',
    }));
  }

  async function openForm(row) {
    const active = await api.get('/api/subscriptions/active');
    const subMap = Object.fromEntries(active.map((s) => [String(s.id), s]));
    if (row && row.subscription_id && !subMap[String(row.subscription_id)]) {
      try { const s = await api.get('/api/subscriptions/' + row.subscription_id); subMap[String(s.id)] = s; active.unshift(s); } catch { /* ignore */ }
    }
    if (active.length === 0 && !row) { toast('Aucune souscription active. Créez une souscription d’abord.', 'error'); return; }

    formModal({
      title: row ? 'Modifier le règlement' : 'Nouveau paiement de loyer',
      size: 'lg',
      fields: [
        { name: 'subscription_id', label: 'Souscription (locataire / bien)', type: 'select', required: true, col: 2,
          options: active.map((s) => ({ value: s.id, label: `${s.tenant_nom} — ${s.property_code} (${fmt.money(s.montant_loyer)})` })) },
        { name: '_bien', label: 'Bien', readonly: true },
        { name: '_locataire', label: 'Locataire', readonly: true },
        { name: 'montant_a_payer', label: 'Montant à payer total', type: 'number', min: 0 },
        { name: 'montant_paye', label: 'Montant payé', type: 'number', required: true, min: 0 },
        { name: 'reste_a_payer', label: 'Reste à payer', type: 'number', readonly: true },
        { name: 'annee_concernee', label: 'Année concernée', type: 'number', required: true },
        { name: 'mois_payes_txt', label: 'Mois payés (séparer par virgule)', required: true, col: 2, placeholder: 'ex. Janvier, Février' },
        { name: 'nombre_mois_payes', label: 'Nombre de mois payés', type: 'number', readonly: true },
        { name: 'mois_dus_txt', label: 'Mois encore dûs après ce paiement', col: 2, placeholder: 'ex. Mars, Avril' },
        { name: 'nombre_mois_dus', label: 'Nombre de mois dûs', type: 'number', readonly: true },
        { name: 'mois_concerne', label: 'Premier mois payé', type: 'hidden' },
        { name: 'date', label: 'Date du paiement', type: 'date' },
        { name: 'numero_recu', label: 'N° de reçu', placeholder: 'ex. 269' },
      ],
      values: row
        ? { ...row, _bien: row.property_code, _locataire: row.tenant_nom, mois_payes_txt: monthListText(row.mois_payes, row.mois_concerne, row.annee_concernee).replace(/ \d{4}/g, ''), mois_dus_txt: row.mois_dus ? monthListText(row.mois_dus).replace(/ \d{4}/g, '') : '' }
        : { date: fmt.today(), annee_concernee: anneeCourante, mois_concerne: moisCourant, mois_payes_txt: moisCourant, nombre_mois_payes: 1, nombre_mois_dus: 0 },
      onChange: (v, changed, set) => {
        if (changed === 'subscription_id') {
          const s = subMap[String(v.subscription_id)];
          if (s) {
            set('_bien', s.property_code || '');
            set('_locataire', s.tenant_nom || '');
            const paidCount = parseMonthText(v.mois_payes_txt || moisCourant, v.annee_concernee).length || 1;
            set('montant_a_payer', s.montant_loyer * paidCount);
            set('montant_paye', s.montant_loyer * paidCount);
            v.montant_a_payer = s.montant_loyer * paidCount; v.montant_paye = s.montant_loyer * paidCount;
          }
        }
        const paid = parseMonthText(v.mois_payes_txt || v.mois_concerne, v.annee_concernee);
        const due = parseMonthText(v.mois_dus_txt, v.annee_concernee);
        set('nombre_mois_payes', paid.length);
        set('nombre_mois_dus', due.length);
        const sub = subMap[String(v.subscription_id)];
        if (sub && (changed === 'mois_payes_txt' || changed === 'annee_concernee')) {
          const totalDue = sub.montant_loyer * Math.max(1, paid.length);
          set('montant_a_payer', totalDue);
          v.montant_a_payer = totalDue;
        }
        const diff = (Number(v.montant_a_payer) || 0) - (Number(v.montant_paye) || 0);
        const reste = diff > PAYMENT_TOLERANCE ? diff : 0;
        set('reste_a_payer', reste);
      },
      onSubmit: async (v) => {
        const payload = monthsPayload(v);
        const saved = row ? await api.put('/api/payments/' + row.id, payload) : await api.post('/api/payments', payload);
        toast(row ? 'Règlement modifié.' : 'Paiement enregistré.');
        load();
        if (!row && saved && saved.id) {
          setTimeout(async () => {
            const ok = await confirmDialog({ title: 'Reçu de paiement', okLabel: 'Imprimer',
              message: 'Souhaitez-vous imprimer le reçu de paiement ?' });
            if (ok) printRecu(saved.id);
          }, 200);
        }
      },
    });
  }

  async function remove(row) {
    const ok = await confirmDialog({ title: 'Supprimer le règlement', danger: true, okLabel: 'Supprimer',
      message: `Supprimer le règlement « ${row.code} » ?` });
    if (!ok) return;
    await api.del('/api/payments/' + row.id);
    toast('Règlement supprimé.');
    load();
  }

  // -------- Encaissement multiple (loyers du mois) --------
  async function openBulk() {
    const active = await api.get('/api/subscriptions/active');
    if (active.length === 0) { toast('Aucune souscription active.', 'error'); return; }
    const items = active.map((s) => `
      <label>
        <input type="checkbox" value="${s.id}" checked />
        <span>${escapeHtml(s.tenant_nom)} <span class="muted">— ${escapeHtml(s.property_code)}</span></span>
        <span class="meta">${fmt.money(s.montant_loyer)}</span>
      </label>`).join('');

    const { overlay, close, modal } = openModal(`
      <div class="modal-head"><h3>Encaissement des loyers du mois</h3><button class="close" data-close>&times;</button></div>
      <div class="modal-body">
        <div id="bulkErr" class="alert alert-error" style="display:none"></div>
        <div class="form-grid">
          <div class="field"><label>Mois concerné <span class="req">*</span></label>
            <select id="bMois">${MOIS.map((m) => `<option${m === moisCourant ? ' selected' : ''}>${m}</option>`).join('')}</select></div>
          <div class="field"><label>Année concernée <span class="req">*</span></label>
            <input type="number" id="bAnnee" value="${anneeCourante}" /></div>
          <div class="field col-2"><label>Date du paiement</label><input type="date" id="bDate" value="${fmt.today()}" /></div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin:6px 0 8px">
          <b>Souscriptions actives (${active.length})</b>
          <button type="button" class="btn btn-ghost btn-sm" id="toggleAll">Tout décocher</button>
        </div>
        <div class="checklist" id="bList">${items}</div>
        <p class="hint">Un loyer déjà enregistré pour la même période sera automatiquement ignoré (pas de doublon).</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-close>Annuler</button>
        <button class="btn btn-accent" id="bValider">${icon('collect', 16)} Enregistrer les encaissements</button>
      </div>`, { size: 'lg' });

    modal.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
    const toggle = modal.querySelector('#toggleAll');
    toggle.onclick = () => {
      const boxes = modal.querySelectorAll('#bList input[type=checkbox]');
      const allChecked = [...boxes].every((c) => c.checked);
      boxes.forEach((c) => { c.checked = !allChecked; });
      toggle.textContent = allChecked ? 'Tout cocher' : 'Tout décocher';
    };
    modal.querySelector('#bValider').onclick = async () => {
      const ids = [...modal.querySelectorAll('#bList input:checked')].map((c) => Number(c.value));
      const errBox = modal.querySelector('#bulkErr');
      if (ids.length === 0) { errBox.textContent = 'Veuillez sélectionner au moins une souscription.'; errBox.style.display = 'block'; return; }
      try {
        const res = await api.post('/api/payments/bulk', {
          date: modal.querySelector('#bDate').value,
          mois: modal.querySelector('#bMois').value,
          annee: Number(modal.querySelector('#bAnnee').value),
          subscription_ids: ids,
        });
        close();
        toast(`${res.crees} encaissement(s) enregistré(s)` + (res.ignores ? `, ${res.ignores} ignoré(s).` : '.'));
        load();
      } catch (e) {
        errBox.textContent = e.message; errBox.style.display = 'block';
      }
    };
  }

  root.querySelector('#addBtn').onclick = () => openForm(null);
  root.querySelector('#bulkBtn').onclick = openBulk;
  let timer;
  root.querySelector('#search').addEventListener('input', (e) => { filtre.q = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(load, 250); });
  root.querySelector('#fMois').addEventListener('change', (e) => { filtre.mois = e.target.value; load(); });
  root.querySelector('#fAnnee').addEventListener('change', (e) => { filtre.annee = e.target.value; load(); });
  root.querySelector('#fStatut').addEventListener('change', (e) => { filtre.statut = e.target.value; load(); });

  await load();
}

// ---------- Impression du reçu de paiement ------------------------------
export async function printRecu(id) {
  const r = await api.get('/api/payments/' + id);
  const row = (k, v) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`;
  const body = `
    ${docHeader()}
    <h2 class="doc-title">REÇU DE PAIEMENT DE LOYER</h2>
    <table class="kv">
      ${row('Identifiant du règlement', `<span style="font-family:monospace">${escapeHtml(r.code)}</span>`)}
      ${r.numero_recu ? row('N° de reçu', `<b>${escapeHtml(r.numero_recu)}</b>`) : ''}
      ${row('Nom et prénoms du locataire', `<b>${escapeHtml(r.tenant_nom || '—')}</b>`)}
      ${row('Contact', escapeHtml(r.tenant_contact || '—'))}
      ${row('Identifiant du bien', `<span style="font-family:monospace">${escapeHtml(r.property_code || '—')}</span>`)}
      ${row('Type de bien', escapeHtml(r.type_construction || '—'))}
      ${row('Désignation', escapeHtml(r.designation || '—'))}
      ${row('Loyer mensuel du locataire', fmt.money(r.subscription_loyer || r.montant_a_payer))}
    </table>
    <table class="kv">
      <tr class="montant-fort"><td class="k"><b>Montant payé par le locataire</b></td><td class="v">${fmt.money(r.montant_paye)}</td></tr>
      ${row('Montant en lettres', `<span class="lettres">${escapeHtml(capitalize(montantEnLettres(r.montant_paye)))} franc(s) CFA</span>`)}
      ${row('Mois payés', `${r.nombre_mois_payes || 1} mois — ${escapeHtml(monthListText(r.mois_payes, r.mois_concerne, r.annee_concernee))}`)}
      ${r.nombre_mois_dus ? row('Mois restant dûs', `${r.nombre_mois_dus} mois — ${escapeHtml(monthListText(r.mois_dus))}`) : ''}
      ${row('Reste à payer', r.reste_a_payer > 0 ? `<b style="color:#b91c1c">${fmt.money(r.reste_a_payer)}</b>` : fmt.money(0))}
    </table>
    <div class="sign" style="margin-top:40px">
      <div style="text-align:left;width:auto">Fait le ${fmt.date(r.date)}</div>
      <div><div class="line"></div>SIGNATURE (${escapeHtml(store.settings.entreprise || 'NOUVEL AFRIC')})</div>
    </div>`;
  printDocument('Reçu — ' + r.code, body);
}

function capitalize(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
