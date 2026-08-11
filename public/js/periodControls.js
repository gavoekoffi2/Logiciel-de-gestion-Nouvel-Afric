const pad = (n) => String(n).padStart(2, '0');
const RENT_MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const VALID_MODES = new Set(['current', 'month', 'range', 'ytd', 'all']);
const safeMonth = (value) => {
  const text = String(value || '');
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text) ? text : '';
};

// Location a terme echu : le loyer d'un mois se recouvre le mois SUIVANT (le
// loyer de juillet est encaisse en aout). Le dernier mois exigible — donc la
// « periode courante » de tous les ecrans de gestion — est le mois precedent.
// Doit rester aligne sur src/rentCycle.js cote serveur.
export function previousRentPeriod(ref = new Date()) {
  const match = String(ref || '').match(/^(\d{4})-(\d{2})/);
  const date = match ? new Date(Number(match[1]), Number(match[2]) - 1, 1) : ref;
  const valid = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const previous = new Date(valid.getFullYear(), valid.getMonth() - 1, 1);
  return {
    mois: RENT_MONTHS[previous.getMonth()],
    annee: previous.getFullYear(),
    value: `${previous.getFullYear()}-${pad(previous.getMonth() + 1)}`,
  };
}

// Valeur 'YYYY-MM' du dernier mois de loyer exigible (borne haute des filtres).
export function dueMonthValue(ref = new Date()) {
  return previousRentPeriod(ref).value;
}

export function periodState(params, defaultMode = 'current') {
  const due = dueMonthValue();
  const dueYear = due.slice(0, 4);
  const requestedMode = params.get('mode') || defaultMode;
  const mode = VALID_MODES.has(requestedMode) ? requestedMode : (VALID_MODES.has(defaultMode) ? defaultMode : 'current');
  let from = safeMonth(params.get('from'));
  let to = safeMonth(params.get('to'));
  if (mode === 'current') from = to = due;
  else if (mode === 'ytd') { from = `${dueYear}-01`; to = due; }
  else if (mode === 'all') { from = ''; to = ''; }
  else if (mode === 'month') { from = from || due; to = from; }
  else { from = from || `${dueYear}-01`; to = to || due; }
  return { mode, from, to };
}

export function periodQuery(state) {
  const p = new URLSearchParams();
  p.set('mode', state.mode);
  if (state.from) p.set('from', state.from);
  if (state.to) p.set('to', state.to);
  return p.toString();
}

export function periodControls(state, { includeAll = true } = {}) {
  const due = dueMonthValue();
  const dueLabel = (() => { const p = previousRentPeriod(); return `${p.mois} ${p.annee}`; })();
  return `
    <div class="card card-pad period-filter" style="margin-bottom:16px;padding:12px 14px">
      <div style="display:flex;align-items:end;gap:10px;flex-wrap:wrap">
        <div class="field" style="margin:0;min-width:230px">
          <label>Période de loyer affichée</label>
          <select data-period-mode>
            <option value="current"${state.mode === 'current' ? ' selected' : ''}>Mois à recouvrer (${dueLabel})</option>
            <option value="month"${state.mode === 'month' ? ' selected' : ''}>Un mois précis</option>
            <option value="range"${state.mode === 'range' ? ' selected' : ''}>Plage de mois</option>
            <option value="ytd"${state.mode === 'ytd' ? ' selected' : ''}>Depuis janvier</option>
            ${includeAll ? `<option value="all"${state.mode === 'all' ? ' selected' : ''}>Toutes les périodes</option>` : ''}
          </select>
        </div>
        <div class="field" data-period-from-wrap style="margin:0;min-width:165px;${['current', 'ytd', 'all'].includes(state.mode) ? 'display:none' : ''}">
          <label data-period-from-label>${state.mode === 'month' ? 'Mois' : 'Du mois'}</label>
          <input type="month" data-period-from max="${due}" value="${state.from}" />
        </div>
        <div class="field" data-period-to-wrap style="margin:0;min-width:165px;${state.mode !== 'range' ? 'display:none' : ''}">
          <label>Au mois</label>
          <input type="month" data-period-to max="${due}" value="${state.to}" />
        </div>
        <div class="muted" style="font-size:12.5px;padding:0 0 9px;max-width:340px">
          Loyers à terme échu : le loyer d’un mois se recouvre le mois suivant.
          Dernier mois exigible : <b>${dueLabel}</b>.
        </div>
      </div>
    </div>`;
}

export function filteredPeriodText(row) {
  const periods = Array.isArray(row && row.periodes_filtrees) ? row.periodes_filtrees : [];
  if (periods.length) return periods.map((p) => `${p.mois} ${p.annee}`).join(', ');
  return row && row.mois_concerne ? `${row.mois_concerne} ${row.annee_concernee || ''}`.trim() : '—';
}

export function bindPeriodControls(root, initialState, onApply) {
  const modeEl = root.querySelector('[data-period-mode]');
  const fromEl = root.querySelector('[data-period-from]');
  const toEl = root.querySelector('[data-period-to]');
  if (!modeEl || !fromEl || !toEl) return;

  // Aucun filtre ne peut depasser le dernier mois exigible : le loyer du mois
  // en cours n'est pas encore du, l'afficher ne ferait que montrer des ecrans
  // vides et laisser croire a un impaye.
  const due = dueMonthValue();
  const capped = (value) => (value && value > due ? due : value);

  const applyMode = (mode) => {
    const dueYear = due.slice(0, 4);
    if (mode === 'current') return onApply({ mode, from: due, to: due });
    if (mode === 'ytd') return onApply({ mode, from: `${dueYear}-01`, to: due });
    if (mode === 'all') return onApply({ mode, from: '', to: '' });
    const start = capped(initialState.from) || due;
    if (mode === 'month') return onApply({ mode, from: start, to: start });
    return onApply({ mode: 'range', from: capped(initialState.from) || `${dueYear}-01`, to: capped(initialState.to) || due });
  };

  modeEl.onchange = () => applyMode(modeEl.value);
  fromEl.onchange = () => {
    const mode = modeEl.value;
    const from = capped(fromEl.value);
    if (!from) return;
    fromEl.value = from;
    onApply({ mode, from, to: mode === 'month' ? from : (capped(toEl.value) || from) });
  };
  toEl.onchange = () => {
    const to = capped(toEl.value);
    if (!to) return;
    toEl.value = to;
    onApply({ mode: 'range', from: capped(fromEl.value) || to, to });
  };
}
