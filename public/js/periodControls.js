const pad = (n) => String(n).padStart(2, '0');
const RENT_MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const VALID_MODES = new Set(['current', 'month', 'range', 'ytd', 'all']);
const safeMonth = (value) => {
  const text = String(value || '');
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text) ? text : '';
};

export function currentMonthValue(ref = new Date()) {
  return `${ref.getFullYear()}-${pad(ref.getMonth() + 1)}`;
}

export function previousRentPeriod(ref = new Date()) {
  const previous = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
  return {
    mois: RENT_MONTHS[previous.getMonth()],
    annee: previous.getFullYear(),
    value: `${previous.getFullYear()}-${pad(previous.getMonth() + 1)}`,
  };
}

export function periodState(params, defaultMode = 'current') {
  const current = currentMonthValue();
  const requestedMode = params.get('mode') || defaultMode;
  const mode = VALID_MODES.has(requestedMode) ? requestedMode : (VALID_MODES.has(defaultMode) ? defaultMode : 'current');
  let from = safeMonth(params.get('from'));
  let to = safeMonth(params.get('to'));
  if (mode === 'current') from = to = current;
  else if (mode === 'ytd') { from = `${new Date().getFullYear()}-01`; to = current; }
  else if (mode === 'all') { from = ''; to = ''; }
  else if (mode === 'month') { from = from || current; to = from; }
  else { from = from || `${new Date().getFullYear()}-01`; to = to || current; }
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
  return `
    <div class="card card-pad period-filter" style="margin-bottom:16px;padding:12px 14px">
      <div style="display:flex;align-items:end;gap:10px;flex-wrap:wrap">
        <div class="field" style="margin:0;min-width:190px">
          <label>Période affichée</label>
          <select data-period-mode>
            <option value="current"${state.mode === 'current' ? ' selected' : ''}>Mois courant</option>
            <option value="month"${state.mode === 'month' ? ' selected' : ''}>Un mois précis</option>
            <option value="range"${state.mode === 'range' ? ' selected' : ''}>Plage de mois</option>
            <option value="ytd"${state.mode === 'ytd' ? ' selected' : ''}>Depuis janvier</option>
            ${includeAll ? `<option value="all"${state.mode === 'all' ? ' selected' : ''}>Toutes les périodes</option>` : ''}
          </select>
        </div>
        <div class="field" data-period-from-wrap style="margin:0;min-width:165px;${['current', 'ytd', 'all'].includes(state.mode) ? 'display:none' : ''}">
          <label data-period-from-label>${state.mode === 'month' ? 'Mois' : 'Du mois'}</label>
          <input type="month" data-period-from value="${state.from}" />
        </div>
        <div class="field" data-period-to-wrap style="margin:0;min-width:165px;${state.mode !== 'range' ? 'display:none' : ''}">
          <label>Au mois</label>
          <input type="month" data-period-to value="${state.to}" />
        </div>
        <div class="muted" style="font-size:12.5px;padding:0 0 9px">Les anciennes données restent enregistrées ; seul l’affichage est filtré.</div>
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

  const applyMode = (mode) => {
    const current = currentMonthValue();
    if (mode === 'current') return onApply({ mode, from: current, to: current });
    if (mode === 'ytd') return onApply({ mode, from: `${new Date().getFullYear()}-01`, to: current });
    if (mode === 'all') return onApply({ mode, from: '', to: '' });
    if (mode === 'month') return onApply({ mode, from: initialState.from || current, to: initialState.from || current });
    return onApply({ mode: 'range', from: initialState.from || `${new Date().getFullYear()}-01`, to: initialState.to || current });
  };

  modeEl.onchange = () => applyMode(modeEl.value);
  fromEl.onchange = () => {
    const mode = modeEl.value;
    if (!fromEl.value) return;
    onApply({ mode, from: fromEl.value, to: mode === 'month' ? fromEl.value : (toEl.value || fromEl.value) });
  };
  toEl.onchange = () => {
    if (!toEl.value) return;
    onApply({ mode: 'range', from: fromEl.value || toEl.value, to: toEl.value });
  };
}
