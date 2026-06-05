// Vue "Mon abonnement" — etat de l'abonnement, contact pour payer, demande
// d'activation, export des donnees, et changement de mot de passe.
// Sert aussi d'ecran de blocage quand l'abonnement est inactif.
import { api, el, escapeHtml, toast, icon, badge, store, pageHeader, downloadJSON } from '../core.js';

function money(n, dev) {
  return (Math.round(Number(n) || 0)).toLocaleString('fr-FR').replace(/ /g, ' ') + ' ' + (dev || 'FCFA');
}
function frDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}
function telLink(v) { return 'tel:' + String(v || '').replace(/[^\d+]/g, ''); }
function waLink(v) { return 'https://wa.me/' + String(v || '').replace(/[^\d]/g, ''); }

const STATE = {
  actif:    { label: 'Abonnement actif',  variant: 'green' },
  essai:    { label: 'Essai gratuit',     variant: 'amber' },
  expire:   { label: 'Abonnement expiré', variant: 'red' },
  suspendu: { label: 'Compte suspendu',   variant: 'red' },
};

async function exportData() {
  try {
    const data = await api.get('/api/data/export');
    const stamp = new Date().toISOString().slice(0, 10);
    const nom = (data.company && data.company.nom ? data.company.nom : 'entreprise').replace(/[^\w\-]+/g, '_');
    downloadJSON(`donnees-${nom}-${stamp}.json`, data);
    toast('Vos données ont été exportées.');
  } catch (err) { toast(err.message, 'error'); }
}

export async function render() {
  const { company, platform } = await api.get('/api/subscription');
  const c = company || {};
  const p = platform || {};
  const isAdmin = store.user.role === 'admin';
  const isBlocked = !c.actif;
  const dev = p.devise || c.devise || 'FCFA';
  const st = c.illimite ? { label: 'Abonnement illimité', variant: 'green' } : (STATE[c.statut_effectif] || STATE.expire);

  let echeanceLigne = '';
  if (c.illimite) echeanceLigne = 'Abonnement <b>illimité</b> (à vie) — aucune échéance. 🎉';
  else if (c.statut_effectif === 'actif') echeanceLigne = `Valable jusqu’au <b>${frDate(c.echeance)}</b> (${c.jours_restants} jour(s)).`;
  else if (c.statut_effectif === 'essai') echeanceLigne = `Essai jusqu’au <b>${frDate(c.echeance)}</b> — ${c.jours_restants} jour(s) restant(s).`;
  else if (c.statut_effectif === 'suspendu') echeanceLigne = 'Votre compte a été suspendu. Contactez-nous pour le réactiver.';
  else echeanceLigne = 'Votre accès est actuellement bloqué. Abonnez-vous pour continuer.';

  const dejaDemande = c.demande_le
    ? `<div class="alert alert-info" style="margin-top:14px">✅ Demande d’activation envoyée le <b>${frDate(c.demande_le)}</b>. Nous vous contacterons après vérification du paiement.</div>`
    : '';

  const contactLignes = [];
  if (p.contact_telephone) contactLignes.push(`📞 Téléphone : <a href="${telLink(p.contact_telephone)}"><b>${escapeHtml(p.contact_telephone)}</b></a>`);
  if (p.contact_whatsapp) contactLignes.push(`💬 WhatsApp : <a href="${waLink(p.contact_whatsapp)}" target="_blank" rel="noopener"><b>${escapeHtml(p.contact_whatsapp)}</b></a>`);
  if (p.contact_email) contactLignes.push(`✉️ E-mail : <a href="mailto:${escapeHtml(p.contact_email)}"><b>${escapeHtml(p.contact_email)}</b></a>`);

  // Carte tarif/contact : masquee si l'entreprise a un abonnement illimite.
  const carteAbonnement = c.illimite ? '' : `
      <div class="card card-pad">
        <h3 style="font-size:16px;margin-bottom:4px">Abonnement annuel</h3>
        <div style="font-size:26px;font-weight:800;color:var(--brand);margin:6px 0 2px">${money(p.prix_annuel, dev)} <span style="font-size:14px;color:var(--muted);font-weight:600">/ an</span></div>
        <p class="muted" style="margin:8px 0 16px;font-size:14px">${escapeHtml(p.message || 'Contactez-nous pour activer votre abonnement annuel. Dès réception de votre paiement, nous activons votre compte.')}</p>

        <div style="background:#f8fafc;border:1px solid var(--border);border-radius:10px;padding:14px 16px;line-height:2">
          <div style="font-weight:700;margin-bottom:4px">Pour vous abonner, contactez ${escapeHtml(p.nom || 'l’administrateur')} :</div>
          ${contactLignes.join('<br>') || '<span class="muted">Coordonnées non renseignées.</span>'}
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px">
          ${p.contact_whatsapp ? `<a class="btn btn-accent" href="${waLink(p.contact_whatsapp)}" target="_blank" rel="noopener">💬 Écrire sur WhatsApp</a>` : ''}
          <button class="btn btn-primary" id="btnRequest">${icon('collect', 16)} J’ai payé — demander l’activation</button>
        </div>
      </div>`;

  const root = el(`
    <div class="grid" style="grid-template-columns:1fr;gap:18px;max-width:780px">
      ${isBlocked ? `<div class="alert alert-error" style="font-size:14.5px">
        ${st.label}. ${c.statut_effectif === 'suspendu' ? 'Votre espace est temporairement bloqué.' : 'Votre essai est terminé ou votre abonnement a expiré.'}
        Réglez votre abonnement annuel pour réactiver l’accès. <b>Vos données sont conservées</b> (vous pouvez les exporter ci-dessous).
      </div>` : ''}

      ${c.illimite ? '' : `<div class="card card-pad">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px">
          <h3 style="font-size:17px">Mon abonnement</h3>
          ${badge(st.label, st.variant)}
        </div>
        <p class="muted" style="margin:0;font-size:14px">${echeanceLigne}</p>
        ${dejaDemande}
      </div>`}

      ${carteAbonnement}

      ${isAdmin ? `<div class="card card-pad">
        <h3 style="font-size:16px;margin-bottom:4px">Mes données</h3>
        <p class="muted" style="margin:0 0 14px;font-size:14px">Téléchargez une sauvegarde complète de vos données (propriétaires, locataires, biens, baux, règlements). Vous pourrez les réimporter à tout moment depuis <b>Paramètres</b>.</p>
        <button class="btn btn-ghost" id="btnExport">${icon('print', 16)} Exporter mes données</button>
      </div>` : ''}

      <div class="card card-pad">
        <h3 style="font-size:16px;margin-bottom:12px">Changer mon e-mail de connexion</h3>
        <form id="emailForm" class="form-grid">
          <div class="field"><label>Nouvel e-mail</label><input type="email" name="email" autocomplete="email" placeholder="vous@exemple.com" /></div>
          <div class="field"><label>Mot de passe actuel</label><input type="password" name="current" autocomplete="current-password" /></div>
          <div class="col-2" style="text-align:right"><button class="btn btn-primary" type="submit">Mettre à jour l'e-mail</button></div>
        </form>
      </div>

      <div class="card card-pad">
        <h3 style="font-size:16px;margin-bottom:12px">Changer mon mot de passe</h3>
        <form id="pwdForm" class="form-grid">
          <div class="field"><label>Mot de passe actuel</label><input type="password" name="current" autocomplete="current-password" /></div>
          <div class="field"><label>Nouveau mot de passe</label><input type="password" name="password" autocomplete="new-password" /></div>
          <div class="col-2" style="text-align:right"><button class="btn btn-primary" type="submit">Enregistrer</button></div>
        </form>
      </div>
    </div>`);
  pageHeader(root);

  const btnReq = root.querySelector('#btnRequest');
  if (btnReq) btnReq.onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api.post('/api/subscription/request');
      toast(r.message || 'Demande envoyée.', 'success');
      render();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  };

  const btnExp = root.querySelector('#btnExport');
  if (btnExp) btnExp.onclick = exportData;

  const emailForm = root.querySelector('#emailForm');
  if (emailForm) emailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/api/auth/email', { current: emailForm.elements.current.value, email: emailForm.elements.email.value });
      if (r.user) { store.user.email = r.user.email; store.user.username = r.user.username; }
      toast('E-mail de connexion mis à jour.');
      emailForm.reset();
    } catch (err) { toast(err.message, 'error'); }
  });

  const pwdForm = root.querySelector('#pwdForm');
  pwdForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/auth/password', { current: pwdForm.elements.current.value, password: pwdForm.elements.password.value });
      toast('Mot de passe modifié.');
      pwdForm.reset();
    } catch (err) { toast(err.message, 'error'); }
  });
}
