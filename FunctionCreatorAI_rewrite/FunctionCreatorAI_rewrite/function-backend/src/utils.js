const crypto = require('crypto');

function toIsoNow() {
    return new Date().toISOString();
}

function safeJsonParse(value, fallback = null) {
    if (typeof value !== 'string') return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function toNumberArray(value) {
    if (!Array.isArray(value)) return null;
    const normalized = value
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item));
    return normalized.length > 0 ? normalized : null;
}

function clamp(value, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.min(max, Math.max(min, num));
}

function normalizePatternList(patterns) {
    if (Array.isArray(patterns)) {
        return patterns.map((item) => String(item || '').trim()).filter(Boolean);
    }
    if (typeof patterns === 'string') {
        return patterns
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return [];
}

function patternToRegex(pattern) {
    const raw = String(pattern || '').trim();
    if (!raw) return null;
    if (raw === '<all_urls>' || raw === '*://*/*') {
        return /^https?:\/\/.+$/i;
    }
    const escaped = raw
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
    try {
        return new RegExp(`^${escaped}$`, 'i');
    } catch {
        return null;
    }
}

function urlMatchesPattern(url, pattern) {
    if (!url || !pattern) return false;
    const regex = patternToRegex(pattern);
    return regex ? regex.test(url) : false;
}

function urlMatchesPatterns(url, patterns = []) {
    const normalized = normalizePatternList(patterns);
    if (normalized.length === 0) return true;
    return normalized.some((pattern) => urlMatchesPattern(url, pattern));
}

function tokenizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2);
}

function buildFtsQuery(text) {
    const tokens = Array.from(new Set(tokenizeText(text)));
    if (tokens.length === 0) return '';
    return tokens.map((token) => `"${token}"`).join(' OR ');
}

function buildSearchableText(functionDef = {}, metadata = {}) {
    const inputText = Array.isArray(functionDef.inputs)
        ? functionDef.inputs
            .map((input) => `${input?.name || ''} ${input?.type || ''} ${input?.description || ''}`)
            .join(' ')
        : '';
    const stepText = Array.isArray(functionDef.steps)
        ? functionDef.steps
            .map((step) => `${step?.type || ''} ${step?.description || ''} ${step?.selector || ''}`)
            .join(' ')
        : '';
    const outputText = functionDef?.outputs
        ? `${functionDef.outputs.type || ''} ${functionDef.outputs.description || ''} ${functionDef.outputs.fields || ''}`
        : '';
    const siteText = normalizePatternList(functionDef.urlPatterns).join(' ');
    const metadataText = [
        metadata?.source || '',
        Array.isArray(metadata?.tags) ? metadata.tags.join(' ') : '',
        Array.isArray(metadata?.applicableSites) ? metadata.applicableSites.join(' ') : ''
    ].join(' ');

    return [
        functionDef?.name || '',
        functionDef?.description || '',
        inputText,
        outputText,
        stepText,
        siteText,
        metadataText
    ]
        .filter(Boolean)
        .join('\n');
}

function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0 || a.length !== b.length) {
        return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (!denom) return 0;
    return dot / denom;
}

function normalizeBm25Score(rawBm25) {
    const value = Number(rawBm25);
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 1;
    return 1 / (1 + value);
}

function generateFingerprint(functionDef = {}, metadata = {}) {
    const basis = JSON.stringify({
        name: functionDef?.name || '',
        description: functionDef?.description || '',
        urlPatterns: normalizePatternList(functionDef?.urlPatterns),
        steps: Array.isArray(functionDef?.steps) ? functionDef.steps : [],
        inputs: Array.isArray(functionDef?.inputs) ? functionDef.inputs : [],
        outputs: functionDef?.outputs || {},
        source: metadata?.source || functionDef?.source || ''
    });
    return crypto.createHash('sha256').update(basis).digest('hex');
}

module.exports = {
    buildFtsQuery,
    buildSearchableText,
    clamp,
    cosineSimilarity,
    generateFingerprint,
    normalizeBm25Score,
    normalizePatternList,
    safeJsonParse,
    toIsoNow,
    toNumberArray,
    tokenizeText,
    urlMatchesPatterns
};
