const state = {
  discoveredChannels: [],
  links: [],
  domains: [],
  bulkScanning: false
};

const $ = (selector) => document.querySelector(selector);
const fmt = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });

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
    const status = $('#apiStatus');
    if (health.youtubeKeyConfigured) {
      status.className = 'status-pill ok';
      status.innerHTML = `<span></span> API YouTube prête${health.databaseConfigured ? ' · PostgreSQL' : ' · mémoire'} · V2`;
    } else {
      status.className = 'status-pill error';
      status.innerHTML = '<span></span> Clé YouTube manquante';
    }
  } catch {
    $('#apiStatus').className = 'status-pill error';
    $('#apiStatus').innerHTML = '<span></span> API indisponible';
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

function renderChannels() {
  const container = $('#channels');
  const scanAllBtn = $('#scanAllBtn');
  scanAllBtn.disabled = !state.discoveredChannels.length || state.bulkScanning;

  if (!state.discoveredChannels.length) {
    container.className = 'channel-list empty-state';
    container.textContent = 'Aucune chaîne francophone trouvée.';
    return;
  }

  container.className = 'channel-list';
  container.innerHTML = state.discoveredChannels.map((channel) => `
    <article class="channel-card" data-channel-card="${escapeHtml(channel.id)}">
      <img class="avatar" src="${escapeHtml(channel.thumbnail || '')}" alt="" loading="lazy" />
      <div class="channel-info">
        <div class="channel-name">${escapeHtml(channel.title)}</div>
        <div class="channel-meta">
          <span><strong>${fmt.format(channel.subscribers)}</strong> abonnés</span>
          <span><strong>${fmt.format(channel.videoCount)}</strong> vidéos</span>
          <span class="fr-badge" title="${escapeHtml(channel.frReason || '')}">${escapeHtml(confidenceLabel(channel))}</span>
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
  `).join('');

  document.querySelectorAll('.scan-btn').forEach((button) => {
    button.addEventListener('click', () => scanChannel(button));
  });
}

async function discover(event) {
  event.preventDefault();
  if (state.bulkScanning) return;

  const button = event.currentTarget.querySelector('button[type="submit"]');
  const query = $('#query').value.trim();
  if (!query) return;

  button.disabled = true;
  button.classList.add('loading');
  button.textContent = 'Analyse FR';
  $('#discoverMeta').textContent = 'Recherche + vérification linguistique en cours…';

  try {
    const data = await api('/api/discover', {
      method: 'POST',
      body: JSON.stringify({ query, maxResults: Number($('#maxResults').value) })
    });
    state.discoveredChannels = data.channels;
    renderChannels();
    $('#discoverMeta').textContent = `${data.count} FR gardée${data.count > 1 ? 's' : ''} · ${data.rejected} étrangère${data.rejected > 1 ? 's' : ''} écartée${data.rejected > 1 ? 's' : ''} · ${data.inspected} vérifiée${data.inspected > 1 ? 's' : ''}`;
    toast(`${data.count} chaîne${data.count > 1 ? 's' : ''} francophone${data.count > 1 ? 's' : ''} gardée${data.count > 1 ? 's' : ''}.`);
    refreshStats();
  } catch (error) {
    $('#discoverMeta').textContent = 'Échec de la recherche.';
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
    button.textContent = 'Trouver les chaînes FR';
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
    if (!silent) toast(`${data.channel.title}: ${data.linksFound} liens · ${data.uniqueDomains} domaines.`);
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

async function scanAllChannels() {
  if (state.bulkScanning || !state.discoveredChannels.length) return;

  state.bulkScanning = true;
  const button = $('#scanAllBtn');
  const maxVideos = Number($('#scanAllCount').value || 100);
  const channels = [...state.discoveredChannels];
  let done = 0;
  let totalLinks = 0;
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
      } catch {
        failures += 1;
      }

      done += 1;
      updateBulkProgress(done, channels.length, `${done}/${channels.length} chaînes · ${totalLinks} liens détectés`);
    }
  }

  // Deux scans simultanés : assez rapide sans marteler l'API ni PostgreSQL.
  await Promise.all([worker(), worker()]);
  await Promise.all([loadLinks(), loadDomains(), refreshStats()]);

  state.bulkScanning = false;
  button.classList.remove('loading');
  button.textContent = 'Scanner toutes';
  renderChannels();
  updateBulkProgress(channels.length, channels.length, `${channels.length - failures}/${channels.length} chaînes terminées · ${totalLinks} liens`);

  if (failures) {
    toast(`Scan terminé avec ${failures} erreur${failures > 1 ? 's' : ''}. ${totalLinks} liens détectés.`, 'error');
  } else {
    toast(`Scan terminé : ${channels.length} chaînes · ${totalLinks} liens détectés.`);
  }
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
  const search = $('#linkFilter').value.trim().toLowerCase();
  const category = $('#categoryFilter').value;

  const links = state.links.filter((link) => {
    if (category && link.category !== category) return false;
    if (!search) return true;
    return [link.channelTitle, link.videoTitle, link.domain, link.normalizedUrl]
      .some((value) => String(value || '').toLowerCase().includes(search));
  });

  if (!links.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-cell">Aucun lien correspondant.</td></tr>';
    return;
  }

  body.innerHTML = links.map((link) => `
    <tr>
      <td><span class="truncate" title="${escapeHtml(link.channelTitle)}">${escapeHtml(link.channelTitle)}</span></td>
      <td><a class="truncate" href="${escapeHtml(link.youtubeUrl || `https://www.youtube.com/watch?v=${link.videoId}`)}" target="_blank" rel="noopener" title="${escapeHtml(link.videoTitle)}">${escapeHtml(link.videoTitle)}</a></td>
      <td><strong>${escapeHtml(link.domain)}</strong></td>
      <td><span class="badge">${escapeHtml(link.category)}</span></td>
      <td><span class="badge ${escapeHtml(link.affiliateLikelihood)}">${escapeHtml(link.affiliateLikelihood)}</span></td>
      <td><a class="truncate" href="${escapeHtml(link.normalizedUrl)}" target="_blank" rel="noopener" title="${escapeHtml(link.normalizedUrl)}">${escapeHtml(link.normalizedUrl)}</a></td>
    </tr>
  `).join('');
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
        <div class="domain-name">${escapeHtml(domain.domain)}</div>
        <div class="domain-sub">${domain.links} liens · ${domain.videos} vidéos</div>
      </div>
      <div class="domain-count">${domain.channels} ch.</div>
    </div>
  `).join('');
}

$('#discoverForm').addEventListener('submit', discover);
$('#scanAllBtn').addEventListener('click', scanAllChannels);
$('#linkFilter').addEventListener('input', renderLinks);
$('#categoryFilter').addEventListener('change', renderLinks);

await Promise.all([loadHealth(), refreshStats(), loadLinks(), loadDomains()]);
