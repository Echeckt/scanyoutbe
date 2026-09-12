# ScanYTB V5.1 — Dodo Payments

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

## Variables Railway

Les variables déjà configurées sont suffisantes :

```env
APP_URL=https://scan-ytb.com
DATABASE_URL=...
YOUTUBE_API_KEY=...
DODO_PAYMENTS_API_KEY=...
DODO_PAYMENTS_WEBHOOK_KEY=...
DODO_PRODUCT_ID=pdt_0NnPPhnQCfvPY1npwmxNm
```

Optionnel :

```env
DODO_PAYMENTS_ENVIRONMENT=live_mode
```

Si cette variable est absente, ScanYTB utilise `live_mode`. Pour tester avec le sandbox Dodo, utilise `test_mode` avec une clé, un produit et un webhook créés en mode test.

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
