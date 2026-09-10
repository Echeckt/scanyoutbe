const state = {
  discoveredChannels: [],
  links: [],
  domains: []
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
  window.__toastTimer = setTimeout(() => { el.className = 'toast'; }, 3300);
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
      status.innerHTML = `<span></span> API YouTube prête${health.databaseConfigured ? ' · PostgreSQL' : ' · mémoire'}`;
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

function renderChannels() {
  const container = $('#channels');
  if (!state.discoveredChannels.length) {
    container.className = 'channel-list empty-state';
    container.textContent = 'Aucune chaîne trouvée.';
    return;
  }

  container.className = 'channel-list';
  container.innerHTML = state.discoveredChannels.map((channel) => `
    <article class="channel-card">
      <img class="avatar" src="${escapeHtml(channel.thumbnail || '')}" alt="" loading="lazy" />
      <div>
        <div class="channel-name">${escapeHtml(channel.title)}</div>
        <div class="channel-meta">
          <span><strong>${fmt.format(channel.subscribers)}</strong> abonnés</span>
          <span><strong>${fmt.format(channel.videoCount)}</strong> vidéos</span>
          <span>${channel.country === 'FR' ? '🇫🇷 Pays déclaré FR' : '🎯 Ciblage FR'}</span>
          <a href="${escapeHtml(channel.youtubeUrl)}" target="_blank" rel="noopener">Ouvrir ↗</a>
        </div>
      </div>
      <div class="channel-actions">
        <select class="scan-select" data-scan-count="${channel.id}" aria-label="Nombre de vidéos à scanner">
          <option value="25">25 vidéos</option>
          <option value="50">50 vidéos</option>
          <option value="100" selected>100 vidéos</option>
          <option value="250">250 vidéos</option>
          <option value="500">500 vidéos</option>
        </select>
        <button class="button primary small scan-btn" data-channel-id="${channel.id}">Scanner</button>
      </div>
    </article>
  `).join('');

  document.querySelectorAll('.scan-btn').forEach((button) => {
    button.addEventListener('click', () => scanChannel(button));
  });
}

async function discover(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const query = $('#query').value.trim();
  if (!query) return;

  button.disabled = true;
  button.classList.add('loading');
  button.textContent = 'Recherche';
  $('#discoverMeta').textContent = 'Recherche YouTube en cours…';

  try {
    const data = await api('/api/discover', {
      method: 'POST',
      body: JSON.stringify({ query, maxResults: Number($('#maxResults').value) })
    });
    state.discoveredChannels = data.channels;
    renderChannels();
    $('#discoverMeta').textContent = `${data.count} chaîne${data.count > 1 ? 's' : ''} trouvée${data.count > 1 ? 's' : ''}`;
    toast(`${data.count} chaînes trouvées pour “${query}”.`);
    refreshStats();
  } catch (error) {
    $('#discoverMeta').textContent = 'Échec de la recherche.';
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
    button.textContent = 'Trouver les chaînes';
  }
}

async function scanChannel(button) {
  const channelId = button.dataset.channelId;
  const maxVideos = Number(document.querySelector(`[data-scan-count="${channelId}"]`).value);
  const original = button.textContent;
  button.disabled = true;
  button.classList.add('loading');
  button.textContent = 'Scan';

  try {
    const data = await api('/api/scan', {
      method: 'POST',
      body: JSON.stringify({ channelId, maxVideos })
    });
    toast(`${data.channel.title}: ${data.linksFound} liens · ${data.uniqueDomains} domaines.`);
    await Promise.all([loadLinks(), loadDomains(), refreshStats()]);
    button.textContent = 'Scanné ✓';
    setTimeout(() => { button.textContent = original; }, 1800);
  } catch (error) {
    toast(error.message, 'error');
    button.textContent = original;
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
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
$('#linkFilter').addEventListener('input', renderLinks);
$('#categoryFilter').addEventListener('change', renderLinks);

await Promise.all([loadHealth(), refreshStats(), loadLinks(), loadDomains()]);
