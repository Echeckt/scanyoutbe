# EcomTube Scanner V2

MVP Node.js + PostgreSQL qui permet de :

- rechercher des chaînes YouTube autour d'une niche (`ecommerce`, `Shopify`, `dropshipping`, etc.) ;
- filtrer les faux positifs étrangers avec un score francophone ;
- analyser le pays déclaré, la description de chaîne et un échantillon des dernières vidéos ;
- scanner 25 à 500 vidéos par chaîne ;
- scanner toutes les chaînes trouvées en un clic ;
- extraire les URLs présentes dans les descriptions ;
- classer les domaines les plus présents ;
- estimer si une URL ressemble à un lien d'affiliation ;
- exporter les résultats en CSV.

## Déploiement Railway

### 1. GitHub

Commit tout le contenu de ce dossier à la racine du repo.

### 2. Variables Railway

Dans le service de l'application :

```env
YOUTUBE_API_KEY=AIzaSy...
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

`PORT` est injecté automatiquement par Railway.

### 3. Google Cloud

Active **YouTube Data API v3**, crée une clé API et limite si possible cette clé à YouTube Data API v3.

Ne commit jamais la clé dans GitHub.

## Filtre francophone V2

`regionCode=FR` et `relevanceLanguage=fr` aident à la découverte mais ne prouvent pas qu'une chaîne est française.

La V2 ajoute donc une seconde passe :

1. pays déclaré de la chaîne ;
2. langue déclarée lorsqu'elle existe ;
3. titre + description de la chaîne ;
4. texte d'un échantillon de ses dernières vidéos ;
5. comparaison de signaux français avec anglais / espagnol / allemand.

Seules les chaînes dont la confiance francophone dépasse le seuil sont enregistrées et affichées. Un pays `FR` ou une langue `fr` déclarée est considéré comme un signal fort.

## Scan global

Après une recherche, sélectionne le nombre de vidéos puis clique sur **Scanner toutes**.

Le navigateur lance deux scans simultanés afin de rester raisonnable côté API YouTube et PostgreSQL. La progression est visible directement dans l'interface.

## Base existante

La migration se fait automatiquement au démarrage avec `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Les anciennes chaînes qui n'ont jamais été vérifiées par la V2 ne sont plus comptées comme chaînes FR tant qu'elles ne sont pas redécouvertes et validées.

## Local

```bash
npm install
cp .env.example .env
npm run dev
```

Puis ouvre `http://localhost:3000`.

## API

- `GET /api/health`
- `POST /api/discover` — `{ "query": "ecommerce", "maxResults": 25 }`
- `POST /api/scan` — `{ "channelId": "...", "maxVideos": 100 }`
- `GET /api/channels`
- `GET /api/links`
- `GET /api/domains`
- `GET /api/stats`
- `GET /api/export.csv`
