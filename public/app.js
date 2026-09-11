const state = {
  discoveredChannels: [],
  links: [],
  domains: [],
  bulkScanning: false,
  searchMode: 'deep',
  sort: 'relevance',
  linkSort: 'views_desc',
  domainSearchResults: [],
  currentSearchQuery: '',
  currentSearchChannelIds: [],
  linkPage: 1,
  linkPageSize: 10
};

const $ = (selector) => document.querySelector(selector);
const fmt = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const exactFmt = new Intl.NumberFormat('fr-FR');
const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

function formatVideoDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFmt.format(date);
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toast(message, type = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${type} show`;
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => { el.className = 'toast'; }, 3800);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Erreur ${response.status}`);
  return data;
}

async function loadHealth() {
  try {
    const health = await api('/api/health');
    if (!health.youtubeKeyConfigured) {
      toast('Le service YouTube est momentanément indisponible.', 'error');
    }
  } catch {
    // Le statut technique reste volontairement invisible dans l’interface publique.
  }
}

async function refreshStats() {
  try {
    const stats = await api('/api/stats');
    $('#statChannels').textContent = fmt.format(Number(stats.channels || 0));
    $('#statVideos').textContent = fmt.format(Number(stats.videos || 0));
    $('#statLinks').textContent = fmt.format(Number(stats.links || 0));
    $('#statDomains').textContent = fmt.format(Number(stats.domains || 0));
  } catch {}
}

function confidenceLabel(channel) {
  if (channel.country === 'FR') return '🇫🇷 FR confirmé';
  const score = Number(channel.frConfidence || 0);
  if (score >= 82) return `🇫🇷 FR ${score}%`;
  return `🇫🇷 FR probable ${score}%`;
}

function getSortedChannels() {
  const channels = [...state.discoveredChannels];
  const sort = state.sort;

  if (sort === 'subscribers') {
    return channels.sort((a, b) => Number(b.subscribers || 0) - Number(a.subscribers || 0));
  }
  if (sort === 'videos') {
    return channels.sort((a, b) => Number(b.videoCount || 0) - Number(a.videoCount || 0));
  }
  if (sort === 'confidence') {
    return channels.sort((a, b) => Number(b.frConfidence || 0) - Number(a.frConfidence || 0));
  }
  return channels.sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0));
}

function renderChannels() {
  const container = $('#channels');
  const scanAllBtn = $('#scanAllBtn');
  scanAllBtn.disabled = !state.discoveredChannels.length || state.bulkScanning;

  if (!state.discoveredChannels.length) {
    container.className = 'channel-list empty-state';
    container.textContent = 'Aucune chaîne francophone trouvée avec ces filtres.';
    return;
  }

  const channels = getSortedChannels();
  container.className = 'channel-list';
  container.innerHTML = channels.map((channel) => {
    const queryCount = Number(channel.matchedQueries?.length || 0);
    const sourceText = channel.discoverySources?.includes('video') && channel.discoverySources?.includes('channel')
      ? 'chaînes + vidéos'
      : channel.discoverySources?.includes('video') ? 'via vidéos' : 'via chaînes';
    const cacheBadge = channel.verificationCached
      ? '<span class="cache-badge">cache</span>'
      : '';

    return `
      <article class="channel-card" data-channel-card="${escapeHtml(channel.id)}">
        <img class="avatar" src="${escapeHtml(channel.thumbnail || '')}" alt="" loading="lazy" />
        <div class="channel-info">
          <div class="channel-name">${escapeHtml(channel.title)}</div>
          <div class="channel-meta">
            <span><strong>${fmt.format(channel.subscribers)}</strong> abonnés</span>
            <span><strong>${fmt.format(channel.videoCount)}</strong> vidéos</span>
            <span class="fr-badge" title="${escapeHtml(channel.frReason || '')}">${escapeHtml(confidenceLabel(channel))}</span>
            ${cacheBadge}
            <span class="discover-badge" title="${escapeHtml((channel.matchedQueries || []).join(' · '))}">${queryCount} req. · ${escapeHtml(sourceText)}</span>
            <a href="${escapeHtml(channel.youtubeUrl)}" target="_blank" rel="noopener">Ouvrir ↗</a>
          </div>
        </div>
        <div class="channel-actions">
          <select class="scan-select" data-scan-count="${escapeHtml(channel.id)}" aria-label="Nombre de vidéos à scanner">
            <option value="25">25 vidéos</option>
            <option value="50">50 vidéos</option>
            <option value="100" selected>100 vidéos</option>
            <option value="250">250 vidéos</option>
            <option value="500">500 vidéos</option>
          </select>
          <button class="button primary small scan-btn" data-channel-id="${escapeHtml(channel.id)}">Scanner</button>
        </div>
      </article>
    `;
  }).join('');

  document.querySelectorAll('.scan-btn').forEach((button) => {
    button.addEventListener('click', () => scanChannel(button));
  });
}

function renderTelemetry(data) {
  $('#searchTelemetry').hidden = false;
  $('#teleRaw').textContent = exactFmt.format(Number(data.rawResults || 0));
  $('#teleUnique').textContent = exactFmt.format(Number(data.uniqueCandidates || 0));
  $('#teleEligible').textContent = exactFmt.format(Number(data.eligibleCandidates || 0));
  $('#teleFrench').textContent = exactFmt.format(Number(data.count || 0));
  $('#teleCache').textContent = exactFmt.format(Number(data.cacheHits || 0));
}

async function discover(event) {
  event.preventDefault();
  if (state.bulkScanning) return;

  const button = $('#discoverBtn');
  const query = $('#query').value.trim();
  if (!query) return;

  const minSubscribers = Number($('#minSubscribers').value || 0);
  const maxSubscribers = Number($('#maxSubscribers').value || 0);
  if (maxSubscribers && maxSubscribers < minSubscribers) {
    toast('Le maximum d’abonnés doit être supérieur ou égal au minimum.', 'error');
    return;
  }

  button.disabled = true;
  button.classList.add('loading');
  button.textContent = state.searchMode === 'deep' ? 'Recherche profonde' : 'Recherche rapide';
  $('#discoverMeta').textContent = state.searchMode === 'deep'
    ? 'Plusieurs requêtes YouTube + déduplication + vérification FR…'
    : 'Recherche rapide + vérification FR…';

  try {
    const data = await api('/api/discover', {
      method: 'POST',
      body: JSON.stringify({
        query,
        mode: state.searchMode,
        maxResults: Number($('#maxResults').value),
        minSubscribers,
        maxSubscribers,
        minVideos: Number($('#minVideos').value)
      })
    });

    state.discoveredChannels = data.channels;
    state.currentSearchQuery = query;
    state.linkPage = 1;
    state.currentSearchChannelIds = data.channels.map((channel) => channel.id);
    $('#exportSearchDomainsBtn').disabled = !state.currentSearchChannelIds.length;
    renderChannels();
    renderTelemetry(data);

    const minimumText = Number(data.filteredByMinimum || 0)
      ? ` · ${data.filteredByMinimum} hors filtres`
      : '';
    const sourceText = data.servedFromCache
      ? (data.quotaReached ? ' · quota YouTube atteint · résultats du cache' : ' · cache recherche · 0 appel YouTube')
      : '';
    $('#discoverMeta').textContent = `${data.rawResults} résultats YouTube · ${data.uniqueCandidates} chaînes uniques · ${data.count} FR retenues · ${data.rejected} étrangères${minimumText} · ${data.cacheHits} vérifs cache${sourceText}`;

    const modeLabel = data.mode === 'deep' ? 'Recherche profonde' : 'Recherche rapide';
    if (data.quotaReached) {
      toast(`Quota YouTube atteint : résultats déjà enregistrés affichés depuis le cache.`, 'error');
    } else if (data.servedFromCache) {
      toast(`Résultats réutilisés depuis le cache : aucun quota de recherche consommé.`);
    } else {
      toast(`${modeLabel} terminée : ${data.count} chaîne${data.count > 1 ? 's' : ''} FR trouvée${data.count > 1 ? 's' : ''}.`);
    }
    refreshStats();
  } catch (error) {
    $('#discoverMeta').textContent = 'Échec de la recherche.';
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
    button.textContent = 'Lancer la recherche';
  }
}

async function scanChannel(button, forcedMaxVideos = null, silent = false) {
  const channelId = button.dataset.channelId;
  const select = document.querySelector(`[data-scan-count="${CSS.escape(channelId)}"]`);
  const maxVideos = forcedMaxVideos ?? Number(select?.value || 100);
  const original = button.textContent;
  button.disabled = true;
  button.classList.add('loading');
  button.textContent = 'Scan';

  try {
    const data = await api('/api/scan', {
      method: 'POST',
      body: JSON.stringify({ channelId, maxVideos })
    });
    if (!silent) {
      toast(`${data.channel.title}: ${data.scannedVideos} vidéos · ${data.linksFound} liens · ${data.uniqueDomains} domaines.`);
      await Promise.all([loadLinks(), loadDomains(), refreshStats()]);
    }
    button.textContent = 'Scanné ✓';
    return data;
  } catch (error) {
    if (!silent) toast(error.message, 'error');
    button.textContent = 'Erreur';
    throw error;
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
    if (!state.bulkScanning) setTimeout(() => { button.textContent = original; }, 1800);
  }
}

function updateBulkProgress(done, total, label) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('#bulkProgress').hidden = false;
  $('#bulkProgressText').textContent = label;
  $('#bulkProgressPct').textContent = `${pct}%`;
  $('#bulkProgressBar').style.width = `${pct}%`;
}

function openScanCompleteModal() {
  if (!state.currentSearchChannelIds.length) return;
  const modal = $('#scanCompleteModal');
  const text = $('#scanCompleteText');
  if (!modal) return;
  text.textContent = `Le scan de « ${state.currentSearchQuery || 'cette recherche'} » est terminé. Souhaites-tu télécharger les NDD business détectés, avec un domaine par ligne ?`;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  $('#scanModalYes')?.focus();
}

function closeScanCompleteModal() {
  const modal = $('#scanCompleteModal');
  if (modal) modal.hidden = true;
  document.body.classList.remove('modal-open');
}

async function scanAllChannels() {
  if (state.bulkScanning || !state.discoveredChannels.length) return;

  state.bulkScanning = true;
  const button = $('#scanAllBtn');
  const maxVideos = Number($('#scanAllCount').value || 100);
  const channels = getSortedChannels();
  let done = 0;
  let totalLinks = 0;
  let totalVideos = 0;
  let failures = 0;
  let cursor = 0;

  button.disabled = true;
  button.classList.add('loading');
  button.textContent = 'Scan global';
  document.querySelectorAll('.scan-btn').forEach((b) => { b.disabled = true; });
  updateBulkProgress(0, channels.length, `0/${channels.length} chaîne scannée`);

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= channels.length) return;
      const channel = channels[index];
      const channelButton = document.querySelector(`.scan-btn[data-channel-id="${CSS.escape(channel.id)}"]`);

      try {
        const data = await scanChannel(channelButton, maxVideos, true);
        totalLinks += Number(data.linksFound || 0);
        totalVideos += Number(data.scannedVideos || 0);
      } catch {
        failures += 1;
      }

      done += 1;
      updateBulkProgress(done, channels.length, `${done}/${channels.length} chaînes · ${totalVideos} vidéos · ${totalLinks} liens`);
    }
  }

  await Promise.all([worker(), worker()]);
  await Promise.all([loadLinks(), loadDomains(), refreshStats()]);

  state.bulkScanning = false;
  button.classList.remove('loading');
  button.textContent = 'Scanner toutes';
  renderChannels();
  updateBulkProgress(channels.length, channels.length, `${channels.length - failures}/${channels.length} chaînes terminées · ${totalVideos} vidéos · ${totalLinks} liens`);

  if (failures) {
    toast(`Scan terminé avec ${failures} erreur${failures > 1 ? 's' : ''}. ${totalLinks} liens détectés.`, 'error');
  } else {
    toast(`Scan terminé : ${channels.length} chaînes · ${totalVideos} vidéos · ${totalLinks} liens.`);
  }

  openScanCompleteModal();
}

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function looksLikeDomain(value = '') {
  const raw = String(value).trim().toLowerCase();
  if (!raw || raw.includes(' ')) return false;
  const cleaned = raw.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].replace(/^www\./, '');
  return /^[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,63}$/i.test(cleaned);
}

async function searchAllLinksByDomain(query) {
  const value = String(query || '').trim();
  if (!looksLikeDomain(value)) {
    state.globalLinkResults = null;
    state.globalLinkQuery = '';
    state.globalLinkSummary = null;
    $('#linkSearchMeta').textContent = 'Filtre local sur les 1 000 derniers liens · entre un NDD complet pour chercher dans toute la base.';
    renderLinks();
    return;
  }

  const meta = $('#linkSearchMeta');
  meta.textContent = `Recherche globale de ${value} dans toute la base…`;

  try {
    const data = await api(`/api/domain-search?domain=${encodeURIComponent(value)}&limit=10000`);
    state.globalLinkResults = data.results || [];
    state.globalLinkQuery = data.domain;
    state.linkPage = 1;
    state.globalLinkSummary = data;
    $('#linkFilter').value = data.domain;
    meta.textContent = `${exactFmt.format(Number(data.total || 0))} occurrence${Number(data.total || 0) > 1 ? 's' : ''} · ${exactFmt.format(Number(data.videos || 0))} vidéo${Number(data.videos || 0) > 1 ? 's' : ''} · ${exactFmt.format(Number(data.channels || 0))} chaîne${Number(data.channels || 0) > 1 ? 's' : ''} · recherche dans toute la base`;
    renderLinks();
  } catch (error) {
    state.globalLinkResults = [];
    state.globalLinkQuery = value;
    state.linkPage = 1;
    state.globalLinkSummary = { total: 0, videos: 0, channels: 0 };
    meta.textContent = 'Erreur pendant la recherche globale.';
    renderLinks();
    toast(error.message, 'error');
  }
}

let linkSearchTimer = null;
function handleLinkFilterInput() {
  clearTimeout(linkSearchTimer);
  const value = $('#linkFilter').value.trim();

  if (!value) {
    state.linkPage = 1;
    state.globalLinkResults = null;
    state.globalLinkQuery = '';
    state.globalLinkSummary = null;
    $('#linkSearchMeta').textContent = 'Tape un NDD complet pour chercher dans toute la base.';
    renderLinks();
    return;
  }

  if (looksLikeDomain(value)) {
    state.linkPage = 1;
    $('#linkSearchMeta').textContent = 'NDD détecté · recherche globale dans 0,5 s…';
    linkSearchTimer = setTimeout(() => searchAllLinksByDomain(value), 500);
    return;
  }

  state.linkPage = 1;
  state.globalLinkResults = null;
  state.globalLinkQuery = '';
  state.globalLinkSummary = null;
  $('#linkSearchMeta').textContent = 'Filtre local sur les 1 000 derniers liens · entre un NDD complet pour chercher dans toute la base.';
  renderLinks();
}

async function loadLinks() {
  try {
    const data = await api('/api/links?limit=1000');
    state.links = data.links;
    renderLinks();
  } catch {}
}

function renderLinks() {
  const body = $('#linksBody');
  const pagination = $('#linksPagination');
  const pageInfo = $('#linksPageInfo');
  const prevButton = $('#linksPrevPage');
  const nextButton = $('#linksNextPage');
  const search = $('#linkFilter').value.trim().toLowerCase();
  const category = $('#categoryFilter').value;
  const source = Array.isArray(state.globalLinkResults) ? state.globalLinkResults : state.links;

  const links = source.filter((link) => {
    if (category && link.category !== category) return false;
    if (Array.isArray(state.globalLinkResults)) return true;
    if (!search) return true;
    return [link.channelTitle, link.videoTitle, link.domain, link.normalizedUrl]
      .some((value) => String(value || '').toLowerCase().includes(search));
  });

  links.sort((a, b) => {
    if (state.linkSort === 'views_asc') {
      return Number(a.viewCount ?? Number.MAX_SAFE_INTEGER) - Number(b.viewCount ?? Number.MAX_SAFE_INTEGER)
        || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
    }
    if (state.linkSort === 'date_desc') {
      return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
    }
    return Number(b.viewCount ?? -1) - Number(a.viewCount ?? -1)
      || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
  });

  if (!links.length) {
    const global = Array.isArray(state.globalLinkResults);
    body.innerHTML = `<tr><td colspan="8" class="empty-cell">${global && state.globalLinkQuery ? `Aucune occurrence de <strong>${escapeHtml(state.globalLinkQuery)}</strong> dans toute la base scannée.` : 'Aucun lien correspondant.'}</td></tr>`;
    if (pagination) pagination.hidden = true;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(links.length / state.linkPageSize));
  state.linkPage = Math.min(Math.max(state.linkPage, 1), totalPages);
  const offset = (state.linkPage - 1) * state.linkPageSize;
  const visibleLinks = links.slice(offset, offset + state.linkPageSize);

  body.innerHTML = visibleLinks.map((link) => `
    <tr>
      <td><span class="truncate" title="${escapeHtml(link.channelTitle)}">${escapeHtml(link.channelTitle)}</span></td>
      <td><a class="truncate" href="${escapeHtml(link.youtubeUrl || `https://www.youtube.com/watch?v=${link.videoId}`)}" target="_blank" rel="noopener" title="${escapeHtml(link.videoTitle)}">${escapeHtml(link.videoTitle)}</a></td>
      <td class="views-cell" title="${link.viewCount === null || link.viewCount === undefined ? 'Nombre de vues non disponible' : `${exactFmt.format(Number(link.viewCount))} vues`}">${link.viewCount === null || link.viewCount === undefined ? '—' : `<strong>${fmt.format(Number(link.viewCount))}</strong>`}</td>
      <td class="date-cell" title="${escapeHtml(link.publishedAt || '')}">${escapeHtml(formatVideoDate(link.publishedAt))}</td>
      <td><strong>${escapeHtml(link.domain)}</strong></td>
      <td><span class="badge">${escapeHtml(link.category)}</span></td>
      <td><span class="badge ${escapeHtml(link.affiliateLikelihood)}">${escapeHtml(link.affiliateLikelihood)}</span></td>
      <td><a class="truncate" href="${escapeHtml(link.normalizedUrl || link.url)}" target="_blank" rel="noopener" title="${escapeHtml(link.normalizedUrl || link.url)}">${escapeHtml(link.normalizedUrl || link.url)}</a></td>
    </tr>
  `).join('');

  if (pagination) {
    pagination.hidden = totalPages <= 1;
    if (pageInfo) pageInfo.textContent = `Page ${state.linkPage} / ${totalPages} · ${exactFmt.format(links.length)} liens`;
    if (prevButton) prevButton.disabled = state.linkPage <= 1;
    if (nextButton) nextButton.disabled = state.linkPage >= totalPages;
  }
}

async function loadDomains() {
  try {
    const data = await api('/api/domains?limit=40');
    state.domains = data.domains;
    renderDomains();
  } catch {}
}

function renderDomains() {
  const container = $('#domains');
  if (!state.domains.length) {
    container.className = 'domain-list empty-state';
    container.textContent = 'Scanne des chaînes pour générer le classement.';
    return;
  }

  container.className = 'domain-list';
  container.innerHTML = state.domains.slice(0, 20).map((domain, index) => `
    <div class="domain-row">
      <div class="domain-rank">${index + 1}</div>
      <div>
        <button class="domain-name domain-quick-search" type="button" data-domain-search="${escapeHtml(domain.domain)}" title="Rechercher ce domaine dans toute la base">${escapeHtml(domain.domain)}</button>
        <div class="domain-sub">${domain.links} liens · ${domain.videos} vidéos</div>
      </div>
      <div class="domain-count">${domain.channels} ch.</div>
    </div>
  `).join('');

  container.querySelectorAll('[data-domain-search]').forEach((button) => {
    button.addEventListener('click', () => {
      $('#linkFilter').value = button.dataset.domainSearch || '';
      searchAllLinksByDomain(button.dataset.domainSearch || '');
      $('.links-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

async function downloadCurrentSearchDomains(businessOnly) {
  if (!state.currentSearchChannelIds.length) {
    toast('Lance d’abord une recherche.', 'error');
    return;
  }

  const button = businessOnly ? null : $('#exportSearchDomainsBtn');
  if (button) {
    button.disabled = true;
    button.classList.add('loading');
    button.setAttribute('aria-busy', 'true');
  }

  try {
    const response = await fetch('/api/export-search-domains.txt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: state.currentSearchQuery,
        channelIds: state.currentSearchChannelIds,
        businessOnly
      })
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Erreur ${response.status}`);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    const filename = filenameMatch?.[1] || (businessOnly ? 'domaines-business-recherche.txt' : 'domaines-recherche.txt');
    const count = response.headers.get('X-Domain-Count');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`${count || '0'} NDD exportés pour « ${state.currentSearchQuery} ».`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove('loading');
      button.removeAttribute('aria-busy');
    }
  }
}

function setMode(mode) {
  state.searchMode = mode === 'rapid' ? 'rapid' : 'deep';
  $('#searchMode').value = state.searchMode;
  document.querySelectorAll('.mode-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === state.searchMode);
  });
  const hint = $('.deep-hint');
  if (state.searchMode === 'deep') {
    hint.innerHTML = '<strong>Profonde</strong><span>8 recherches YouTube · chaînes + vidéos · cache 30 jours</span>';
  } else {
    hint.innerHTML = '<strong>Rapide</strong><span>1 recherche YouTube · idéale pour tester un mot-clé</span>';
  }
}

$('#discoverForm').addEventListener('submit', discover);
$('#scanAllBtn').addEventListener('click', scanAllChannels);
$('#linksPrevPage')?.addEventListener('click', () => {
  if (state.linkPage <= 1) return;
  state.linkPage -= 1;
  renderLinks();
  $('#links')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#linksNextPage')?.addEventListener('click', () => {
  state.linkPage += 1;
  renderLinks();
  $('#links')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#scanModalNo')?.addEventListener('click', closeScanCompleteModal);
$('#scanModalYes')?.addEventListener('click', async () => {
  closeScanCompleteModal();
  await downloadCurrentSearchDomains(true);
});
$('#scanCompleteModal')?.addEventListener('click', (event) => {
  if (event.target.id === 'scanCompleteModal') closeScanCompleteModal();
});
$('#exportSearchDomainsBtn').addEventListener('click', () => downloadCurrentSearchDomains(false));
$('#linkFilter').addEventListener('input', handleLinkFilterInput);
$('#categoryFilter').addEventListener('change', () => {
  state.linkPage = 1;
  renderLinks();
});
$('#linkSort').addEventListener('change', (event) => {
  state.linkSort = event.target.value;
  state.linkPage = 1;
  renderLinks();
});
$('#channelSort').addEventListener('change', (event) => {
  state.sort = event.target.value;
  renderChannels();
});
document.querySelectorAll('.mode-btn').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
});

document.querySelectorAll('[data-query-example]').forEach((button) => {
  button.addEventListener('click', () => {
    $('#query').value = button.dataset.queryExample || '';
    $('#query').focus();
  });
});

const focusMainSearch = () => {
  document.querySelector('#home')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => $('#query')?.focus(), 250);
};

$('#topSearchButton')?.addEventListener('click', focusMainSearch);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#scanCompleteModal')?.hidden) {
    closeScanCompleteModal();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    focusMainSearch();
  }
});

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.remove('active'));
    item.classList.add('active');
  });
});

setMode('deep');
await Promise.all([loadHealth(), refreshStats(), loadLinks(), loadDomains()]);
