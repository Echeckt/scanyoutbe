import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { initDatabase, hasDatabase } from './db.js';
import { discoverChannels, getChannel, getUploadedVideos } from './youtube.js';
import { extractLinks } from './links.js';
import {
  saveChannel,
  saveScan,
  getChannels,
  getKnownChannels,
  getLinks,
  getDomainStats,
  getStats
} from './repository.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'img-src': ["'self'", 'data:', 'https:'],
      'connect-src': ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    version: '3.0.0',
    youtubeKeyConfigured: Boolean(process.env.YOUTUBE_API_KEY),
    databaseConfigured: hasDatabase(),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/discover', async (req, res, next) => {
  try {
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'Entre un mot-clé de recherche.' });

    const mode = req.body?.mode === 'deep' ? 'deep' : 'rapid';
    const maxResults = Math.min(Math.max(Number(req.body?.maxResults || 50), 1), 200);
    const minSubscribers = Math.max(Number(req.body?.minSubscribers || 0), 0);
    const minVideos = Math.max(Number(req.body?.minVideos || 0), 0);

    // V3: les chaînes déjà vérifiées (FR ou étrangères) sont réutilisées pendant 30 jours.
    const cachedChannels = await getKnownChannels(10000);
    const result = await discoverChannels({
      query,
      mode,
      maxResults,
      minSubscribers,
      minVideos,
      cachedChannels
    });

    // On mémorise tous les candidats, y compris ceux hors filtres et les chaînes étrangères.
    // Les chaînes déjà vérifiées n'auront pas besoin d'une nouvelle analyse linguistique demain.
    await Promise.all(result.rememberedChannels.map((channel) => saveChannel(channel)));

    res.json({
      query,
      mode: result.mode,
      count: result.channels.length,
      rawResults: result.rawResults,
      uniqueCandidates: result.uniqueCandidates,
      eligibleCandidates: result.eligibleCandidates,
      inspected: result.inspected,
      rejected: result.rejected,
      filteredByMinimum: result.filteredByMinimum,
      cacheHits: result.cacheHits,
      freshChecks: result.freshChecks,
      searchCalls: result.searchCalls,
      searchQueries: result.searchQueries,
      channels: result.channels
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/scan', async (req, res, next) => {
  try {
    const channelId = String(req.body?.channelId || '').trim();
    const maxVideos = Math.min(Math.max(Number(req.body?.maxVideos || 100), 1), 1000);
    if (!channelId) return res.status(400).json({ error: 'channelId requis.' });

    const freshChannel = await getChannel(channelId);
    const knownChannels = await getKnownChannels(10000);
    const known = knownChannels.find((channel) => channel.id === channelId);
    const channel = known
      ? {
          ...known,
          ...freshChannel,
          isFrench: known.isFrench,
          frConfidence: known.frConfidence,
          frReason: known.frReason,
          lastVerifiedAt: known.lastVerifiedAt,
          discoveredQuery: known.discoveredQuery
        }
      : freshChannel;

    const videos = await getUploadedVideos(channel.uploadsPlaylistId, maxVideos);
    const videosWithLinks = videos.map((video) => ({
      video,
      links: extractLinks(video.description)
    }));

    await saveScan(channel, videosWithLinks);

    const links = videosWithLinks.flatMap(({ video, links: videoLinks }) =>
      videoLinks.map((link) => ({
        ...link,
        videoId: video.id,
        videoTitle: video.title,
        publishedAt: video.publishedAt,
        youtubeUrl: video.youtubeUrl,
        channelId: channel.id,
        channelTitle: channel.title
      }))
    );

    const domains = [...new Set(links.map((link) => link.domain))];
    res.json({
      channel,
      scannedVideos: videos.length,
      videosWithLinks: videosWithLinks.filter((item) => item.links.length).length,
      linksFound: links.length,
      uniqueDomains: domains.length,
      links
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/channels', async (_req, res, next) => {
  try {
    res.json({ channels: await getChannels() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/links', async (req, res, next) => {
  try {
    res.json({
      links: await getLinks({
        channelId: req.query.channelId || undefined,
        limit: req.query.limit || 1000
      })
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/domains', async (req, res, next) => {
  try {
    res.json({ domains: await getDomainStats(req.query.limit || 100) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stats', async (_req, res, next) => {
  try {
    res.json(await getStats());
  } catch (error) {
    next(error);
  }
});

app.get('/api/export.csv', async (_req, res, next) => {
  try {
    const links = await getLinks({ limit: 5000 });
    const headers = ['channel', 'video', 'published_at', 'domain', 'category', 'affiliate_likelihood', 'url', 'youtube_url'];
    const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = links.map((link) => [
      link.channelTitle,
      link.videoTitle,
      link.publishedAt,
      link.domain,
      link.category,
      link.affiliateLikelihood,
      link.normalizedUrl,
      link.youtubeUrl
    ].map(escapeCsv).join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="youtube-ecom-fr-links.csv"');
    res.send(`\uFEFF${headers.join(',')}\n${rows.join('\n')}`);
  } catch (error) {
    next(error);
  }
});

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error.status) || 500;
  res.status(status).json({
    error: error.message || 'Erreur interne.',
    details: process.env.NODE_ENV === 'development' ? error.details : undefined
  });
});

async function bootstrap() {
  try {
    const databaseReady = await initDatabase();
    console.log(databaseReady ? 'PostgreSQL ready.' : 'DATABASE_URL absent: memory mode enabled.');
  } catch (error) {
    console.error('Database init failed:', error.message);
    console.log('App will not start because DATABASE_URL is configured but invalid.');
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`YouTube Ecom FR Scanner v3 running on port ${PORT}`);
  });
}

bootstrap();
