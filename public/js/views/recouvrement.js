import { api, icon, el, escapeHtml, fmt, MOIS, pageHeader, printDocument, docHeader, openModal, toast } from '../core.js';

const anneeCourante = new Date().getFullYear();

function chip(label, value, danger) {
  return `<div style="background:#f8fafc;border:1px solid #eef2f6;border-radius:10px;padding:10px 12px">
    <div style="font-size:16px;font-weight:800;${danger ? 'color:#b91c1c' : 'color:#0f172a'}">${value}</div>
    <div style="font-size:12px;color:#64748b">${escapeHtml(label)}</div>
  </div>`;
}

const grid = (inner) => `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">${inner}</div>`;

export async function render() {
  // Location a terme echu : par defaut, on presente le dernier mois exigible
  // (le mois precedent), puisqu'on encaisse le loyer apres le mois consomme.
  const moisEchu = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
  const filtre = { mois: MOIS[moisEchu.getMonth()], annee: moisEchu.getFullYear() };
  const annees = [];
  for (let a = anneeCourante + 1; a >= anneeCourante - 6; a--) annees.push(a);

  const root = el(`
    <div>
      <div class="toolbar">
        <div class="filters">
          <select id="fMois">${MOIS.map((m) => `<option${m === filtre.mois ? ' selected' : ''}>${m}</option>`).join('')}</select>
          <select id="fAnnee">${annees.map((a) => `<option${a === filtre.annee ? ' selected' : ''}>${a}</option>`).join('')}</select>
        </div>
        <div class="spacer"></div>
        <button class="btn btn-ghost" id="printBtn">${icon('print', 16)} Imprimer le rapport</button>
      </div>
      <div id="recap"></div>
      <div id="zones"></div>
    </div>`);
  pageHeader(root);
  const recapBox = root.querySelector('#recap');
  const zonesBox = root.querySelector('#zones');
  let current = null;

  async function load() {
    recapBox.innerHTML = '<div class="spinner"></div>';
    zonesBox.innerHTML = '';
    current = await api.get(`/api/recouvrement?mois=${encodeURIComponent(filtre.mois)}&annee=${filtre.annee}`);
    renderRecap(current);
    zonesBox.innerHTML = '';
    if (!current.zones.length) {
      zonesBox.innerHTML = '<div class="card card-pad"><p class="muted" style="margin:0">Aucun bail actif pour cette période.</p></div>';
      return;
    }
    current.zones.forEach((z) => zonesBox.appendChild(renderZone(z)));
  }

  function renderRecap(d) {
    const r = d.recap;
    recapBox.innerHTML = `
      <div class="card card-pad" style="margin-bottom:16px;background:linear-gradient(120deg,#0f6e4f,#0b5740);color:#eafff6;border:none">
        <h3 style="color:#fff;font-size:16px;margin:0 0 10px">Récapitulatif du recouvrement — ${escapeHtml(d.mois)} ${d.annee}</h3>
        ${grid(`
          ${chip('Total dû', fmt.money(r.total_du))}
          ${chip('Total encaissé', fmt.money(r.total_paye))}
          ${chip('Écart (impayés)', fmt.money(r.ecart), r.ecart > 0)}
          ${chip('Réparations', fmt.money(r.reparations))}
          ${chip('Commission agence', fmt.money(r.commission_generale))}
          ${chip('SOLDE à reverser', fmt.money(r.solde), r.solde < 0)}
        `)}
      </div>`;
  }

  function renderZone(z) {
    const sec = el('<div style="margin-bottom:22px"></div>');
    sec.appendChild(el(`<div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
      <span>${icon('building', 18)} Zone : ${escapeHtml(z.zone)}</span>
      <span style="font-size:13px;font-weight:700;color:#0b5740">Solde zone : ${fmt.money(z.solde)}</span>
    </div>`));
    z.maisons.forEach((m) => sec.appendChild(renderMaison(m)));
    return sec;
  }

  function renderMaison(m) {
    const card = el('<div class="card card-pad" style="margin-bottom:14px"></div>');
    const td = 'padding:6px 8px;border-bottom:1px solid #eef2f6;font-size:13px';
    const tn = td + ';text-align:right';
    const lignes = m.locataires.map((l) => `
      <tr>
        <td style="${td}">${escapeHtml(l.tenant_nom || '—')}</td>
        <td style="${td}">${escapeHtml(l.designation || '—')}</td>
        <td style="${tn}">${fmt.money(l.loyer)}</td>
        <td style="${tn}">${l.mois_payes}<br><span class="muted">${escapeHtml((l.mois_payes_liste || []).join(', ') || '—')}</span>${l.mois_credit ? `<br><span style="color:#0f6e4f;font-size:12px">Crédit: ${escapeHtml((l.mois_credit_liste || []).join(', '))}</span>` : ''}</td>
        <td style="${tn}">${l.mois_dus > 0 ? `<b style="color:#b45309">${l.mois_dus}</b><br><span class="muted">${escapeHtml((l.mois_dus_liste || []).join(', '))}</span>` : 0}</td>
        <td style="${tn}">${fmt.money(l.montant_du)}</td>
        <td style="${tn}">${fmt.money(l.montant_paye)}</td>
        <td style="${tn}">${l.ecart > 0 ? `<b style="color:#b91c1c">${fmt.money(l.ecart)}</b>` : fmt.money(0)}</td>
        <td style="${td}">${escapeHtml(l.numero_recu || '—')}</td>
      </tr>`).join('');

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">
        <div>
          <b style="font-size:15px">${icon('houses', 15)} ${escapeHtml(m.code)}</b>
          ${m.designation ? `<span class="muted"> — ${escapeHtml(m.designation)}</span>` : ''}
          <div class="muted" style="font-size:13px">Propriétaire : <b>${escapeHtml(m.owner_nom || '—')}</b> · Commission : ${m.part_commission || 0} %</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-rep>${icon('edit', 14)} Réparations (${fmt.money(m.reparations)})</button>
      </div>
      <div class="table-wrap">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:#f1f5f9">
            <th style="${td};text-align:left">Locataire</th><th style="${td};text-align:left">Désignation</th>
            <th style="${tn}">Loyer</th><th style="${tn}">Mois payés</th><th style="${tn}">Mois dûs</th>
            <th style="${tn}">Dû</th><th style="${tn}">Payé</th><th style="${tn}">Écart</th><th style="${td};text-align:left">N° reçu</th>
          </tr></thead>
          <tbody>${lignes}</tbody>
          <tfoot>
            <tr style="font-weight:800;background:#f8fafc">
              <td style="${td}" colspan="5">TOTAUX</td>
              <td style="${tn}">${fmt.money(m.total_du)}</td>
              <td style="${tn}">${fmt.money(m.total_paye)}</td>
              <td style="${tn}">${m.ecart > 0 ? `<span style="color:#b91c1c">${fmt.money(m.ecart)}</span>` : fmt.money(0)}</td>
              <td style="${td}"></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px">
        ${chip('Réparations', fmt.money(m.reparations))}
        ${chip('Commission partielle (sur encaissé)', fmt.money(m.commission_partielle))}
        ${chip('Commission générale (sur dû)', fmt.money(m.commission_generale))}
        ${chip('SOLDE à reverser', fmt.money(m.solde), m.solde < 0)}
      </div>
      ${m.solde < 0 ? '<p class="hint" style="color:#b91c1c;margin-top:8px">⚠ Solde négatif : la commission sur le montant dû dépasse ce qui a été encaissé (loyers impayés).</p>' : ''}`;

    card.querySelector('[data-rep]').onclick = () => openReparations(m);
    return card;
  }

  async function openReparations(m) {
    const all = await api.get('/api/repairs?property_id=' + m.property_id);
    const list = all.filter((x) => x.mois === filtre.mois && x.annee === filtre.annee);
    const rows = list.map((x) => `
      <tr>
        <td style="padding:6px;border-bottom:1px solid #eef2f6">${escapeHtml(x.description || '—')}</td>
        <td style="padding:6px;border-bottom:1px solid #eef2f6;text-align:right">${fmt.money(x.montant)}</td>
        <td style="padding:6px;border-bottom:1px solid #eef2f6;text-align:right"><button class="btn btn-icon btn-sm btn-ghost" data-del="${x.id}" title="Supprimer">${icon('trash', 15)}</button></td>
      </tr>`).join('');
    const { overlay, close, modal } = openModal(`
      <div class="modal-head"><h3>Réparations — ${escapeHtml(m.code)} (${escapeHtml(filtre.mois)} ${filtre.annee})</h3><button class="close" data-close>&times;</button></div>
      <div class="modal-body">
        <div id="repErr" class="alert alert-error" style="display:none"></div>
        <div class="table-wrap"><table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f1f5f9"><th style="padding:6px;text-align:left">Description</th><th style="padding:6px;text-align:right">Montant</th><th></th></tr></thead>
          <tbody id="repList">${rows || '<tr><td colspan="3" style="padding:10px;color:#64748b">Aucune réparation pour cette période.</td></tr>'}</tbody>
        </table></div>
        <div class="form-grid" style="margin-top:14px">
          <div class="field"><label>Description</label><input id="repDesc" placeholder="ex. Plomberie, peinture…" /></div>
          <div class="field"><label>Montant (FCFA)</label><input id="repMontant" type="number" min="0" step="500" /></div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-close>Fermer</button>
        <button class="btn btn-primary" id="repAdd">${icon('plus', 15)} Ajouter</button>
      </div>`, { size: 'lg' });

    let changed = false;
    const finish = () => { close(); if (changed) load(); };
    modal.querySelectorAll('[data-close]').forEach((b) => { b.onclick = finish; });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(); });
    modal.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => { await api.del('/api/repairs/' + b.getAttribute('data-del')); changed = true; toast('Réparation supprimée.'); close(); load(); };
    });
    modal.querySelector('#repAdd').onclick = async () => {
      const montant = Number(modal.querySelector('#repMontant').value);
      const description = modal.querySelector('#repDesc').value;
      const err = modal.querySelector('#repErr');
      if (!montant || montant <= 0) { err.textContent = 'Veuillez saisir le montant.'; err.style.display = 'block'; return; }
      try {
        await api.post('/api/repairs', { property_id: m.property_id, mois: filtre.mois, annee: filtre.annee, montant, description });
        changed = true; toast('Réparation ajoutée.'); close(); load();
      } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
    };
  }

  root.querySelector('#fMois').onchange = (e) => { filtre.mois = e.target.value; load(); };
  root.querySelector('#fAnnee').onchange = (e) => { filtre.annee = Number(e.target.value); load(); };
  root.querySelector('#printBtn').onclick = () => { if (current) printReport(current); };
  await load();
}

// ---------- Impression du rapport de recouvrement ------------------------
function printReport(d) {
  const money = (n) => fmt.money(n);
  const th = 'padding:5px 7px;border:1px solid #cbd5e1;font-size:12px;background:#eef2f6';
  const tdc = 'padding:5px 7px;border:1px solid #e2e8f0;font-size:12px';
  const tdr = tdc + ';text-align:right';
  let body = `${docHeader()}<h2 class="doc-title">RAPPORT DE RECOUVREMENT — ${escapeHtml(d.mois)} ${d.annee}</h2>`;

  for (const z of d.zones) {
    body += `<h3 style="margin:16px 0 6px;color:#0b5740;border-bottom:2px solid #0f6e4f;padding-bottom:3px">Zone : ${escapeHtml(z.zone)}</h3>`;
    for (const m of z.maisons) {
      body += `<div style="margin:8px 0 4px;font-weight:700">${escapeHtml(m.code)}${m.designation ? ' — ' + escapeHtml(m.designation) : ''} · Propriétaire : ${escapeHtml(m.owner_nom || '—')} (commission ${m.part_commission || 0} %)</div>`;
      body += `<table style="width:100%;border-collapse:collapse;margin-bottom:4px">
        <thead><tr>
          <th style="${th};text-align:left">Locataire</th><th style="${th};text-align:left">Désignation</th>
          <th style="${th}">Loyer</th><th style="${th}">M. payés</th><th style="${th}">M. dûs</th>
          <th style="${th}">Dû</th><th style="${th}">Payé</th><th style="${th}">Écart</th><th style="${th}">N° reçu</th>
        </tr></thead><tbody>`;
      for (const l of m.locataires) {
        body += `<tr>
          <td style="${tdc}">${escapeHtml(l.tenant_nom || '—')}</td><td style="${tdc}">${escapeHtml(l.designation || '—')}</td>
          <td style="${tdr}">${money(l.loyer)}</td><td style="${tdr}">${l.mois_payes}<br>${escapeHtml((l.mois_payes_liste || []).join(', ') || '—')}</td><td style="${tdr}">${l.mois_dus}<br>${escapeHtml((l.mois_dus_liste || []).join(', ') || '—')}</td>
          <td style="${tdr}">${money(l.montant_du)}</td><td style="${tdr}">${money(l.montant_paye)}</td><td style="${tdr}">${money(l.ecart)}</td>
          <td style="${tdc}">${escapeHtml(l.numero_recu || '—')}</td>
        </tr>`;
      }
      body += `</tbody><tfoot>
        <tr style="font-weight:700;background:#f8fafc"><td style="${tdc}" colspan="5">TOTAUX</td>
          <td style="${tdr}">${money(m.total_du)}</td><td style="${tdr}">${money(m.total_paye)}</td><td style="${tdr}">${money(m.ecart)}</td><td style="${tdc}"></td></tr>
      </tfoot></table>
      <div style="font-size:12px;margin:0 0 12px">Réparations : <b>${money(m.reparations)}</b> · Commission partielle : <b>${money(m.commission_partielle)}</b> · Commission générale : <b>${money(m.commission_generale)}</b> · <b>SOLDE À REVERSER : ${money(m.solde)}</b></div>`;
    }
  }

  const r = d.recap;
  body += `<h3 style="margin:18px 0 6px;color:#0b5740">RÉCAPITULATIF GÉNÉRAL</h3>
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="${tdc}">Total dû</td><td style="${tdr}">${money(r.total_du)}</td></tr>
      <tr><td style="${tdc}">Total encaissé</td><td style="${tdr}">${money(r.total_paye)}</td></tr>
      <tr><td style="${tdc}">Écart (impayés)</td><td style="${tdr}">${money(r.ecart)}</td></tr>
      <tr><td style="${tdc}">Réparations</td><td style="${tdr}">${money(r.reparations)}</td></tr>
      <tr><td style="${tdc}">Commission agence (générale)</td><td style="${tdr}">${money(r.commission_generale)}</td></tr>
      <tr style="font-weight:800;background:#f0faf5"><td style="${tdc}">SOLDE TOTAL À REVERSER</td><td style="${tdr}">${money(r.solde)}</td></tr>
    </table>`;
  printDocument('Recouvrement ' + d.mois + ' ' + d.annee, body);
}
