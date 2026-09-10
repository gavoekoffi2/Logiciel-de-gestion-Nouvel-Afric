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
| **Tableau de bord** | Vue d'ensemble du **mois à recouvrer** (compteur remis à zéro chaque mois) : nombre de propriétaires / locataires / biens, biens disponibles ou occupés, cautions, avances, loyers encaissés dans le mois, impayés, derniers paiements. Le sélecteur de période permet d'afficher un cumul (« Depuis janvier », « Toutes les périodes »). |
| **Propriétaires** | Ajout, modification, suppression et recherche des propriétaires. |
| **Maisons / Biens** | Gestion des biens (code généré automatiquement, type, nombre de pièces, loyer, localisation, commission, statut **Disponible / Occupé** calculé automatiquement). |
| **Locataires** | Gestion des locataires. Dans la fiche d'un bien, on peut **ajouter un locataire** ou, quand un locataire **a quitté** le logement, le **retirer du bien** (le bail est clôturé, l'historique est conservé et le logement redevient disponible). Un bail clôturé peut ensuite être **supprimé définitivement** en cas d'erreur de saisie. |
| **Souscriptions (baux)** | Mise en location d'un bien : calcul automatique de la **caution** (nb mois × loyer) et de l'**avance**, impression du **contrat de location**. |
| **Règlements (loyers)** | Enregistrement des paiements (reste à payer et statut **Soldé / Non soldé** automatiques), **impression du reçu** (avec montant en toutes lettres), et **encaissement multiple** pour collecter en une seule fois les loyers du mois. Les loyers se paient **à terme échu** : on encaisse le loyer d'un mois **après** que celui-ci a été consommé (ex. le loyer de juin s'encaisse en juillet). Le **mois en cours** reste « À échoir » et n'est jamais compté comme impayé. |
| **Paramètres** | Coordonnées de l'entreprise (affichées sur les reçus et contrats) et **gestion des utilisateurs**. |

### 📅 Règle capitale : le loyer se paie **à terme échu**

Le locataire règle un mois de loyer **après** l'avoir consommé : **le loyer de juillet
se recouvre en août**, celui d'août en septembre, et ainsi de suite.

Toute l'application applique cette règle, sans exception :

- **Dernier mois exigible = le mois civil précédent.** Le mois en cours est affiché
  « À échoir » : il n'est jamais réclamé, jamais compté en retard, jamais proposé par défaut.
- **Encaissement.** Le mois proposé est celui qui précède la date d'encaissement
  (encaissement du 05/08 → loyer de juillet). Changer la date recalcule le mois.
- **Filtres de période.** « Mois à recouvrer » désigne le mois de loyer exigible, pas le
  mois du calendrier. Aucun filtre ne peut viser un mois dont le loyer n'est pas encore dû.
- **État de recouvrement.** Une période demandée au-delà du dernier mois exigible est
  automatiquement ramenée à ce dernier, et l'écran le signale.
- **Encaissement groupé.** Une campagne ne peut porter que sur un mois déjà terminé.
- **Paiement d'avance.** Un locataire qui paie en avance reste enregistrable au cas par cas
  (le mois apparaît en « crédit ») : on ne le lui réclame simplement jamais.

La règle est portée par un seul fichier, [`src/rentCycle.js`](src/rentCycle.js) — tout calcul
de « quel mois de loyer est dû aujourd'hui ? » doit passer par lui.

### 🔄 Règle capitale : le compteur repart de **zéro chaque mois**

Un état mensuel ne doit contenir **que son mois**. Les loyers encaissés en août
n'apparaissent jamais dans le total de septembre : sans cela, l'agence est
incapable de savoir combien elle a réellement récolté dans le mois.

- **État de recouvrement.** « Dû du mois », « Encaissé ce mois » et « Écart du mois »
  ne portent que sur le mois sélectionné. Changer de mois remet ces compteurs à zéro.
- **Tableau de bord** et **fiche d'un bien** s'ouvrent sur le **mois à recouvrer**, pas
  sur un cumul. Le sélecteur de période permet toujours d'afficher « Depuis janvier »
  ou « Toutes les périodes » quand on veut un cumul.
- **Les retards ne sont pas perdus.** Ce qui reste dû au titre des mois antérieurs est
  chiffré à part, dans la colonne **« Arriérés antérieurs »**, et n'est jamais additionné
  aux totaux du mois affiché.
- **Un paiement reste rattaché au mois de loyer qu'il règle**, quelle que soit la date
  d'encaissement : un loyer d'août payé en octobre reste compté dans le mois d'août.
- **Les arriérés sont visibles partout.** La liste des **Locataires** affiche pour chacun
  le nombre de **mois dus**, les mois concernés et le montant restant dû, avec un filtre
  « seulement ceux qui doivent des mois » ; la **fiche d'un locataire** détaille ces mois
  un par un. Un seul calcul les produit tous — `outstandingMonths()` dans `src/api.js`.
- **Les arriérés restent encaissables.** La fiche d'un bien liste les mois en retard dans
  un tableau **« Arriérés à recouvrer »** distinct. Encaisser depuis ce tableau impute le
  règlement **au mois en retard**, jamais au mois en cours ; et un mois choisi à la main
  n'est plus réécrit quand on change la date d'encaissement.
- **Flux et encours ne se mélangent pas.** Les loyers encaissés et les impayés sont des
  **flux** du mois affiché. Les cautions, les avances et le « à reverser » sont des
  **encours** : de l'argent détenu ou dû tant qu'il n'a pas été restitué ou reversé — ils
  ne se remettent pas à zéro avec le mois.
- **Un bien supprimé ne pèse plus sur les compteurs.** Ses baux et règlements restent
  consultables dans l'historique, mais ne comptent plus dans le tableau de bord, comme
  l'écran Reversements les ignore déjà.
- **Rien à ressaisir.** Cette règle est un calcul d'affichage : elle ne modifie aucune
  donnée enregistrée et n'exige aucune suppression ni nouvelle saisie.

### Plateforme multi-entreprises (abonnement annuel)
L'application est une **plateforme** : chaque **entreprise** (agence) crée son propre espace
et ne voit **que ses données** (propriétaires, locataires, biens, loyers…), totalement
isolées des autres entreprises.

- **Inscription libre** : une entreprise s'inscrit sur `/register`, démarre avec un
  **essai gratuit de 14 jours**, puis passe à l'**abonnement annuel**.
- **Activation manuelle** : pour s'abonner, l'entreprise contacte le propriétaire de la
  plateforme (téléphone / WhatsApp / e-mail) ; **après paiement, le super-administrateur
  active le compte** (pas de paiement en ligne pour l'instant).

### Rôles des utilisateurs
- **Super-administrateur** : propriétaire de la plateforme. Supervise **toutes** les
  entreprises et **active / prolonge / suspend** leurs abonnements.
- **Administrateur** (d'une entreprise) : accès complet à son entreprise, paramètres et
  création des comptes de son équipe.
- **Secrétaire** (d'une entreprise) : gestion courante (biens, locataires, souscriptions,
  paiements, impressions).

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

**a) Côté super-administrateur** (propriétaire de la plateforme) — compte créé
automatiquement au premier lancement :

| E-mail | Mot de passe |
|--------|--------------|
| `superadmin@nouvelafric.tg` | `SuperAdmin2025` |

> ⚠️ **Changez ce mot de passe** dès la première connexion (menu **Mon compte**).
> En production, définissez plutôt `SUPERADMIN_EMAIL` et `SUPERADMIN_PASSWORD`
> (voir la section Configuration) pour utiliser vos propres identifiants.

Depuis l'espace **Plateforme**, renseignez vos **coordonnées** (téléphone, WhatsApp,
e-mail) et le **tarif annuel** : ils s'afficheront aux entreprises pour qu'elles
vous contactent et paient.

**b) Côté entreprise** : chaque agence crée son espace via le bouton
**« Créer mon entreprise »** (page `/register`). Elle obtient **14 jours d'essai
gratuit**, puis vous l'activez manuellement après paiement.

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
| `SUPERADMIN_EMAIL` | E-mail du super-administrateur (créé au 1er lancement) | `superadmin@nouvelafric.tg` |
| `SUPERADMIN_PASSWORD` | Mot de passe initial du super-administrateur | `SuperAdmin2025` |
| `TRIAL_DAYS` | Durée de l'essai gratuit (en jours) | `14` |

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
│   ├── db.js              # Base de données (multi-entreprises + abonnements)
│   ├── auth.js            # Inscription / connexion e-mail / rôles / abonnement
│   ├── api.js             # Logique métier (API REST, isolée par entreprise)
│   ├── rentCycle.js       # Loyer à terme échu : quel mois est exigible aujourd'hui
│   ├── paymentPeriods.js  # Mois payés / dus d'un règlement
│   ├── periodRange.js     # Filtres de période (mois, plage, depuis janvier…)
│   └── platform.js        # Espace super-administrateur (gestion des entreprises)
├── public/                # Interface (ce que voit l'utilisateur)
│   ├── login.html         # Connexion par e-mail
│   ├── register.html      # Inscription d'une entreprise
│   ├── index.html         # Application
│   ├── css/style.css
│   └── js/                # Écrans : tableau de bord, biens, abonnement, super-admin…
├── docs/
│   └── ANALYSE_EXCEL.md   # Correspondance avec le fichier Excel d'origine
└── data/                  # Base de données (créée automatiquement)
```

Voir [`docs/ANALYSE_EXCEL.md`](docs/ANALYSE_EXCEL.md) pour le détail de la reprise du fichier Excel.
