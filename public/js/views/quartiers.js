import { api, icon, el, escapeHtml, badge, fmt, pageHeader } from '../core.js';

function propertyCard(r) {
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
      </div>
    </div>`);
  card.querySelector('[data-enter]').onclick = () => { location.hash = '#/bien?id=' + r.id; };
  return card;
}

export async function render() {
  const quartier = new URLSearchParams(location.hash.split('?')[1] || '').get('name');
  const root = el('<div><div id="box"></div></div>');
  pageHeader(root);
  const box = root.querySelector('#box');
  box.innerHTML = '<div class="spinner"></div>';
  const rows = await api.get('/api/properties');

  if (quartier) {
    const decoded = decodeURIComponent(quartier);
    const props = rows.filter((p) => (p.quartier || 'Sans quartier') === decoded);
    box.innerHTML = '';
    const header = el(`
      <div style="margin-bottom:14px">
        <button class="btn btn-ghost btn-sm" id="back">${icon('back', 16)} Retour aux quartiers</button>
        <div class="card card-pad" style="margin-top:12px;background:linear-gradient(135deg,#f8fafc,#fff)">
          <div class="muted" style="text-transform:uppercase;font-size:12px;font-weight:800;letter-spacing:.08em">Quartier</div>
          <h2 style="margin:4px 0;color:#0f172a">${escapeHtml(decoded)}</h2>
          <div class="muted">${fmt.int(props.length)} bien(s) dans ce quartier. Entrez dans un bien pour voir son propriétaire, ses locataires, paiements, dépenses et reversements.</div>
        </div>
      </div>`);
    header.querySelector('#back').onclick = () => { location.hash = '#/quartiers'; };
    box.appendChild(header);
    const grid = el('<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(285px,1fr));gap:14px"></div>');
    props.forEach((p) => grid.appendChild(propertyCard(p)));
    box.appendChild(grid);
    if (!props.length) box.appendChild(el('<div class="card card-pad"><p class="muted" style="margin:0">Aucun bien dans ce quartier.</p></div>'));
    return;
  }

  const grouped = new Map();
  rows.forEach((p) => {
    const key = p.quartier || 'Sans quartier';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(p);
  });
  box.innerHTML = '';
  if (!grouped.size) {
    box.innerHTML = '<div class="card card-pad"><p class="muted" style="margin:0">Aucun quartier trouvé. Ajoutez des biens avec leur quartier.</p></div>';
    return;
  }
  const grid = el('<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px"></div>');
  [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([name, props]) => {
    const occupied = props.filter((p) => p.statut === 'Occupé').length;
    const card = el(`
      <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px;border-left:4px solid #2563eb">
        <div>
          <div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;font-weight:800">Quartier</div>
          <h3 style="font-size:18px;margin:4px 0;color:#0f172a">${escapeHtml(name)}</h3>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
          <div style="background:#f8fafc;border-radius:10px;padding:9px"><div class="muted">Biens</div><b>${fmt.int(props.length)}</b></div>
          <div style="background:#f8fafc;border-radius:10px;padding:9px"><div class="muted">Occupés</div><b>${fmt.int(occupied)}</b></div>
        </div>
        <button class="btn btn-primary btn-sm" data-open style="margin-top:auto">${icon('eye', 15)} Entrer dans le quartier</button>
      </div>`);
    card.querySelector('[data-open]').onclick = () => { location.hash = '#/quartiers?name=' + encodeURIComponent(name); };
    grid.appendChild(card);
  });
  box.appendChild(grid);
}
