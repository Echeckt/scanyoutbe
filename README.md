# EcomTube Scanner V3.6

Le champ **Liens détectés** recherche automatiquement un NDD dans toute la base dès qu'un domaine complet est saisi.

# EcomTube Scanner V3.1

Scanner Node.js + PostgreSQL pour trouver les chaînes YouTube francophones autour de niches e-commerce et récupérer les liens présents dans leurs descriptions.

## Nouveautés V3

- mode **Rapide** : 1 recherche YouTube pour tester une niche ;
- mode **Profonde** : 8 recherches combinées ;
- recherche à la fois dans les **chaînes** et dans les **vidéos** pour découvrir des créateurs dont le nom de chaîne ne contient pas forcément le mot-clé ;
- variantes automatiques : requête principale, `France`, `français`, `tutoriel`, `comment faire ...` ;
- déduplication des chaînes trouvées ;
- filtre francophone avec pays, langue, description et échantillon des dernières vidéos ;
- filtre minimum d'abonnés ;
- filtre minimum de vidéos ;
- tri par pertinence, abonnés, nombre de vidéos ou score FR ;
- mémorisation des chaînes FR **et étrangères** ;
- cache de vérification linguistique pendant 30 jours : une chaîne déjà contrôlée n'est pas réanalysée inutilement ;
- scan individuel ou **Scanner toutes** ;
- extraction des URLs et classement des domaines ;
- export CSV.

## Déploiement Railway

### 1. GitHub

Place tout le contenu de ce dossier à la racine de ton repo puis commit/push.

### 2. Variables Railway

Dans le service applicatif :

```env
YOUTUBE_API_KEY=AIzaSy...
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Railway injecte automatiquement `PORT`.

### 3. Google Cloud

Active **YouTube Data API v3**, crée une clé API et restreins-la à cette API si possible.

Ne mets jamais la clé dans GitHub.

## Comment fonctionne la recherche profonde

Pour une requête comme `dropshipping`, la V3 lance plusieurs recherches autour de :

- `dropshipping`
- `dropshipping france`
- `dropshipping français`
- `dropshipping tutoriel`
- `comment faire dropshipping`

Certaines recherches ciblent les chaînes, d'autres les vidéos. Pour un résultat vidéo, la V3 récupère le `channelId` du créateur. Tous les IDs sont ensuite dédupliqués.

La V3 récupère ensuite les statistiques des chaînes, applique les minima demandés puis contrôle si elles sont francophones. Les vérifications de moins de 30 jours présentes dans PostgreSQL sont réutilisées.

## Base existante / migration

Aucune suppression de ta base actuelle n'est nécessaire. Au démarrage, la V3 ajoute automatiquement les colonnes manquantes avec `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

Les nouvelles colonnes servent notamment à conserver :

- `default_language`
- `discovery_count`
- `first_discovered_at`
- `last_discovered_at`
- `last_verified_at`

## Scan des descriptions

Après une recherche :

1. choisis 25, 50, 100, 250 ou 500 vidéos par chaîne ;
2. clique sur **Scanner toutes** ;
3. deux chaînes sont scannées en parallèle ;
4. les liens sont enregistrés dans PostgreSQL ;
5. le classement des domaines et la table des liens se mettent à jour.

## Local

```bash
npm install
cp .env.example .env
npm run dev
```

Puis ouvre `http://localhost:3000`.

## API

- `GET /api/health`
- `POST /api/discover`

Exemple :

```json
{
  "query": "dropshipping",
  "mode": "deep",
  "maxResults": 50,
  "minSubscribers": 1000,
  "minVideos": 10
}
```

- `POST /api/scan` — `{ "channelId": "...", "maxVideos": 100 }`
- `GET /api/channels`
- `GET /api/links`
- `GET /api/domains`
- `GET /api/stats`
- `GET /api/export.csv`


## Exports domaines V3.2

- `/api/export-domains.txt` : tous les noms de domaine racine uniques, un par ligne.
- `/api/export-business-domains.txt` : domaines business uniquement (réseaux sociaux, YouTube, messageries et raccourcisseurs écartés), un par ligne.

Les sous-domaines sont ramenés au domaine enregistrable : `app.minea.com` devient `minea.com`, `shopify.pxf.io` devient `pxf.io`.


## Recherche NDD V3.3

Une recherche globale permet de saisir un domaine (ex. `dropified-france.com`) et de retrouver toutes ses occurrences dans l'ensemble des liens scannés, avec la chaîne, la vidéo, la date, l'URL détectée et un lien direct vers la vidéo YouTube.

Endpoint : `/api/domain-search?domain=dropified-france.com`


## V3.5 — vues vidéo

- Récupération des statistiques YouTube par lots de 50 vidéos.
- Colonne **Vues** dans les résultats de liens.
- Tri par défaut **Vues ↓**.
- Les anciennes vidéos sans stats sont hydratées automatiquement lors d’une recherche NDD (cache 24 h).


## V3.6 — date de publication des vidéos

- Ajout d'une colonne **Date vidéo** dans le tableau des liens détectés.
- La date correspond à `publishedAt` retourné par YouTube et est affichée au format `JJ/MM/AAAA`.
- Fonctionne aussi dans la recherche globale par NDD.
