// Embedding Service - Dual-engine text embeddings (Gemini cloud + Ollama local)
// In-memory vector store with cosine similarity search
// Persistent storage via chrome.storage.local

const EmbeddingService = {
    GEMINI_MODEL: 'gemini-embedding-001',
    GEMINI_API_BASE: 'https://generativelanguage.googleapis.com/v1beta',
    _vectorStore: {},  // { collectionName: [{ id, text, vector, metadata }] }
    _engine: 'gemini', // 'gemini' or 'ollama'

    setEngine(engine) {
        this._engine = engine === 'ollama' ? 'ollama' : 'gemini';
    },

    // Generate embedding vector for text
    async embed(text, apiKey, engine, options = {}) {
        const useEngine = engine || this._engine;

        if (useEngine === 'ollama') {
            try {
                return await this._embedOllama(text, options);
            } catch (e) {
                if (options.strictLocal) {
                    throw new Error(`Strict local embedding failed: ${e.message}`);
                }
                console.warn('[Embedding] Ollama embedding failed, falling back to Gemini:', e.message);
                if (!apiKey) {
                    throw new Error(`Ollama embedding failed and no Gemini API key available: ${e.message}`);
                }
                return await this._embedGemini(text, apiKey);
            }
        }
        return await this._embedGemini(text, apiKey);
    },

    async _embedGemini(text, apiKey) {
        if (!apiKey) throw new Error('API key required for Gemini embeddings');

        try {
            const response = await fetch(
                `${this.GEMINI_API_BASE}/models/${this.GEMINI_MODEL}:embedContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content: { parts: [{ text }] }
                    })
                }
            );

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Gemini embedding failed (${response.status}): ${err}`);
            }

            const result = await response.json();
            return result.embedding?.values || null;
        } catch (e) {
            console.error('[Embedding] Gemini embed error:', e.message);
            throw e;
        }
    },

    async _embedOllama(text, options = {}) {
        if (typeof OllamaService === 'undefined') {
            throw new Error('OllamaService not loaded');
        }
        const result = await OllamaService.embed(text, { model: options.model || options.embeddingModel });
        if (result.fallback || !result.success) {
            throw new Error(result?.error || 'Ollama not available for embedding');
        }
        return result.embeddings;
    },

    // Batch embed multiple texts
    async embedBatch(texts, apiKey, engine, options = {}) {
        const vectors = [];
        for (const text of texts) {
            const vec = await this.embed(text, apiKey, engine, options);
            vectors.push(vec);
        }
        return vectors;
    },

    // Cosine similarity between two vectors
    cosineSimilarity(a, b) {
        if (!a || !b || a.length !== b.length) return 0;
        let dotProduct = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        return denominator === 0 ? 0 : dotProduct / denominator;
    },

    // ===== Vector Store Operations =====

    // Store a text with its embedding in a collection
    async store(collection, id, text, apiKey, metadata = {}, engine, options = {}) {
        const vector = await this.embed(text, apiKey, engine, options);
        if (!this._vectorStore[collection]) {
            this._vectorStore[collection] = [];
        }

        // Update if id exists, else append
        const existingIdx = this._vectorStore[collection].findIndex(item => item.id === id);
        const entry = { id, text, vector, metadata, storedAt: Date.now() };

        if (existingIdx >= 0) {
            this._vectorStore[collection][existingIdx] = entry;
        } else {
            this._vectorStore[collection].push(entry);
        }

        return { success: true, collection, id };
    },

    // Store multiple items at once
    async storeBatch(collection, items, apiKey, engine, options = {}) {
        // items: [{ id, text, metadata }]
        for (const item of items) {
            await this.store(collection, item.id, item.text, apiKey, item.metadata || {}, engine, options);
        }
        return { success: true, stored: items.length };
    },

    // Search collection by semantic similarity
    async search(collection, query, topK = 5, apiKey, engine, options = {}) {
        const items = this._vectorStore[collection] || [];
        if (items.length === 0) return [];

        const queryVector = await this.embed(query, apiKey, engine, options);
        if (!queryVector) return [];

        const scored = items.map(item => ({
            id: item.id,
            text: item.text,
            metadata: item.metadata,
            score: this.cosineSimilarity(queryVector, item.vector)
        }));

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    },

    // Compare two texts directly (without storing)
    async compare(text1, text2, apiKey, engine, options = {}) {
        const [vec1, vec2] = await Promise.all([
            this.embed(text1, apiKey, engine, options),
            this.embed(text2, apiKey, engine, options)
        ]);
        return this.cosineSimilarity(vec1, vec2);
    },

    // Compare a query against multiple texts, return sorted scores
    async rank(query, texts, apiKey, engine, options = {}) {
        const queryVec = await this.embed(query, apiKey, engine, options);
        const results = [];
        for (let i = 0; i < texts.length; i++) {
            const textVec = await this.embed(texts[i], apiKey, engine, options);
            results.push({
                index: i,
                text: texts[i],
                score: this.cosineSimilarity(queryVec, textVec)
            });
        }
        results.sort((a, b) => b.score - a.score);
        return results;
    },

    // Filter texts by similarity threshold (e.g., find all titles about "politics")
    async filterBySimilarity(texts, reference, threshold = 0.5, apiKey, engine, options = {}) {
        const refVec = await this.embed(reference, apiKey, engine, options);
        const matched = [];
        const unmatched = [];

        for (let i = 0; i < texts.length; i++) {
            const textVec = await this.embed(texts[i], apiKey, engine, options);
            const score = this.cosineSimilarity(refVec, textVec);
            const entry = { index: i, text: texts[i], score };
            if (score >= threshold) {
                matched.push(entry);
            } else {
                unmatched.push(entry);
            }
        }

        return { matched, unmatched };
    },

    // ===== Persistence =====

    async persistCollection(collection) {
        const data = this._vectorStore[collection] || [];
        await chrome.storage.local.set({
            [`embeddings_${collection}`]: data
        });
        console.log(`[Embedding] Persisted collection "${collection}" (${data.length} items)`);
    },

    async loadCollection(collection) {
        const result = await chrome.storage.local.get([`embeddings_${collection}`]);
        this._vectorStore[collection] = result[`embeddings_${collection}`] || [];
        console.log(`[Embedding] Loaded collection "${collection}" (${this._vectorStore[collection].length} items)`);
        return this._vectorStore[collection].length;
    },

    async deleteCollection(collection) {
        delete this._vectorStore[collection];
        await chrome.storage.local.remove([`embeddings_${collection}`]);
    },

    getCollectionSize(collection) {
        return (this._vectorStore[collection] || []).length;
    },

    listCollections() {
        return Object.keys(this._vectorStore).map(name => ({
            name,
            size: this._vectorStore[name].length
        }));
    },

    _normalizeAction(params = {}) {
        const raw = params.action || params.task || '';
        if (!raw) return '';
        const key = String(raw).trim().toLowerCase();
        const map = {
            rank_by_similarity: 'rank',
            rankbysimilarity: 'rank',
            semantic_rank: 'rank',
            filter_by_similarity: 'filter',
            similarity_search: 'rank',
            semantic_similarity_search: 'rank',
            semantic_search: 'rank'
        };
        return map[key] || key;
    },

    _pickTextFromObject(obj) {
        if (!obj || typeof obj !== 'object') return '';
        const preferredKeys = ['title', 'text', 'headline', 'name', 'description', 'summary', 'content'];
        for (const key of preferredKeys) {
            const value = obj[key];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
        for (const value of Object.values(obj)) {
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return '';
    },

    _extractTextList(input) {
        if (!input) return [];

        const toTextArray = (arr) => arr
            .map(item => {
                if (typeof item === 'string') return item.trim();
                if (item && typeof item === 'object') return this._pickTextFromObject(item);
                return '';
            })
            .filter(Boolean);

        if (Array.isArray(input)) return toTextArray(input);
        if (typeof input === 'string') return [input];
        if (typeof input !== 'object') return [];

        if (Array.isArray(input.documents)) return toTextArray(input.documents);
        if (Array.isArray(input.extractedData)) return toTextArray(input.extractedData);
        if (Array.isArray(input.result)) return toTextArray(input.result);
        if (Array.isArray(input.results)) return toTextArray(input.results);
        if (Array.isArray(input.lastExtractionResult?.result)) return toTextArray(input.lastExtractionResult.result);

        const objectText = this._pickTextFromObject(input);
        return objectText ? [objectText] : [];
    },

    _extractTextsFromDocuments(documents, documentKey = '') {
        if (!Array.isArray(documents)) return [];
        const key = String(documentKey || '').trim();
        return documents
            .map(doc => {
                if (typeof doc === 'string') return doc.trim();
                if (!doc || typeof doc !== 'object') return '';
                if (key && typeof doc[key] === 'string' && doc[key].trim()) {
                    return doc[key].trim();
                }
                return this._pickTextFromObject(doc);
            })
            .filter(Boolean);
    },

    // ===== Unified execute for tool registry =====
    async execute(params, context) {
        const apiKey = params.apiKey || context.apiKey;
        const action = this._normalizeAction(params);
        const engine = params.engine;
        const embedOptions = {
            model: params.embeddingModel || params.model,
            embeddingModel: params.embeddingModel || params.model,
            strictLocal: params.strictLocal === true
        };

        switch (action) {
            case 'embed':
                return { success: true, vector: await this.embed(params.text, apiKey, engine, embedOptions) };

            case 'store':
                return await this.store(params.collection, params.id, params.text, apiKey, params.metadata, engine, embedOptions);

            case 'storeBatch':
                return await this.storeBatch(params.collection, params.items, apiKey, engine, embedOptions);

            case 'search':
                return { success: true, results: await this.search(params.collection, params.query, params.topK || 5, apiKey, engine, embedOptions) };

            case 'compare':
                return { success: true, similarity: await this.compare(params.text1, params.text2, apiKey, engine, embedOptions) };

            case 'rank': {
                let sourceDocuments = params.documents;
                const documentKey = params.document_key || params.documentField || params.document_field || '';
                const documentsKey = params.documents_key || params.documentsKey || '';

                if ((!sourceDocuments || (Array.isArray(sourceDocuments) && sourceDocuments.length === 0)) && documentsKey) {
                    if (typeof NotepadService !== 'undefined' && NotepadService?.read) {
                        sourceDocuments = NotepadService.read(documentsKey);
                    }
                }
                if (typeof sourceDocuments === 'string') {
                    const token = sourceDocuments.match(/^\{\{notepad:(\w+)\}\}$/);
                    if (token && typeof NotepadService !== 'undefined' && NotepadService?.read) {
                        sourceDocuments = NotepadService.read(token[1]);
                    }
                }

                const docTexts = this._extractTextsFromDocuments(sourceDocuments, documentKey);
                const texts = docTexts.length > 0
                    ? docTexts
                    : this._extractTextList(
                        params.texts ||
                        params.items ||
                        sourceDocuments ||
                        params.dataset ||
                        params.result ||
                        params.results
                    );
                if (!params.query) throw new Error('Missing query for rank action');
                if (!texts.length) throw new Error('No texts available for ranking');
                return { success: true, rankings: await this.rank(params.query, texts, apiKey, engine, embedOptions) };
            }

            case 'filter': {
                const texts = this._extractTextList(params.texts || params.items || params.dataset);
                const reference = params.reference || params.query;
                if (!reference) throw new Error('Missing reference/query for filter action');
                if (!texts.length) throw new Error('No texts available for filtering');
                return { success: true, ...(await this.filterBySimilarity(texts, reference, params.threshold, apiKey, engine, embedOptions)) };
            }

            case 'persist':
                await this.persistCollection(params.collection);
                return { success: true };

            case 'load':
                const count = await this.loadCollection(params.collection);
                return { success: true, count };

            default:
                throw new Error(`Unknown embedding action: ${params.action || params.task}`);
        }
    }
};

// Register as tool
if (typeof ToolRegistry !== 'undefined') {
    ToolRegistry.register('embedding_handler', {
        description: 'Generate text embeddings, store vectors, and perform semantic similarity search/ranking/filtering',
        capabilities: ['embedding', 'similarity', 'semantic-search', 'ranking', 'vector-store'],
        parameters: {
            type: 'OBJECT',
            properties: {
                action: { type: 'STRING', enum: ['embed', 'store', 'storeBatch', 'search', 'compare', 'rank', 'filter', 'persist', 'load', 'similarity_search', 'rank_by_similarity', 'semantic_rank'] },
                task: { type: 'STRING', description: 'Alias for action (e.g., rank_by_similarity)' },
                text: { type: 'STRING' },
                text1: { type: 'STRING' },
                text2: { type: 'STRING' },
                texts: { type: 'ARRAY', items: { type: 'STRING' } },
                documents: { type: 'ARRAY', description: 'Alias for texts/items when running similarity_search' },
                document_key: { type: 'STRING', description: 'When documents are objects, key to embed (e.g. "title")' },
                documents_key: { type: 'STRING', description: 'Notepad key that stores documents array' },
                document_field: { type: 'STRING', description: 'Alias for document_key' },
                query: { type: 'STRING' },
                reference: { type: 'STRING' },
                collection: { type: 'STRING' },
                id: { type: 'STRING' },
                items: { type: 'ARRAY' },
                topK: { type: 'NUMBER' },
                threshold: { type: 'NUMBER' },
                engine: { type: 'STRING', enum: ['gemini', 'ollama'] },
                model: { type: 'STRING', description: 'Optional embedding model name (especially for Ollama engine)' },
                embeddingModel: { type: 'STRING', description: 'Alias for model when selecting Ollama embedding model' },
                strictLocal: { type: 'BOOLEAN', description: 'If true with engine=ollama, do not fallback to Gemini on failure' },
                metadata: { type: 'OBJECT' }
            },
            required: ['action']
        },
        execute: async (params, context) => EmbeddingService.execute(params, context)
    });
}

if (typeof self !== 'undefined') self.EmbeddingService = EmbeddingService;
