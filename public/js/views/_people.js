// Vue generique pour les "personnes" (Proprietaires et Locataires)
import { api, icon, el, escapeHtml, dataTable, formModal, confirmDialog, toast, pageHeader } from '../core.js';

export function peopleView({ endpoint, titre, singular }) {
  async function render() {
    let q = '';
    const root = el(`
      <div>
        <div class="toolbar">
          <div class="search">
            ${icon('search', 17)}
            <input type="text" id="search" placeholder="Rechercher un ${singular}…" />
          </div>
          <div class="spacer"></div>
          <button class="btn btn-primary" id="addBtn">${icon('plus', 17)} Ajouter</button>
        </div>
        <div id="list"></div>
      </div>`);
    pageHeader(root);

    const listBox = root.querySelector('#list');
    async function load() {
      listBox.innerHTML = '<div class="spinner"></div>';
      const rows = await api.get(`/api/${endpoint}` + (q ? `?q=${encodeURIComponent(q)}` : ''));
      listBox.innerHTML = '';
      listBox.appendChild(dataTable({
        columns: [
          { label: 'Nom & prénoms', render: (r) => `<b>${escapeHtml(r.nom_prenoms)}</b>` },
          { label: 'Contact', render: (r) => escapeHtml(r.contact || '—') },
          { label: 'Email', render: (r) => escapeHtml(r.email || '—') },
          { label: 'Adresse', render: (r) => escapeHtml(r.adresse || '—') },
        ],
        rows,
        actions: [
          { title: 'Modifier', icon: 'edit', onClick: (r) => openForm(r) },
          { title: 'Supprimer', icon: 'trash', variant: 'btn-ghost', onClick: (r) => remove(r) },
        ],
        empty: `Aucun ${singular} enregistré.`,
      }));
    }

    function openForm(row) {
      formModal({
        title: row ? `Modifier le ${singular}` : `Nouveau ${singular}`,
        fields: [
          { name: 'nom_prenoms', label: 'Nom et prénoms', required: true, col: 2 },
          { name: 'contact', label: 'Contact (téléphone)', required: true },
          { name: 'email', label: 'Email' },
          { name: 'adresse', label: 'Adresse', type: 'textarea' },
        ],
        values: row || {},
        onSubmit: async (v) => {
          if (row) await api.put(`/api/${endpoint}/${row.id}`, v);
          else await api.post(`/api/${endpoint}`, v);
          toast(row ? 'Modification enregistrée.' : `${capitalize(singular)} ajouté.`);
          load();
        },
      });
    }

    async function remove(row) {
      const ok = await confirmDialog({
        title: 'Supprimer', danger: true, okLabel: 'Supprimer',
        message: `Souhaitez-vous supprimer « ${row.nom_prenoms} » ?`,
      });
      if (!ok) return;
      await api.del(`/api/${endpoint}/${row.id}`);
      toast('Suppression effectuée.');
      load();
    }

    root.querySelector('#addBtn').onclick = () => openForm(null);
    let timer;
    root.querySelector('#search').addEventListener('input', (e) => {
      q = e.target.value.trim();
      clearTimeout(timer);
      timer = setTimeout(load, 250);
    });

    await load();
  }
  return { render };
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
