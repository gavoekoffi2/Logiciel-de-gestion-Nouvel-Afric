# Analyse du fichier Excel d'origine et correspondance avec l'application

Le logiciel d'origine était un classeur Excel à macros : **`GLocat_Excel_VF2.xlsm`**
(« KIT DE GESTION DE LOCATION IMMOBILIERE »), conçu pour une société de gestion immobilière
(l'en-tête mentionnait « NOAH IMMOBILIER »). Cette application web en reprend **toutes les
fonctionnalités**, rebaptisées au nom de **NOUVEL AFRIC**.

## 1. Feuilles Excel → Modules de l'application

| Feuille Excel | Rôle | Module de l'application |
|---------------|------|--------------------------|
| `Accueil` | Tableau de bord (compteurs + totaux) | **Tableau de bord** |
| `Proprietaires` | Liste des propriétaires | **Propriétaires** |
| `Maisons` | Liste des biens | **Maisons / Biens** |
| `Locataires` | Liste des locataires | **Locataires** |
| `Souscription` | Baux / mises en location | **Souscriptions** |
| `Reglement` | Paiements de loyer | **Règlements** |
| `Parametres` | Listes de référence | intégré (types, mois, statuts) |
| `RECU` *(masquée)* | Modèle de reçu | **Impression du reçu** |
| `Contrat` *(masquée)* | Modèle de contrat | **Impression du contrat** |

## 2. Champs repris (à l'identique)

**Propriétaires / Locataires** : Nom & prénoms, Contact, Email, Adresse.

**Maisons** : Code (IDM), Propriétaire, Type de construction, Nombre de pièces, Coût du loyer,
Ville, Commune, Quartier, Observation, Part de commission, Statut (Disponible/Occupé),
Nombre de portes.

**Souscriptions** : Code (IDS), Maison, Locataire, Date de souscription, Montant loyer,
Nombre de mois de caution, Montant caution, Nombre de mois d'avance, Montant avance,
Autres frais + montant, Date d'entrée, Date de début de paiement, Statut (Active/Désactivé).

**Règlements** : Code (IDR), Maison, Locataire, Date, Montant à payer, Montant payé,
Reste à payer, Mois concerné, Année concernée, Statut (Soldé/Non soldé), Souscription liée.

## 3. Règles de gestion reprises (des macros VBA)

- **Génération automatique des codes** (comme dans le VBA d'origine) :
  - Maison : `MB_P3_C150000_M…A…` → `MB`/`MI`/`MC` (type) + `P`(pièces) + `C`(coût) + date + nombre aléatoire ;
  - Souscription : `S` + date + `A` + aléatoire ;
  - Règlement : `R` + date + `A` + aléatoire.
- **Loyer** automatiquement repris du bien sélectionné lors d'une souscription.
- **Montant caution** = nombre de mois de caution × loyer ; **Montant avance** = nombre de mois × loyer.
- **Reste à payer** = montant à payer − montant payé ; **statut** Soldé/Non soldé déduit automatiquement.
- **Statut du bien** : « Occupé » s'il existe une souscription active, sinon « Disponible »
  (seuls les biens disponibles sont proposés pour une nouvelle souscription).
- **Contrôle des doublons** sur les noms (propriétaires, locataires) et **commission ≤ 100 %**.
- **Encaissement multiple** : enregistrement en une fois du loyer du mois pour toutes les
  souscriptions actives sélectionnées (équivalent du formulaire « Saisie multiple paiement »).
- **Reçu** avec **montant en toutes lettres** (français) et **contrat de location** imprimables
  (PDF via le navigateur), reprenant la mise en page des feuilles `RECU` et `Contrat`.

## 4. Améliorations par rapport à l'Excel

- **Multi-utilisateurs en réseau** : données centralisées et mises à jour en temps réel
  (le besoin principal exprimé).
- **Comptes & rôles** (administrateur / secrétaire) avec mots de passe.
- **Recherche et filtres** sur chaque liste (par mois, année, statut…).
- **Tableau de bord enrichi** : taux de recouvrement du mois, impayés, biens disponibles.
- **Anti-doublon** sur l'encaissement multiple (un même loyer ne peut être enregistré deux fois
  pour la même période).
- Devise et coordonnées de l'entreprise **paramétrables**.

## 5. Données d'exemple

Au premier lancement, l'application est pré-remplie avec le jeu d'exemple du fichier Excel
(propriétaire *BAHI DJEDJE LAURENT*, deux biens à Yopougon et Cocody, locataires *N'GUESSAN ANGE*
et *AFFESSY FRANCK*, leurs souscriptions et quelques règlements) afin de montrer le fonctionnement.
Ces données peuvent être modifiées ou supprimées librement.
