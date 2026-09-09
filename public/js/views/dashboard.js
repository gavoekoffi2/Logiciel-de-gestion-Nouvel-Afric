import { api, icon, el, escapeHtml, fmt, badge, store, pageHeader } from '../core.js';
import { periodState, periodQuery, periodControls, bindPeriodControls, filteredPeriodText } from '../periodControls.js';

function stat(icClass, icName, value, label) {
  return `<div class="stat"><div class="ic ${icClass}">${icon(icName, 24)}</div><div><div class="v">${value}</div><div class="l">${label}</div></div></div>`;
}

export async function render() {
  // Compteur mensuel : le tableau de bord s'ouvre sur le mois en cours de
  // recouvrement, jamais sur un cumul. Les chiffres repartent donc de zéro à
  // chaque nouveau mois ; « Depuis janvier » et « Toutes les périodes » restent
  // accessibles dans le sélecteur de période.
  const selectedPeriod = periodState(new URLSearchParams(location.hash.split('?')[1] || ''), 'current');
  const d = await api.get('/api/dashboard?' + periodQuery(selectedPeriod));
  const prenom = (store.user.nom || store.user.email || 'utilisateur').split(' ')[0];

  const pct = d.loyer_attendu > 0 ? Math.min(100, Math.round((d.loyer_encaisse_mois / d.loyer_attendu) * 100)) : 0;

  const root = el(`
    <div>
      <div class="card card-pad" style="background:linear-gradient(120deg,#0f6e4f,#0b5740);color:#eafff6;border:none;margin-bottom:18px">
        <h2 style="color:#fff;font-size:20px">Bonjour ${escapeHtml(prenom)} 👋</h2>
        <p style="margin:6px 0 0;color:#bfe9d8">Voici la situation de votre parc locatif — ${escapeHtml((d.periode && d.periode.label) || `${d.moisCourant} ${d.anneeCourante}`)}.</p>
      </div>

      ${periodControls(selectedPeriod)}

      <div class="grid stats-grid">
        ${stat('ic-brand', 'owners', fmt.int(d.nb_proprietaires), 'Propriétaires')}
        ${stat('ic-blue', 'tenants', fmt.int(d.nb_locataires), 'Locataires')}
        ${stat('ic-amber', 'houses', fmt.int(d.nb_maisons), 'Biens / Maisons')}
        ${stat('ic-green', 'building', fmt.int(d.nb_disponibles) + ' / ' + fmt.int(d.nb_occupees), 'Disponibles / Occupés')}
      </div>

      <div class="section-title">${icon('money', 18)} Finances — ${escapeHtml((d.periode && d.periode.label) || '')}</div>
      <div class="muted" style="font-size:12.5px;margin:-6px 0 10px">Loyers encaissés et impayés : <b>période affichée uniquement</b>, le compteur repart de zéro à chaque mois. Cautions, avances et « à reverser » sont des <b>encours</b> : de l’argent détenu ou dû tant qu’il n’a pas été restitué ou reversé. Les biens supprimés ne comptent dans aucune de ces tuiles.</div>
      <div class="grid stats-grid">
        ${stat('ic-green', 'wallet', fmt.money(d.total_loyer), 'Total loyers encaissés')}
        ${stat('ic-blue', 'money', fmt.money(d.total_caution), 'Cautions détenues (baux actifs)')}
        ${stat('ic-amber', 'money', fmt.money(d.total_avance), 'Avances détenues (baux actifs)')}
        ${stat('ic-red', 'payments', fmt.money(d.impayes_montant), 'Impayés (' + d.impayes_nombre + ')')}
        ${stat('ic-brand', 'owners', fmt.money(d.reste_a_reverser || 0), 'À reverser (total en attente)')}
      </div>

      <div class="grid" style="grid-template-columns:1.1fr 1fr;align-items:start;margin-top:18px" id="bottomGrid">
        <div class="card card-pad">
          <h3 style="font-size:15px;margin-bottom:6px">Recouvrement — ${escapeHtml((d.periode && d.periode.label) || '')}</h3>
          <div class="muted" style="font-size:12px;margin-bottom:4px">Comparaison des loyers attendus et encaissés sur la période sélectionnée.</div>
          <div style="display:flex;justify-content:space-between;font-size:13px;color:#475569;margin:10px 0 6px">
            <span>Encaissé : <b style="color:#15803d">${fmt.money(d.loyer_encaisse_mois)}</b></span>
            <span>Attendu : <b>${fmt.money(d.loyer_attendu)}</b></span>
          </div>
          <div style="height:12px;background:#eef2f6;border-radius:99px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#16a34a,#0f6e4f);border-radius:99px"></div>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:13px">
            <span class="muted">${pct}% recouvré</span>
            <span>Reste attendu : <b style="color:#b45309">${fmt.money(d.reste_attendu_mois)}</b></span>
          </div>
          <div class="section-title" style="margin:20px 0 10px;font-size:14px">Derniers paiements</div>
          <div id="recent"></div>
        </div>

        <div class="card card-pad">
          <h3 style="font-size:15px;margin-bottom:12px">Biens disponibles</h3>
          <div id="dispo"></div>
        </div>
      </div>
    </div>`);
  pageHeader(root);
  bindPeriodControls(root, selectedPeriod, (next) => {
    location.hash = '#/dashboard?' + periodQuery(next);
  });

  // Derniers paiements
  const recent = root.querySelector('#recent');
  if (!d.derniers_paiements.length) {
    recent.innerHTML = '<p class="muted">Aucun paiement enregistré.</p>';
  } else {
    recent.innerHTML = `<div class="table-wrap"><table class="data"><tbody>${
      d.derniers_paiements.map((p) => `<tr>
        <td><b>${escapeHtml(p.tenant_nom || '—')}</b><br><span class="muted" style="font-size:12px">${escapeHtml(filteredPeriodText(p))}</span></td>
        <td class="num">${fmt.money(p.montant_paye)}</td>
        <td>${badge(p.statut, p.statut === 'Soldé' ? 'green' : 'red')}</td>
      </tr>`).join('')
    }</tbody></table></div>`;
  }

  // Biens disponibles
  const dispo = root.querySelector('#dispo');
  if (!d.maisons_disponibles.length) {
    dispo.innerHTML = '<p class="muted">Tous les biens sont actuellement occupés. 🎉</p>';
  } else {
    dispo.innerHTML = d.maisons_disponibles.map((m) => `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #eef2f6">
        <div class="ic ic-green" style="width:38px;height:38px;border-radius:10px">${icon('houses', 19)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:13.5px">${escapeHtml(m.type_construction || 'Bien')} · ${m.nombre_piece || '?'} pièces</div>
          <div class="muted" style="font-size:12.5px">${escapeHtml([m.commune, m.quartier].filter(Boolean).join(' · ') || m.ville || '')}</div>
        </div>
        <div style="font-weight:800;color:#0b5740;white-space:nowrap">${fmt.money(m.cout_loyer)}</div>
      </div>`).join('');
  }

  // Responsive : empiler sur petit ecran
  if (window.matchMedia('(max-width: 800px)').matches) {
    root.querySelector('#bottomGrid').style.gridTemplateColumns = '1fr';
  }
}
