const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./db');
const { hybridSearch, parseFunctionRow } = require('./search');
const {
    buildSearchableText,
    clamp,
    generateFingerprint,
    normalizePatternList,
    toNumberArray
} = require('./utils');

const PORT = Number(process.env.PORT || 8787);
const app = express();
const dbClient = initDatabase();

app.use(cors());
app.use(express.json({ limit: '20mb' }));

function ok(res, payload = {}) {
    res.json({ success: true, ...payload });
}

function fail(res, status, message, details = null) {
    res.status(status).json({
        success: false,
        error: message,
        details
    });
}

function normalizeMetadata(input = {}, functionDef = {}) {
    const applicableSites = normalizePatternList(input.applicableSites || functionDef.urlPatterns || []);
    return {
        source: input.source || functionDef.source || 'unknown',
        tags: Array.isArray(input.tags) ? input.tags.filter(Boolean) : [],
        applicableSites,
        testsPassed: input.testsPassed === true || functionDef.testsPassed === true,
        extensionVersion: input.extensionVersion || '',
        createdAt: input.createdAt || functionDef.createdAt || Date.now(),
        updatedAt: Date.now()
    };
}

function normalizeFunctionDef(input = {}) {
    if (!input || typeof input !== 'object') return null;
    if (!input.name || typeof input.name !== 'string') return null;
    return {
        ...input,
        name: input.name.trim(),
        description: typeof input.description === 'string' ? input.description.trim() : '',
        urlPatterns: normalizePatternList(input.urlPatterns),
        steps: Array.isArray(input.steps) ? input.steps : [],
        inputs: Array.isArray(input.inputs) ? input.inputs : []
    };
}

app.get('/api/health', (_req, res) => {
    ok(res, {
        status: 'ok',
        dbPath: dbClient.dbPath,
        functionCount: dbClient.countFunctions()
    });
});

app.get('/api/stats', (_req, res) => {
    ok(res, {
        functionCount: dbClient.countFunctions(),
        dbPath: dbClient.dbPath
    });
});

app.get('/api/functions', (req, res) => {
    const limit = clamp(req.query.limit || 50, 1, 200);
    const offset = Math.max(0, Number(req.query.offset || 0) || 0);
    const rows = dbClient.listFunctions(limit, offset);
    const items = rows.map((row) => {
        const parsed = parseFunctionRow(row);
        return {
            id: parsed.id,
            name: parsed.functionDef?.name || row.name,
            description: parsed.functionDef?.description || row.description || '',
            sites: parsed.sites,
            metadata: parsed.metadata,
            verified: parsed.verified,
            updatedAt: parsed.updatedAt
        };
    });
    ok(res, { items, limit, offset });
});

app.get('/api/functions/:id', (req, res) => {
    const row = dbClient.getFunctionById(req.params.id);
    if (!row) return fail(res, 404, 'Function not found');
    const parsed = parseFunctionRow(row);
    ok(res, {
        item: {
            id: parsed.id,
            functionDef: parsed.functionDef,
            metadata: parsed.metadata,
            sites: parsed.sites,
            verified: parsed.verified,
            updatedAt: parsed.updatedAt
        }
    });
});

app.post('/api/functions/upsert', (req, res) => {
    try {
        const payload = req.body || {};
        const functionDef = normalizeFunctionDef(payload.functionDef);
        if (!functionDef) {
            return fail(res, 400, 'Invalid functionDef payload. "name" is required.');
        }

        const metadata = normalizeMetadata(payload.metadata || {}, functionDef);
        const searchableText = buildSearchableText(functionDef, metadata);
        const embedding = toNumberArray(payload.embedding);
        const fingerprint = String(payload.fingerprint || generateFingerprint(functionDef, metadata)).trim();
        const id = String(payload.id || payload.functionId || crypto.randomUUID());

        const record = {
            id,
            name: functionDef.name,
            description: functionDef.description || '',
            function_json: JSON.stringify(functionDef),
            embedding_json: embedding ? JSON.stringify(embedding) : null,
            metadata_json: JSON.stringify(metadata),
            sites_json: JSON.stringify(metadata.applicableSites),
            searchable_text: searchableText || functionDef.name,
            fingerprint,
            source_extension: String(payload.clientId || '').trim(),
            verified: metadata.testsPassed ? 1 : 0
        };

        const stored = dbClient.upsertFunction(record);
        ok(res, {
            id: stored.id,
            name: stored.name,
            verified: stored.verified === 1,
            updatedAt: stored.updated_at
        });
    } catch (error) {
        fail(res, 500, 'Failed to upsert function', error.message);
    }
});

app.post('/api/functions/search', (req, res) => {
    try {
        const body = req.body || {};
        const query = String(body.query || '').trim();
        const currentUrl = String(body.currentUrl || '').trim();
        const topK = clamp(body.topK || 8, 1, 30);
        const alpha = clamp(body.alpha || 0.65, 0, 1);
        const queryEmbedding = toNumberArray(body.queryEmbedding);

        const searchResult = hybridSearch(dbClient, {
            query,
            queryEmbedding,
            currentUrl,
            topK,
            alpha
        });

        ok(res, {
            query,
            currentUrl,
            topK,
            alpha,
            totalCandidates: searchResult.totalCandidates,
            results: searchResult.results
        });
    } catch (error) {
        fail(res, 500, 'Search failed', error.message);
    }
});

const staticDir = path.join(__dirname, '..', 'ui');
app.use(express.static(staticDir));

app.get('*', (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
});

app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[function-backend] listening on http://0.0.0.0:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[function-backend] database: ${dbClient.dbPath}`);
});
