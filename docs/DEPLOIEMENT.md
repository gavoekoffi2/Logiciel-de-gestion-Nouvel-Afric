# Mettre l'application en ligne (accessible depuis n'importe où)

Ce guide explique comment héberger NOUVEL AFRIC sur Internet, pour y accéder
depuis n'importe quel poste ou téléphone (pas seulement le réseau du bureau).

L'application est déjà **prête pour l'hébergement** :
- HTTPS géré automatiquement par l'hébergeur ;
- base de données **conservée** sur un disque persistant (vos données ne se perdent pas) ;
- clé de sécurité des sessions générée automatiquement.

---

## Option A — Render (recommandée, la plus simple)

> Render lit le fichier `render.yaml` du projet et crée tout automatiquement.

1. Créer un compte sur **https://render.com** (connexion possible avec GitHub).
2. Cliquer sur **New +** → **Blueprint**.
3. Choisir le dépôt **`gavoekoffi2/Logiciel-de-gestion-Nouvel-Afric`**
   et la branche **`claude/practical-cray-gjRsH`** (ou `main` une fois fusionnée).
4. Render détecte `render.yaml` et propose de créer le service **nouvel-afric**
   avec un disque persistant. Cliquer sur **Apply**.
5. Patienter quelques minutes (installation + démarrage).
6. L'application est en ligne à une adresse du type
   **`https://nouvel-afric.onrender.com`**. Se connecter avec `admin / admin123`.

> 💡 Le plan **Starter (~7 $/mois)** est nécessaire pour le **disque persistant**
> (indispensable pour ne pas perdre les données). Le plan gratuit fonctionne pour
> tester, mais il s'endort après inactivité et **ne conserve pas** les données.

---

## Option B — Railway (avec Docker)

1. Créer un compte sur **https://railway.app**.
2. **New Project** → **Deploy from GitHub repo** → choisir le dépôt.
3. Railway construit l'image à partir du `Dockerfile`.
4. Dans **Variables**, ajouter :
   - `NODE_ENV` = `production`
   - `SESSION_SECRET` = (une longue suite de caractères au hasard)
   - `DB_PATH` = `/data/nouvelafric.db`
5. Dans **Settings → Volumes**, ajouter un volume monté sur **`/data`**
   (pour conserver la base de données).
6. Générer un domaine public dans **Settings → Networking**.

---

## Option C — Votre propre serveur / VPS

Avec Docker :
```bash
docker build -t nouvel-afric .
docker run -d -p 80:3000 \
  -e NODE_ENV=production \
  -e SESSION_SECRET="une-cle-secrete-longue" \
  -v /chemin/vers/donnees:/data \
  --restart unless-stopped \
  nouvel-afric
```

Sans Docker (Node.js installé sur le serveur) :
```bash
npm install
NODE_ENV=production SESSION_SECRET="une-cle-longue" npm start
```
(garder le processus actif avec un gestionnaire comme **pm2** : `pm2 start server.js --name nouvel-afric`)

---

## Après la mise en ligne — à faire absolument

1. **Changer les mots de passe** par défaut (menu **Paramètres → Utilisateurs**).
2. Renseigner les **coordonnées de l'entreprise** (Paramètres) — elles s'affichent
   sur les reçus et les contrats.
3. **Sauvegarder régulièrement** : télécharger une copie du fichier
   `nouvelafric.db` (depuis le disque de l'hébergeur).

---

## Variables d'environnement utilisées

| Variable | Rôle | Exemple |
|----------|------|---------|
| `NODE_ENV` | Active le mode production (cookies HTTPS sécurisés) | `production` |
| `SESSION_SECRET` | Clé de chiffrement des sessions (à garder secrète et stable) | une longue chaîne aléatoire |
| `DB_PATH` | Emplacement de la base de données | `/data/nouvelafric.db` |
| `PORT` | Port d'écoute (souvent imposé par l'hébergeur) | `3000` |
