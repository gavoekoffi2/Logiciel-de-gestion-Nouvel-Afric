import { api, icon, el, escapeHtml, dataTable, formModal, confirmDialog, toast, badge, store, pageHeader, openModal, downloadJSON, fmt } from '../core.js';

// Libellés lisibles des rôles d'entreprise.
const RLAB = { admin: 'Administrateur', assistant: 'Assistant', secretaire: 'Secrétaire' };

// Convertit un fichier image en data URL ; redimensionne les images matricielles
// (max 256 px) pour garder un logo leger. Les SVG sont conserves tels quels.
function fileToLogoDataURL(file) {
  return new Promise((resolve, reject) => {
    if (!file.type || !file.type.startsWith('image/')) return reject(new Error('Veuillez choisir une image.'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Lecture du fichier impossible.'));
    reader.onload = () => {
      const dataUrl = reader.result;
      if (file.type === 'image/svg+xml') return resolve(dataUrl);
      const img = new Image();
      img.onload = () => {
        const max = 256;
        let w = img.width, h = img.height;
        if (!w || !h) return resolve(dataUrl);
        if (w > max || h > max) {
          if (w >= h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; }
        }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        try { resolve(c.toDataURL('image/png')); } catch { resolve(dataUrl); }
      };
      img.onerror = () => reject(new Error('Image invalide.'));
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

export async function render() {
  const root = el(`
    <div class="grid" style="grid-template-columns:1fr;gap:18px;max-width:920px">
      <div class="card card-pad">
        <h3 style="font-size:16px;margin-bottom:4px">Informations de l’entreprise</h3>
        <p class="muted" style="margin:0 0 16px;font-size:13px">Ces informations apparaissent sur les reçus et les contrats imprimés.</p>
        <form id="settingsForm" class="form-grid">
          <div class="field col-2"><label>Nom de l’entreprise</label><input name="entreprise" /></div>
          <div class="field"><label>Téléphone</label><input name="telephone" /></div>
          <div class="field"><label>Email</label><input name="email" /></div>
          <div class="field"><label>Adresse</label><input name="adresse" /></div>
          <div class="field"><label>Devise</label><input name="devise" placeholder="FCFA" /></div>
          <div class="field col-2">
            <label>Logo de l’entreprise</label>
            <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
              <img id="logoPreview" alt="logo" style="width:66px;height:66px;object-fit:contain;border:1px solid #e2e8f0;border-radius:10px;background:#fff;padding:4px" />
              <div>
                <input type="file" id="logoInput" accept="image/png,image/jpeg,image/webp,image/svg+xml" style="display:none" />
                <button type="button" class="btn btn-ghost btn-sm" id="logoBtn">${icon('edit', 15)} Choisir une image</button>
                <button type="button" class="btn btn-ghost btn-sm" id="logoClear">Réinitialiser</button>
                <div class="hint" style="margin-top:6px">PNG, JPG ou SVG — redimensionné automatiquement. Apparaît dans l’application, sur les reçus et les contrats.</div>
              </div>
            </div>
          </div>
          <div class="col-2" style="text-align:right"><button class="btn btn-primary" type="submit">${icon('settings', 16)} Enregistrer</button></div>
        </form>
      </div>

      <div class="card card-pad">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <h3 style="font-size:16px">Utilisateurs</h3>
          <button class="btn btn-primary btn-sm" id="addUser">${icon('plus', 16)} Ajouter</button>
        </div>
        <div id="usersList"></div>
      </div>

      <div class="card card-pad">
        <h3 style="font-size:16px;margin-bottom:4px">Sauvegarde des données</h3>
        <p class="muted" style="margin:0 0 16px;font-size:13px">
          Exportez l’ensemble de vos données (propriétaires, locataires, biens, baux et règlements)
          dans un fichier à conserver en lieu sûr. Vous pourrez le réimporter en cas de besoin
          ou pour transférer vos données vers un autre espace.
        </p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-primary" id="exportData">${icon('collect', 16)} Exporter mes données</button>
          <button class="btn btn-ghost" id="importBtn">${icon('inbox', 16)} Importer une sauvegarde</button>
          <input type="file" id="importInput" accept="application/json,.json" style="display:none" />
        </div>
      </div>
    </div>`);
  pageHeader(root);

  // ----- Parametres entreprise -----
  const s = store.settings;
  const form = root.querySelector('#settingsForm');
  ['entreprise', 'telephone', 'email', 'adresse', 'devise'].forEach((k) => { if (form.elements[k]) form.elements[k].value = s[k] || ''; });

  // ----- Logo -----
  const DEFAULT_LOGO = '/assets/logo.svg';
  let logoData = s.logo || null;
  const logoPreview = root.querySelector('#logoPreview');
  const logoInput = root.querySelector('#logoInput');
  logoPreview.src = logoData || DEFAULT_LOGO;
  root.querySelector('#logoBtn').onclick = () => logoInput.click();
  root.querySelector('#logoClear').onclick = () => { logoData = null; logoPreview.src = DEFAULT_LOGO; };
  logoInput.onchange = async () => {
    const file = logoInput.files && logoInput.files[0];
    logoInput.value = '';
    if (!file) return;
    try { logoData = await fileToLogoDataURL(file); logoPreview.src = logoData; }
    catch (err) { toast(err.message, 'error'); }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(['entreprise', 'telephone', 'email', 'adresse', 'devise'].map((k) => [k, form.elements[k].value]));
    body.logo = logoData; // data URL, ou null pour réinitialiser
    try {
      const updated = await api.put('/api/settings', body);
      store.settings = updated;
      if (window.refreshBrand) window.refreshBrand();
      toast('Paramètres enregistrés.');
    } catch (err) { toast(err.message, 'error'); }
  });

  // ----- Utilisateurs -----
  const usersBox = root.querySelector('#usersList');
  async function loadUsers() {
    usersBox.innerHTML = '<div class="spinner"></div>';
    const users = await api.get('/api/users');
    usersBox.innerHTML = '';
    usersBox.appendChild(dataTable({
      columns: [
        { label: 'E-mail', render: (u) => `<b>${escapeHtml(u.email || '—')}</b>` },
        { label: 'Nom', render: (u) => escapeHtml(u.nom || '—') },
        { label: 'Rôle', render: (u) => badge(RLAB[u.role] || u.role, u.role === 'admin' ? 'blue' : (u.role === 'assistant' ? 'amber' : 'gray')) },
        { label: 'État', render: (u) => badge(u.actif ? 'Actif' : 'Désactivé', u.actif ? 'green' : 'red') },
      ],
      rows: users,
      actions: [
        { title: 'Modifier', icon: 'edit', onClick: (u) => openUser(u) },
        { title: 'Supprimer', icon: 'trash', show: (u) => u.id !== store.user.id, onClick: (u) => removeUser(u) },
      ],
      empty: 'Aucun utilisateur.',
    }));
  }

  function openUser(row) {
    formModal({
      title: row ? `Modifier « ${escapeHtml(row.nom || row.email)} »` : 'Nouvel utilisateur',
      fields: [
        ...(row
          ? [{ name: 'email_ro', label: 'E-mail (connexion)', readonly: true, col: 2 }]
          : [{ name: 'email', label: 'E-mail de connexion', required: true, col: 2, hint: 'Servira à se connecter.' }]),
        { name: 'nom', label: 'Nom complet', col: 2 },
        { name: 'role', label: 'Rôle', type: 'select', options: [
          { value: 'secretaire', label: 'Secrétaire' }, { value: 'assistant', label: 'Assistant' }, { value: 'admin', label: 'Administrateur' }] },
        { name: 'password', label: row ? 'Nouveau mot de passe' : 'Mot de passe', required: !row,
          hint: row ? 'Laisser vide pour ne pas changer.' : '' },
        ...(row ? [{ name: 'actif', label: 'Compte actif', type: 'select', options: [
          { value: 1, label: 'Oui' }, { value: 0, label: 'Non' }] }] : []),
      ],
      values: row ? { ...row, email_ro: row.email, role: row.role, actif: row.actif } : { role: 'secretaire' },
      onSubmit: async (v) => {
        if (row) await api.put('/api/users/' + row.id, { ...v, actif: Number(v.actif) });
        else await api.post('/api/users', v);
        toast(row ? 'Utilisateur modifié.' : 'Utilisateur créé.');
        loadUsers();
      },
    });
  }

  async function removeUser(row) {
    const ok = await confirmDialog({ title: 'Supprimer l’utilisateur', danger: true, okLabel: 'Supprimer',
      message: `Supprimer le compte « ${row.email || row.nom} » ?` });
    if (!ok) return;
    try { await api.del('/api/users/' + row.id); toast('Utilisateur supprimé.'); loadUsers(); }
    catch (e) { toast(e.message, 'error'); }
  }

  root.querySelector('#addUser').onclick = () => openUser(null);

  // ----- Sauvegarde / restauration des données -----
  const exportBtn = root.querySelector('#exportData');
  exportBtn.onclick = async () => {
    exportBtn.disabled = true;
    try {
      const data = await api.get('/api/data/export');
      const slug = (store.settings.entreprise || 'entreprise')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'entreprise';
      downloadJSON(`sauvegarde-${slug}-${fmt.today()}.json`, data);
      toast('Export réussi. Conservez le fichier en lieu sûr.');
    } catch (err) { toast(err.message, 'error'); }
    finally { exportBtn.disabled = false; }
  };

  const importInput = root.querySelector('#importInput');
  root.querySelector('#importBtn').onclick = () => importInput.click();
  importInput.onchange = async () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!file) return;

    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch { return toast('Fichier illisible : ce n’est pas une sauvegarde valide.', 'error'); }

    const d = (parsed && parsed.donnees) || parsed || {};
    const n = (k) => (Array.isArray(d[k]) ? d[k].length : 0);
    const counts = { owners: n('owners'), tenants: n('tenants'), properties: n('properties'), subscriptions: n('subscriptions'), payments: n('payments') };
    if (!Object.values(counts).some(Boolean)) {
      return toast('Ce fichier ne contient aucune donnée à importer.', 'error');
    }

    const mode = await chooseImportMode(parsed, counts);
    if (!mode) return;
    if (mode === 'remplacer') {
      const ok = await confirmDialog({
        title: 'Remplacer toutes les données', danger: true, okLabel: 'Tout remplacer',
        message: 'ATTENTION : toutes les données actuelles de l’entreprise seront définitivement supprimées, puis remplacées par celles du fichier. Cette action est irréversible.',
      });
      if (!ok) return;
    }

    try {
      const r = await api.post('/api/data/import', { ...parsed, mode });
      const c = r.importe;
      toast(`Importation réussie : ${c.owners} propriétaire(s), ${c.tenants} locataire(s), ${c.properties} bien(s), ${c.subscriptions} bail/baux, ${c.payments} règlement(s).`);
    } catch (err) { toast(err.message, 'error'); }
  };

  await loadUsers();
}

// Demande à l'utilisateur comment importer (fusionner ou remplacer) en affichant
// d'abord un résumé du contenu du fichier. Résout vers 'fusionner' | 'remplacer' | null.
function chooseImportMode(meta, counts) {
  const ent = (meta && meta.entreprise) || {};
  const when = meta && meta.exporte_le ? fmt.date(meta.exporte_le) : null;
  const li = (n, label) => `<li><b>${n}</b> ${escapeHtml(label)}</li>`;
  return new Promise((resolve) => {
    const { overlay, close } = openModal(`
      <div class="modal-head"><h3>Importer une sauvegarde</h3><button class="close" data-close>&times;</button></div>
      <div class="modal-body">
        <p class="muted" style="margin:0 0 12px;font-size:13px">
          ${ent.nom ? 'Sauvegarde de « ' + escapeHtml(ent.nom) + ' »' : 'Fichier de sauvegarde'}${when ? ' — exportée le ' + escapeHtml(when) : ''}.
        </p>
        <ul style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.7">
          ${li(counts.owners, 'propriétaire(s)')}
          ${li(counts.tenants, 'locataire(s)')}
          ${li(counts.properties, 'bien(s)')}
          ${li(counts.subscriptions, 'bail/baux')}
          ${li(counts.payments, 'règlement(s)')}
        </ul>
        <p style="margin:0;font-size:13.5px">Comment souhaitez-vous importer ces données ?</p>
        <p class="muted" style="margin:6px 0 0;font-size:12.5px">
          <b>Ajouter</b> : conserve vos données actuelles et y ajoute celles du fichier.
          <b>Remplacer</b> : efface tout puis restaure le fichier.
        </p>
      </div>
      <div class="modal-foot" style="flex-wrap:wrap;gap:8px">
        <button class="btn btn-ghost" data-close>Annuler</button>
        <button class="btn btn-danger" data-mode="remplacer">Remplacer tout</button>
        <button class="btn btn-primary" data-mode="fusionner">Ajouter aux données</button>
      </div>`);
    overlay.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { close(); resolve(null); }; });
    overlay.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { close(); resolve(b.getAttribute('data-mode')); }; });
  });
}
