// Ollama Service - Local LLM integration via Ollama HTTP API
// Acts as the "Gatekeeper" for cost reduction: boolean checks, JSON extraction, sentiment
// Gracefully degrades when Ollama is not running (returns {fallback: true})

const OllamaService = {
    _url: 'http://localhost:11434',
    _model: '',
    _embeddingModel: '',
    _available: null,
    _lastHealthCheck: 0,
    _healthCacheDuration: 30000, // 30 seconds

    configure(url, model, embeddingModel) {
        if (url) this._url = url.replace(/\/$/, ''); // Strip trailing slash
        if (model !== undefined) this._model = this._normalizeModelName(model);
        if (embeddingModel !== undefined) this._embeddingModel = this._normalizeModelName(embeddingModel);
        this._available = null; // Reset cache
        this._lastHealthCheck = 0;
    },

    async healthCheck(force = false) {
        // Cache health check result for 30s
        if (!force && this._available !== null && (Date.now() - this._lastHealthCheck) < this._healthCacheDuration) {
            return this._available;
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            const response = await fetch(`${this._url}/api/tags`, {
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            this._available = response.ok;
        } catch (e) {
            this._available = false;
        }
        this._lastHealthCheck = Date.now();
        return this._available;
    },

    async listModels() {
        if (!await this.healthCheck()) return [];
        try {
            const response = await fetch(`${this._url}/api/tags`);
            const data = await response.json();
            const models = Array.isArray(data?.models) ? data.models : [];
            const normalized = models.map((m) => {
                if (typeof m === 'string') return { name: m };
                const name = m?.name || m?.model || '';
                return {
                    name,
                    size: m?.size ?? null,
                    digest: m?.digest ?? null,
                    modifiedAt: m?.modified_at || m?.modifiedAt || null
                };
            }).filter(m => !!m.name);

            const deduped = [];
            const seen = new Set();
            for (const model of normalized) {
                if (seen.has(model.name)) continue;
                seen.add(model.name);
                deduped.push(model);
            }
            return deduped;
        } catch {
            return [];
        }
    },

    _normalizeModelName(name) {
        return typeof name === 'string' ? name.trim() : '';
    },

    _extractModelNames(models = []) {
        return Array.from(new Set((Array.isArray(models) ? models : [])
            .map(m => typeof m === 'string' ? m : (m?.name || m?.model || ''))
            .map(name => this._normalizeModelName(name))
            .filter(Boolean)));
    },

    async _pickAvailableModel(preferredModel = '', { embedding = false } = {}) {
        const models = await this.listModels();
        const names = this._extractModelNames(models);
        if (!names.length) return this._normalizeModelName(preferredModel);

        const preferred = this._normalizeModelName(preferredModel);
        if (preferred && names.includes(preferred)) return preferred;

        if (embedding) {
            const embedCandidate = names.find(name => /embed|embedding|bge|e5|nomic|mxbai/i.test(name));
            if (embedCandidate) return embedCandidate;
        }

        return names[0];
    },

    async generate(prompt, options = {}) {
        if (!await this.healthCheck()) {
            return { success: false, fallback: true, error: 'Ollama not available' };
        }

        const retryAttempted = options._modelRetryAttempted === true;
        let modelToUse = this._normalizeModelName(options.model || this._model);
        if (!modelToUse) {
            modelToUse = await this._pickAvailableModel('');
        }
        if (!modelToUse) {
            return {
                success: false,
                fallback: true,
                error: 'No Ollama model configured. Select a local LLM model in settings.'
            };
        }

        try {
            const response = await fetch(`${this._url}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelToUse,
                    prompt,
                    stream: false,
                    options: {
                        temperature: options.temperature !== undefined ? options.temperature : 0.1,
                        num_predict: options.maxTokens || 512
                    }
                })
            });

            if (!response.ok) {
                const errText = (await response.text()).trim();

                if (
                    response.status === 404 &&
                    !retryAttempted &&
                    /model .*not found/i.test(errText)
                ) {
                    const fallbackModel = await this._pickAvailableModel(this._model);
                    if (fallbackModel && fallbackModel !== modelToUse) {
                        this._model = fallbackModel;
                        return await this.generate(prompt, {
                            ...options,
                            model: fallbackModel,
                            _modelRetryAttempted: true
                        });
                    }
                }

                if (response.status === 403) {
                    const extensionOrigin = (typeof chrome !== 'undefined' && chrome.runtime?.id)
                        ? `chrome-extension://${chrome.runtime.id}`
                        : 'chrome-extension://<extension-id>';
                    return {
                        success: false,
                        fallback: true,
                        error: `Ollama HTTP 403 (Forbidden). Allow origin ${extensionOrigin} in OLLAMA_ORIGINS and restart Ollama. ${errText || ''}`.trim()
                    };
                }

                return {
                    success: false,
                    fallback: true,
                    error: `Ollama HTTP ${response.status}: ${errText || response.statusText || 'Request failed'}`
                };
            }

            const result = await response.json();
            this._model = result.model || modelToUse;
            return { success: true, response: result.response, model: result.model || modelToUse };
        } catch (e) {
            return { success: false, fallback: true, error: e.message };
        }
    },

    // Boolean check: returns true, false, or null (fallback needed)
    async booleanCheck(question) {
        const result = await this.generate(
            `Answer ONLY with the word "true" or "false", nothing else.\n\nQuestion: ${question}`,
            { temperature: 0, maxTokens: 10 }
        );
        if (result.fallback) return null;
        if (!result.success) return null;
        const answer = (result.response || '').trim().toLowerCase();
        if (answer.includes('true')) return true;
        if (answer.includes('false')) return false;
        return null;
    },

    // JSON extraction from text
    async jsonExtract(text, schema) {
        const schemaStr = typeof schema === 'string' ? schema : JSON.stringify(schema);
        const result = await this.generate(
            `Extract structured data from the text below. Return ONLY valid JSON matching this schema (no explanation):\nSchema: ${schemaStr}\n\nText:\n${text}`,
            { temperature: 0, maxTokens: 1024 }
        );
        if (result.fallback || !result.success) return null;
        try {
            // Try to extract JSON from the response (may have markdown code fences)
            let jsonStr = result.response.trim();
            const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) jsonStr = jsonMatch[1];
            return JSON.parse(jsonStr);
        } catch {
            return null;
        }
    },

    // Sentiment analysis: returns "positive", "negative", "neutral", or null
    async sentiment(text) {
        const result = await this.generate(
            `Classify the sentiment as exactly one word: "positive", "negative", or "neutral". No explanation.\n\nText: ${text}`,
            { temperature: 0, maxTokens: 10 }
        );
        if (result.fallback || !result.success) return null;
        const answer = (result.response || '').trim().toLowerCase();
        if (answer.includes('positive')) return 'positive';
        if (answer.includes('negative')) return 'negative';
        if (answer.includes('neutral')) return 'neutral';
        return null;
    },

    // Filter: Given a list and criteria, return which items pass
    async filterItems(items, criteria) {
        const result = await this.generate(
            `Given these items:\n${JSON.stringify(items, null, 1)}\n\nFilter criteria: ${criteria}\n\nReturn ONLY a JSON array of the items that match the criteria. No explanation.`,
            { temperature: 0, maxTokens: 2048 }
        );
        if (result.fallback || !result.success) return null;
        try {
            let jsonStr = result.response.trim();
            const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) jsonStr = jsonMatch[1];
            return JSON.parse(jsonStr);
        } catch {
            return null;
        }
    },

    // Embedding via Ollama (for local vector search)
    async embed(text, options = {}) {
        if (!await this.healthCheck()) {
            return { success: false, fallback: true, error: 'Ollama not available' };
        }

        const input = Array.isArray(text) ? text : [text];
        let modelToUse = this._normalizeModelName(options.model || this._embeddingModel);
        if (!modelToUse) {
            modelToUse = await this._pickAvailableModel('', { embedding: true });
        }
        if (!modelToUse) {
            return {
                success: false,
                fallback: true,
                error: 'No Ollama embedding model configured. Select an embedding-capable model in settings.'
            };
        }

        try {
            const response = await fetch(`${this._url}/api/embed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelToUse,
                    input
                })
            });

            if (!response.ok) {
                const errText = (await response.text()).trim();
                if (response.status === 404 && /model .*not found/i.test(errText)) {
                    const fallbackEmbeddingModel = await this._pickAvailableModel(modelToUse || this._embeddingModel, { embedding: true });
                    if (fallbackEmbeddingModel && fallbackEmbeddingModel !== modelToUse) {
                        this._embeddingModel = fallbackEmbeddingModel;
                        return await this.embed(text, { ...options, model: fallbackEmbeddingModel });
                    }
                }
                return {
                    success: false,
                    fallback: true,
                    error: `Ollama embed HTTP ${response.status}: ${errText || response.statusText || 'Request failed'}`
                };
            }

            const result = await response.json();
            const embeddings = result.embeddings || [];
            this._embeddingModel = modelToUse;
            return {
                success: true,
                embeddings: Array.isArray(text) ? embeddings : embeddings[0] || null,
                model: modelToUse
            };
        } catch (e) {
            return { success: false, fallback: true, error: e.message };
        }
    },

    // Compare two texts semantically
    async compareTexts(text1, text2) {
        const result = await this.generate(
            `On a scale of 0.0 to 1.0, how semantically similar are these two texts? Return ONLY a decimal number.\n\nText 1: ${text1}\nText 2: ${text2}`,
            { temperature: 0, maxTokens: 10 }
        );
        if (result.fallback || !result.success) return null;
        const num = parseFloat(result.response);
        return isNaN(num) ? null : Math.min(1, Math.max(0, num));
    },

    // Math/weighted scoring
    async weightedScore(items, weights) {
        const result = await this.generate(
            `Given these items with their attributes:\n${JSON.stringify(items, null, 1)}\n\nWeights: ${JSON.stringify(weights)}\n\nCalculate a weighted score for each item. Return a JSON array of objects with the original data plus a "score" field. Sort by score descending. No explanation.`,
            { temperature: 0, maxTokens: 2048 }
        );
        if (result.fallback || !result.success) return null;
        try {
            let jsonStr = result.response.trim();
            const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) jsonStr = jsonMatch[1];
            return JSON.parse(jsonStr);
        } catch {
            return null;
        }
    },

    _pickText(value) {
        if (typeof value === 'string') return value.trim();
        if (!value || typeof value !== 'object') return '';
        const preferred = [
            'review_text', 'reviewText', 'review', 'comment', 'commentBody', 'body', 'message',
            'title', 'headline', 'name', 'text', 'text_content', 'description', 'summary', 'content'
        ];
        for (const key of preferred) {
            const v = value[key];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
        for (const v of Object.values(value)) {
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
        return '';
    },

    _extractTexts(payload) {
        if (!payload) return [];
        if (Array.isArray(payload)) {
            return payload.map(v => this._pickText(v)).filter(Boolean);
        }
        if (typeof payload === 'object') {
            const candidates = [
                payload.items,
                payload.data,
                payload.results,
                payload.result,
                payload.extractedData,
                payload.lastExtractionResult?.result
            ];
            for (const c of candidates) {
                if (Array.isArray(c)) return c.map(v => this._pickText(v)).filter(Boolean);
            }
            const single = this._pickText(payload);
            return single ? [single] : [];
        }
        const text = this._pickText(payload);
        return text ? [text] : [];
    },

    _heuristicSentiment(text, item = null) {
        const normalized = String(text || '').toLowerCase();
        const ratingCandidates = item && typeof item === 'object'
            ? [item.rating, item.ratingText, item.stars, item.score, item.starsToday]
            : [];

        for (const raw of ratingCandidates) {
            const value = parseFloat(String(raw || '').replace(/[^\d.]/g, ''));
            if (!Number.isNaN(value)) {
                if (value >= 4) return 'positive';
                if (value <= 2) return 'negative';
            }
        }

        if (!normalized) return 'neutral';
        const positiveTerms = ['excellent', 'great', 'good', 'amazing', 'perfect', 'satisfied', 'love', 'awesome', 'nice', 'best', 'genuine'];
        const negativeTerms = ['bad', 'poor', 'awful', 'terrible', 'broken', 'fake', 'defect', 'waste', 'worst', 'disappointed'];
        const posHits = positiveTerms.filter(term => normalized.includes(term)).length;
        const negHits = negativeTerms.filter(term => normalized.includes(term)).length;
        if (posHits > negHits) return 'positive';
        if (negHits > posHits) return 'negative';
        return 'neutral';
    },

    _summarizeSentiments(rows) {
        const summary = { positive: 0, negative: 0, neutral: 0, total: 0 };
        for (const row of rows || []) {
            const label = String(row?.sentiment || '').toLowerCase();
            if (label === 'positive' || label === 'negative' || label === 'neutral') {
                summary[label] += 1;
                summary.total += 1;
            }
        }
        return summary;
    },

    async _classifySentimentItems(items, textKey = null) {
        const labeled = [];
        for (const item of (Array.isArray(items) ? items : [])) {
            let text = '';
            if (textKey && item && typeof item === 'object' && typeof item[textKey] === 'string') {
                text = item[textKey].trim();
            } else {
                text = this._pickText(item);
            }
            if (!text) continue;

            let sentiment = await this.sentiment(text);
            if (!sentiment) sentiment = this._heuristicSentiment(text, item);

            if (item && typeof item === 'object') {
                labeled.push({ ...item, sentiment });
            } else {
                labeled.push({ text, sentiment });
            }
        }

        return {
            items: labeled,
            summary: this._summarizeSentiments(labeled)
        };
    },

    _inferAction(params = {}) {
        if (params.action) return params.action;
        if (params.task && typeof params.task === 'string') return params.task;
        if (params.question) return 'booleanCheck';
        if (params.text && params.schema) return 'jsonExtract';
        if (params.items && params.criteria) return 'filterItems';
        if (params.items && params.weights) return 'weightedScore';
        if (params.text && params.text2) return 'compareTexts';
        if (params.prompt) return 'generate';
        return '';
    }
};

// Register as tool
if (typeof ToolRegistry !== 'undefined') {
    ToolRegistry.register('local_ollama_model', {
        description: 'Local LLM via Ollama for boolean checks, JSON extraction, sentiment, filtering. Cost-free gatekeeper.',
        capabilities: ['boolean', 'extraction', 'sentiment', 'filtering', 'scoring', 'local-llm'],
        parameters: {
            type: 'OBJECT',
            properties: {
                action: { type: 'STRING', enum: ['booleanCheck', 'jsonExtract', 'sentiment', 'filterItems', 'generate', 'compareTexts', 'weightedScore'] },
                task: { type: 'STRING', description: 'Alias for action' },
                prompt: { type: 'STRING' },
                question: { type: 'STRING' },
                text: { type: 'STRING' },
                items: { type: 'ARRAY' },
                criteria: { type: 'STRING' },
                schema: {},
                weights: {}
            },
            required: []
        },
        execute: async (params) => {
            const normalizedParams = { ...(params || {}) };
            if (normalizedParams.items === undefined && normalizedParams.input !== undefined) {
                normalizedParams.items = normalizedParams.input;
            }
            if (
                (normalizedParams.action === 'filterItems' || normalizedParams.task === 'filterItems') &&
                normalizedParams.criteria === undefined &&
                typeof normalizedParams.prompt === 'string' &&
                normalizedParams.prompt.trim()
            ) {
                normalizedParams.criteria = normalizedParams.prompt.trim();
            }

            const action = OllamaService._inferAction(normalizedParams);

            // Deterministic fallback for extraction-style calls when no action was provided.
            // This keeps tool chains usable even if the planner omits `action`.
            if (!action) {
                const texts = OllamaService._extractTexts(
                    normalizedParams.items || normalizedParams.data || normalizedParams.documents || normalizedParams.results || normalizedParams.result || normalizedParams
                );
                if (texts.length > 0) {
                    return { success: true, result: texts };
                }
                if (normalizedParams.prompt) {
                    return await OllamaService.generate(normalizedParams.prompt, normalizedParams);
                }
                throw new Error('Unknown Ollama action: undefined');
            }

            switch (action) {
                case 'booleanCheck': return { success: true, result: await OllamaService.booleanCheck(normalizedParams.question || normalizedParams.prompt) };
                case 'jsonExtract': return { success: true, result: await OllamaService.jsonExtract(normalizedParams.text, normalizedParams.schema) };
                case 'sentiment': {
                    if (Array.isArray(normalizedParams.items)) {
                        const batch = await OllamaService._classifySentimentItems(
                            normalizedParams.items,
                            typeof normalizedParams.text_key === 'string'
                                ? normalizedParams.text_key
                                : (typeof normalizedParams.textKey === 'string' ? normalizedParams.textKey : null)
                        );
                        return { success: true, result: batch.items, summary: batch.summary };
                    }
                    const text = normalizedParams.text || normalizedParams.prompt || '';
                    const single = await OllamaService.sentiment(text);
                    return { success: true, result: single || OllamaService._heuristicSentiment(text) };
                }
                case 'filterItems': return { success: true, result: await OllamaService.filterItems(normalizedParams.items, normalizedParams.criteria) };
                case 'generate': return await OllamaService.generate(normalizedParams.prompt, normalizedParams);
                case 'compareTexts': return { success: true, result: await OllamaService.compareTexts(normalizedParams.text, normalizedParams.text2) };
                case 'weightedScore': return { success: true, result: await OllamaService.weightedScore(normalizedParams.items, normalizedParams.weights) };
                default: throw new Error(`Unknown Ollama action: ${action}`);
            }
        },
        isAvailable: async () => OllamaService.healthCheck()
    });
}

if (typeof self !== 'undefined') self.OllamaService = OllamaService;
