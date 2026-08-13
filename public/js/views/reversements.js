import { api, icon, el, escapeHtml, dataTable, confirmDialog, toast, fmt, montantEnLettres, pageHeader, printDocument, docHeader, openModal, store, codeCell } from '../core.js';

export async function render() {
  const root = el(`
    <div>
      <div class="card card-pad" style="margin-bottom:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div>
            <h3 style="font-size:16px;margin:0 0 2px">À reverser aux propriétaires</h3>
            <p class="muted" style="margin:0;font-size:13px">Loyers encaissés non encore reversés, nets de la commission de l’agence.</p>
          </div>
          <div style="text-align:right">
            <div class="muted" style="font-size:12px">Total net à reverser</div>
            <div id="totalNet" style="font-size:20px;font-weight:800;color:#0b5740">—</div>
          </div>
        </div>
        <div id="dueList" style="margin-top:14px"></div>
      </div>

      <div class="card card-pad">
        <div class="toolbar" style="margin-bottom:10px">
          <b style="font-size:15px">Historique des reversements</b>
          <div class="spacer"></div>
          <div class="search">${icon('search', 17)}<input type="text" id="search" placeholder="Rechercher (code, propriétaire…)" /></div>
        </div>
        <div id="histList"></div>
      </div>
    </div>`);
  pageHeader(root);

  const dueBox = root.querySelector('#dueList');
  const histBox = root.querySelector('#histList');
  const totalNetEl = root.querySelector('#totalNet');
  let histFilter = '';

  async function loadDue() {
    dueBox.innerHTML = '<div class="spinner"></div>';
    const rows = await api.get('/api/payouts/due');
    totalNetEl.textContent = fmt.money(rows.reduce((a, r) => a + r.net, 0));
    dueBox.innerHTML = '';
    dueBox.appendChild(dataTable({
      columns: [
        { label: 'Propriétaire', render: (r) => `<b>${escapeHtml(r.owner_nom || '—')}</b>` },
        { label: 'Contact', render: (r) => escapeHtml(r.owner_contact || '—') },
        { label: 'Paiements', num: true, render: (r) => fmt.int(r.nombre_paiements) },
        { label: 'Loyers encaissés', num: true, render: (r) => fmt.money(r.loyers) },
        { label: 'Commission', num: true, render: (r) => fmt.money(r.commission) },
        { label: 'Net à reverser', num: true, render: (r) => `<b style="color:#0b5740">${fmt.money(r.net)}</b>` },
      ],
      rows,
      actions: [
        { title: 'Reverser', icon: 'collect', variant: 'btn-accent', onClick: (r) => openReverser(r.owner_id) },
      ],
      empty: 'Aucun loyer en attente de reversement. 🎉',
    }));
  }

  async function loadHist() {
    histBox.innerHTML = '<div class="spinner"></div>';
    const rows = await api.get('/api/payouts' + (histFilter ? '?q=' + encodeURIComponent(histFilter) : ''));
    histBox.innerHTML = '';
    histBox.appendChild(dataTable({
      columns: [
        { label: 'Code', render: (r) => codeCell(r.code) },
        { label: 'Date', render: (r) => fmt.date(r.date) },
        { label: 'Propriétaire', render: (r) => `<b>${escapeHtml(r.owner_nom || '—')}</b>` },
        { label: 'Période', render: (r) => (r.periode_debut ? `${fmt.date(r.periode_debut)} → ${fmt.date(r.periode_fin)}` : '—') },
        { label: 'Loyers', num: true, render: (r) => fmt.money(r.montant_loyers) },
        { label: 'Commission', num: true, render: (r) => fmt.money(r.montant_commission) },
        { label: 'Net reversé', num: true, render: (r) => `<b style="color:#0b5740">${fmt.money(r.montant_net)}</b>` },
      ],
      rows,
      actions: [
        { title: 'Imprimer le relevé', icon: 'print', variant: 'btn-ghost', onClick: (r) => printReleve(r.id) },
        { title: 'Annuler le reversement', icon: 'trash', onClick: (r) => cancel(r) },
      ],
      empty: 'Aucun reversement effectué pour le moment.',
    }));
  }

  async function openReverser(ownerId) {
    let data;
    try { data = await api.get('/api/payouts/due/' + ownerId); }
    catch (e) { return toast(e.message, 'error'); }
    if (!data.lignes.length) { toast('Rien à reverser pour ce propriétaire.', 'error'); loadDue(); return; }

    const lignesHtml = data.lignes.map((l) => `
      <tr>
        <td style="padding:6px;border:1px solid #e8edf2">${escapeHtml(l.mois_concerne || '—')} ${l.annee_concernee || ''}</td>
        <td style="padding:6px;border:1px solid #e8edf2;font-family:monospace;font-size:12px">${escapeHtml(l.property_code || '—')}</td>
        <td style="padding:6px;border:1px solid #e8edf2">${escapeHtml(l.tenant_nom || '—')}</td>
        <td style="padding:6px;border:1px solid #e8edf2;text-align:right">${fmt.money(l.montant_paye)}</td>
        <td style="padding:6px;border:1px solid #e8edf2;text-align:right">${l.part_commission || 0} %</td>
        <td style="padding:6px;border:1px solid #e8edf2;text-align:right">${fmt.money(l.commission)}</td>
        <td style="padding:6px;border:1px solid #e8edf2;text-align:right"><b>${fmt.money(l.net)}</b></td>
      </tr>`).join('');

    const { close, modal } = openModal(`
      <div class="modal-head"><h3>Reverser à ${escapeHtml(data.owner.nom_prenoms)}</h3><button class="close" data-close>&times;</button></div>
      <div class="modal-body">
        <div id="revErr" class="alert alert-error" style="display:none"></div>
        <div class="table-wrap" style="max-height:300px;overflow:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="background:#f1f5f9">
              <th style="padding:6px;border:1px solid #e8edf2;text-align:left">Période</th>
              <th style="padding:6px;border:1px solid #e8edf2;text-align:left">Bien</th>
              <th style="padding:6px;border:1px solid #e8edf2;text-align:left">Locataire</th>
              <th style="padding:6px;border:1px solid #e8edf2;text-align:right">Loyer payé</th>
              <th style="padding:6px;border:1px solid #e8edf2;text-align:right">Taux</th>
              <th style="padding:6px;border:1px solid #e8edf2;text-align:right">Commission</th>
              <th style="padding:6px;border:1px solid #e8edf2;text-align:right">Net</th>
            </tr></thead>
            <tbody>${lignesHtml}</tbody>
            <tfoot><tr style="font-weight:800;background:#f0faf5">
              <td colspan="3" style="padding:6px;border:1px solid #e8edf2">TOTAL — ${data.nombre_paiements} paiement(s)</td>
              <td style="padding:6px;border:1px solid #e8edf2;text-align:right">${fmt.money(data.totals.loyers)}</td>
              <td style="padding:6px;border:1px solid #e8edf2"></td>
              <td style="padding:6px;border:1px solid #e8edf2;text-align:right">${fmt.money(data.totals.commission)}</td>
              <td style="padding:6px;border:1px solid #e8edf2;text-align:right;color:#0b5740">${fmt.money(data.totals.net)}</td>
            </tr></tfoot>
          </table>
        </div>
        <div class="form-grid" style="margin-top:14px">
          <div class="field"><label>Date du reversement</label><input type="date" id="revDate" value="${fmt.today()}" /></div>
          <div class="field"><label>Note (facultatif)</label><input type="text" id="revNote" placeholder="ex : virement, espèces…" /></div>
        </div>
        <p class="hint">Le <b>net de ${fmt.money(data.totals.net)}</b> sera marqué comme reversé à ${escapeHtml(data.owner.nom_prenoms)} ; ces loyers ne réapparaîtront plus dans la liste « à reverser ».</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-close>Annuler</button>
        <button class="btn btn-accent" id="revOk">${icon('collect', 16)} Valider le reversement</button>
      </div>`, { size: 'lg' });

    modal.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
    modal.querySelector('#revOk').onclick = async () => {
      const btn = modal.querySelector('#revOk');
      btn.disabled = true;
      try {
        // On reverse EXACTEMENT les loyers affichés dans ce tableau. Sans cette
        // liste, un encaissement enregistré entre-temps par un collègue serait
        // inclus en silence et le montant reversé dépasserait celui validé.
        const saved = await api.post('/api/payouts', {
          owner_id: ownerId,
          date: modal.querySelector('#revDate').value,
          note: modal.querySelector('#revNote').value,
          payment_ids: data.lignes.map((l) => l.id),
        });
        close();
        toast('Reversement enregistré.');
        loadDue(); loadHist();
        setTimeout(async () => {
          const ok = await confirmDialog({ title: 'Relevé de reversement', okLabel: 'Imprimer',
            message: 'Souhaitez-vous imprimer le relevé de reversement ?' });
          if (ok) printReleve(saved.id);
        }, 200);
      } catch (e) {
        const errBox = modal.querySelector('#revErr');
        errBox.textContent = e.message; errBox.style.display = 'block';
        btn.disabled = false;
      }
    };
  }

  async function cancel(row) {
    const ok = await confirmDialog({ title: 'Annuler le reversement', danger: true, okLabel: 'Annuler le reversement',
      message: `Annuler le reversement « ${row.code} » de ${fmt.money(row.montant_net)} à ${row.owner_nom} ? Les loyers concernés redeviendront « à reverser ».` });
    if (!ok) return;
    try { await api.del('/api/payouts/' + row.id); toast('Reversement annulé.'); loadDue(); loadHist(); }
    catch (e) { toast(e.message, 'error'); }
  }

  let timer;
  root.querySelector('#search').addEventListener('input', (e) => {
    histFilter = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(loadHist, 250);
  });

  await Promise.all([loadDue(), loadHist()]);
}

// ---------- Impression du relevé de reversement -------------------------
export async function printReleve(id) {
  const v = await api.get('/api/payouts/' + id);
  const lignes = (v.lignes || []).map((l) => `
    <tr>
      <td style="padding:6px;border:1px solid #e8edf2">${escapeHtml(l.mois_concerne || '—')} ${l.annee_concernee || ''}</td>
      <td style="padding:6px;border:1px solid #e8edf2;font-family:monospace;font-size:12px">${escapeHtml(l.property_code || '—')}</td>
      <td style="padding:6px;border:1px solid #e8edf2">${escapeHtml(l.tenant_nom || '—')}</td>
      <td style="padding:6px;border:1px solid #e8edf2;text-align:right">${fmt.money(l.montant_paye)}</td>
      <td style="padding:6px;border:1px solid #e8edf2;text-align:right">${fmt.money(l.commission)}</td>
      <td style="padding:6px;border:1px solid #e8edf2;text-align:right">${fmt.money(l.net)}</td>
    </tr>`).join('');

  const body = `
    ${docHeader()}
    <h2 class="doc-title">RELEVÉ DE REVERSEMENT AU PROPRIÉTAIRE</h2>
    <table class="kv">
      <tr><td class="k">Identifiant du reversement</td><td class="v"><span style="font-family:monospace">${escapeHtml(v.code)}</span></td></tr>
      <tr><td class="k">Propriétaire</td><td class="v"><b>${escapeHtml(v.owner_nom || '—')}</b></td></tr>
      <tr><td class="k">Contact</td><td class="v">${escapeHtml(v.owner_contact || '—')}</td></tr>
      <tr><td class="k">Date du reversement</td><td class="v">${fmt.date(v.date)}</td></tr>
      ${v.periode_debut ? `<tr><td class="k">Période couverte</td><td class="v">du ${fmt.date(v.periode_debut)} au ${fmt.date(v.periode_fin)}</td></tr>` : ''}
    </table>
    <table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:13px">
      <thead><tr style="background:#f1f5f9">
        <th style="padding:6px;border:1px solid #e8edf2;text-align:left">Période</th>
        <th style="padding:6px;border:1px solid #e8edf2;text-align:left">Bien</th>
        <th style="padding:6px;border:1px solid #e8edf2;text-align:left">Locataire</th>
        <th style="padding:6px;border:1px solid #e8edf2;text-align:right">Loyer payé</th>
        <th style="padding:6px;border:1px solid #e8edf2;text-align:right">Commission</th>
        <th style="padding:6px;border:1px solid #e8edf2;text-align:right">Net</th>
      </tr></thead>
      <tbody>${lignes}</tbody>
    </table>
    <table class="kv" style="margin-top:6px">
      <tr><td class="k">Total loyers encaissés</td><td class="v" style="text-align:right">${fmt.money(v.montant_loyers)}</td></tr>
      <tr><td class="k">Commission de l’agence</td><td class="v" style="text-align:right">− ${fmt.money(v.montant_commission)}</td></tr>
      <tr class="montant-fort"><td class="k"><b>NET REVERSÉ AU PROPRIÉTAIRE</b></td><td class="v" style="text-align:right"><b>${fmt.money(v.montant_net)}</b></td></tr>
      <tr><td class="k">Montant en lettres</td><td class="v"><span class="lettres">${escapeHtml(capitalize(montantEnLettres(v.montant_net)))} franc(s) CFA</span></td></tr>
    </table>
    <div class="sign" style="margin-top:44px">
      <div><div class="line"></div>Le propriétaire</div>
      <div><div class="line"></div>SIGNATURE (${escapeHtml(store.settings.entreprise || 'NOUVEL AFRIC')})</div>
    </div>`;
  printDocument('Reversement — ' + v.code, body);
}

function capitalize(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
