import { api, icon, el, escapeHtml, dataTable, badge, fmt, pageHeader, formModal, toast, MOIS } from '../core.js';

function miniStat(label, value, danger) {
  return `<div style="background:#f8fafc;border:1px solid #eef2f6;border-radius:10px;padding:10px 12px">
    <div style="font-size:16px;font-weight:800;${danger ? 'color:#b91c1c' : 'color:#0f172a'}">${value}</div>
    <div style="font-size:12px;color:#64748b">${escapeHtml(label)}</div>
  </div>`;
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
  const actifs = subs.filter((s) => s.statut === 'Active');
  const enRetard = actifs.filter((s) => s.resume.mois_retard > 0).length;
  const totalEncaisse = subs.reduce((a, s) => a + s.resume.total_paye, 0);
  const totalImpaye = actifs.reduce((a, s) => a + s.resume.reste, 0);

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
        render(); // recharge la situation de la maison
      },
    });
  }

  function renderSub(s) {
    const r = s.resume;
    const card = el('<div class="card card-pad" style="margin-bottom:14px"></div>');
    const retard = r.mois_retard > 0
      ? `<span class="badge badge-red">${r.mois_retard} mois en retard</span>`
      : '<span class="badge badge-green">À jour</span>';
    const head = el(`
      <div>
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:flex-start">
          <div>
            <div style="font-weight:800;font-size:15px">${icon('tenants', 16)} ${escapeHtml(s.tenant_nom || '—')}</div>
            <div class="muted" style="font-size:13px">
              ${escapeHtml(s.tenant_contact || '')} · Bail <span style="font-family:monospace">${escapeHtml(s.code)}</span>
              · depuis le ${fmt.date(s.date_debut_paiement || s.date_entree)}
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            ${badge(s.statut === 'Active' ? 'Bail actif' : 'Bail désactivé', s.statut === 'Active' ? 'green' : 'gray')}
            ${s.statut === 'Active' ? retard : ''}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:12px 0">
          ${miniStat('Loyer mensuel', fmt.money(s.montant_loyer))}
          ${miniStat('Total attendu', fmt.money(r.total_attendu))}
          ${miniStat('Total payé', fmt.money(r.total_paye))}
          ${miniStat('Reste dû (impayés)', fmt.money(r.reste), r.reste > 0)}
        </div>
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
        rows: s.echeancier,
        actions: [
          { title: 'Encaisser ce mois', icon: 'collect', variant: 'btn-accent', show: (m) => m.reste > 0, onClick: (m) => openEncaisser(s, m) },
        ],
        empty: 'Aucune échéance.',
      }));
    } else if (s.paiements.length) {
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
      <div class="card card-pad" style="margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px">
          <div>
            <h2 style="font-size:18px;margin:0 0 4px">${icon('houses', 20)} ${escapeHtml(p.type_construction || 'Bien')}${p.designation ? ' — ' + escapeHtml(p.designation) : ''}</h2>
            <div class="muted" style="font-size:13px">Code : <span style="font-family:monospace">${escapeHtml(p.code)}</span></div>
            <div style="margin-top:8px;font-size:14px;line-height:1.7">
              Propriétaire : <b>${escapeHtml(p.owner_nom || '—')}</b>${p.owner_contact ? ' · ' + escapeHtml(p.owner_contact) : ''}<br>
              Localisation : ${escapeHtml([p.commune, p.quartier].filter(Boolean).join(' · ') || p.ville || '—')}<br>
              Loyer : <b>${fmt.money(p.cout_loyer)}</b> · Commission agence : ${p.part_commission || 0} %
            </div>
          </div>
          <div>${badge(p.statut, p.statut === 'Occupé' ? 'amber' : 'green')}</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:14px">
          ${miniStat('Locataires actifs', fmt.int(actifs.length))}
          ${miniStat('À jour / En retard', `${fmt.int(actifs.length - enRetard)} / ${fmt.int(enRetard)}`, enRetard > 0)}
          ${miniStat('Total encaissé', fmt.money(totalEncaisse))}
          ${miniStat('Total impayé', fmt.money(totalImpaye), totalImpaye > 0)}
        </div>
      </div>
      <h3 style="font-size:15px;margin:0 0 10px">Locataires &amp; situation des paiements</h3>
      <div id="subs"></div>
    </div>`);
  pageHeader(root);
  root.querySelector('#back').onclick = () => { location.hash = '#/maisons'; };

  const subsBox = root.querySelector('#subs');
  if (!subs.length) {
    subsBox.innerHTML = '<div class="card card-pad"><p class="muted" style="margin:0">Aucune souscription (locataire) pour ce bien.</p></div>';
    return;
  }
  subs.forEach((s) => subsBox.appendChild(renderSub(s)));
}
