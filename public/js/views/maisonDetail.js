import { api, icon, el, escapeHtml, dataTable, badge, fmt, pageHeader, formModal, openModal, confirmDialog, toast, MOIS } from '../core.js';
import { periodState, periodQuery, periodControls, bindPeriodControls, filteredPeriodText, previousRentPeriod } from '../periodControls.js';

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

const FEE_LABELS = ['Gardiennage', 'Entretien', 'Eau', 'WC', 'Ordures', 'Nettoyage', 'Sécurité'];
function tenantFeeFields() {
  return [
    ...FEE_LABELS.map((label) => ({ name: `fee_${label}`, label: `${label} — montant`, type: 'number', min: 0, step: 1 })),
    { name: 'fee_autre_label', label: 'Autre frais — libellé' },
    { name: 'fee_autre_montant', label: 'Autre frais — montant', type: 'number', min: 0, step: 1 },
    { name: 'montant_autre_frais', label: 'Total autres frais', type: 'number', readonly: true },
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
function feesTotal(v) { return collectFees(v).reduce((a, f) => a + f.montant, 0); }
function serializeFees(v) {
  const fees = collectFees(v);
  return { autre_frais: fees.length ? JSON.stringify(fees) : '', montant_autre_frais: fees.reduce((a, f) => a + f.montant, 0) };
}
function feeValues(raw) {
  const values = {};
  try {
    const fees = JSON.parse(raw || '[]');
    if (Array.isArray(fees)) fees.forEach((f) => {
      if (FEE_LABELS.includes(f.libelle)) values[`fee_${f.libelle}`] = Number(f.montant) || 0;
      else if (!values.fee_autre_label) {
        values.fee_autre_label = f.libelle || '';
        values.fee_autre_montant = Number(f.montant) || 0;
      }
    });
  } catch (_) { /* ancien format non structuré */ }
  return values;
}

export async function render() {
  const hashParams = new URLSearchParams(location.hash.split('?')[1] || '');
  const id = hashParams.get('id');
  // Compteur mensuel : la fiche s'ouvre sur le mois en cours de recouvrement,
  // pour que « Loyers encaissés » indique bien ce qui a été récolté CE mois-ci
  // et non le cumul depuis l'entrée du locataire. Les retards des mois
  // précédents ne sont pas perdus : ils sont affichés à part (« Arriérés
  // antérieurs »), et le sélecteur de période permet de revoir tout
  // l'historique.
  const selectedPeriod = periodState(hashParams, 'current');
  if (!id) { location.hash = '#/maisons'; return; }

  const content = document.getElementById('content');
  content.innerHTML = '<div class="spinner"></div>';
  let data;
  try { data = await api.get('/api/properties/' + id + '/details?' + periodQuery(selectedPeriod)); }
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
  // Retards des mois situés AVANT la période affichée : montrés à part pour ne
  // jamais gonfler les compteurs du mois en cours de recouvrement.
  const totalArrieres = totals.total_arrieres || 0;
  const locationText = [p.ville, p.commune, p.quartier].filter(Boolean).join(' · ') || '—';

  // Encaisser un loyer pour un bail, depuis la maison. presetMonth = échéance ciblée.
  function openEncaisser(s, presetMonth) {
    const loyer = s.montant_loyer || 0;
    const pm = presetMonth || previousRentPeriod();
    const avance = presetMonth && presetMonth.echu === false;
    // Un arriéré est un mois échu, antérieur au dernier mois exigible.
    const arriere = !!presetMonth && presetMonth.echu === true
      && `${presetMonth.annee}-${presetMonth.mois}` !== `${previousRentPeriod().annee}-${previousRentPeriod().mois}`;
    // Dès que l'utilisateur choisit lui-même un mois (cas d'un arriéré saisi à
    // la main), on ne le lui écrase plus : changer la date d'encaissement ne
    // doit plus ramener le formulaire au mois en cours de recouvrement.
    let moisChoisiManuellement = false;
    formModal({
      title: (avance ? 'Encaisser par avance — ' : (arriere ? 'Encaisser un arriéré — ' : 'Encaisser un loyer — ')) + (s.tenant_nom || ''),
      fields: [
        { name: 'mois_concerne', label: 'Mois de loyer réglé', type: 'select', required: true, options: MOIS,
          hint: avance
            ? 'Ce mois n’est pas terminé : il s’agit d’un paiement anticipé, il n’est pas réclamé au locataire.'
            : (arriere
              ? `Arriéré : ce règlement sera enregistré sur ${pm.mois} ${pm.annee}, pas sur le mois en cours.`
              : 'Loyers à terme échu : par défaut, le mois précédent. Vous pouvez choisir un mois antérieur pour encaisser un arriéré.') },
        { name: 'annee_concernee', label: 'Année concernée', type: 'number', required: true },
        { name: 'montant_a_payer', label: 'Montant à payer', type: 'number', readonly: true },
        { name: 'montant_paye', label: 'Montant payé', type: 'number', required: true, min: 0 },
        { name: 'date', label: "Date réelle d'encaissement", type: 'date' },
        { name: 'numero_recu', label: 'N° de reçu', placeholder: 'ex. 269' },
      ],
      values: {
        mois_concerne: pm.mois,
        annee_concernee: pm.annee,
        montant_a_payer: loyer,
        // Reste dû si le mois est partiellement/non payé, sinon le loyer plein
        // (cas d'un encaissement anticipé d'un mois « à échoir »).
        montant_paye: pm.reste ? pm.reste : loyer,
        date: fmt.today(),
      },
      onChange: (v, changed, set) => {
        if (changed === 'mois_concerne' || changed === 'annee_concernee') { moisChoisiManuellement = true; return; }
        // La date d'encaissement ne repositionne le mois de loyer que tant que
        // personne ne l'a choisi explicitement.
        if (changed !== 'date' || presetMonth || moisChoisiManuellement || !v.date) return;
        const period = previousRentPeriod(v.date);
        set('mois_concerne', period.mois);
        set('annee_concernee', period.annee);
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
        { name: 'montant', label: 'Montant', type: 'number', min: 0, step: 1, required: true },
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
    try {
      await api.del('/api/repairs/' + row.id);
      toast('Dépense supprimée.');
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function openAddTenants() {
    formModal({
      title: 'Ajouter un locataire dans ce bien',
      size: 'lg',
      submitLabel: 'Ajouter le locataire au bien',
      fields: [
        { name: 'nom_prenoms', label: 'Nom et prénoms', required: true, col: 2 },
        { name: 'contact', label: 'Contact (téléphone)', required: true },
        { name: 'email', label: 'Email' },
        { name: 'adresse', label: 'Adresse', type: 'textarea' },
        { name: 'montant_loyer', label: 'Loyer mensuel du locataire', type: 'number', required: true, min: 1, step: 1, hint: 'Montant propre à ce locataire dans ce bien.' },
        { name: 'date_souscription', label: 'Date de souscription', type: 'date' },
        { name: 'date_entree', label: 'Date d’entrée', type: 'date', required: true },
        { name: 'date_debut_paiement', label: 'Date début de paiement', type: 'date', required: true },
        { name: 'nombre_mois_caution', label: 'Nombre de mois de caution', type: 'number', min: 0 },
        { name: 'montant_caution', label: 'Montant caution', type: 'number', readonly: true },
        { name: 'nombre_mois_garantie', label: 'Nombre de mois de garantie', type: 'number', min: 0 },
        { name: 'montant_garantie', label: 'Montant garantie', type: 'number', readonly: true },
        { name: 'nombre_mois_avance', label: 'Nombre de mois d’avance', type: 'number', min: 0 },
        { name: 'montant_avance', label: 'Montant avance', type: 'number', readonly: true },
        ...tenantFeeFields(),
      ],
      values: {
        date_souscription: fmt.today(), date_entree: fmt.today(), date_debut_paiement: fmt.today(),
        nombre_mois_caution: 2, nombre_mois_garantie: 0, nombre_mois_avance: 1,
        montant_caution: 0, montant_garantie: 0, montant_avance: 0, montant_autre_frais: 0,
      },
      onChange: (v, changed, set) => {
        const loyer = Number(v.montant_loyer) || 0;
        set('montant_caution', (Number(v.nombre_mois_caution) || 0) * loyer);
        set('montant_garantie', (Number(v.nombre_mois_garantie) || 0) * loyer);
        set('montant_avance', (Number(v.nombre_mois_avance) || 0) * loyer);
        set('montant_autre_frais', feesTotal(v));
      },
      onSubmit: async (v) => {
        const loyer = Number(v.montant_loyer) || 0;
        if (loyer <= 0) throw new Error('Veuillez saisir le loyer mensuel de ce locataire.');
        await api.post('/api/tenants', {
          ...v,
          ...serializeFees(v),
          property_id: p.id,
          caution: Number(v.montant_caution) || 0,
          statut: 'Active',
        });
        toast('Locataire ajouté directement dans ce bien.');
        render();
      },
    });
  }

  function openEditTenant(s) {
    formModal({
      title: 'Modifier le locataire et son bail',
      size: 'lg',
      submitLabel: 'Enregistrer les modifications',
      fields: [
        { name: 'nom_prenoms', label: 'Nom et prénoms', required: true, col: 2 },
        { name: 'contact', label: 'Contact (téléphone)', required: true },
        { name: 'email', label: 'Email' },
        { name: 'adresse', label: 'Adresse', type: 'textarea' },
        { name: 'montant_loyer', label: 'Loyer mensuel', type: 'number', required: true, min: 1 },
        { name: 'date_souscription', label: 'Date de souscription', type: 'date' },
        { name: 'date_entree', label: 'Date d’entrée', type: 'date', required: true },
        { name: 'date_debut_paiement', label: 'Date début de paiement', type: 'date', required: true },
        { name: 'nombre_mois_caution', label: 'Nombre de mois de caution', type: 'number', min: 0 },
        { name: 'montant_caution', label: 'Montant caution', type: 'number', readonly: true },
        { name: 'nombre_mois_garantie', label: 'Nombre de mois de garantie', type: 'number', min: 0 },
        { name: 'montant_garantie', label: 'Montant garantie', type: 'number', readonly: true },
        { name: 'nombre_mois_avance', label: 'Nombre de mois d’avance', type: 'number', min: 0 },
        { name: 'montant_avance', label: 'Montant avance', type: 'number', readonly: true },
        ...tenantFeeFields(),
      ],
      values: {
        ...s,
        nom_prenoms: s.tenant_nom || '',
        contact: s.tenant_contact || '',
        email: s.tenant_email || '',
        adresse: s.tenant_adresse || '',
        ...feeValues(s.autre_frais),
      },
      onChange: (v, changed, set) => {
        const loyer = Number(v.montant_loyer) || 0;
        set('montant_caution', (Number(v.nombre_mois_caution) || 0) * loyer);
        set('montant_garantie', (Number(v.nombre_mois_garantie) || 0) * loyer);
        set('montant_avance', (Number(v.nombre_mois_avance) || 0) * loyer);
        set('montant_autre_frais', feesTotal(v));
      },
      onSubmit: async (v) => {
        const fees = serializeFees(v);
        await api.put('/api/subscriptions/' + s.id + '/tenant', {
          ...s,
          ...v,
          ...fees,
          nom_prenoms: v.nom_prenoms,
          contact: v.contact,
          email: v.email,
          adresse: v.adresse,
          caution: Number(v.montant_caution) || 0,
          statut: s.statut,
        });
        toast('Locataire et bail modifiés.');
        render();
      },
    });
  }

  async function deleteTenant(s) {
    const ok = await confirmDialog({
      title: 'Supprimer le locataire', danger: true, okLabel: 'Supprimer',
      message: `Supprimer « ${s.tenant_nom || 'ce locataire'} » et son bail erroné ? Cette action est possible uniquement s’il n’existe aucun paiement.`,
    });
    if (!ok) return;
    try {
      await api.del('/api/tenants/' + s.tenant_id);
      toast('Locataire supprimé.');
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // Le locataire a quitté le bien : on clôture le bail (historique conservé,
  // logement de nouveau disponible).
  async function departTenant(s) {
    const ok = await confirmDialog({
      title: 'Le locataire a quitté ce bien',
      okLabel: 'Confirmer le départ',
      message: `Confirmer que « ${s.tenant_nom || 'ce locataire'} » a quitté ce bien ?\n\nLe bail sera clôturé. L’historique des paiements reste conservé et le logement redevient disponible.`,
    });
    if (!ok) return;
    try {
      await api.post('/api/subscriptions/' + s.id + '/depart', {});
      toast('Locataire retiré du bien.');
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // Suppression définitive du bail (erreur de saisie, doublon…).
  async function deleteSub(s) {
    const ok = await confirmDialog({
      title: 'Supprimer définitivement le bail', danger: true, okLabel: 'Supprimer',
      message: `Supprimer définitivement le bail de « ${s.tenant_nom || 'ce locataire'} » (${s.code}) ?\n\nCette action est irréversible. À n’utiliser qu’en cas d’erreur de saisie.`,
    });
    if (!ok) return;
    try {
      await api.del('/api/subscriptions/' + s.id);
      toast('Bail supprimé.');
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function renderSub(s) {
    const r = s.resume || { total_attendu: 0, total_paye: 0, reste: 0, mois_retard: 0, arrieres: 0, arrieres_mois: 0 };
    const card = el('<div class="card card-pad" style="margin-bottom:14px;border-left:4px solid #2563eb"></div>');
    // « À jour » ne parle que de la période affichée : un locataire peut avoir
    // soldé le mois en cours tout en trainant des arriérés. Le libellé le dit,
    // sinon les deux badges se contredisent à l'écran.
    const retard = r.mois_retard > 0
      ? `<span class="badge badge-red">${r.mois_retard} mois en retard</span>`
      : '<span class="badge badge-green">Période à jour</span>';
    const arriere = r.arrieres > 0
      ? `<span class="badge badge-amber">${r.arrieres_mois} mois d’arriéré</span>`
      : '';
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
            ${arriere}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px;margin:12px 0">
          ${miniStat('Loyer mensuel', fmt.money(s.montant_loyer))}
          ${miniStat('Caution', fmt.money(s.montant_caution))}
          ${miniStat('Avance', fmt.money(s.montant_avance))}
          ${miniStat('Garantie', fmt.money(s.montant_garantie))}
          ${miniStat('Attendu sur la période', fmt.money(r.total_attendu))}
          ${miniStat('Payé sur la période', fmt.money(r.total_paye))}
          ${miniStat('Reste dû sur la période', fmt.money(r.reste), r.reste > 0)}
          ${miniStat('Arriérés antérieurs', fmt.money(r.arrieres || 0), (r.arrieres || 0) > 0)}
        </div>
        ${s.autre_frais || s.montant_autre_frais ? `<div class="muted" style="font-size:13px;margin-bottom:10px">Autres frais : ${displayFees(s.autre_frais)} — total ${fmt.money(s.montant_autre_frais)}</div>` : ''}
      </div>`);
    card.appendChild(head);

    if (s.statut === 'Active') {
      const bar = el('<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"></div>');
      const encBtn = el(`<button class="btn btn-accent btn-sm">${icon('collect', 15)} Encaisser un loyer</button>`);
      encBtn.onclick = () => openEncaisser(s, null);
      bar.appendChild(encBtn);
      const editBtn = el(`<button class="btn btn-ghost btn-sm">${icon('edit', 15)} Modifier</button>`);
      editBtn.onclick = () => openEditTenant(s);
      bar.appendChild(editBtn);
      const deleteTenantBtn = el(`<button class="btn btn-ghost btn-sm" style="color:#b91c1c">${icon('trash', 15)} Supprimer</button>`);
      deleteTenantBtn.onclick = () => deleteTenant(s);
      bar.appendChild(deleteTenantBtn);
      const departBtn = el(`<button class="btn btn-ghost btn-sm" style="color:#b45309">${icon('back', 15)} Le locataire a quitté</button>`);
      departBtn.onclick = () => departTenant(s);
      bar.appendChild(departBtn);
      card.appendChild(bar);

      card.appendChild(dataTable({
        columns: [
          { label: 'Période', render: (m) => `${escapeHtml(m.mois)} ${m.annee}` },
          { label: 'Attendu', num: true, render: (m) => fmt.money(m.attendu) },
          { label: 'Payé', num: true, render: (m) => fmt.money(m.paye) },
          { label: 'Reste', num: true, render: (m) => (m.reste > 0 ? `<b style="color:#b91c1c">${fmt.money(m.reste)}</b>` : fmt.money(0)) },
          { label: 'Statut', render: (m) => badge(m.statut, m.statut === 'Payé' ? 'green' : (m.statut === 'Partiel' ? 'amber' : (m.statut === 'À échoir' ? 'gray' : 'red'))) },
        ],
        rows: s.echeancier || [],
        actions: [
          {
            title: (m) => (m.echu ? 'Encaisser ce mois' : 'Encaisser par avance (mois non terminé)'),
            icon: 'collect',
            variant: 'btn-accent',
            show: (m) => m.reste > 0 || !m.echu,
            onClick: (m) => openEncaisser(s, m),
          },
        ],
        empty: 'Aucune échéance.',
      }));

      // ARRIERES : les mois échus non soldés situés AVANT la période affichée.
      // Ils ont leur propre tableau — visibles et encaissables même quand
      // l'écran est calé sur le mois en cours — mais leurs montants n'entrent
      // pas dans les compteurs du mois.
      const arr = s.arrieres_echeancier || [];
      if (arr.length) {
        card.appendChild(el(`<div style="margin:16px 0 8px">
          <div style="font-weight:800;font-size:13.5px;color:#b45309">
            ${icon('clock', 15)} Arriérés à recouvrer — ${arr.length} mois, ${fmt.money(r.arrieres || 0)}
          </div>
          <div class="muted" style="font-size:12.5px;margin-top:3px">Mois antérieurs restés impayés. Encaisser ici enregistre le loyer <b>sur le mois concerné</b>, pas sur le mois en cours.</div>
        </div>`));
        card.appendChild(dataTable({
          columns: [
            { label: 'Période en retard', render: (m) => `<b>${escapeHtml(m.mois)} ${m.annee}</b>` },
            { label: 'Attendu', num: true, render: (m) => fmt.money(m.attendu) },
            { label: 'Déjà payé', num: true, render: (m) => fmt.money(m.paye) },
            { label: 'Reste dû', num: true, render: (m) => `<b style="color:#b91c1c">${fmt.money(m.reste)}</b>` },
            { label: 'Statut', render: (m) => badge(m.statut, m.statut === 'Partiel' ? 'amber' : 'red') },
          ],
          rows: arr,
          actions: [
            {
              title: (m) => `Encaisser l’arriéré de ${m.mois} ${m.annee}`,
              icon: 'collect',
              variant: 'btn-accent',
              onClick: (m) => openEncaisser(s, m),
            },
          ],
          empty: 'Aucun arriéré.',
        }));
      }
    } else if ((s.paiements || []).length) {
      card.appendChild(dataTable({
        columns: [
          { label: 'Période', render: (m) => escapeHtml(filteredPeriodText(m)) },
          { label: 'Payé', num: true, render: (m) => fmt.money(m.montant_paye) },
          { label: "Date d'encaissement", render: (m) => fmt.date(m.date) },
          { label: 'Statut', render: (m) => badge(m.statut, m.statut === 'Soldé' ? 'green' : 'red') },
        ],
        rows: s.paiements,
        empty: 'Aucun paiement.',
      }));
    } else {
      card.appendChild(el('<p class="muted" style="margin:0">Aucun paiement enregistré.</p>'));
    }

    // Bail désactivé (locataire parti) : permettre la suppression définitive.
    if (s.statut !== 'Active') {
      const bar = el('<div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:10px"></div>');
      const editBtn = el(`<button class="btn btn-ghost btn-sm">${icon('edit', 15)} Modifier le locataire</button>`);
      editBtn.onclick = () => openEditTenant(s);
      bar.appendChild(editBtn);
      const deleteTenantBtn = el(`<button class="btn btn-ghost btn-sm" style="color:#b91c1c">${icon('trash', 15)} Supprimer le locataire</button>`);
      deleteTenantBtn.onclick = () => deleteTenant(s);
      bar.appendChild(deleteTenantBtn);
      const delBtn = el(`<button class="btn btn-ghost btn-sm" style="color:#b91c1c">${icon('trash', 15)} Supprimer définitivement le bail</button>`);
      delBtn.onclick = () => deleteSub(s);
      bar.appendChild(delBtn);
      card.appendChild(bar);
    }
    return card;
  }

  const root = el(`
    <div>
      <button class="btn btn-ghost btn-sm" id="back" style="margin-bottom:12px">${icon('back', 16)} Retour aux biens</button>
      ${periodControls(selectedPeriod)}

      <div class="card card-pad" style="margin-bottom:16px;background:linear-gradient(135deg,#f8fafc,#ffffff);border:1px solid #e2e8f0">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px">
          <div>
            <div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;font-weight:800">Fiche du bien — ${escapeHtml((data.periode && data.periode.label) || '')}</div>
            <div class="muted" style="font-size:12.5px;margin-top:4px">Les montants ci-dessous ne concernent que cette période : le compteur repart de zéro à chaque mois.</div>
            <h2 style="font-size:21px;margin:5px 0 4px;color:#0f172a">${icon('houses', 22)} ${escapeHtml(p.type_construction || 'Bien')}${p.designation ? ' — ' + escapeHtml(p.designation) : ''}</h2>
            <div class="muted" style="font-size:13px">Code : <span style="font-family:monospace;font-weight:800;color:#0f172a">${escapeHtml(p.code)}</span></div>
          </div>
          <div style="display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" id="addTenantsTop">${icon('plus', 15)} Ajouter un locataire</button>
            ${badge(p.statut, p.statut === 'Occupé' ? 'amber' : 'green')}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-top:16px">
          ${miniStat('Locataires actifs', fmt.int(actifs.length))}
          ${miniStat('À jour / En retard', `${fmt.int(actifs.length - enRetard)} / ${fmt.int(enRetard)}`, enRetard > 0)}
          ${miniStat('Loyers attendus', fmt.money(totalAttendu))}
          ${miniStat('Loyers encaissés', fmt.money(totals.total_paye))}
          ${miniStat('Impayés de la période', fmt.money(totalImpaye), totalImpaye > 0)}
          ${miniStat('Arriérés antérieurs', fmt.money(totalArrieres), totalArrieres > 0)}
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
          ${infoLine('Loyer mensuel', 'Défini par locataire')}
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

      ${sectionTitle('Locataires, baux et paiements attendus', 'Chaque locataire lié à ce bien, avec son bail, son échéancier et ses retards. Le loyer se paie à terme échu : le mois en cours reste « À échoir » jusqu’à sa fin.')}
      <div style="display:flex;justify-content:flex-end;margin:-4px 0 12px">
        <button class="btn btn-primary btn-sm" id="addTenants">${icon('plus', 15)} Ajouter un locataire</button>
      </div>
      <div id="subs"></div>

      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px">
        <div>${sectionTitle('Dépenses / réparations du bien', 'Travaux, réparations ou charges déduites du suivi du bien.')}</div>
        <button class="btn btn-primary btn-sm" id="addRepair">${icon('plus', 15)} Ajouter une dépense</button>
      </div>
      <div id="repairs"></div>

      ${sectionTitle('Paiements du bien sur la période', 'Encaissements correspondant à la période sélectionnée, tous locataires confondus.')}
      <div id="payments"></div>

      ${sectionTitle('Reversements liés à ce bien', 'Reversements propriétaire contenant au moins un paiement de ce bien.')}
      <div id="payouts"></div>
    </div>`);
  pageHeader(root);
  bindPeriodControls(root, selectedPeriod, (next) => {
    location.hash = `#/bien?id=${encodeURIComponent(id)}&${periodQuery(next)}`;
  });
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
      { label: 'Période', render: (r) => escapeHtml(filteredPeriodText(r)) },
      { label: "Date d'encaissement", render: (r) => fmt.date(r.date) },
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
