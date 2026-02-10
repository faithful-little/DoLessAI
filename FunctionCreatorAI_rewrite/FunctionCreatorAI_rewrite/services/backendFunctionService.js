// Backend Function Service
// Handles optional sync/search against a self-hosted function backend.

const BackendFunctionService = {
    DEFAULT_URL: 'http://localhost:8787',
    SETTINGS_KEYS: ['backendEnabled', 'backendUrl', 'backendUploadEnabled', 'backendSearchTopK'],

    normalizeSettings(raw = {}) {
        const topKRaw = Number(raw.backendSearchTopK);
        return {
            backendEnabled: raw.backendEnabled === true,
            backendUploadEnabled: raw.backendUploadEnabled === true,
            backendUrl: this._normalizeBackendUrl(raw.backendUrl || this.DEFAULT_URL),
            backendSearchTopK: Number.isFinite(topKRaw) ? Math.max(1, Math.min(30, Math.floor(topKRaw))) : 8
        };
    },

    async getSettings(overrides = null) {
        if (overrides && typeof overrides === 'object') {
            return this.normalizeSettings(overrides);
        }
        const stored = await chrome.storage.local.get(this.SETTINGS_KEYS);
        return this.normalizeSettings(stored);
    },

    _normalizeBackendUrl(url) {
        const raw = String(url || '').trim() || this.DEFAULT_URL;
        return raw.replace(/\/+$/, '');
    },

    _normalizePatternList(patterns) {
        if (Array.isArray(patterns)) return patterns.map((p) => String(p || '').trim()).filter(Boolean);
        if (typeof patterns === 'string') {
            return patterns.split(',').map((p) => p.trim()).filter(Boolean);
        }
        return [];
    },

    _patternToRegex(pattern) {
        const raw = String(pattern || '').trim();
        if (!raw) return null;
        if (raw === '<all_urls>' || raw === '*://*/*') {
            return /^https?:\/\/.+$/i;
        }
        try {
            const escaped = raw
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*');
            return new RegExp(`^${escaped}$`, 'i');
        } catch {
            return null;
        }
    },

    _urlMatchesPatterns(url, patterns = []) {
        const normalized = this._normalizePatternList(patterns);
        if (!url || normalized.length === 0) return true;
        return normalized.some((pattern) => {
            const regex = this._patternToRegex(pattern);
            return regex ? regex.test(url) : false;
        });
    },

    _tokenize(text) {
        return new Set(
            String(text || '')
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, ' ')
                .split(/\s+/)
                .map((token) => token.trim())
                .filter((token) => token.length >= 3)
        );
    },

    _scoreLocalFunctionForQuery(func, query = '') {
        const queryTokens = this._tokenize(query);
        if (queryTokens.size === 0) return 0;
        const source = [
            func?.name || '',
            func?.description || '',
            Array.isArray(func?.inputs) ? func.inputs.map((i) => `${i?.name || ''} ${i?.description || ''}`).join(' ') : '',
            func?.outputs?.description || '',
            Array.isArray(func?.steps) ? func.steps.map((s) => `${s?.type || ''} ${s?.description || ''}`).join(' ') : ''
        ].join(' ');
        const fnTokens = this._tokenize(source);
        let overlap = 0;
        for (const token of queryTokens) {
            if (fnTokens.has(token)) overlap += 1;
        }
        return overlap;
    },

    async _hasLocalMatch(query = '', currentUrl = '') {
        const all = await FunctionLibraryService.getAll();
        const candidates = Object.values(all || {}).filter((func) => {
            if (!currentUrl) return true;
            return this._urlMatchesPatterns(currentUrl, func?.urlPatterns || []);
        });
        if (candidates.length === 0) return false;
        if (!query.trim()) return candidates.length > 0;
        return candidates.some((func) => this._scoreLocalFunctionForQuery(func, query) > 0);
    },

    _buildEmbeddingText(functionDef, metadata = {}) {
        const inputsText = Array.isArray(functionDef?.inputs)
            ? functionDef.inputs.map((input) => `${input?.name || ''}:${input?.type || ''}:${input?.description || ''}`).join(' ')
            : '';
        const stepsText = Array.isArray(functionDef?.steps)
            ? functionDef.steps.map((step) => `${step?.type || ''}:${step?.description || ''}:${step?.selector || ''}`).join(' ')
            : '';
        const outputText = functionDef?.outputs
            ? `${functionDef.outputs.type || ''} ${functionDef.outputs.description || ''} ${functionDef.outputs.fields || ''}`
            : '';
        const siteText = this._normalizePatternList(functionDef?.urlPatterns).join(' ');
        return [
            functionDef?.name || '',
            functionDef?.description || '',
            inputsText,
            stepsText,
            outputText,
            siteText,
            metadata?.source || ''
        ].filter(Boolean).join('\n');
    },

    _buildMetadata(functionDef, extra = {}) {
        return {
            source: extra.source || functionDef?.source || 'extension',
            testsPassed: functionDef?.testsPassed === true || extra.testsPassed === true,
            applicableSites: this._normalizePatternList(extra.applicableSites || functionDef?.urlPatterns),
            tags: Array.isArray(extra.tags) ? extra.tags.filter(Boolean) : [],
            createdAt: functionDef?.createdAt || Date.now(),
            updatedAt: Date.now(),
            extensionVersion: chrome?.runtime?.getManifest?.()?.version || ''
        };
    },

    _simpleHash(text) {
        let hash = 0;
        const input = String(text || '');
        for (let i = 0; i < input.length; i += 1) {
            hash = ((hash << 5) - hash) + input.charCodeAt(i);
            hash |= 0;
        }
        return `h${Math.abs(hash)}`;
    },

    async _generateEmbedding(text) {
        const content = String(text || '').trim();
        if (!content) return null;

        const settings = typeof syncOllamaRuntimeSettings === 'function'
            ? await syncOllamaRuntimeSettings()
            : { embeddingEngine: 'gemini', ollamaEmbeddingModel: '' };
        const storage = await chrome.storage.local.get(['geminiApiKey']);
        const apiKey = storage?.geminiApiKey;
        const engine = settings?.embeddingEngine || 'gemini';

        const response = await EmbeddingService.execute({
            action: 'embed',
            text: content,
            engine,
            embeddingModel: settings?.ollamaEmbeddingModel || ''
        }, { apiKey });

        return Array.isArray(response?.vector) && response.vector.length > 0
            ? response.vector
            : null;
    },

    async healthCheck(overrides = null) {
        const settings = await this.getSettings(overrides);
        try {
            const response = await fetch(`${settings.backendUrl}/api/health`);
            if (!response.ok) {
                return { success: false, status: 'offline', error: `Health check failed (${response.status})`, settings };
            }
            const data = await response.json();
            return { success: true, status: 'online', data, settings };
        } catch (error) {
            return { success: false, status: 'offline', error: error.message, settings };
        }
    },

    async uploadVerifiedFunction(functionDef, options = {}) {
        const settings = await this.getSettings();
        if (!settings.backendUploadEnabled) {
            return { success: false, skipped: true, reason: 'upload-disabled' };
        }
        if (!functionDef || typeof functionDef !== 'object') {
            return { success: false, skipped: true, reason: 'invalid-function' };
        }
        if (functionDef.testsPassed !== true) {
            return { success: false, skipped: true, reason: 'not-verified' };
        }
        if (functionDef.syncedFromBackend === true || functionDef.source === 'backend-import') {
            return { success: false, skipped: true, reason: 'backend-imported' };
        }

        const metadata = this._buildMetadata(functionDef, options.metadata || {});
        const embeddingText = this._buildEmbeddingText(functionDef, metadata);
        const embedding = await this._generateEmbedding(embeddingText);
        if (!embedding) {
            return { success: false, skipped: true, reason: 'embedding-unavailable' };
        }

        const fingerprint = this._simpleHash(JSON.stringify({
            name: functionDef?.name || '',
            description: functionDef?.description || '',
            urlPatterns: this._normalizePatternList(functionDef?.urlPatterns),
            inputs: functionDef?.inputs || [],
            outputs: functionDef?.outputs || {},
            steps: functionDef?.steps || []
        }));

        const response = await fetch(`${settings.backendUrl}/api/functions/upsert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientId: chrome?.runtime?.id || 'extension',
                functionDef,
                embedding,
                metadata,
                fingerprint
            })
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Backend upload failed (${response.status}): ${text}`);
        }
        const result = await response.json();
        return { success: true, result, fingerprint };
    },

    async searchFunctions({ query = '', currentUrl = '', topK = null, queryEmbedding = null } = {}) {
        const settings = await this.getSettings();
        if (!settings.backendEnabled) {
            return { success: false, skipped: true, reason: 'backend-disabled', results: [] };
        }

        const searchQuery = String(query || '').trim();
        let embedding = Array.isArray(queryEmbedding) && queryEmbedding.length > 0
            ? queryEmbedding
            : null;

        if (!embedding && searchQuery) {
            try {
                embedding = await this._generateEmbedding(searchQuery);
            } catch {
                embedding = null;
            }
        }

        const response = await fetch(`${settings.backendUrl}/api/functions/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: searchQuery,
                queryEmbedding: embedding,
                currentUrl: String(currentUrl || '').trim(),
                topK: Number.isFinite(Number(topK)) ? topK : settings.backendSearchTopK
            })
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Backend search failed (${response.status}): ${text}`);
        }
        return await response.json();
    },

    _toBackendImport(result = {}) {
        const functionDef = result?.functionDef || null;
        if (!functionDef || typeof functionDef !== 'object') return null;
        return {
            ...functionDef,
            syncedFromBackend: true,
            source: functionDef.source || 'backend-import',
            backendMeta: {
                backendId: result.id || null,
                score: typeof result.score === 'number' ? result.score : null,
                bm25Score: typeof result.bm25Score === 'number' ? result.bm25Score : null,
                vectorScore: typeof result.vectorScore === 'number' ? result.vectorScore : null,
                importedAt: Date.now()
            }
        };
    },

    async importResults(results = [], options = {}) {
        const defs = (Array.isArray(results) ? results : [])
            .map((item) => this._toBackendImport(item))
            .filter(Boolean);
        if (defs.length === 0) {
            const allFunctions = await FunctionLibraryService.getAll();
            return { success: true, importedCount: 0, saved: [], allFunctions };
        }

        const allFunctions = await FunctionLibraryService.getAll();
        const saved = [];

        for (const def of defs) {
            let targetName = def.name;
            const backendId = def?.backendMeta?.backendId || null;

            if (backendId) {
                const existingByBackendId = Object.entries(allFunctions).find(([, existing]) => (
                    existing?.syncedFromBackend === true
                    && String(existing?.backendMeta?.backendId || '') === String(backendId)
                ));
                if (existingByBackendId) {
                    targetName = existingByBackendId[0];
                }
            }

            const existingAtName = allFunctions[targetName];
            const shouldOverwrite = existingAtName?.syncedFromBackend === true;
            const saveResult = await FunctionLibraryService.upsert(
                { ...def, name: targetName },
                { unique: shouldOverwrite ? false : options.unique !== false }
            );
            saved.push({
                name: saveResult.name,
                functionDef: saveResult.functionDef,
                renamed: saveResult.renamed
            });
            Object.assign(allFunctions, saveResult.allFunctions || {});
        }

        return {
            success: true,
            importedCount: saved.length,
            saved,
            allFunctions
        };
    },

    async hydrateForTask({ query = '', currentUrl = '', topK = null, onlyWhenNoLocalMatches = false } = {}) {
        if (onlyWhenNoLocalMatches) {
            const hasLocalMatch = await this._hasLocalMatch(String(query || '').trim(), String(currentUrl || '').trim());
            if (hasLocalMatch) {
                const allFunctions = await FunctionLibraryService.getAll();
                return {
                    success: true,
                    skipped: true,
                    reason: 'local-match-found',
                    importedCount: 0,
                    allFunctions
                };
            }
        }

        const searchResult = await this.searchFunctions({ query, currentUrl, topK });
        if (!searchResult?.success || !Array.isArray(searchResult.results)) {
            return { ...(searchResult || {}), importedCount: 0 };
        }
        const imported = await this.importResults(searchResult.results, { unique: true });
        return {
            success: true,
            importedCount: imported.importedCount,
            importedNames: imported.saved.map((item) => item.name),
            totalCandidates: Number(searchResult.totalCandidates || 0),
            allFunctions: imported.allFunctions
        };
    },

    async fetchByName(name, currentUrl = '') {
        const wanted = String(name || '').trim();
        if (!wanted) return null;

        const searchResult = await this.searchFunctions({
            query: wanted,
            currentUrl,
            topK: 6
        });
        if (!searchResult?.success || !Array.isArray(searchResult.results) || searchResult.results.length === 0) {
            return null;
        }

        const exact = searchResult.results.find((item) => {
            const foundName = String(item?.functionDef?.name || '').trim().toLowerCase();
            return foundName === wanted.toLowerCase();
        });
        const candidate = exact || searchResult.results[0];
        if (!candidate) return null;

        const imported = await this.importResults([candidate], { unique: false });
        if (imported.importedCount <= 0) return null;
        return imported.saved[0]?.functionDef || null;
    }
};

if (typeof self !== 'undefined') self.BackendFunctionService = BackendFunctionService;
