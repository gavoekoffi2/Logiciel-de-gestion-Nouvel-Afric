import { api, icon, el, escapeHtml, dataTable, formModal, confirmDialog, toast, badge, fmt, pageHeader, codeCell } from '../core.js';

const TYPES = ["Maison à l'immeuble", 'Maison basse', 'Maison composée'];

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
    listBox.appendChild(dataTable({
      columns: [
        { label: 'Code', render: (r) => codeCell(r.code) },
        { label: 'Propriétaire', render: (r) => escapeHtml(r.owner_nom || '—') },
        { label: 'Type', render: (r) => escapeHtml(r.type_construction || '—') },
        { label: 'Pièces', num: true, render: (r) => r.nombre_piece ?? '—' },
        { label: 'Loyer', num: true, render: (r) => fmt.money(r.cout_loyer) },
        { label: 'Localisation', render: (r) => escapeHtml([r.commune, r.quartier].filter(Boolean).join(' · ') || r.ville || '—') },
        { label: 'Commission', num: true, render: (r) => (r.part_commission || 0) + ' %' },
        { label: 'Statut', render: (r) => badge(r.statut, r.statut === 'Occupé' ? 'amber' : 'green') },
      ],
      rows,
      actions: [
        { title: 'Modifier', icon: 'edit', onClick: (r) => openForm(r) },
        { title: 'Supprimer', icon: 'trash', onClick: (r) => remove(r) },
      ],
      empty: 'Aucun bien enregistré.',
    }));
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
        { name: 'type_construction', label: 'Type de construction', type: 'select', required: true, options: TYPES },
        { name: 'nombre_piece', label: 'Nombre de pièces', type: 'number', required: true, min: 0 },
        { name: 'cout_loyer', label: 'Coût du loyer (mensuel)', type: 'number', required: true, min: 0, step: 1000 },
        { name: 'nombre_porte', label: 'Nombre de portes', type: 'number', min: 0 },
        { name: 'part_commission', label: 'Part commission (%)', type: 'number', min: 0, max: 100, hint: 'Pourcentage perçu par l’agence (≤ 100).' },
        { name: 'ville', label: 'Ville' },
        { name: 'commune', label: 'Commune' },
        { name: 'quartier', label: 'Quartier' },
        { name: 'observation', label: 'Observation', type: 'textarea' },
      ],
      values: row || { part_commission: 0, ville: 'ABIDJAN' },
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
