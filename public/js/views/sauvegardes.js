// Sauvegarde / restauration des donnees de l'entreprise.
// Chaque administrateur d'entreprise peut exporter ses propres donnees et les
// restaurer sans acceder aux donnees des autres entreprises.
import {
  api, el, icon, toast, confirmDialog, pageHeader, downloadJSON,
} from '../core.js';

function countLabel(data) {
  const d = (data && data.donnees) || {};
  const n = (k) => (Array.isArray(d[k]) ? d[k].length : 0);
  return [
    `${n('owners')} propriétaire(s)`,
    `${n('tenants')} locataire(s)`,
    `${n('properties')} bien(s)`,
    `${n('subscriptions')} souscription(s)`,
    `${n('payments')} règlement(s)`,
    `${n('payouts')} reversement(s)`,
    `${n('repairs')} réparation(s)`,
  ].join(' · ');
}

async function render() {
  const root = el(`
    <div class="grid" style="grid-template-columns:1fr;gap:18px;max-width:900px">
      <div class="card card-pad">
        <h3 style="font-size:16px;margin-bottom:6px">Sauvegarde de mon entreprise</h3>
        <p class="muted" style="margin:0 0 16px;font-size:13px">
          Télécharge un fichier JSON contenant uniquement les données de votre entreprise : profil, propriétaires, locataires, biens, souscriptions, règlements, reversements, réparations et journal d’activité.
        </p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-primary" id="exportBtn">${icon('inbox', 16)} Télécharger ma sauvegarde</button>
        </div>
      </div>

      <div class="card card-pad">
        <h3 style="font-size:16px;margin-bottom:6px">Restaurer mes données</h3>
        <p class="muted" style="margin:0 0 12px;font-size:13px">
          À utiliser si vous perdez vos données ou si votre entreprise change d’hébergement. La restauration agit seulement sur votre entreprise connectée.
        </p>
        <div class="alert alert-error" style="margin-bottom:14px">
          Attention : en mode « remplacer », les données actuelles de votre entreprise sont effacées puis remplacées par le fichier. Les autres entreprises ne sont jamais touchées.
        </div>
        <form id="restoreForm" class="form-grid">
          <div class="field col-2"><label>Fichier de sauvegarde entreprise (.json)</label><input type="file" name="file" accept="application/json,.json" /></div>
          <div class="field"><label>Mode</label><select name="mode"><option value="remplacer">Remplacer mes données actuelles</option><option value="fusionner">Fusionner avec mes données actuelles</option></select></div>
          <div class="field"><label>Confirmation</label><input name="confirmation" placeholder="Tapez RESTAURER" /></div>
          <div class="col-2" style="text-align:right"><button class="btn btn-danger" type="submit">Restaurer mes données</button></div>
        </form>
      </div>
    </div>`);
  pageHeader(root);

  root.querySelector('#exportBtn').onclick = async () => {
    try {
      const res = await fetch('/api/data/export');
      if (!res.ok) throw new Error('Export impossible');
      const data = await res.json();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      downloadJSON(`sauvegarde-entreprise-${stamp}.json`, data);
      toast(`Sauvegarde téléchargée : ${countLabel(data)}.`);
    } catch (err) { toast(err.message || 'Export impossible', 'error'); }
  };

  const form = root.querySelector('#restoreForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = form.elements.file.files && form.elements.file.files[0];
    const mode = form.elements.mode.value === 'fusionner' ? 'fusionner' : 'remplacer';
    const confirmation = form.elements.confirmation.value.trim();
    if (!file) return toast('Choisissez un fichier de sauvegarde.', 'error');
    if (confirmation !== 'RESTAURER') return toast('Tapez RESTAURER pour confirmer.', 'error');

    let backup;
    try { backup = JSON.parse(await file.text()); }
    catch (_) { return toast('Fichier JSON invalide.', 'error'); }

    const ok = await confirmDialog({
      title: mode === 'remplacer' ? 'Remplacer mes données' : 'Fusionner mes données',
      danger: mode === 'remplacer',
      okLabel: mode === 'remplacer' ? 'Oui, remplacer' : 'Oui, fusionner',
      message: `${mode === 'remplacer' ? 'Cette action efface les données actuelles de votre entreprise avant restauration.' : 'Cette action ajoute les données du fichier à vos données actuelles.'} Continuer ?`,
    });
    if (!ok) return;

    try {
      const result = await api.post('/api/data/import', { ...backup, mode });
      const c = result.importe || {};
      toast(`Restauration terminée : ${c.owners || 0} propriétaire(s), ${c.tenants || 0} locataire(s), ${c.properties || 0} bien(s), ${c.payments || 0} règlement(s).`);
      form.reset();
    } catch (err) {
      toast(err.message || 'Restauration impossible', 'error');
    }
  });
}

export { render };
