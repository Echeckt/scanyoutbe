# ScanYTB V5.5 — Dodo Payments + compte admin + recherche NDD exacte

ScanYTB analyse les chaînes YouTube françaises et extrait les liens présents dans les descriptions. Cette version ajoute les comptes utilisateurs, les crédits de recherche et le paiement unique via Dodo Payments.

## Fonctionnement

- Création de compte / connexion sécurisée.
- 1 recherche = 1 crédit.
- 1 crédit = 4,99 € TTC.
- Checkout hébergé par Dodo Payments.
- Webhook `payment.succeeded` vérifié par signature Standard Webhooks.
- Le crédit est ajouté une seule fois grâce à l’idempotence côté PostgreSQL.
- Le crédit est débité côté serveur au lancement d’une recherche.
- Si la recherche échoue techniquement avant résultat, le crédit est automatiquement rendu.
- Historique des recherches par utilisateur.
- Les scans de chaînes et exports restent liés aux recherches achetées.
- Compte administrateur avec recherches, scans, exports et recherche NDD illimités.
- L’admin n’est jamais débité et n’a pas besoin d’acheter de crédit.

## Variables Railway

Garde tes variables actuelles et ajoute `ADMIN_EMAIL` :

```env
APP_URL=https://scan-ytb.com
DATABASE_URL=...
YOUTUBE_API_KEY=...
DODO_PAYMENTS_API_KEY=...
DODO_PAYMENTS_WEBHOOK_KEY=...
DODO_PRODUCT_ID=pdt_0NnPPhnQCfvPY1npwmxNm
ADMIN_EMAIL=ton-email@exemple.com
```

Optionnel :

```env
DODO_PAYMENTS_ENVIRONMENT=live_mode
```

Si cette variable est absente, ScanYTB utilise `live_mode`. Pour tester avec le sandbox Dodo, utilise `test_mode` avec une clé, un produit et un webhook créés en mode test.


## Compte administrateur

Ajoute dans Railway :

```env
ADMIN_EMAIL=ton-email@exemple.com
```

Connecte-toi ensuite à ScanYTB avec **exactement cette adresse e-mail**. Le compte est reconnu comme administrateur automatiquement, même si le compte existait déjà avant la V5.2.

Un compte admin affiche `∞ crédits` et bénéficie de :

- recherches illimitées ;
- aucun débit de crédit ;
- scan de toutes les chaînes ;
- accès aux exports ;
- accès à la recherche globale NDD ;
- historique de ses propres recherches.

Tu peux autoriser plusieurs admins en séparant les e-mails par des virgules :

```env
ADMIN_EMAIL=toi@exemple.com,associe@exemple.com
```

La base ajoute aussi une colonne `users.is_admin` pour permettre plus tard de promouvoir manuellement d’autres comptes si besoin.

## Webhook Dodo

Endpoint :

```text
https://scan-ytb.com/api/dodo/webhook
```

Événement :

```text
payment.succeeded
```

Le webhook doit conserver sa Signing Secret dans Railway sous `DODO_PAYMENTS_WEBHOOK_KEY`.

## Déploiement

1. Remplace le contenu du repo GitHub par cette version.
2. Commit / push sur la branche reliée à Railway.
3. Railway redéploie automatiquement.
4. La migration PostgreSQL est exécutée au démarrage et crée les tables de compte/paiement manquantes.
5. Dans Dodo Payments > Webhooks > Testing, envoie un exemple `payment.succeeded` pour vérifier que l’endpoint répond en 2xx.

## Paiement

Le serveur crée une Checkout Session Dodo à chaque achat :

- produit : `DODO_PRODUCT_ID`
- quantité : `1`
- e-mail prérempli depuis le compte ScanYTB
- metadata : `user_id`, `credits=1`, `product_id`
- retour : `https://scan-ytb.com/?payment=success`

Le retour navigateur n’est jamais considéré comme preuve de paiement : ScanYTB vérifie le paiement côté serveur et/ou attend le webhook signé.


## V5.2.3
- Correction visuelle : le bouton d’achat de crédit est désormais strictement masqué pour les comptes administrateurs.
- Ajout d’une règle globale `[hidden] { display: none !important; }` pour éviter qu’un style `display:flex` ne réaffiche un élément masqué.


## V5.4 — Mode domaine exact

La barre principale détecte maintenant automatiquement un nom de domaine (`mortode.com`, `https://mortode.com`, etc.).

Dans ce cas ScanYTB n'utilise plus les variantes de mots-clés du mode classique :

- **Rapide** : inspecte jusqu'à 50 résultats vidéo YouTube pour le NDD ;
- **Profonde** : parcourt jusqu'à 4 pages, soit 200 résultats vidéo ;
- récupère ensuite la description complète de chaque vidéo ;
- ne conserve une vidéo que si le domaine demandé est **réellement présent dans sa description** ;
- accepte le domaine racine, `www.` et les sous-domaines ;
- rejette les faux positifs comme `notmortode.com` ou `mortode.com.evil.com` ;
- déduit les chaînes à partir de ces vidéos exactes ;
- applique ensuite les filtres abonnés/vidéos et la vérification francophone ;
- affiche sur chaque chaîne le nombre de vidéos contenant réellement le NDD ;
- mémorise immédiatement les liens des vidéos preuves dans PostgreSQL.

Le cache de recherche distingue maintenant `keyword` et `domain`, ce qui empêche une ancienne recherche mot-clé d'être réutilisée pour un NDD.


## V5.4 — découverte large

- suppression du mode de découverte par nom de domaine dans le champ principal ;
- mode rapide : recherche dans les chaînes + les vidéos ;
- mode profond : 18 à 21 appels `search.list` selon la niche ;
- plusieurs pages sur la requête principale ;
- diversification par pertinence, date et vues ;
- variantes France / français / francophone / tutoriel / formation / débutant / conseils / 2026 ;
- expansions contextuelles pour plusieurs niches courantes (dropshipping, e-commerce, Shopify, Amazon FBA, WordPress, Vinted, SEO) ;
- jusqu’à 500 chaînes candidates conservées avant filtre FR ;
- cache de découverte versionné pour ne pas réutiliser les anciens résultats étroits.

La recherche NDD dans la section **Liens détectés** reste disponible : seule l’ancienne détection automatique d’un NDD dans le champ principal a été supprimée.


## V5.5 — intégration extension Chrome

La home accepte maintenant deux deep links utilisés par l’extension officielle :

- `/?q=NomDeLaChaine&source=chrome-extension` préremplit la recherche principale sans la lancer automatiquement ;
- `/?domain=exemple.com&source=chrome-extension` ouvre la section Liens et lance la recherche globale de ce NDD après authentification.

Aucune recherche payante n’est lancée automatiquement depuis l’extension : le bouton de recherche reste une action volontaire de l’utilisateur.
