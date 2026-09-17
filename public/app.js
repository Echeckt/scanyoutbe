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
  linkPageSize: 10,
  user: null,
  authMode: 'register',
  pendingSearchPayload: null
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
  if (!response.ok) {
    const error = new Error(data.error || `Erreur ${response.status}`);
    error.status = response.status;
    error.code = data.code;
    error.data = data;
    throw error;
  }
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
    const hitCount = Number(channel.hitCount || 0);
    const sourceText = channel.discoverySources?.includes('video') && channel.discoverySources?.includes('channel')
      ? 'chaînes + vidéos'
      : channel.discoverySources?.includes('video') ? 'via vidéos' : 'via chaînes';
    const sourceTitle = (channel.matchedQueries || []).join(' · ');
    const cacheBadge = channel.verificationCached
      ? '<span class="cache-badge">cache</span>'
      : '';

    return `
      <article class="channel-card" data-channel-card="${escapeHtml(channel.id)}">
        <div class="channel-primary">
          <img class="avatar" src="${escapeHtml(channel.thumbnail || '')}" alt="" loading="lazy" />
          <div class="channel-info">
            <div class="channel-name-row">
              <div class="channel-name">${escapeHtml(channel.title)}</div>
              <a class="channel-open" href="${escapeHtml(channel.youtubeUrl)}" target="_blank" rel="noopener" aria-label="Ouvrir ${escapeHtml(channel.title)} sur YouTube">↗</a>
            </div>
            <div class="channel-source-meta">
              ${cacheBadge}
              <span class="discover-badge" title="${escapeHtml(sourceTitle)}">${queryCount} req. · ${hitCount} signaux · ${escapeHtml(sourceText)}</span>
            </div>
          </div>
        </div>
        <div class="channel-stat"><strong>${fmt.format(channel.subscribers)}</strong><span>abonnés</span></div>
        <div class="channel-stat"><strong>${fmt.format(channel.videoCount)}</strong><span>vidéos</span></div>
        <div class="channel-score"><span class="fr-badge" title="${escapeHtml(channel.frReason || '')}">${escapeHtml(confidenceLabel(channel))}</span></div>
        <div class="channel-actions">
          <select class="scan-select" data-scan-count="${escapeHtml(channel.id)}" aria-label="Nombre de vidéos à scanner">
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100" selected>100 vidéos</option>
            <option value="250">250</option>
            <option value="500">500</option>
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

function collectSearchPayload() {
  const query = $('#query').value.trim();
  const minSubscribers = Number($('#minSubscribers').value || 0);
  const maxSubscribers = Number($('#maxSubscribers').value || 0);
  if (!query) return null;
  if (looksLikeDomain(query)) {
    toast('Entre une niche ou un mot-clé, pas un nom de domaine.', 'error');
    return null;
  }
  if (maxSubscribers && maxSubscribers < minSubscribers) {
    toast('Le maximum d’abonnés doit être supérieur ou égal au minimum.', 'error');
    return null;
  }
  return {
    query,
    mode: state.searchMode,
    maxResults: Number($('#maxResults').value),
    minSubscribers,
    maxSubscribers,
    minVideos: Number($('#minVideos').value)
  };
}

function restoreSearchForm(payload) {
  if (!payload) return;
  $('#query').value = payload.query || '';
  $('#maxResults').value = String(payload.maxResults || 50);
  $('#minSubscribers').value = String(payload.minSubscribers || 0);
  $('#maxSubscribers').value = String(payload.maxSubscribers || 0);
  $('#minVideos').value = String(payload.minVideos || 0);
  setMode(payload.mode || 'deep');
}

async function discover(event) {
  event.preventDefault();
  if (state.bulkScanning) return;
  const payload = collectSearchPayload();
  if (!payload) return;
  state.pendingSearchPayload = payload;

  if (!state.user) {
    openAuthModal('register');
    return;
  }
  if (!state.user.isAdmin && Number(state.user.credits || 0) < 1) {
    openPurchaseModal();
    return;
  }
  await performDiscovery(payload);
}

async function performDiscovery(payload) {
  if (!payload || state.bulkScanning) return;
  const button = $('#discoverBtn');
  button.disabled = true;
  button.classList.add('loading');
  button.textContent = payload.mode === 'deep' ? 'Recherche profonde' : 'Recherche rapide';
  $('#discoverMeta').textContent = payload.mode === 'deep'
    ? 'Exploration multi-requêtes YouTube + plusieurs classements + déduplication + vérification FR…'
    : 'Recherche chaînes + vidéos + vérification FR…';

  try {
    const data = await api('/api/discover', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    state.discoveredChannels = data.channels;
    state.currentSearchQuery = data.query || payload.query;
    state.linkPage = 1;
    state.currentSearchChannelIds = data.channels.map((channel) => channel.id);
    $('#exportSearchDomainsBtn').disabled = !state.currentSearchChannelIds.length;
    if (state.user && !state.user.isAdmin) state.user.credits = Number(data.creditsRemaining ?? state.user.credits ?? 0);
    state.pendingSearchPayload = null;
    sessionStorage.removeItem('scanYTB.pendingSearch');
    renderUserUI();
    renderChannels();
    renderTelemetry(data);

    const minimumText = Number(data.filteredByMinimum || 0)
      ? ` · ${data.filteredByMinimum} hors filtres`
      : '';
    const sourceText = data.servedFromCache
      ? (data.quotaReached ? ' · quota YouTube atteint · résultats du cache' : ' · cache recherche')
      : '';
    $('#discoverMeta').textContent = `${data.rawResults} résultats YouTube · ${data.searchCalls || 0} appels de découverte · ${data.uniqueCandidates} chaînes uniques · ${data.count} FR retenues · ${data.rejected} étrangères${minimumText} · ${data.cacheHits} vérifs cache${sourceText}`;

    const modeLabel = data.mode === 'deep' ? 'Recherche profonde' : 'Recherche rapide';
    const creditSuffix = state.user?.isAdmin ? ' · compte admin, aucun crédit débité.' : ' · 1 crédit utilisé.';
    if (data.quotaReached) {
      toast(`Résultats déjà enregistrés affichés depuis le cache${creditSuffix}`);
    } else if (data.servedFromCache) {
      toast(`Recherche terminée depuis le cache${creditSuffix}`);
    } else {
      toast(`${modeLabel} terminée : ${data.count} chaîne${data.count > 1 ? 's' : ''} FR trouvée${data.count > 1 ? 's' : ''}${creditSuffix}`);
    }
    await Promise.all([refreshStats(), loadAccountHistory()]);
  } catch (error) {
    $('#discoverMeta').textContent = 'Échec de la recherche.';
    if (error.code === 'NO_CREDITS' || error.status === 402) {
      await loadSession();
      openPurchaseModal();
    } else if (error.code === 'AUTH_REQUIRED' || error.status === 401) {
      state.user = null;
      renderUserUI();
      openAuthModal('login');
    } else {
      toast(error.message, 'error');
      await loadSession();
    }
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

function anyModalOpen() {
  return [...document.querySelectorAll('.modal-backdrop')].some((modal) => !modal.hidden);
}

function openModal(id) {
  const modal = $(`#${id}`);
  if (!modal) return;
  modal.hidden = false;
  document.body.classList.add('modal-open');
}

function closeModal(id) {
  const modal = $(`#${id}`);
  if (modal) modal.hidden = true;
  if (!anyModalOpen()) document.body.classList.remove('modal-open');
}

function setAuthMode(mode) {
  state.authMode = mode === 'login' ? 'login' : 'register';
  $('#authTabLogin')?.classList.toggle('active', state.authMode === 'login');
  $('#authTabRegister')?.classList.toggle('active', state.authMode === 'register');
  $('#authTitle').textContent = state.authMode === 'login' ? 'Connecte-toi à ScanYTB' : 'Crée ton compte pour continuer';
  $('#authSubmit').textContent = state.authMode === 'login' ? 'Se connecter' : 'Créer mon compte';
  $('#authPassword').autocomplete = state.authMode === 'login' ? 'current-password' : 'new-password';
  $('#authError').hidden = true;
}

function openAuthModal(mode = 'register') {
  setAuthMode(mode);
  openModal('authModal');
  window.setTimeout(() => $('#authEmail')?.focus(), 50);
}

function openPurchaseModal() {
  if (!state.user) return openAuthModal('register');
  if (state.user.isAdmin) return;
  closeModal('authModal');
  openModal('purchaseModal');
}

async function loadSession() {
  try {
    const data = await api('/api/auth/session');
    state.user = data.user || null;
  } catch {
    state.user = null;
  }
  renderUserUI();
  return state.user;
}

function renderUserUI() {
  const topAccount = $('#accountButton');
  const heroAccount = $('#heroAccountButton');
  const creditsButton = $('#creditsButton');
  if (!state.user) {
    if (topAccount) topAccount.textContent = 'Se connecter';
    if (heroAccount) heroAccount.textContent = 'Se connecter';
    if (creditsButton) {
      creditsButton.hidden = true;
      creditsButton.classList.remove('admin-credit-pill');
    }
    if ($('#accountAdminBadge')) $('#accountAdminBadge').hidden = true;
    if ($('#accountCreditLabel')) $('#accountCreditLabel').textContent = 'crédit';
    if ($('#accountBuyCredit')) {
      $('#accountBuyCredit').hidden = false;
      $('#accountBuyCredit').style.display = '';
    }
    if ($('#searchPriceNote')) {
      $('#searchPriceNote').innerHTML = '<span>1 recherche = 1 crédit</span><strong>4,99 €</strong><small>Le crédit est rendu automatiquement si la recherche échoue.</small>';
    }
    return;
  }
  const credits = Number(state.user.credits || 0);
  const admin = Boolean(state.user.isAdmin);
  const label = admin ? '∞ crédits' : `${credits} crédit${credits > 1 ? 's' : ''}`;
  if (topAccount) topAccount.textContent = admin ? 'Admin' : 'Mon compte';
  if (heroAccount) heroAccount.textContent = admin ? 'Admin · Crédits illimités' : `${label} · Mon compte`;
  if (creditsButton) {
    creditsButton.hidden = false;
    creditsButton.textContent = admin ? '∞ crédits' : label;
    creditsButton.classList.toggle('admin-credit-pill', admin);
  }
  if ($('#accountEmail')) $('#accountEmail').textContent = state.user.email || '—';
  if ($('#accountCredits')) $('#accountCredits').textContent = admin ? '∞' : exactFmt.format(credits);
  if ($('#accountCreditLabel')) $('#accountCreditLabel').textContent = admin ? 'illimités' : 'crédit';
  if ($('#accountAdminBadge')) $('#accountAdminBadge').hidden = !admin;
  if ($('#accountBuyCredit')) {
    $('#accountBuyCredit').hidden = admin;
    $('#accountBuyCredit').style.display = admin ? 'none' : '';
  }
  if ($('#searchPriceNote')) {
    $('#searchPriceNote').innerHTML = admin
      ? '<span>Compte administrateur</span><strong>∞</strong><small>Recherches et accès illimités.</small>'
      : '<span>1 recherche = 1 crédit</span><strong>4,99 €</strong><small>Le crédit est rendu automatiquement si la recherche échoue.</small>';
  }
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const button = $('#authSubmit');
  const errorBox = $('#authError');
  button.disabled = true;
  button.classList.add('loading');
  errorBox.hidden = true;
  try {
    const data = await api(state.authMode === 'login' ? '/api/auth/login' : '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: $('#authEmail').value.trim(), password: $('#authPassword').value })
    });
    state.user = data.user;
    renderUserUI();
    closeModal('authModal');
    toast(state.authMode === 'login' ? 'Connexion réussie.' : 'Compte créé. Bienvenue sur ScanYTB.');
    if (state.pendingSearchPayload) {
      if (state.user.isAdmin || Number(state.user.credits || 0) > 0) await performDiscovery(state.pendingSearchPayload);
      else openPurchaseModal();
    } else {
      await loadAccountHistory();
    }
    await handleExtensionDeepLink();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
  }
}

async function startCheckout() {
  if (!state.user) return openAuthModal('login');
  const button = $('#buyCreditButton');
  button.disabled = true;
  button.classList.add('loading');
  try {
    if (state.pendingSearchPayload) {
      sessionStorage.setItem('scanYTB.pendingSearch', JSON.stringify(state.pendingSearchPayload));
    }
    const data = await api('/api/billing/checkout', { method: 'POST', body: '{}' });
    window.location.href = data.url;
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
    button.classList.remove('loading');
  }
}

function formatHistoryDate(value) {
  if (!value) return '—';
  try { return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
  catch { return '—'; }
}

async function loadAccountHistory() {
  const container = $('#accountHistory');
  if (!container || !state.user) return;
  try {
    const data = await api('/api/account/history?limit=30');
    const searches = data.searches || [];
    if (!searches.length) {
      container.innerHTML = '<div class="history-empty">Aucune recherche pour le moment.</div>';
      return;
    }
    container.innerHTML = searches.map((search) => {
      const count = Number(search.resultSummary?.count || 0);
      const statusLabel = search.status === 'completed' ? 'terminée' : search.status === 'refunded' ? 'remboursée' : search.status;
      return `<div class="history-row">
        <div class="history-main"><strong>${escapeHtml(search.query)} <span class="history-status ${escapeHtml(search.status)}">${escapeHtml(statusLabel)}</span></strong><span>${escapeHtml(formatHistoryDate(search.createdAt))} · ${escapeHtml(search.mode === 'deep' ? 'Profonde' : 'Rapide')}</span></div>
        <div class="history-count">${count ? `${exactFmt.format(count)} chaîne${count > 1 ? 's' : ''}` : '—'}</div>
        ${search.status === 'completed' ? `<button class="history-open" type="button" data-history-id="${search.id}">Revoir</button>` : ''}
      </div>`;
    }).join('');
    container.querySelectorAll('[data-history-id]').forEach((button) => {
      button.addEventListener('click', () => reopenHistorySearch(button.dataset.historyId));
    });
  } catch (error) {
    container.innerHTML = `<div class="history-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function openAccountModal() {
  if (!state.user) return openAuthModal('login');
  renderUserUI();
  openModal('accountModal');
  await loadAccountHistory();
}

async function reopenHistorySearch(searchId) {
  try {
    const data = await api(`/api/account/searches/${encodeURIComponent(searchId)}`);
    if (!data.payload?.channels) throw new Error('Ces résultats ne sont plus disponibles dans le cache.');
    const payload = data.payload;
    state.discoveredChannels = payload.channels || [];
    state.currentSearchQuery = data.search.query || payload.query || '';
    state.currentSearchChannelIds = state.discoveredChannels.map((channel) => channel.id);
    $('#exportSearchDomainsBtn').disabled = !state.currentSearchChannelIds.length;
    restoreSearchForm({ query: data.search.query, mode: data.search.mode, ...(data.search.filters || {}) });
    renderChannels();
    renderTelemetry(payload);
    $('#discoverMeta').textContent = `Historique · ${payload.count || state.discoveredChannels.length} chaînes FR · recherche du ${formatHistoryDate(data.search.createdAt)}`;
    closeModal('accountModal');
    $('#discovery')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  state.user = null;
  state.discoveredChannels = [];
  state.currentSearchChannelIds = [];
  renderUserUI();
  renderChannels();
  closeModal('accountModal');
  toast('Tu es déconnecté.');
}

async function handlePaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const payment = params.get('payment');
  const paymentId = params.get('payment_id');
  const dodoStatus = params.get('status');
  if (!payment) return;

  history.replaceState({}, '', window.location.pathname + window.location.hash);
  if (payment === 'cancelled') {
    sessionStorage.removeItem('scanYTB.pendingSearch');
    state.pendingSearchPayload = null;
    toast('Paiement annulé. Aucun crédit consommé.', 'error');
    return;
  }
  if (payment !== 'success' || !state.user || state.user.isAdmin) return;

  try {
    let result = null;
    if (paymentId) {
      result = await api('/api/billing/verify-payment', {
        method: 'POST',
        body: JSON.stringify({ paymentId })
      });
    } else {
      // Le webhook Dodo peut être arrivé avant le retour navigateur.
      await new Promise((resolve) => setTimeout(resolve, 900));
      await loadSession();
      result = { paid: Number(state.user?.credits || 0) > 0, user: state.user };
    }

    state.user = result.user || state.user;
    renderUserUI();
    if (!result.paid && dodoStatus !== 'succeeded') {
      throw new Error('Le paiement est encore en cours de confirmation par Dodo Payments.');
    }

    // Si le retour annonce succeeded mais le webhook n'est pas encore visible, recharge le compte quelques fois.
    if (Number(state.user?.credits || 0) < 1) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await loadSession();
        if (Number(state.user?.credits || 0) > 0) break;
      }
    }

    if (Number(state.user?.credits || 0) < 1) {
      toast('Paiement reçu. Le crédit est en cours d’ajout, recharge la page dans quelques secondes.');
      return;
    }

    toast('Paiement confirmé : +1 crédit ajouté.');
    const pendingRaw = sessionStorage.getItem('scanYTB.pendingSearch');
    if (pendingRaw) {
      sessionStorage.removeItem('scanYTB.pendingSearch');
      const pending = JSON.parse(pendingRaw);
      state.pendingSearchPayload = pending;
      restoreSearchForm(pending);
      await performDiscovery(pending);
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

function updateSearchHint() {
  const hint = $('.deep-hint');
  if (!hint) return;
  const query = $('#query')?.value?.trim() || '';
  if (looksLikeDomain(query)) {
    hint.innerHTML = '<strong>Recherche par niche</strong><span>Entre un mot-clé comme dropshipping, Shopify ou WordPress — pas un nom de domaine.</span>';
    return;
  }
  if (state.searchMode === 'deep') {
    hint.innerHTML = '<strong>Profonde</strong><span>18 à 21 appels YouTube · variantes FR · chaînes + vidéos · pertinence + récent + vues · déduplication</span>';
  } else {
    hint.innerHTML = '<strong>Rapide</strong><span>2 appels YouTube · chaînes + vidéos · idéale pour tester un mot-clé</span>';
  }
}

function setMode(mode) {
  state.searchMode = mode === 'rapid' ? 'rapid' : 'deep';
  $('#searchMode').value = state.searchMode;
  document.querySelectorAll('.mode-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === state.searchMode);
  });
  updateSearchHint();
}

function clearDeepLinkParams(...keys) {
  const url = new URL(window.location.href);
  keys.forEach((key) => url.searchParams.delete(key));
  if ([...url.searchParams.keys()].length === 0) url.search = '';
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

async function handleExtensionDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const source = params.get('source');
  const domain = String(params.get('domain') || '').trim();
  const query = String(params.get('q') || '').trim();

  if (domain && looksLikeDomain(domain)) {
    $('#linkFilter').value = domain;
    state.linkPage = 1;
    document.querySelector('#links')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    if (!state.user) {
      $('#linkSearchMeta').textContent = `Connecte-toi pour chercher ${domain} dans toute la base.`;
      setAuthMode('login');
      openAuthModal('login');
      return;
    }

    await searchAllLinksByDomain(domain);
    clearDeepLinkParams('domain', 'source');
    if (source === 'chrome-extension') toast(`Recherche ScanYTB ouverte pour ${domain}.`);
    return;
  }

  if (query) {
    $('#query').value = query;
    updateSearchHint();
    document.querySelector('#home')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => $('#query')?.focus(), 250);
    clearDeepLinkParams('q', 'source');
    if (source === 'chrome-extension') toast(`Chaîne préremplie : ${query}`);
  }
}

$('#discoverForm').addEventListener('submit', discover);
$('#query')?.addEventListener('input', updateSearchHint);
$('#authForm')?.addEventListener('submit', handleAuthSubmit);
$('#authTabLogin')?.addEventListener('click', () => setAuthMode('login'));
$('#authTabRegister')?.addEventListener('click', () => setAuthMode('register'));
$('#buyCreditButton')?.addEventListener('click', startCheckout);
$('#accountButton')?.addEventListener('click', openAccountModal);
$('#heroAccountButton')?.addEventListener('click', openAccountModal);
$('#creditsButton')?.addEventListener('click', openAccountModal);
$('#accountBuyCredit')?.addEventListener('click', () => {
  if (state.user?.isAdmin) return;
  state.pendingSearchPayload = null;
  sessionStorage.removeItem('scanYTB.pendingSearch');
  closeModal('accountModal');
  openPurchaseModal();
});
$('#logoutButton')?.addEventListener('click', logout);
document.querySelectorAll('[data-close-modal]').forEach((button) => {
  button.addEventListener('click', () => closeModal(button.dataset.closeModal));
});
['authModal', 'purchaseModal', 'accountModal'].forEach((id) => {
  $(`#${id}`)?.addEventListener('click', (event) => { if (event.target.id === id) closeModal(id); });
});
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
    updateSearchHint();
    $('#query').focus();
  });
});

const focusMainSearch = () => {
  document.querySelector('#home')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => $('#query')?.focus(), 250);
};

$('#topSearchButton')?.addEventListener('click', focusMainSearch);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!$('#scanCompleteModal')?.hidden) { closeScanCompleteModal(); return; }
    for (const id of ['authModal', 'purchaseModal', 'accountModal']) {
      if (!$(`#${id}`)?.hidden) { closeModal(id); return; }
    }
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


document.querySelectorAll('a.export-card').forEach((link) => {
  link.addEventListener('click', (event) => {
    if (!state.user) {
      event.preventDefault();
      openAuthModal('login');
    }
  });
});
setMode('deep');
await loadSession();
await handlePaymentReturn();
await Promise.all([loadHealth(), refreshStats()]);
if (state.user) await Promise.all([loadLinks(), loadDomains(), loadAccountHistory()]);
await handleExtensionDeepLink();
