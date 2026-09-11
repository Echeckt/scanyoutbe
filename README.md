# ScanYTB V4.5

Scanner YouTube pour découvrir les chaînes françaises, analyser leurs descriptions et extraire leurs liens, outils, sponsors, affiliations et noms de domaine.

## Domaine

`https://scan-ytb.com`

## Déploiement Railway

Variables nécessaires :

```env
YOUTUBE_API_KEY=...
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Le projet est prêt à être déployé depuis GitHub sur Railway avec PostgreSQL.

## Fonctionnalités

- recherche rapide ou profonde de chaînes YouTube francophones ;
- filtres abonnés / nombre de vidéos ;
- scan global des descriptions ;
- extraction et classement des liens / domaines ;
- recherche d’un NDD dans toute la base ;
- vues et date de publication des vidéos ;
- exports CSV ;
- exports TXT d’un NDD par ligne pour la recherche actuelle ;
- export business filtré (réseaux sociaux et raccourcisseurs retirés).

## Scripts

```bash
npm install
npm run check
npm start
```


## V4.3 — cache de recherche et gestion du quota

- Une recherche strictement identique est servie depuis PostgreSQL pendant 24 h sans nouvel appel `search.list`.
- Si le quota YouTube est atteint, ScanYTB tente d'afficher le dernier résultat mis en cache pour cette recherche.
- Si aucun cache n'existe, l'interface affiche une erreur claire au lieu de relancer des appels inutiles.
- Aucun mécanisme de rotation de projets/clefs pour contourner les quotas YouTube n'est inclus.
