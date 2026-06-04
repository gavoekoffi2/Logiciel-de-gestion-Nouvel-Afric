// =========================================================================
// core.js — utilitaires partages : API, formatage, modales, tableaux, toasts
// =========================================================================

export const store = { user: null, settings: { entreprise: 'NOUVEL AFRIC', devise: 'FCFA' } };

// ---------- API ----------------------------------------------------------
async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Session expirée'); }
  let data = null;
  const txt = await res.text();
  if (txt) { try { data = JSON.parse(txt); } catch { data = txt; } }
  // 402 : abonnement inactif (essai terminé / abonnement expiré / suspendu).
  if (res.status === 402) {
    if (typeof window !== 'undefined' && window.__subscriptionBlocked) window.__subscriptionBlocked(data || {});
    const err = new Error((data && data.error) || 'Abonnement inactif');
    err.code = 'subscription';
    throw err;
  }
  if (!res.ok) throw new Error((data && data.error) || 'Une erreur est survenue');
  return data;
}
export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b),
  put: (u, b) => request('PUT', u, b),
  del: (u) => request('DELETE', u),
};

// ---------- Formatage ----------------------------------------------------
export const fmt = {
  money(n) {
    const v = Math.round(Number(n) || 0);
    const dev = (store.settings && store.settings.devise) || 'FCFA';
    return v.toLocaleString('fr-FR').replace(/ /g, ' ') + ' ' + dev;
  },
  int(n) { return (Math.round(Number(n) || 0)).toLocaleString('fr-FR').replace(/ /g, ' '); },
  date(iso) {
    if (!iso) return '—';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    const d = new Date(iso);
    return isNaN(d) ? String(iso) : d.toLocaleDateString('fr-FR');
  },
  today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
};

export const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

// Telecharge un objet JSON sous forme de fichier (export des donnees).
export function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Montant en toutes lettres (francais) -------------------------
const UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
  'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];

function below100(x, isLast) {
  if (x < 20) return UNITS[x];
  const t = Math.floor(x / 10), u = x % 10;
  if (t >= 2 && t <= 6) {
    const base = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'][t];
    if (u === 0) return base;
    if (u === 1) return base + ' et un';
    return base + '-' + UNITS[u];
  }
  if (t === 7) {
    if (u === 0) return 'soixante-dix';
    if (u === 1) return 'soixante et onze';
    return 'soixante-' + UNITS[10 + u];
  }
  if (t === 8) {
    if (u === 0) return isLast ? 'quatre-vingts' : 'quatre-vingt';
    return 'quatre-vingt-' + UNITS[u];
  }
  // t === 9
  if (u === 0) return 'quatre-vingt-dix';
  return 'quatre-vingt-' + UNITS[10 + u];
}

function troisChiffres(x, isLast) {
  const c = Math.floor(x / 100), r = x % 100;
  if (c === 0) return below100(r, isLast);
  let s = c === 1 ? 'cent' : UNITS[c] + ' cent';
  if (c > 1 && r === 0 && isLast) s += 's';
  if (r > 0) s += ' ' + below100(r, isLast);
  return s;
}

export function montantEnLettres(n) {
  n = Math.round(Number(n) || 0);
  if (n === 0) return 'zéro';
  const neg = n < 0; n = Math.abs(n);
  const mil = Math.floor(n / 1000000);
  const mille = Math.floor((n % 1000000) / 1000);
  const reste = n % 1000;
  const parts = [];
  if (mil > 0) parts.push(mil === 1 ? 'un million' : troisChiffres(mil, true) + ' millions');
  if (mille > 0) parts.push(mille === 1 ? 'mille' : troisChiffres(mille, false) + ' mille');
  if (reste > 0) parts.push(troisChiffres(reste, true));
  return (neg ? 'moins ' : '') + parts.join(' ');
}

// ---------- DOM ----------------------------------------------------------
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Icones SVG ---------------------------------------------------
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
  owners: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  houses: '<path d="M3 9.5 12 3l9 6.5"/><path d="M5 10v10h14V10"/><rect x="10" y="14" width="4" height="6"/>',
  tenants: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 11 2 2 4-4"/>',
  subscriptions: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
  payments: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  users: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  money: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  print: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>',
  collect: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="m9 14 2 2 4-4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
};
export function icon(name, size = 19) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

// ---------- Toasts -------------------------------------------------------
export function toast(message, type = 'success') {
  const box = document.getElementById('toasts');
  const t = el(`<div class="toast ${type}">${escapeHtml(message)}</div>`);
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3200);
}

// ---------- Modale generique --------------------------------------------
export function openModal(innerHtml, { size = '' } = {}) {
  const overlay = el(`<div class="modal-overlay"><div class="modal ${size}">${innerHtml}</div></div>`);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  return { overlay, close, modal: overlay.querySelector('.modal') };
}

export function confirmDialog({ title = 'Confirmation', message, danger = false, okLabel = 'Confirmer' }) {
  return new Promise((resolve) => {
    const { overlay, close } = openModal(`
      <div class="modal-head"><h3>${escapeHtml(title)}</h3></div>
      <div class="modal-body">${escapeHtml(message)}</div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-no>Annuler</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${escapeHtml(okLabel)}</button>
      </div>`);
    overlay.querySelector('[data-no]').onclick = () => { close(); resolve(false); };
    overlay.querySelector('[data-yes]').onclick = () => { close(); resolve(true); };
  });
}

// ---------- Formulaire en modale ----------------------------------------
// fields: { name, label, type, required, options, readonly, value, placeholder, col, hint, min, max, step }
// onChange(values, changedName, setField) ; onSubmit(values) -> peut lever une erreur (affichee).
export function formModal({ title, fields, values = {}, size = '', submitLabel = 'Enregistrer', onChange, onSubmit }) {
  return new Promise((resolve) => {
    const fieldHtml = fields.map((f) => {
      if (f.type === 'hidden') return '';
      const v = values[f.name] ?? f.value ?? '';
      const col = f.col === 2 || f.type === 'textarea' ? ' col-2' : '';
      const req = f.required ? ' <span class="req">*</span>' : '';
      const ro = f.readonly ? ' readonly' : '';
      let input;
      if (f.type === 'select') {
        const opts = (f.options || []).map((o) => {
          const val = typeof o === 'object' ? o.value : o;
          const lab = typeof o === 'object' ? o.label : o;
          return `<option value="${escapeHtml(val)}"${String(val) === String(v) ? ' selected' : ''}>${escapeHtml(lab)}</option>`;
        }).join('');
        input = `<select name="${f.name}"${f.required ? ' required' : ''}><option value="">— choisir —</option>${opts}</select>`;
      } else if (f.type === 'textarea') {
        input = `<textarea name="${f.name}" placeholder="${escapeHtml(f.placeholder || '')}"${ro}>${escapeHtml(v)}</textarea>`;
      } else {
        const t = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
        const extra = f.type === 'number' ? ` step="${f.step || 1}"${f.min !== undefined ? ` min="${f.min}"` : ''}${f.max !== undefined ? ` max="${f.max}"` : ''}` : '';
        input = `<input type="${t}" name="${f.name}" value="${escapeHtml(v)}" placeholder="${escapeHtml(f.placeholder || '')}"${ro}${extra}/>`;
      }
      return `<div class="field${col}"><label>${escapeHtml(f.label)}${req}</label>${input}${f.hint ? `<div class="hint">${escapeHtml(f.hint)}</div>` : ''}</div>`;
    }).join('');

    const { overlay, close, modal } = openModal(`
      <div class="modal-head"><h3>${escapeHtml(title)}</h3><button class="close" data-close>&times;</button></div>
      <form id="modalForm">
        <div class="modal-body">
          <div id="formError" class="alert alert-error" style="display:none"></div>
          <div class="form-grid">${fieldHtml}</div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn btn-ghost" data-close>Annuler</button>
          <button type="submit" class="btn btn-primary" id="formSubmit">${escapeHtml(submitLabel)}</button>
        </div>
      </form>`, { size });

    const form = modal.querySelector('#modalForm');
    const errBox = modal.querySelector('#formError');
    const getValues = () => {
      const out = {};
      fields.forEach((f) => {
        const input = form.elements[f.name];
        if (!input) { if (values[f.name] !== undefined) out[f.name] = values[f.name]; return; }
        out[f.name] = f.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value;
      });
      return out;
    };
    const setField = (name, val) => { if (form.elements[name]) form.elements[name].value = val; };

    if (onChange) {
      form.addEventListener('input', (e) => {
        const changed = e.target.name;
        onChange(getValues(), changed, setField);
      });
      onChange(getValues(), null, setField); // calcul initial
    }

    modal.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { close(); resolve(null); }; });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.style.display = 'none';
      const btn = modal.querySelector('#formSubmit');
      btn.disabled = true; btn.textContent = 'Enregistrement…';
      try {
        const result = onSubmit ? await onSubmit(getValues()) : getValues();
        close();
        resolve(result ?? getValues());
      } catch (err) {
        errBox.textContent = err.message || 'Erreur';
        errBox.style.display = 'block';
        btn.disabled = false; btn.textContent = submitLabel;
      }
    });
  });
}

// ---------- Tableau de donnees ------------------------------------------
// columns: { label, render(row)->html|string, num }
// actions: { title, variant, icon, show(row), onClick(row) }
export function dataTable({ columns, rows, actions = [], empty = 'Aucune donnée pour le moment.' }) {
  const wrap = el('<div class="table-wrap"></div>');
  if (!rows || rows.length === 0) {
    wrap.appendChild(el(`<div class="empty">${icon('inbox', 46)}<div>${escapeHtml(empty)}</div></div>`));
    return wrap;
  }
  const table = el('<table class="data"></table>');
  const thead = el('<thead><tr></tr></thead>');
  const htr = thead.querySelector('tr');
  columns.forEach((c) => htr.appendChild(el(`<th class="${c.num ? 'num' : ''}">${escapeHtml(c.label)}</th>`)));
  if (actions.length) htr.appendChild(el('<th class="actions">Actions</th>'));
  table.appendChild(thead);

  const tbody = el('<tbody></tbody>');
  rows.forEach((row) => {
    const tr = el('<tr></tr>');
    columns.forEach((c) => {
      const td = el(`<td class="${c.num ? 'num' : ''}"></td>`);
      const val = c.render ? c.render(row) : '';
      if (val instanceof Node) td.appendChild(val); else td.innerHTML = val;
      tr.appendChild(td);
    });
    if (actions.length) {
      const td = el('<td class="actions"></td>');
      actions.forEach((a) => {
        if (a.show && !a.show(row)) return;
        const b = el(`<button class="btn btn-icon btn-sm ${a.variant || 'btn-ghost'}" title="${escapeHtml(a.title || '')}">${icon(a.icon, 16)}</button>`);
        b.onclick = () => a.onClick(row);
        td.appendChild(b);
        td.appendChild(document.createTextNode(' '));
      });
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

export function badge(text, variant) { return `<span class="badge badge-${variant}">${escapeHtml(text)}</span>`; }

// Affiche un code tronque (l'integralite apparait au survol).
export function codeCell(code) {
  const c = escapeHtml(code || '—');
  return `<span class="code-cell" title="${c}">${c}</span>`;
}

// ---------- En-tete de page ---------------------------------------------
export function pageHeader(content) {
  const c = document.getElementById('content');
  c.innerHTML = '';
  const node = typeof content === 'string' ? el(content) : content;
  c.appendChild(node);
  return c;
}

// ---------- Impression (recu / contrat) ---------------------------------
export function printDocument(title, bodyHtml) {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) { toast('Veuillez autoriser les fenêtres pop-up pour imprimer.', 'error'); return; }
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: "Segoe UI", Arial, sans-serif; color: #1f2a37; margin: 0; padding: 28px 34px; }
    .doc-head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #0f6e4f; padding-bottom:14px; margin-bottom:8px; }
    .doc-head .ent { font-size:22px; font-weight:800; color:#0b5740; letter-spacing:.5px; }
    .doc-head .coord { font-size:12.5px; color:#475569; margin-top:4px; line-height:1.5; }
    .doc-logo { width:60px;height:60px; }
    h2.doc-title { text-align:center; font-size:18px; letter-spacing:1px; margin:18px 0; padding:8px; background:#f1f5f9; border-radius:8px; }
    table.kv { width:100%; border-collapse:collapse; margin:6px 0; }
    table.kv td { padding:7px 6px; border-bottom:1px solid #e8edf2; font-size:14px; vertical-align:top; }
    table.kv td.k { color:#475569; width:48%; font-weight:600; }
    table.kv td.v { font-weight:700; }
    .lettres { font-style:italic; color:#0b5740; font-weight:600; }
    .montant-fort td { background:#f0faf5; }
    .sign { display:flex; justify-content:space-between; margin-top:54px; }
    .sign div { text-align:center; width:42%; font-size:13px; color:#475569; }
    .sign .line { border-top:1px solid #94a3b8; margin-bottom:6px; height:46px; }
    .foot { margin-top:34px; text-align:center; font-size:11px; color:#94a3b8; border-top:1px solid #e8edf2; padding-top:10px; }
    @media print { body { padding:10px 16px; } .no-print { display:none; } }
    .toolbar-print { text-align:center; margin-bottom:16px; }
    .toolbar-print button { font-size:14px; padding:9px 22px; border:none; border-radius:8px; background:#0f6e4f; color:#fff; font-weight:700; cursor:pointer; }
  </style></head><body>
  <div class="toolbar-print no-print"><button onclick="window.print()">🖨️ Imprimer / Enregistrer en PDF</button></div>
  ${bodyHtml}
  <div class="foot">Document généré par le logiciel de gestion locative — ${escapeHtml(store.settings.entreprise || 'NOUVEL AFRIC')}</div>
  </body></html>`);
  w.document.close();
  w.focus();
}

export function docHeader() {
  const s = store.settings || {};
  const logo = s.logo || '/assets/logo.svg';
  return `<div class="doc-head">
    <div>
      <div class="ent">${escapeHtml(s.entreprise || 'NOUVEL AFRIC')}</div>
      <div class="coord">
        ${s.telephone ? 'Tél : ' + escapeHtml(s.telephone) + '<br>' : ''}
        ${s.email ? 'Email : ' + escapeHtml(s.email) + '<br>' : ''}
        ${s.adresse ? escapeHtml(s.adresse) : ''}
      </div>
    </div>
    <img src="${logo}" class="doc-logo" alt="">
  </div>`;
}
