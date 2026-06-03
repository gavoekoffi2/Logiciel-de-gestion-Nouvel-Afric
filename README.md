# NOUVEL AFRIC — Logiciel de gestion locative immobilière

Application web simple et moderne pour la **gestion de biens immobiliers en location**.
Elle remplace le fichier Excel d'origine par une **vraie application partagée** : plusieurs
postes (la secrétaire, le gérant…) peuvent travailler **en même temps sur les mêmes données**,
mises à jour en temps réel.

> Toutes les fonctionnalités du fichier Excel ont été reprises et simplifiées :
> propriétaires, maisons, locataires, souscriptions (baux), règlements (loyers),
> reçus et contrats imprimables, tableau de bord.

---

## ✨ Fonctionnalités

| Module | Description |
|--------|-------------|
| **Tableau de bord** | Vue d'ensemble : nombre de propriétaires / locataires / biens, biens disponibles ou occupés, total des cautions, avances et loyers encaissés, recouvrement du mois en cours, impayés, derniers paiements. |
| **Propriétaires** | Ajout, modification, suppression et recherche des propriétaires. |
| **Maisons / Biens** | Gestion des biens (code généré automatiquement, type, nombre de pièces, loyer, localisation, commission, statut **Disponible / Occupé** calculé automatiquement). |
| **Locataires** | Gestion des locataires. |
| **Souscriptions (baux)** | Mise en location d'un bien : calcul automatique de la **caution** (nb mois × loyer) et de l'**avance**, impression du **contrat de location**. |
| **Règlements (loyers)** | Enregistrement des paiements (reste à payer et statut **Soldé / Non soldé** automatiques), **impression du reçu** (avec montant en toutes lettres), et **encaissement multiple** pour collecter en une seule fois les loyers du mois. |
| **Paramètres** | Coordonnées de l'entreprise (affichées sur les reçus et contrats) et **gestion des utilisateurs**. |

### Rôles des utilisateurs
- **Administrateur** : accès complet, y compris les paramètres et la création des comptes.
- **Secrétaire** : gestion courante (biens, locataires, souscriptions, paiements, impressions).

---

## 🚀 Installation et démarrage

### 1. Prérequis
Installer **Node.js version 18 ou supérieure** : <https://nodejs.org> (choisir la version « LTS »).

### 2. Installer l'application
Ouvrir un terminal dans le dossier du projet, puis :

```bash
npm install
```

### 3. Démarrer
```bash
npm start
```

L'application est alors disponible sur :
- **Sur le poste serveur** : <http://localhost:3000>
- **Sur les autres postes du réseau (bureau)** : `http://ADRESSE-IP-DU-SERVEUR:3000`
  (par exemple `http://192.168.1.10:3000`).

> Pour connaître l'adresse IP du poste serveur : `ipconfig` (Windows) ou `ip a` (Linux).

### 4. Première connexion
Comptes créés automatiquement au premier lancement :

| Identifiant | Mot de passe | Rôle |
|-------------|--------------|------|
| `admin` | `admin123` | Administrateur |
| `secretaire` | `secret123` | Secrétaire |

> ⚠️ **Pensez à changer ces mots de passe** dès la première utilisation (menu **Paramètres → Utilisateurs**).

---

## 🔄 Pourquoi c'est « actualisable » et partagé ?

Contrairement au fichier Excel (où chaque poste avait sa propre copie), ici les données sont
stockées dans **une base unique sur le poste serveur**. Tous les postes du bureau se connectent
à cette même base via le navigateur : **dès qu'une information est saisie, tout le monde la voit.**

Il suffit de laisser **un seul poste (ou un petit serveur) allumé** avec l'application démarrée ;
les autres s'y connectent avec leur navigateur (Chrome, Edge, Firefox…).

---

## 🌍 Mettre l'application en ligne (gratuitement)

Pour un accès **depuis n'importe où** (et pas seulement le réseau du bureau),
l'application peut être hébergée **gratuitement**, avec les données conservées
dans une base en ligne (**Turso**, compatible SQLite). Guide pas à pas :
[`docs/DEPLOIEMENT.md`](docs/DEPLOIEMENT.md).

En pratique : on définit les variables `TURSO_DATABASE_URL` et `TURSO_AUTH_TOKEN`,
et les données vont automatiquement dans la base en ligne (rien d'autre à changer).

## 💾 Sauvegarde des données

- **En local** : toutes les données sont dans **un seul fichier** `data/nouvelafric.db` —
  il suffit de **copier ce fichier** pour sauvegarder (et de le remettre pour restaurer).
- **En ligne (Turso)** : exporter la base depuis le tableau de bord Turso
  (ou `turso db dump`).

---

## ⚙️ Configuration (optionnelle)

Variables d'environnement possibles au démarrage :

| Variable | Rôle | Défaut |
|----------|------|--------|
| `PORT` | Port d'écoute | `3000` |
| `HOST` | Adresse d'écoute | `0.0.0.0` (tout le réseau) |
| `SESSION_SECRET` | Clé de sécurité des sessions | générée au démarrage |
| `DB_PATH` | Emplacement du fichier de base (mode local) | `data/nouvelafric.db` |
| `TURSO_DATABASE_URL` | Active la base en ligne Turso (sinon fichier local) | *(non défini)* |
| `TURSO_AUTH_TOKEN` | Jeton d'accès à la base Turso | *(non défini)* |

Exemple (Windows) : `set PORT=8080 && npm start`
Exemple (Linux/Mac) : `PORT=8080 npm start`

---

## 🧰 Technologie

- **Serveur** : Node.js + Express
- **Base de données** : libSQL / SQLite — un simple fichier en local, ou une base
  en ligne **Turso** (gratuite) pour un accès depuis Internet, sans changer le code
- **Interface** : HTML / CSS / JavaScript (aucune dépendance lourde, aucune compilation)

L'ensemble est volontairement **simple à maintenir et à héberger** (un PC du bureau, un petit
serveur local, ou un hébergement web).

---

## 📂 Structure du projet

```
.
├── server.js              # Démarrage du serveur web
├── src/
│   ├── db.js              # Base de données (schéma + données d'exemple)
│   ├── auth.js            # Connexion / rôles
│   └── api.js             # Toute la logique métier (API REST)
├── public/                # Interface (ce que voit l'utilisateur)
│   ├── login.html         # Page de connexion
│   ├── index.html         # Application
│   ├── css/style.css
│   └── js/                # Écrans : tableau de bord, biens, paiements…
├── docs/
│   └── ANALYSE_EXCEL.md   # Correspondance avec le fichier Excel d'origine
└── data/                  # Base de données (créée automatiquement)
```

Voir [`docs/ANALYSE_EXCEL.md`](docs/ANALYSE_EXCEL.md) pour le détail de la reprise du fichier Excel.
