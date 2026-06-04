import { api, icon, el, escapeHtml, dataTable, formModal, confirmDialog, toast, badge, store, pageHeader } from '../core.js';

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
        { label: 'Identifiant', render: (u) => `<b>${escapeHtml(u.username)}</b>` },
        { label: 'Nom', render: (u) => escapeHtml(u.nom || '—') },
        { label: 'Rôle', render: (u) => badge(u.role === 'admin' ? 'Administrateur' : 'Secrétaire', u.role === 'admin' ? 'blue' : 'gray') },
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
      title: row ? `Modifier « ${row.username} »` : 'Nouvel utilisateur',
      fields: [
        ...(row ? [] : [{ name: 'username', label: 'Identifiant de connexion', required: true, col: 2, hint: 'En minuscules, sans espace.' }]),
        { name: 'nom', label: 'Nom complet', col: 2 },
        { name: 'role', label: 'Rôle', type: 'select', options: [
          { value: 'secretaire', label: 'Secrétaire' }, { value: 'admin', label: 'Administrateur' }] },
        { name: 'password', label: row ? 'Nouveau mot de passe' : 'Mot de passe', required: !row,
          hint: row ? 'Laisser vide pour ne pas changer.' : '' },
        ...(row ? [{ name: 'actif', label: 'Compte actif', type: 'select', options: [
          { value: 1, label: 'Oui' }, { value: 0, label: 'Non' }] }] : []),
      ],
      values: row ? { ...row, role: row.role, actif: row.actif } : { role: 'secretaire' },
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
      message: `Supprimer le compte « ${row.username} » ?` });
    if (!ok) return;
    try { await api.del('/api/users/' + row.id); toast('Utilisateur supprimé.'); loadUsers(); }
    catch (e) { toast(e.message, 'error'); }
  }

  root.querySelector('#addUser').onclick = () => openUser(null);
  await loadUsers();
}
