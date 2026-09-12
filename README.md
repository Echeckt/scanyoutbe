# ScanYTB V5

Scanner YouTube français avec comptes utilisateurs, crédits de recherche et paiement Stripe.

## Modèle commercial

- Création de compte gratuite.
- 1 recherche = 1 crédit.
- 1 crédit = 4,99 USD.
- Le crédit est réservé côté serveur au lancement de la recherche.
- Si la recherche échoue techniquement ou si YouTube refuse la requête sans cache disponible, le crédit est automatiquement rendu.
- Une recherche terminée apparaît dans l’historique du compte.

## Fonctionnalités

- Inscription / connexion / déconnexion.
- Sessions sécurisées via cookie `HttpOnly`, `SameSite=Lax` et `Secure` en production.
- Mots de passe hashés avec bcrypt.
- Stripe Checkout hébergé par Stripe.
- Webhook Stripe idempotent pour créditer le compte une seule fois.
- Vérification serveur du paiement au retour de Stripe.
- Historique des recherches par utilisateur.
- Protection serveur des recherches, scans, exports et recherche globale NDD.
- Une chaîne ne peut être scannée que si elle provient d’une recherche achetée par le compte.
- Cache YouTube conservé pour réduire la consommation du quota.
- Les descriptions complètes des vidéos ne sont plus conservées après extraction des liens afin de réduire fortement la taille PostgreSQL.

## Variables Railway

Conserve les variables existantes :

```env
YOUTUBE_API_KEY=...
DATABASE_URL=${{Postgres.DATABASE_URL}}
NODE_ENV=production
```

Ajoute :

```env
APP_URL=https://scan-ytb.com
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Pour tester avant le live, utilise une clé Stripe `sk_test_...` et le webhook du mode test.

## Stripe

### 1. Récupérer la clé secrète

Dans Stripe Dashboard > Developers > API keys, copie la clé secrète et ajoute-la dans Railway sous :

```env
STRIPE_SECRET_KEY=sk_test_...
```

### 2. Créer le webhook

Dans Stripe Dashboard > Developers > Webhooks, ajoute l’endpoint :

```text
https://scan-ytb.com/api/stripe/webhook
```

Événements à écouter :

```text
checkout.session.completed
checkout.session.async_payment_succeeded
```

Copie ensuite le signing secret du webhook dans Railway :

```env
STRIPE_WEBHOOK_SECRET=whsec_...
```

### 3. Redeploy

Après avoir ajouté les variables, redeploy le service ScanYTB sur Railway.

## Flux utilisateur

1. L’utilisateur configure sa recherche.
2. Il clique sur `Lancer la recherche`.
3. Sans compte : popup inscription / connexion.
4. Avec 0 crédit : popup paiement 4,99 $.
5. Stripe Checkout encaisse le paiement.
6. Le webhook crédite le compte de +1.
7. Le retour Stripe vérifie le paiement et relance automatiquement la recherche en attente.
8. Le serveur retire 1 crédit au lancement.
9. Si la recherche échoue, le serveur rembourse automatiquement le crédit.

## Tables ajoutées

```text
users
user_sessions
user_searches
user_search_channels
credit_transactions
payments
```

Les migrations sont créées automatiquement au démarrage avec `initDatabase()`.

## Déploiement

Le contenu du dossier peut être placé directement à la racine du repository GitHub relié à Railway.

```bash
npm install
npm start
```

Vérification syntaxique :

```bash
npm run check
```

## Important avant ouverture publique

La V5 inclut l’authentification et le paiement, mais pas encore la vérification d’adresse e-mail ni la récupération de mot de passe. Avant une commercialisation à grande échelle, ajoute également CGV, politique de confidentialité et politique de remboursement adaptées à ton activité.
