const healthBadge = document.getElementById('healthBadge');
const refreshBtn = document.getElementById('refreshBtn');
const searchForm = document.getElementById('searchForm');
const queryInput = document.getElementById('queryInput');
const urlInput = document.getElementById('urlInput');
const topKInput = document.getElementById('topKInput');
const embeddingInput = document.getElementById('embeddingInput');
const searchMeta = document.getElementById('searchMeta');
const searchResults = document.getElementById('searchResults');
const stats = document.getElementById('stats');
const functionsList = document.getElementById('functionsList');
const itemTemplate = document.getElementById('resultItemTemplate');

async function api(path, options = {}) {
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
        throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
}

function setHealth(status, label) {
    healthBadge.className = `badge ${status}`;
    healthBadge.textContent = label;
}

function renderStats(data) {
    stats.innerHTML = '';
    const items = [
        { label: 'Functions', value: data.functionCount || 0 },
        { label: 'Database', value: data.dbPath || 'n/a' }
    ];
    items.forEach((item) => {
        const el = document.createElement('div');
        el.className = 'stat';
        el.innerHTML = `
            <span class="stat-label">${item.label}</span>
            <span class="stat-value">${item.value}</span>
        `;
        stats.appendChild(el);
    });
}

function createItemCard(entry) {
    const node = itemTemplate.content.cloneNode(true);
    const title = node.querySelector('.item-title');
    const score = node.querySelector('.item-score');
    const desc = node.querySelector('.item-desc');
    const chips = node.querySelector('.chips');
    const json = node.querySelector('.json');

    const func = entry.functionDef || {};
    title.textContent = func.name || entry.name || 'Unnamed function';
    score.textContent = typeof entry.score === 'number'
        ? `score ${entry.score.toFixed(3)}`
        : 'stored';
    desc.textContent = func.description || entry.description || 'No description';
    json.textContent = JSON.stringify(entry, null, 2);

    const chipData = [];
    if (Array.isArray(entry.sites) && entry.sites.length > 0) {
        chipData.push(`sites: ${entry.sites.slice(0, 2).join(' | ')}`);
    }
    if (typeof entry.bm25Score === 'number') {
        chipData.push(`bm25: ${entry.bm25Score.toFixed(3)}`);
    }
    if (typeof entry.vectorScore === 'number') {
        chipData.push(`vector: ${entry.vectorScore.toFixed(3)}`);
    }
    if (entry.metadata?.source) {
        chipData.push(`source: ${entry.metadata.source}`);
    }
    if (entry.verified === true || entry.metadata?.testsPassed === true) {
        chipData.push('verified');
    }

    chipData.forEach((text) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = text;
        chips.appendChild(chip);
    });

    return node;
}

async function refreshHealthAndStats() {
    try {
        setHealth('unknown', 'Checking');
        const health = await api('/api/health');
        setHealth('ok', 'Online');
        renderStats(health);
    } catch (error) {
        setHealth('error', 'Offline');
        searchMeta.textContent = `Health check failed: ${error.message}`;
    }
}

async function loadRecentFunctions() {
    functionsList.innerHTML = '';
    try {
        const result = await api('/api/functions?limit=30');
        if (!Array.isArray(result.items) || result.items.length === 0) {
            functionsList.innerHTML = '<div class="muted">No functions stored yet.</div>';
            return;
        }
        result.items.forEach((item) => {
            functionsList.appendChild(createItemCard(item));
        });
    } catch (error) {
        functionsList.innerHTML = `<div class="muted">${error.message}</div>`;
    }
}

function parseEmbeddingInput() {
    const raw = embeddingInput.value.trim();
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        return parsed.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    } catch {
        return null;
    }
}

async function runSearch(event) {
    event.preventDefault();
    searchResults.innerHTML = '';
    searchMeta.textContent = 'Searching...';

    const query = queryInput.value.trim();
    const currentUrl = urlInput.value.trim();
    const topK = Number(topKInput.value) || 8;
    const queryEmbedding = parseEmbeddingInput();

    try {
        const result = await api('/api/functions/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query,
                currentUrl,
                topK,
                queryEmbedding
            })
        });

        searchMeta.textContent = `Returned ${result.results.length} results from ${result.totalCandidates} candidates.`;
        if (!Array.isArray(result.results) || result.results.length === 0) {
            searchResults.innerHTML = '<div class="muted">No matches found.</div>';
            return;
        }
        result.results.forEach((entry) => {
            searchResults.appendChild(createItemCard(entry));
        });
    } catch (error) {
        searchMeta.textContent = `Search failed: ${error.message}`;
    }
}

refreshBtn.addEventListener('click', async () => {
    await refreshHealthAndStats();
    await loadRecentFunctions();
});
searchForm.addEventListener('submit', runSearch);

refreshHealthAndStats();
loadRecentFunctions();
