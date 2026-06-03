# Mettre l'application en ligne — GRATUITEMENT, sans perdre les données

Objectif : rendre NOUVEL AFRIC accessible depuis **n'importe quel téléphone ou
ordinateur**, **gratuitement**, tout en **conservant les données** en sécurité.

## Comment ça marche (en 1 phrase)

Les données sont stockées dans une **base en ligne gratuite (Turso)**, et
l'application tourne sur un **hébergement gratuit (Render)**. Comme les données
sont dans Turso, elles ne se perdent jamais, même si l'hébergement redémarre.

> ℹ️ Seul petit inconvénient du gratuit : après ~15 min sans visite, la 1ʳᵉ page
> peut mettre ~1 minute à s'ouvrir (l'hébergement « se réveille »). Ensuite c'est rapide.

---

## Étape 1 — Créer la base de données en ligne (Turso) — gratuit

1. Aller sur **https://turso.tech** et créer un compte (connexion possible avec GitHub).
2. Créer une base de données (**Create Database**) ; donner un nom, ex. `nouvel-afric`.
   Choisir une région proche (ex. *Frankfurt / eu*).
3. Une fois la base créée, récupérer **2 informations** (boutons dans le tableau de bord) :
   - **URL de la base** — commence par `libsql://…` *(bouton « Connect » / « URL »)*
   - **Jeton d'accès (auth token)** — une longue suite de caractères
     *(bouton « Create Token » / « Tokens »)*
4. **Garder ces 2 valeurs** sous la main pour l'étape 2.

> 💻 *(Alternative en ligne de commande, facultatif)* — avec le CLI Turso :
> ```bash
> turso db create nouvel-afric
> turso db show nouvel-afric --url        # -> TURSO_DATABASE_URL
> turso db tokens create nouvel-afric     # -> TURSO_AUTH_TOKEN
> ```

---

## Étape 2 — Mettre l'application en ligne (Render) — gratuit

1. Créer un compte sur **https://render.com** (connexion avec GitHub recommandée).
2. Cliquer sur **New +** → **Blueprint**.
3. Choisir le dépôt **`Logiciel-de-gestion-Nouvel-Afric`** et la branche
   **`claude/practical-cray-gjRsH`** (ou `main` une fois fusionnée).
4. Render détecte `render.yaml` et affiche le service **nouvel-afric** (plan **Free**).
5. Il demande de renseigner 2 variables — **coller les valeurs de l'étape 1** :
   - `TURSO_DATABASE_URL` → l'URL `libsql://…`
   - `TURSO_AUTH_TOKEN` → le jeton d'accès
   *(la variable `SESSION_SECRET` est générée automatiquement)*
6. Cliquer sur **Apply** et patienter quelques minutes.
7. 🎉 L'application est en ligne, à une adresse comme **`https://nouvel-afric.onrender.com`**.
   Se connecter avec **`admin` / `admin123`**.

---

## Étape 3 — Après la mise en ligne (important)

1. **Changer les mots de passe** par défaut → menu **Paramètres → Utilisateurs**.
2. Renseigner les **coordonnées de l'entreprise** → menu **Paramètres**
   (nom, téléphone, email, adresse) ; elles s'affichent sur les reçus et contrats.

---

## Variante gratuite : Koyeb (au lieu de Render)

1. Compte sur **https://koyeb.com** → **Create Web Service** → **GitHub** → choisir le dépôt.
2. Build : *Buildpack* (Node) ou *Dockerfile*. Commande de démarrage : `npm start`.
3. Dans **Environment variables**, ajouter :
   `NODE_ENV=production`, `SESSION_SECRET=` (une longue suite au hasard),
   `TURSO_DATABASE_URL=…`, `TURSO_AUTH_TOKEN=…`.
4. Déployer ; Koyeb fournit une adresse publique.

---

## Sauvegarde des données

Les données vivent dans **Turso**. Pour une copie de sécurité, on peut exporter
la base depuis le tableau de bord Turso (ou `turso db dump nouvel-afric`).

---

## Variables d'environnement

| Variable | Rôle | Exemple |
|----------|------|---------|
| `TURSO_DATABASE_URL` | Adresse de la base en ligne | `libsql://nouvel-afric-xxx.turso.io` |
| `TURSO_AUTH_TOKEN` | Jeton d'accès à la base | une longue chaîne |
| `SESSION_SECRET` | Clé de sécurité des connexions (stable) | une longue chaîne aléatoire |
| `NODE_ENV` | Mode production (cookies HTTPS sécurisés) | `production` |
| `PORT` | Port d'écoute (imposé par l'hébergeur) | `3000` |

> 🖥️ **En local** (sur votre ordinateur), aucune de ces variables n'est nécessaire :
> l'application utilise automatiquement un simple fichier `data/nouvelafric.db`.
