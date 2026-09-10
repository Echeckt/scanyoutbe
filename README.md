# EcomTube Scanner — YouTube FR

MVP full-stack pour :

- rechercher des chaînes YouTube ciblées **France / français** autour de l'e-commerce ;
- récupérer la playlist automatique **Uploads** d'une chaîne ;
- scanner jusqu'à 1 000 vidéos par chaîne ;
- extraire toutes les URLs trouvées dans les descriptions ;
- normaliser les URLs et regrouper les résultats par domaine ;
- classifier rapidement les liens (`social`, `ecommerce`, `shortener`, `youtube`, `other`) ;
- détecter les paramètres typiques d'affiliation/referral ;
- sauvegarder les scans en PostgreSQL si `DATABASE_URL` est configuré ;
- exporter les liens en CSV.

## 1. Créer la clé YouTube API

Dans Google Cloud Console :

1. crée ou sélectionne un projet ;
2. active **YouTube Data API v3** ;
3. crée une **API key** ;
4. ajoute-la dans `YOUTUBE_API_KEY`.

La clé reste uniquement côté serveur et n'est jamais envoyée au navigateur.

## 2. Lancer en local

```bash
cp .env.example .env
# renseigne YOUTUBE_API_KEY dans .env
npm install
npm run dev
```

Puis ouvre :

```text
http://localhost:3000
```

Sans `DATABASE_URL`, l'app fonctionne en mémoire. Les données disparaissent au redémarrage.

## 3. PostgreSQL

Ajoute simplement :

```env
DATABASE_URL=postgresql://...
```

Le schéma est créé automatiquement au démarrage. Une copie est également disponible dans `sql/schema.sql`.

## 4. Déploiement Railway

1. pousse ce dossier sur GitHub ;
2. crée un nouveau projet Railway depuis le repo ;
3. ajoute `YOUTUBE_API_KEY` dans **Variables** ;
4. ajoute un service PostgreSQL Railway ;
5. vérifie que `DATABASE_URL` est injectée dans ton service web ;
6. déploie.

Le fichier `railway.json` est déjà inclus.

## API du projet

### `POST /api/discover`

```json
{
  "query": "ecommerce",
  "maxResults": 25
}
```

Retourne les chaînes trouvées avec abonnés, nombre de vidéos, pays déclaré quand disponible et playlist Uploads.

### `POST /api/scan`

```json
{
  "channelId": "UCxxxxxxxx",
  "maxVideos": 100
}
```

Scanne les descriptions des vidéos et retourne les liens détectés.

### `GET /api/channels`

Chaînes déjà découvertes/scannées.

### `GET /api/links?limit=1000`

Liens sauvegardés.

### `GET /api/domains?limit=100`

Classement des domaines les plus présents par nombre de chaînes puis nombre de liens.

### `GET /api/stats`

KPIs globaux.

### `GET /api/export.csv`

Export CSV des liens.

## Quota YouTube

Le point important est la découverte : `search.list` est à utiliser avec parcimonie. Le scan d'une chaîne passe ensuite par :

1. `channels.list` → `contentDetails.relatedPlaylists.uploads` ;
2. `playlistItems.list` par pages de 50 vidéos.

Le dashboard fait donc une seule recherche YouTube par clic sur **Trouver les chaînes**, puis les scans utilisent la playlist Uploads.

## Limite “chaînes FR”

YouTube ne fournit pas une catégorie native “chaînes françaises e-commerce”. L'app utilise :

- `relevanceLanguage=fr` ;
- `regionCode=FR` ;
- le mot-clé saisi ;
- `snippet.country` lorsqu'une chaîne a déclaré son pays.

Une chaîne sans `country=FR` peut tout de même être francophone et pertinente.

## Structure

```text
.
├── .env.example
├── .gitignore
├── package.json
├── railway.json
├── README.md
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── sql/
│   └── schema.sql
└── src/
    ├── db.js
    ├── links.js
    ├── repository.js
    ├── server.js
    └── youtube.js
```

## Prochaines évolutions utiles

- scanner automatiquement une liste de mots-clés e-commerce FR ;
- dédupliquer une même chaîne trouvée sur plusieurs niches ;
- détecter les **nouveaux domaines apparus** depuis le scan précédent ;
- historique “première apparition / dernière apparition” d'un sponsor ;
- résolution optionnelle des shortlinks (`bit.ly`, `linktr.ee`, etc.) ;
- détection plus poussée des liens affiliés ;
- score de pertinence “e-commerce FR” par chaîne ;
- scan planifié des chaînes enregistrées ;
- alertes Telegram/Discord lorsqu'un nouveau sponsor est détecté.
