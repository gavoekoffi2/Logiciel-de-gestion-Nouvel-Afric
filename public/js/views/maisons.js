import { api, icon, el, escapeHtml, formModal, confirmDialog, toast, badge, fmt, pageHeader } from '../core.js';

const TYPES = ['RDC', 'R+1', 'R+2', 'R+3'];

export async function render() {
  let q = '';
  let statut = '';
  const root = el(`
    <div>
      <div class="toolbar">
        <div class="search">${icon('search', 17)}<input type="text" id="search" placeholder="Rechercher (code, propriétaire, ville…)" /></div>
        <div class="filters">
          <select id="fStatut">
            <option value="">Tous les statuts</option>
            <option value="Disponible">Disponible</option>
            <option value="Occupé">Occupé</option>
          </select>
        </div>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="addBtn">${icon('plus', 17)} Ajouter un bien</button>
      </div>
      <div id="list"></div>
    </div>`);
  pageHeader(root);

  const listBox = root.querySelector('#list');

  async function load() {
    listBox.innerHTML = '<div class="spinner"></div>';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (statut) params.set('statut', statut);
    const rows = await api.get('/api/properties' + (params.toString() ? '?' + params : ''));
    listBox.innerHTML = '';
    if (!rows.length) {
      listBox.innerHTML = '<div class="card card-pad"><p class="muted" style="margin:0">Aucun bien enregistré.</p></div>';
      return;
    }

    const grid = el('<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(285px,1fr));gap:14px"></div>');
    rows.forEach((r) => {
      const loc = [r.commune, r.quartier].filter(Boolean).join(' · ') || r.ville || '—';
      const card = el(`
        <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px;border-left:4px solid ${r.statut === 'Occupé' ? '#f59e0b' : '#10b981'}">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
            <div>
              <div style="font-family:monospace;font-weight:800;color:#0f172a">${escapeHtml(r.code)}</div>
              <h3 style="font-size:16px;margin:4px 0 2px;color:#0f172a">${escapeHtml(r.type_construction || 'Bien')}${r.designation ? ' — ' + escapeHtml(r.designation) : ''}</h3>
              <div class="muted" style="font-size:13px">${escapeHtml(loc)}</div>
            </div>
            <div>${badge(r.statut, r.statut === 'Occupé' ? 'amber' : 'green')}</div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
            <div style="background:#f8fafc;border-radius:10px;padding:9px"><div class="muted">Propriétaire</div><b>${escapeHtml(r.owner_nom || '—')}</b></div>
            <div style="background:#f8fafc;border-radius:10px;padding:9px"><div class="muted">Loyer</div><b>${fmt.money(r.cout_loyer)}</b></div>
            <div style="background:#f8fafc;border-radius:10px;padding:9px"><div class="muted">Portes / apparts</div><b>${fmt.int(r.nombre_porte || 0)}</b></div>
            <div style="background:#f8fafc;border-radius:10px;padding:9px"><div class="muted">Commission</div><b>${fmt.int(r.part_commission || 0)} %</b></div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:auto">
            <button class="btn btn-primary btn-sm" data-enter>${icon('eye', 15)} Entrer dans le bien</button>
            <button class="btn btn-ghost btn-sm" data-edit>${icon('edit', 15)} Modifier</button>
            <button class="btn btn-danger btn-sm" data-del>${icon('trash', 15)}</button>
          </div>
        </div>`);
      card.querySelector('[data-enter]').onclick = () => { location.hash = '#/bien?id=' + r.id; };
      card.querySelector('[data-edit]').onclick = () => openForm(r);
      card.querySelector('[data-del]').onclick = () => remove(r);
      grid.appendChild(card);
    });
    listBox.appendChild(grid);
  }

  async function openForm(row) {
    const owners = await api.get('/api/owners');
    if (owners.length === 0) {
      toast('Veuillez d’abord enregistrer au moins un propriétaire.', 'error');
      return;
    }
    formModal({
      title: row ? 'Modifier le bien' : 'Nouveau bien',
      size: 'lg',
      fields: [
        { name: 'owner_id', label: 'Propriétaire', type: 'select', required: true,
          options: owners.map((o) => ({ value: o.id, label: o.nom_prenoms })) },
        { name: 'type_construction', label: 'Type de bien', type: 'select', required: true, options: TYPES },
        { name: 'designation', label: 'Désignation', required: true, col: 2, placeholder: 'ex. Appartement meublé, studio, magasin…' },
        { name: 'cout_loyer', label: 'Coût du loyer (mensuel)', type: 'number', required: true, min: 0, step: 1000 },
        { name: 'nombre_porte', label: "Nombre d'appartement(s)", type: 'number', min: 0 },
        { name: 'part_commission', label: 'Part commission (%)', type: 'number', min: 0, max: 100, hint: 'Pourcentage perçu par l’agence (≤ 100).' },
        { name: 'ville', label: 'Ville' },
        { name: 'commune', label: 'Commune' },
        { name: 'quartier', label: 'Quartier' },
        { name: 'observation', label: 'Observation', type: 'textarea' },
      ],
      values: row || { part_commission: 0, ville: 'LOMÉ' },
      onSubmit: async (v) => {
        if (row) await api.put('/api/properties/' + row.id, v);
        else await api.post('/api/properties', v);
        toast(row ? 'Bien modifié.' : 'Bien ajouté.');
        load();
      },
    });
  }

  async function remove(row) {
    const ok = await confirmDialog({
      title: 'Supprimer le bien', danger: true, okLabel: 'Supprimer',
      message: `Supprimer le bien « ${row.code} » ? Cette action est irréversible.`,
    });
    if (!ok) return;
    try {
      await api.del('/api/properties/' + row.id);
      toast('Bien supprimé.');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  root.querySelector('#addBtn').onclick = () => openForm(null);
  let timer;
  root.querySelector('#search').addEventListener('input', (e) => {
    q = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(load, 250);
  });
  root.querySelector('#fStatut').addEventListener('change', (e) => { statut = e.target.value; load(); });

  await load();
}
