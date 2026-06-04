import { api, icon, el, escapeHtml, dataTable, badge, fmt, pageHeader } from '../core.js';

const ACTION_VARIANT = { 'Création': 'green', 'Modification': 'amber', 'Suppression': 'red' };

// Affiche date + heure (le journal enregistre l'heure locale).
function dateTime(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]} à ${m[4]}:${m[5]}`;
  return fmt.date(iso);
}

export async function render() {
  let q = '';
  const root = el(`
    <div>
      <div class="toolbar">
        <div class="search">${icon('search', 17)}<input type="text" id="search" placeholder="Rechercher (utilisateur, action, élément…)" /></div>
        <div class="spacer"></div>
        <div class="muted" style="font-size:13px;display:flex;align-items:center;gap:6px">${icon('clock', 15)} Qui a fait quoi dans le logiciel</div>
      </div>
      <div id="list"></div>
    </div>`);
  pageHeader(root);
  const listBox = root.querySelector('#list');

  async function load() {
    listBox.innerHTML = '<div class="spinner"></div>';
    const rows = await api.get('/api/audit' + (q ? '?q=' + encodeURIComponent(q) : ''));
    listBox.innerHTML = '';
    listBox.appendChild(dataTable({
      columns: [
        { label: 'Date & heure', render: (r) => dateTime(r.created_at) },
        { label: 'Utilisateur', render: (r) => `<b>${escapeHtml(r.user_nom || r.current_nom || r.current_email || '—')}</b>` },
        { label: 'Action', render: (r) => badge(r.action || '—', ACTION_VARIANT[r.action] || 'gray') },
        { label: 'Élément', render: (r) => escapeHtml(r.entity || '—') },
        { label: 'Détail', render: (r) => escapeHtml(r.label || '—') },
      ],
      rows,
      empty: 'Aucune activité enregistrée pour le moment.',
    }));
  }

  let timer;
  root.querySelector('#search').addEventListener('input', (e) => {
    q = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(load, 250);
  });
  await load();
}
